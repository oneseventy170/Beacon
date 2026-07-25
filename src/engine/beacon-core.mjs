// Beacon engine — pure logic, no console output, no process.exit.
// Every function takes an options object (always including `cwd`, the repo to
// operate on) and RETURNS structured data or throws an Error. Both the CLI and
// the Electron app consume this module.

import { existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Process helpers (cwd-aware)
// ---------------------------------------------------------------------------

function run(cmd, args, { cwd, env } = {}) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
  });
  if (res.error) return { code: 1, stdout: "", stderr: String(res.error.message) };
  return { code: res.status ?? 1, stdout: (res.stdout || "").trim(), stderr: (res.stderr || "").trim() };
}

// Bind a git runner to a working directory.
function gitFor(cwd) {
  return (...args) => run("git", args, { cwd });
}
function gitMust(cwd, ...args) {
  const r = run("git", args, { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

// ---------------------------------------------------------------------------
// Repo introspection
// ---------------------------------------------------------------------------

export function isRepo(cwd) {
  const r = run("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
  return r.code === 0 && r.stdout === "true";
}

export function currentBranch(cwd) {
  return gitFor(cwd)("branch", "--show-current").stdout;
}

export function defaultBranch(cwd) {
  const git = gitFor(cwd);
  const r = git("symbolic-ref", "refs/remotes/origin/HEAD");
  if (r.code === 0 && r.stdout) return r.stdout.replace("refs/remotes/origin/", "");
  for (const cand of ["main", "master"]) {
    if (git("show-ref", "--verify", `refs/remotes/origin/${cand}`).code === 0) return cand;
  }
  return "main";
}

export function workingTreeDirty(cwd) {
  return gitMust(cwd, "status", "--porcelain").length > 0;
}

function originUrl(cwd) {
  const r = gitFor(cwd)("remote", "get-url", "origin");
  return r.code === 0 ? r.stdout : "";
}

export function ownerRepo(cwd) {
  const m = originUrl(cwd).match(/github\.com[:/](.+?)(?:\.git)?$/);
  return m ? m[1] : null;
}

// gh CLI present + authenticated (optionally scoped to a token).
export function ghReady(token) {
  const env = token ? { GH_TOKEN: token } : undefined;
  if (run("gh", ["--version"], { env }).code !== 0) return false;
  return run("gh", ["auth", "status"], { env }).code === 0;
}

// Whichever GitHub identity a given token maps to (for the UI to display).
export function ghIdentity(token) {
  const env = token ? { GH_TOKEN: token } : undefined;
  const r = run("gh", ["api", "user", "--jq", ".login"], { env });
  return r.code === 0 ? r.stdout : null;
}

// gh install + auth status, plus the signed-in login — drives the onboarding UI.
export function ghStatus() {
  const installed = run("gh", ["--version"]).code === 0;
  if (!installed) return { installed: false, authed: false, login: null };
  const authed = run("gh", ["auth", "status"]).code === 0;
  let login = null;
  if (authed) {
    const r = run("gh", ["api", "user", "--jq", ".login"]);
    if (r.code === 0) login = r.stdout;
  }
  return { installed, authed, login };
}

// A full snapshot the UI can render on load.
export function getContext(cwd) {
  if (!isRepo(cwd)) return { cwd, isRepo: false };
  return {
    cwd,
    isRepo: true,
    branch: currentBranch(cwd),
    defaultBranch: defaultBranch(cwd),
    dirty: workingTreeDirty(cwd),
    ownerRepo: ownerRepo(cwd),
    originUrl: originUrl(cwd),
    ghReady: ghReady(),
  };
}

// All local branches, most-recently-committed first, with the current and
// default branch flagged. Read-only — safe to call on every repo load.
export function listBranches({ cwd } = {}) {
  if (!isRepo(cwd)) return { current: "", defaultBranch: "main", branches: [] };
  const cur = currentBranch(cwd);
  const def = defaultBranch(cwd);
  const r = gitFor(cwd)(
    "for-each-ref", "refs/heads", "--sort=-committerdate",
    "--format=%(refname:short)%09%(committerdate:unix)%09%(objectname:short)%09%(upstream:short)"
  );
  const branches = (r.stdout || "").split("\n").filter(Boolean).map((line) => {
    const [name, ts, oid, upstream] = line.split("\t");
    return {
      name,
      oid: oid || "",
      upstream: upstream || null,
      date: ts ? new Date(Number(ts) * 1000).toISOString() : null,
      current: name === cur,
      isDefault: name === def,
    };
  });
  return { current: cur, defaultBranch: def, branches };
}

// Switch to an existing local branch. Refuses on a dirty tree (like `start`)
// so uncommitted work is never silently disturbed. Purely reversible.
export function checkout({ cwd, branch } = {}) {
  if (!isRepo(cwd)) throw new Error("not a git repository");
  if (!branch) throw new Error("no branch given");
  if (workingTreeDirty(cwd)) throw new Error("working tree has uncommitted changes — commit or stash first");
  gitMust(cwd, "switch", branch);
  return { branch };
}

// Delete a local branch. Refuses the current or default branch. Without force,
// git refuses branches with unmerged commits — the UI re-calls with force after
// a second confirmation. Never touches the remote.
export function deleteBranch({ cwd, branch, force = false } = {}) {
  if (!isRepo(cwd)) throw new Error("not a git repository");
  if (!branch) throw new Error("no branch given");
  if (branch === currentBranch(cwd)) throw new Error("can't delete the branch you're on — switch away first");
  if (branch === defaultBranch(cwd)) throw new Error("can't delete the default branch");
  const r = gitFor(cwd)("branch", force ? "-D" : "-d", branch);
  if (r.code !== 0) {
    const msg = r.stderr || r.stdout || "could not delete branch";
    if (/not fully merged/i.test(msg)) throw new Error("unmerged");
    throw new Error(msg);
  }
  return { deleted: branch, forced: force };
}

// Fetch remote refs (no working-tree changes). Safe to call anytime.
export function fetchRemote({ cwd } = {}) {
  if (!isRepo(cwd)) throw new Error("not a git repository");
  const r = gitFor(cwd)("fetch", "origin", "--prune");
  if (r.code !== 0) throw new Error(r.stderr || r.stdout || "fetch failed");
  return { fetched: true };
}

// Pull the current branch (fast-forward only — never creates a merge or leaves
// conflicts; if it can't fast-forward it errors cleanly for the UI to surface).
export function pull({ cwd } = {}) {
  if (!isRepo(cwd)) throw new Error("not a git repository");
  const branch = currentBranch(cwd);
  if (!branch) throw new Error("detached HEAD — checkout a branch first");
  if (workingTreeDirty(cwd)) throw new Error("you have uncommitted changes — save or set them aside first");
  const r = gitFor(cwd)("pull", "--ff-only");
  if (r.code !== 0) throw new Error(r.stderr || r.stdout || "pull failed");
  return { pulled: true, note: r.stdout };
}

// How far the current branch is ahead/behind its upstream. Optionally fetches
// first so the answer reflects the real remote. Drives the "pull first" prompt.
export function remoteState({ cwd, fetch = false } = {}) {
  if (!isRepo(cwd)) return { behind: 0, ahead: 0, upstream: null };
  if (fetch) run("git", ["fetch", "origin", "--prune"], { cwd });
  const branch = currentBranch(cwd);
  if (!branch) return { behind: 0, ahead: 0, upstream: null };
  const up = gitFor(cwd)("rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`);
  if (up.code !== 0 || !up.stdout) return { behind: 0, ahead: 0, upstream: null };
  const counts = gitFor(cwd)("rev-list", "--left-right", "--count", `${branch}...${up.stdout}`);
  const parts = (counts.stdout || "0 0").split(/\s+/);
  return { ahead: Number(parts[0]) || 0, behind: Number(parts[1]) || 0, upstream: up.stdout };
}

// The "saves" (commits) made on this branch since it left the default branch,
// newest first, each with its own change counts. Powers the branch activity view.
export function branchLog({ cwd } = {}) {
  if (!isRepo(cwd)) throw new Error("not a git repository");
  const branch = currentBranch(cwd);
  const def = defaultBranch(cwd);
  const base = baseRef(cwd, def);
  // \x1e separates commits, \x1f separates fields; numstat lines follow each header.
  const raw = gitFor(cwd)("log", `${base}..HEAD`, "--numstat", "--format=%x1e%H%x1f%an%x1f%aI%x1f%s").stdout || "";
  const commits = raw.split("\x1e").filter((c) => c.trim()).map((chunk) => {
    const lines = chunk.split("\n");
    const [oid, author, date, ...rest] = lines[0].split("\x1f");
    let additions = 0, deletions = 0, files = 0;
    for (const l of lines.slice(1)) {
      if (!l.trim()) continue;
      const [a, d] = l.split("\t");
      files++;
      if (a !== "-") additions += Number(a) || 0;
      if (d !== "-") deletions += Number(d) || 0;
    }
    return { oid: (oid || "").slice(0, 7), author, date, message: rest.join("\x1f"), files, additions, deletions };
  });
  return { branch, defaultBranch: def, count: commits.length, commits };
}

// ---------------------------------------------------------------------------
// Branch scope (.beacon/scope.json)
//
// The scope is an ALLOWLIST: on a Beacon-started branch, the agent (or anyone)
// may edit files matching `allow` (the front end — styles, components, pages,
// assets, tokens, …) and may create new files there. `deny` ALWAYS WINS, so
// backend/auth/routing/DB/config stay protected even when they'd otherwise
// match the allowlist (e.g. a `routes/` folder full of .tsx). A file is in
// scope iff it matches `allow` AND not `deny`; everything else is out of scope.
//
// The scope is written per branch, committed as the branch's FIRST commit
// (together with a plain-language CLAUDE.md section) so the declaration is
// visible in the PR diff before any change is.
//
// PROTOTYPE ZONE: when the task needs backend behaviour to work, the agent is
// told (CLAUDE.md) not to build it — instead it mocks the data/service layer
// under the `prototype` paths and renders the real components against fixtures
// there. Prototype files are always in scope, tracked as their own category,
// and the backend work needed (`.beacon/prototype/README.md`) rides into the
// PR description for the developer who productionizes it.
// ---------------------------------------------------------------------------

export const SCOPE_FILE = ".beacon/scope.json";
export const PROTO_NOTES = ".beacon/prototype/README.md";

// Where a working prototype may mock what the backend would provide.
export const DEFAULT_PROTOTYPE = [".beacon/prototype/**"];

// The front end: what a Beacon-scoped branch can freely edit and add to.
export const DEFAULT_ALLOW = [
  "**/*.css", "**/*.scss", "**/*.sass", "**/*.less", "**/*.pcss", "**/*.styl",
  "**/*.svg", "**/*.png", "**/*.jpg", "**/*.jpeg", "**/*.gif", "**/*.webp", "**/*.avif", "**/*.ico",
  "**/*.woff", "**/*.woff2", "**/*.ttf", "**/*.otf",
  "**/*.tsx", "**/*.jsx", "**/*.vue", "**/*.svelte", "**/*.astro", "**/*.mdx",
  "**/*.html", "**/*.md",
  "**/components/**", "**/component/**",
  "**/pages/**", "**/views/**", "**/screens/**", "**/layouts/**", "**/layout/**",
  "**/styles/**", "**/styling/**", "**/theme/**", "**/themes/**",
  "**/design-tokens/**", "**/tokens/**", "**/*.tokens.json",
  "**/assets/**", "**/public/**", "**/static/**", "**/images/**", "**/img/**", "**/fonts/**", "**/icons/**",
  "apps/web-client/**", "apps/web-customer-client/**",
  "packages/design-tokens/**",
  // Front-end build & styling config (Tailwind, PostCSS, Vite, tsconfig), at the
  // repo root or nested. Backend configs stay denied — their directory
  // (apps/web-server, …) wins on the denylist below.
  "*.config.js", "*.config.cjs", "*.config.mjs", "*.config.ts", "tsconfig*.json",
  "**/*.config.js", "**/*.config.cjs", "**/*.config.mjs", "**/*.config.ts", "**/tsconfig*.json",
];

// Never in scope, even if matched above. Denylist wins.
export const DEFAULT_DENY = [
  "**/auth/**", "**/*auth*",
  "**/middleware*", "**/*middleware*",
  "**/routes/**", "**/routing/**", "**/*router*", "**/*routes-registry*", "**/route.*", "**/*.route.*",
  "**/api/**",
  "**/server/**", "apps/web-server/**", "apps/worker/**",
  "supabase/**", "**/migrations/**", "**/*.sql",
  "**/db/**", "**/database/**", "**/prisma/**", "**/*schema*",
  "**/.env*", "**/*.env*", "**/fnox.toml",
  ".github/**", "**/.github/**",
  "package.json", "**/package.json", "**/package-lock.json", "**/pnpm-lock.yaml", "**/yarn.lock",
];

function repoRoot(cwd) {
  return gitMust(cwd, "rev-parse", "--show-toplevel");
}

function loadScope(cwd) {
  const path = join(repoRoot(cwd), SCOPE_FILE);
  let allow = DEFAULT_ALLOW;
  let deny = DEFAULT_DENY;
  let prototype = DEFAULT_PROTOTYPE;
  if (existsSync(path)) {
    try {
      const cfg = JSON.parse(readFileSync(path, "utf8"));
      if (Array.isArray(cfg.allow)) allow = cfg.allow;
      if (Array.isArray(cfg.deny)) deny = cfg.deny;
      if (Array.isArray(cfg.prototype)) prototype = cfg.prototype;
    } catch {
      /* malformed scope — fall back to defaults */
    }
  }
  return { allow, deny, prototype };
}

function globToRegex(glob) {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\0/g, ".*");
  return new RegExp(`^${re}$`);
}

const matchesAny = (file, globs) => globs.some((g) => globToRegex(g).test(file));

// Classify a file: "prototype" (the mock zone — always in scope, tracked as
// its own category), "beacon" (Beacon's own declaration files), "in" (matches
// allow and not deny), or "out" (everything else — flagged).
function fileZone(file, cfg) {
  if (matchesAny(file, cfg.prototype)) return "prototype";
  if (file === "CLAUDE.md" || file === ".beacon" || file.startsWith(".beacon/")) return "beacon";
  return matchesAny(file, cfg.allow) && !matchesAny(file, cfg.deny) ? "in" : "out";
}
const isOutOfScope = (file, cfg) => fileZone(file, cfg) === "out";

// ---------------------------------------------------------------------------
// Diff analysis
// ---------------------------------------------------------------------------

const STATUS_WORDS = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "type-changed" };

function baseRef(cwd, def) {
  const r = gitFor(cwd)("merge-base", "HEAD", `origin/${def}`);
  return r.code === 0 ? r.stdout : `origin/${def}`;
}

function untrackedFiles(cwd) {
  const r = gitFor(cwd)("ls-files", "--others", "--exclude-standard");
  return r.code === 0 ? r.stdout.split("\n").filter(Boolean) : [];
}

function untrackedAsDiff(cwd) {
  const root = repoRoot(cwd);
  let out = "";
  for (const f of untrackedFiles(cwd)) {
    if (f === "CLAUDE.md" || f === SCOPE_FILE) continue;
    try {
      const content = readFileSync(join(root, f), "utf8");
      if (content.includes("\0")) continue;
      const lines = content.split("\n").slice(0, 500);
      out += `\n+++ b/${f}\n${lines.map((l) => `+${l}`).join("\n")}\n`;
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

function changedFiles(cwd, base, cfg) {
  const git = gitFor(cwd);
  const merged = new Map();
  const ingest = (text) => {
    for (const line of text.split("\n").filter(Boolean)) {
      const parts = line.split(/\t/);
      const code = parts[0][0];
      const file = parts[parts.length - 1];
      if (!merged.has(file)) merged.set(file, code);
    }
  };
  ingest(git("diff", "--name-status", `${base}...HEAD`).stdout || "");
  ingest(git("diff", "--name-status", "--cached").stdout || "");
  ingest(git("diff", "--name-status", "HEAD").stdout || "");
  for (const f of untrackedFiles(cwd)) if (!merged.has(f)) merged.set(f, "A");

  return [...merged.entries()].map(([file, code]) => {
    const zone = fileZone(file, cfg);
    return {
      file,
      status: STATUS_WORDS[code] || "changed",
      outOfScope: zone === "out",
      prototype: zone === "prototype",
    };
  });
}

// Beacon's declaration files are excluded — their glob patterns would pollute
// the reused-token/component signal on every branch. Prototype code stays in:
// it's real UI work and its reuse signal matters.
function fullDiff(cwd, base) {
  const git = gitFor(cwd);
  const excl = ["--", ".", `:(exclude)${SCOPE_FILE}`, ":(exclude)CLAUDE.md"];
  const committed = git("diff", `${base}...HEAD`, ...excl).stdout || "";
  const uncommitted = git("diff", "HEAD", ...excl).stdout || "";
  return [committed, uncommitted, untrackedAsDiff(cwd)].filter(Boolean).join("\n");
}

function analyzeAddedLines(diff) {
  const added = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
  const tokens = new Set();
  const components = new Set();
  const assumptions = [];
  for (const line of added) {
    if (/design-tokens|["']@[\w-]+\/tokens/.test(line)) {
      const m = line.match(/from\s+["']([^"']*(?:design-tokens|tokens)[^"']*)["']/);
      if (m) tokens.add(m[1]);
    }
    for (const v of line.matchAll(/var\(\s*(--[\w-]+)/g)) tokens.add(v[1]);
    for (const t of line.matchAll(/\btokens\.([\w.]+)/g)) tokens.add(`tokens.${t[1]}`);
    for (const c of line.matchAll(/<([A-Z][A-Za-z0-9]+)[\s/>]/g)) components.add(c[1]);
    const imp = line.match(/import\s+\{?\s*([A-Z][A-Za-z0-9]+)[\s,}].*from\s+["'][^"']*components?[^"']*["']/);
    if (imp) components.add(imp[1]);
    if (/\b(TODO|FIXME|HACK|XXX)\b/i.test(line) || /\b(assume|assumption|placeholder|hard-?cod|for now)\b/i.test(line)) {
      assumptions.push(line.trim().slice(0, 120));
    }
  }
  return {
    tokens: [...tokens].slice(0, 20),
    components: [...components].slice(0, 20),
    assumptions: assumptions.slice(0, 8),
  };
}

// ---------------------------------------------------------------------------
// Public: status
// ---------------------------------------------------------------------------

export function status({ cwd, fetch: doFetch = true } = {}) {
  if (!isRepo(cwd)) throw new Error("not a git repository");
  const branch = currentBranch(cwd);
  if (!branch) throw new Error("detached HEAD — checkout a branch first");
  const def = defaultBranch(cwd);
  if (doFetch) run("git", ["fetch", "origin", def], { cwd });
  const cfg = loadScope(cwd);
  const base = baseRef(cwd, def);
  const files = changedFiles(cwd, base, cfg);
  const signal = analyzeAddedLines(fullDiff(cwd, base));
  const stat = gitFor(cwd)("diff", "--shortstat", base).stdout || "";
  return { branch, defaultBranch: def, files, signal, stat };
}

// ---------------------------------------------------------------------------
// Public: start
// ---------------------------------------------------------------------------

export function slugify(name) {
  return String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

// --- scope declaration (written + committed on `start`) ---------------------

// (Re)write .beacon/scope.json for this branch. Always rewritten on start so a
// scope.json inherited from a merged branch never leaks onto a new one.
export function writeScope({ cwd, branch, task } = {}) {
  const root = repoRoot(cwd);
  mkdirSync(join(root, ".beacon"), { recursive: true });
  const scope = {
    _comment:
      "Beacon branch scope — the enforced rule for this branch/task. Edits may touch files matching `allow` (the front end); `deny` always wins (backend, auth, routing, DB schema, API handlers, infra config). Beacon's Claude Code PreToolUse hook checks every file write against this: out-of-scope writes are flagged (never blocked) and revertable via `beacon review` before the PR goes out. `prototype` paths are the mock zone: when the UI needs backend behaviour, it gets prototyped there against fixtures instead of touching the real backend. Tune the globs per repo.",
    branch,
    task: task || branch,
    createdAt: new Date().toISOString(),
    allow: DEFAULT_ALLOW,
    deny: DEFAULT_DENY,
    prototype: DEFAULT_PROTOTYPE,
  };
  writeFileSync(join(root, SCOPE_FILE), `${JSON.stringify(scope, null, 2)}\n`);
  return { path: join(root, SCOPE_FILE) };
}

// --- CLAUDE.md guidance (plain language, marker-delimited) -------------------

const CLAUDE_START = "<!-- beacon:scope -->";
const CLAUDE_END = "<!-- /beacon:scope -->";

function claudeSection(branch) {
  return `${CLAUDE_START}
## Branch scope (Beacon)

This branch (\`${branch}\`) is scoped to **front-end / presentation files only** —
components, styles, view templates, static assets, and front-end test files.
See \`.beacon/scope.json\` for the enforced rule (allowed and denied path patterns).

**Never modify backend, auth, routing, database-schema, API, or infra-config
files** — a developer owns those. Beacon watches every file write: anything
outside the scope is flagged (not blocked) and reviewed — and revertable —
before a PR is opened.

### Needs backend to work? Prototype in front of it

If the change depends on backend behaviour that doesn't exist yet, don't build
the backend — build a **working prototype in front of it**:

- Put everything mock under \`.beacon/prototype/\`: fixture data plus a stubbed
  service/API layer exposing the same interface the real backend would.
- Build the real UI with the repo's **actual components, styles, and design
  tokens** — only the data behind it is fake.
- Render it separately: a sandbox entry (story, standalone page, or harness)
  inside \`.beacon/prototype/\`. Never wire mocks into production entry points
  and never register real routes.
- List the backend work needed to make it real in
  \`.beacon/prototype/README.md\` — Beacon includes it in the PR so the
  reviewing developer knows exactly what to productionize.
${CLAUDE_END}`;
}

// Append (or refresh) the Beacon section in CLAUDE.md; create the file if the
// repo doesn't have one. Marker-delimited so re-running replaces, never stacks.
export function writeClaudeMd({ cwd, branch } = {}) {
  const root = repoRoot(cwd);
  const path = join(root, "CLAUDE.md");
  const section = claudeSection(branch);
  if (!existsSync(path)) {
    writeFileSync(path, `${section}\n`);
    return { path, created: true };
  }
  const cur = readFileSync(path, "utf8");
  const si = cur.indexOf(CLAUDE_START);
  const ei = cur.indexOf(CLAUDE_END);
  const next = si !== -1 && ei !== -1
    ? cur.slice(0, si) + section + cur.slice(ei + CLAUDE_END.length)
    : `${cur.replace(/\n*$/, "\n\n")}${section}\n`;
  writeFileSync(path, next);
  return { path, created: false };
}

// --- Claude Code PreToolUse guard (local install, alert-and-flag) -----------

// Where Beacon keeps its local, never-committed state: <git-dir>/beacon/
// (inside .git so `git add -A` can never sweep it into a commit).
function beaconDir(cwd) {
  const r = run("git", ["rev-parse", "--absolute-git-dir"], { cwd });
  const gitDir = r.code === 0 && r.stdout ? r.stdout : join(repoRoot(cwd), ".git");
  return join(gitDir, "beacon");
}

// Make sure a repo-local git exclude covers a path (kept out of commits without
// touching the repo's committed .gitignore).
function ensureExcluded(cwd, pattern) {
  const r = run("git", ["rev-parse", "--absolute-git-dir"], { cwd });
  if (r.code !== 0 || !r.stdout) return;
  const info = join(r.stdout, "info");
  mkdirSync(info, { recursive: true });
  const path = join(info, "exclude");
  const cur = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (cur.split("\n").includes(pattern)) return;
  writeFileSync(path, `${cur.replace(/\n*$/, "\n")}${pattern}\n`);
}

// Remove the pre-Beacon (Devsigner-era) commit-blocking pre-commit guard, if
// this repo still has one. Beacon flags — it never blocks — so the old hook
// would fight the new model. Restores any backed-up original hook.
function removeLegacyGuard(cwd) {
  const r = run("git", ["rev-parse", "--path-format=absolute", "--git-path", "hooks"], { cwd });
  if (r.code !== 0 || !r.stdout) return { removed: false };
  const dir = r.stdout;
  const pre = join(dir, "pre-commit");
  if (!existsSync(pre) || !readFileSync(pre, "utf8").includes("devsigner-editable-zone-guard")) return { removed: false };
  const backup = join(dir, "pre-commit.pre-graft");
  if (existsSync(backup)) {
    writeFileSync(pre, readFileSync(backup, "utf8"));
    rmSync(backup, { force: true });
  } else {
    rmSync(pre, { force: true });
  }
  rmSync(join(dir, "devsigner-zone-check.mjs"), { force: true });
  return { removed: true };
}

// Install the PreToolUse guard (idempotent):
//   <git-dir>/beacon/guard.mjs        the checker (flags.jsonl lands beside it)
//   .claude/settings.local.json      registers the hook for Claude Code
// The settings file is added to .git/info/exclude so it never rides along in a
// commit. Returns installed:false (with a reason) rather than throwing, so a
// hook problem never stops a branch from being created.
export function installGuard(cwd) {
  const root = repoRoot(cwd);
  const dir = beaconDir(cwd);
  mkdirSync(dir, { recursive: true });
  const guardPath = join(dir, "guard.mjs");
  const source = readFileSync(fileURLToPath(new URL("./beacon-guard.mjs", import.meta.url)), "utf8");
  writeFileSync(guardPath, source);

  // $CLAUDE_PROJECT_DIR keeps the registration portable while the git dir sits
  // at <root>/.git; a linked worktree gets the absolute path instead.
  const command = dir === join(root, ".git", "beacon")
    ? `node "$CLAUDE_PROJECT_DIR/.git/beacon/guard.mjs"`
    : `node "${guardPath}"`;

  const settingsPath = join(root, ".claude", "settings.local.json");
  let settings = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, "utf8")); }
    catch { return { installed: false, reason: ".claude/settings.local.json is not valid JSON — fix it and re-run start" }; }
  }
  settings.hooks = settings.hooks || {};
  settings.hooks.PreToolUse = settings.hooks.PreToolUse || [];
  const present = settings.hooks.PreToolUse.some((entry) =>
    (entry.hooks || []).some((h) => typeof h.command === "string" && h.command.includes("beacon/guard.mjs")));
  if (!present) {
    settings.hooks.PreToolUse.push({
      matcher: "Write|Edit|MultiEdit|NotebookEdit",
      hooks: [{ type: "command", command }],
    });
  }
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  ensureExcluded(cwd, ".claude/settings.local.json");
  return { installed: true, guardPath };
}

// Create the branch off the latest default branch, declare its scope
// (.beacon/scope.json + a CLAUDE.md section), commit both as the branch's
// FIRST commit — the declaration shows in the PR diff before any change does —
// then install the local Claude Code guard.
export function start({ cwd, name }) {
  if (!isRepo(cwd)) throw new Error("not a git repository");
  const slug = slugify(name);
  if (!slug) throw new Error(`could not derive a branch name from "${name}"`);
  if (workingTreeDirty(cwd)) throw new Error("working tree has uncommitted changes — commit or stash first");
  const def = defaultBranch(cwd);
  gitMust(cwd, "fetch", "origin", def);
  if (gitFor(cwd)("show-ref", "--verify", `refs/heads/${slug}`).code === 0) {
    throw new Error(`branch "${slug}" already exists`);
  }
  gitMust(cwd, "switch", "-c", slug, `origin/${def}`, "--no-track");

  // Clear any pre-Beacon commit-blocking hook BEFORE committing the scope —
  // it would otherwise reject the declaration commit itself.
  const legacy = removeLegacyGuard(cwd);

  writeScope({ cwd, branch: slug, task: String(name).trim() });
  const claude = writeClaudeMd({ cwd, branch: slug });

  gitMust(cwd, "add", "--", SCOPE_FILE, "CLAUDE.md");
  let committed = false;
  if (gitFor(cwd)("diff", "--cached", "--quiet").code !== 0) {
    gitMust(cwd, "commit", "-m", `Beacon: declare front-end scope for ${slug}`);
    committed = true;
  }

  const guard = installGuard(cwd);
  return {
    branch: slug,
    base: `origin/${def}`,
    scopePath: SCOPE_FILE,
    claudeMdCreated: claude.created,
    committed,
    guardInstalled: guard.installed,
    guardNote: guard.reason || null,
    legacyGuardRemoved: legacy.removed,
  };
}

// ---------------------------------------------------------------------------
// Public: review — flagged / out-of-scope changes on this branch, pre-PR
// ---------------------------------------------------------------------------

// Every event the guard logged for a branch, oldest first.
function readFlagEvents(cwd, branch) {
  const path = join(beaconDir(cwd), "flags.jsonl");
  const events = [];
  if (!existsSync(path)) return events;
  for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
    try {
      const f = JSON.parse(line);
      if (f.branch === branch && f.file) events.push({ ts: f.ts, file: f.file, tool: f.tool || "", reason: f.reason || "" });
    } catch { /* skip malformed lines */ }
  }
  return events;
}

// Newest flag per file (for annotating the flagged-file list).
function readFlags(cwd, branch) {
  const byFile = new Map();
  for (const f of readFlagEvents(cwd, branch)) byFile.set(f.file, { ts: f.ts, tool: f.tool, reason: f.reason });
  return byFile;
}

// Why a file is out of scope — same wording whether the guard saw the write
// or the diff scan found it.
function scopeReason(file, cfg) {
  const denied = cfg.deny.find((g) => globToRegex(g).test(file));
  if (denied) return `it matches the denied pattern "${denied}" — backend, auth, routing, DB, and infra are off-limits on this branch`;
  return "it doesn't match any allowed front-end pattern for this branch";
}

// Everything on this branch that sits outside the declared scope — the diff is
// the source of truth (it catches writes the hook never saw), enriched with
// the guard's flag log (when/how the agent drifted). Files that were flagged
// but no longer differ from base are resolved, so they don't appear.
export function review({ cwd, fetch: doFetch = false } = {}) {
  const s = status({ cwd, fetch: doFetch });
  const cfg = loadScope(cwd);
  const flags = readFlags(cwd, s.branch);
  const flagged = s.files
    .filter((f) => f.outOfScope)
    .map((f) => {
      const flag = flags.get(f.file) || null;
      return { ...f, flag, reason: (flag && flag.reason) || scopeReason(f.file, cfg) };
    });
  const prototype = s.files.filter((f) => f.prototype);
  // The guard's recent activity, newest first. An event whose file no longer
  // differs from base is resolved (reverted, or the agent self-corrected).
  const stillFlagged = new Set(flagged.map((f) => f.file));
  const events = readFlagEvents(cwd, s.branch).slice(-20).reverse()
    .map((e) => ({ ...e, resolved: !stillFlagged.has(e.file) }));
  return {
    branch: s.branch,
    defaultBranch: s.defaultBranch,
    totalChanges: s.files.length,
    inScope: s.files.length - flagged.length - prototype.length,
    flagged,
    prototype,
    protoNotes: readProtoNotes(cwd),
    events,
    files: s.files,
    stat: s.stat,
  };
}

// The prototype's "what the backend needs to provide" doc, if the agent wrote
// one — lifted into the PR description and shown in review.
function readProtoNotes(cwd) {
  const path = join(repoRoot(cwd), PROTO_NOTES);
  if (!existsSync(path)) return null;
  try {
    let lines = readFileSync(path, "utf8").split("\n").slice(0, 40);
    // Drop a leading title — the PR section supplies its own heading.
    while (lines.length && !lines[0].trim()) lines.shift();
    if (lines.length && /^#\s/.test(lines[0])) lines.shift();
    return lines.join("\n").trim() || null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Annotations (deterministic + optional LLM)
// ---------------------------------------------------------------------------

function titleFromBranch(branch) {
  return branch.replace(/^(feat|fix|chore|style)\//, "").replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function buildDeterministic({ branch, files, signal, protoNotes }) {
  const flagged = files.filter((f) => f.outOfScope);
  const proto = files.filter((f) => f.prototype);
  const inScope = files.filter((f) => !f.outOfScope && !f.prototype);

  const byArea = new Map();
  for (const f of files) {
    const area = f.file.split("/").slice(0, 2).join("/") || f.file;
    if (!byArea.has(area)) byArea.set(area, []);
    byArea.get(area).push(f);
  }
  const whatChanged = [...byArea.entries()]
    .map(([area, fs]) => `- **${area}**: ${fs.length} file${fs.length > 1 ? "s" : ""} (${fs.map((f) => f.status).join(", ")})`)
    .join("\n");

  const why = [];
  if (signal.components.length) why.push(`- Reuses existing components: ${signal.components.map((c) => `\`${c}\``).join(", ")}`);
  if (signal.tokens.length) why.push(`- Reuses design tokens / variables: ${signal.tokens.map((t) => `\`${t}\``).join(", ")}`);
  if (!why.length) why.push("- No reused components or design tokens were auto-detected. Reviewer should confirm styling follows existing patterns.");

  const flags = [];
  if (flagged.length) flags.push(`- **Flagged by Beacon — outside this branch's declared scope** (see \`.beacon/scope.json\`):\n${flagged.map((f) => `  - \`${f.file}\` (${f.status})`).join("\n")}`);
  if (signal.assumptions.length) flags.push(`- **Assumption markers found**:\n${signal.assumptions.map((a) => `  - \`${a}\``).join("\n")}`);
  const deletions = files.filter((f) => f.status === "deleted");
  if (deletions.length) flags.push(`- **${deletions.length} file(s) deleted** — confirm nothing depends on them.`);
  if (!flags.length) flags.push("- Nothing risky auto-detected. Standard review still recommended.");

  const protoSection = proto.length ? `

## Prototype (in front of the backend)

This branch ships a working prototype under \`.beacon/prototype/\` — the repo's
real components rendered on mock data, instead of touching the backend.

${proto.map((f) => `- \`${f.file}\` — ${f.status}`).join("\n")}

**Backend work needed to make it real:**

${protoNotes || "_(no `.beacon/prototype/README.md` found — ask the author what the mocks stand in for.)_"}` : "";

  const body = `## What changed

${whatChanged}

<details><summary>All changed files (${files.length})</summary>

${files.map((f) => `- \`${f.file}\` — ${f.status}${f.outOfScope ? "  ⚠️ out of scope" : f.prototype ? "  ◆ prototype" : ""}`).join("\n")}
</details>${protoSection}

## Why this approach

${why.join("\n")}

## Flag for review

${flags.join("\n")}

---
_Generated by Beacon. In-scope files: ${inScope.length} · prototype: ${proto.length} · flagged (out of scope): ${flagged.length}._`;

  return { title: titleFromBranch(branch), body, source: "deterministic" };
}

async function enrichWithLLM({ branch, files, signal, diff, protoNotes, anthropicKey, model }) {
  if (!anthropicKey) return null;
  const useModel = model || "claude-sonnet-5";
  const hasProto = files.some((f) => f.prototype);
  const prompt = `You are writing a GitHub PR description for a front-end change made with a guardrail tool called Beacon.
The branch declares an enforced front-end scope (.beacon/scope.json); anything outside it was flagged, not blocked.
Files under .beacon/prototype/ are a PROTOTYPE: the repo's real components rendered on mock data, standing in for
backend work that a developer still has to do. The audience is a developer who needs to review quickly and trust the change.

Branch: ${branch}
Changed files:
${files.map((f) => `- ${f.file} (${f.status})${f.outOfScope ? " [FLAGGED: OUT OF SCOPE]" : f.prototype ? " [PROTOTYPE]" : ""}`).join("\n")}
Auto-detected reused components: ${signal.components.join(", ") || "none"}
Auto-detected reused tokens/vars: ${signal.tokens.join(", ") || "none"}
Assumption markers: ${signal.assumptions.join(" | ") || "none"}
${hasProto ? `Backend work the prototype needs (from .beacon/prototype/README.md):\n${protoNotes || "(not documented)"}\n` : ""}
Unified diff (may be truncated):
\`\`\`diff
${diff.slice(0, 12000)}
\`\`\`

Return ONLY valid JSON: {"title":"...","body":"..."} where body is GitHub markdown with exactly these
sections: "## What changed" (plain language),${hasProto ? ` "## Prototype (in front of the backend)" (what the mocks stand in for and the backend work needed to make it real),` : ""} "## Why this approach" (name reused components/patterns/tokens),
and "## Flag for review" (risky or assumption-based items — lead with any out-of-scope flagged files). Be concise.`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: useModel, max_tokens: 1500, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data?.content?.[0]?.text ?? "";
    const json = JSON.parse(text.replace(/^```json\s*|\s*```$/g, ""));
    if (json.title && json.body) {
      return { title: json.title, body: `${json.body}\n\n---\n_Generated by Beacon (Claude ${useModel})._`, source: `claude:${useModel}` };
    }
  } catch {
    return null;
  }
  return null;
}

// Build the analysis + annotation without any side effects (used by the UI preview).
export async function plan({ cwd, anthropicKey, model } = {}) {
  const s = status({ cwd, fetch: true });
  const base = baseRef(cwd, s.defaultBranch);
  const diff = fullDiff(cwd, base);
  const protoNotes = readProtoNotes(cwd);
  const llm = await enrichWithLLM({ branch: s.branch, files: s.files, signal: s.signal, diff, protoNotes, anthropicKey, model });
  const annotation = llm || buildDeterministic({ branch: s.branch, files: s.files, signal: s.signal, protoNotes });
  return { ...s, annotation };
}

// ---------------------------------------------------------------------------
// Public: ship
// ---------------------------------------------------------------------------

function createPrViaGh({ cwd, title, body, base, head, token }) {
  const dir = mkdtempSync(join(tmpdir(), "beacon-"));
  const bodyFile = join(dir, "body.md");
  writeFileSync(bodyFile, body, "utf8");
  const env = token ? { GH_TOKEN: token } : undefined;
  const r = run("gh", ["pr", "create", "--title", title, "--body-file", bodyFile, "--base", base, "--head", head], { cwd, env });
  if (r.code !== 0) throw new Error(`gh pr create failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

async function createPrViaRest({ cwd, title, body, base, head, token }) {
  if (!token) throw new Error("no gh auth and no GitHub token — cannot open a PR");
  const or = ownerRepo(cwd);
  if (!or) throw new Error("could not parse owner/repo from origin remote");
  const res = await fetch(`https://api.github.com/repos/${or}/pulls`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "beacon-app",
    },
    body: JSON.stringify({ title, body, base, head }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`GitHub API PR create failed (${res.status}): ${data.message || JSON.stringify(data)}`);
  return data.html_url;
}

// dryRun: returns {branch, defaultBranch, files, annotation} with zero side effects.
// real:   stages, commits, pushes, opens PR. githubToken scopes the gh/REST call.
export async function ship({ cwd, dryRun = false, title, anthropicKey, model, githubToken, allowFlagged = false } = {}) {
  if (!isRepo(cwd)) throw new Error("not a git repository");
  const branch = currentBranch(cwd);
  const def = defaultBranch(cwd);
  if (!branch) throw new Error("detached HEAD — checkout a branch first");
  if (branch === def) throw new Error(`on ${def} — run start first; Beacon won't ship to the default branch`);

  const p = await plan({ cwd, anthropicKey, model });
  if (!p.files.length) throw new Error("no changes to ship on this branch");
  const finalTitle = title || p.annotation.title;
  const flagged = p.files.filter((f) => f.outOfScope).map((f) => f.file);

  if (dryRun) {
    // Preview never mutates; surface flagged files as a warning, don't throw.
    return { dryRun: true, branch, defaultBranch: def, files: p.files, flagged, annotation: { ...p.annotation, title: finalTitle } };
  }

  // The pre-PR gate: flagged changes must be looked at (and reverted or
  // explicitly accepted) before the PR opens. allowFlagged is the "create the
  // PR anyway" override — the files are still called out in the PR body.
  if (flagged.length && !allowFlagged) {
    throw new Error(
      `blocked: ${flagged.length} file(s) are outside this branch's declared scope. Review them (beacon review) or ship with them flagged:\n${flagged.map((f) => `  ${f}`).join("\n")}`
    );
  }

  // Stage + commit.
  gitMust(cwd, "add", "-A");
  let committed = false;
  if (gitFor(cwd)("diff", "--cached", "--quiet").code !== 0) {
    const msg = [finalTitle, "", ...p.files.map((f) => `- ${f.status}: ${f.file}`)].join("\n");
    const dir = mkdtempSync(join(tmpdir(), "beacon-"));
    const msgFile = join(dir, "msg.txt");
    writeFileSync(msgFile, msg, "utf8");
    gitMust(cwd, "commit", "-F", msgFile);
    committed = true;
  }

  // Push.
  gitMust(cwd, "push", "-u", "origin", branch);

  // Open PR (gh scoped to token, else REST).
  const useGh = ghReady(githubToken);
  const prUrl = useGh
    ? createPrViaGh({ cwd, title: finalTitle, body: p.annotation.body, base: def, head: branch, token: githubToken })
    : await createPrViaRest({ cwd, title: finalTitle, body: p.annotation.body, base: def, head: branch, token: githubToken });

  return { dryRun: false, branch, defaultBranch: def, committed, pushed: true, prUrl, annotation: { ...p.annotation, title: finalTitle }, via: useGh ? "gh" : "rest" };
}

// ---------------------------------------------------------------------------
// Save-your-work: commit + stash (exposed to the UI with plain-language help)
// ---------------------------------------------------------------------------

// Stage and commit ("Save" in the UI). Out-of-scope files are allowed but
// flagged: the UI passes allowFlagged so a designer can save freely (and the
// change shows in the save list); the flagged files surface in the branch view
// and the pre-PR review instead of blocking mid-task.
//
// Pass `files` to save just those files (the per-row Save button): only their
// uncommitted changes are committed — everything else stays exactly as it is,
// staged or not.
export function commit({ cwd, message, allowFlagged = false, files } = {}) {
  if (!isRepo(cwd)) throw new Error("not a git repository");

  let targets;          // the changes this commit will contain
  let pathspec = null;  // non-null = per-file save
  if (files && files.length) {
    const wanted = new Set(files);
    targets = workingChanges({ cwd }).files.filter((f) => wanted.has(f.file));
    if (!targets.length) throw new Error("no unsaved changes in the selected file(s)");
    pathspec = targets.map((f) => f.file);
  } else {
    targets = status({ cwd, fetch: false }).files;
    if (!targets.length) throw new Error("nothing to commit — no changes yet");
  }

  const flagged = targets.filter((f) => f.outOfScope).map((f) => f.file);
  if (flagged.length && !allowFlagged) {
    throw new Error(`can't commit — ${flagged.length} file(s) outside this branch's scope:\n${flagged.map((f) => `  ${f}`).join("\n")}`);
  }

  const fallback = pathspec && pathspec.length === 1 ? `Update ${pathspec[0].split("/").pop()}` : "Update";
  const finalMessage = (message && message.trim()) || fallback;
  const dir = mkdtempSync(join(tmpdir(), "beacon-"));
  const msgFile = join(dir, "msg.txt");
  writeFileSync(msgFile, finalMessage, "utf8");

  if (pathspec) {
    // Stage the chosen files (covers untracked adds and deletions), then commit
    // only that pathspec — other staged work is left untouched for a later save.
    gitMust(cwd, "add", "--", ...pathspec);
    gitMust(cwd, "commit", "-F", msgFile, "--", ...pathspec);
  } else {
    gitMust(cwd, "add", "-A");
    gitMust(cwd, "commit", "-F", msgFile);
  }
  return { committed: true, message: finalMessage, files: targets.length, flagged: flagged.length };
}

// Set current changes aside (including untracked) without committing.
export function stash({ cwd, message } = {}) {
  if (!isRepo(cwd)) throw new Error("not a git repository");
  const args = ["stash", "push", "-u"];
  if (message && message.trim()) args.push("-m", message.trim());
  const r = gitFor(cwd)(...args);
  if (r.code !== 0) throw new Error(r.stderr || r.stdout || "stash failed");
  const nothing = /no local changes/i.test(r.stdout);
  return { stashed: !nothing, note: r.stdout };
}

export function stashList({ cwd } = {}) {
  const r = gitFor(cwd)("stash", "list");
  return (r.stdout || "").split("\n").filter(Boolean);
}

// Bring back the most recently stashed changes.
export function stashPop({ cwd } = {}) {
  const r = gitFor(cwd)("stash", "pop");
  if (r.code !== 0) throw new Error(r.stderr || r.stdout || "nothing to restore");
  return { popped: true };
}

// Current uncommitted changes (staged + unstaged + untracked) — the working tree,
// independent of the base comparison. Used for the always-visible working-tree view.
// NOTE: porcelain output is parsed raw (no trim) — the two status columns can
// legitimately start with a space, and trimming would eat the first path's
// leading character. -uall lists files inside untracked directories.
export function workingChanges({ cwd } = {}) {
  if (!isRepo(cwd)) throw new Error("not a git repository");
  const cfg = loadScope(cwd);
  const res = spawnSync("git", ["status", "--porcelain", "-uall"], { encoding: "utf8", cwd });
  const files = (res.stdout || "").split("\n").filter(Boolean).map((line) => {
    const x = line.slice(0, 2);
    let file = line.slice(3);
    if (file.includes(" -> ")) file = file.split(" -> ")[1]; // renames
    file = file.replace(/^"|"$/g, "");
    let status = "modified";
    if (x === "??" || x.includes("A")) status = "added";
    else if (x.includes("D")) status = "deleted";
    else if (x.includes("R")) status = "renamed";
    const zone = fileZone(file, cfg);
    return { file, status, outOfScope: zone === "out", prototype: zone === "prototype" };
  });
  return { branch: currentBranch(cwd), files };
}

// Throw away all uncommitted changes (tracked reset + untracked removed). Destructive.
export function discard({ cwd } = {}) {
  if (!isRepo(cwd)) throw new Error("not a git repository");
  gitMust(cwd, "reset", "--hard", "HEAD");
  gitFor(cwd)("clean", "-fd");
  return { discarded: true };
}

// Revert out-of-scope changes on this branch — uncommitted AND already-committed
// — back to the base (default branch), leaving in-scope work untouched. Pass
// `files` to revert specific flagged files (the per-item revert in review);
// omit it to revert everything out of scope. Anything that was committed is
// undone with one new commit (no history rewrite, so it's safe on a pushed
// branch / open PR).
export function revertOutOfScope({ cwd, files } = {}) {
  if (!isRepo(cwd)) throw new Error("not a git repository");
  const root = repoRoot(cwd);
  const cfg = loadScope(cwd);
  const base = baseRef(cwd, defaultBranch(cwd));
  const g = gitFor(cwd);

  // Every path that differs from base: committed, staged, unstaged, or untracked.
  const paths = new Set();
  for (const range of [`${base}...HEAD`, "HEAD", "--cached"]) {
    for (const p of (g("diff", "--name-only", range).stdout || "").split("\n").filter(Boolean)) paths.add(p);
  }
  for (const p of untrackedFiles(cwd)) paths.add(p);
  let targets = [...paths].filter((f) => isOutOfScope(f, cfg));
  if (files && files.length) {
    const wanted = new Set(files);
    targets = targets.filter((f) => wanted.has(f));
  }
  if (!targets.length) return { reverted: 0, committed: false, files: [] };

  for (const f of targets) {
    if (g("cat-file", "-e", `${base}:${f}`).code === 0) {
      g("checkout", base, "--", f); // restore the base version (stages it)
    } else if (g("cat-file", "-e", `HEAD:${f}`).code === 0) {
      g("rm", "-f", "--", f); // added & committed on the branch → stage a deletion
    } else {
      try { rmSync(join(root, f), { force: true }); } catch { /* already gone */ }
      g("reset", "-q", "--", f); // untracked new file → just remove it, unstaged
    }
  }

  // If undoing committed changes staged anything, land it as one commit.
  let committed = false;
  if (g("diff", "--cached", "--quiet").code !== 0) {
    const msg = targets.length === 1
      ? `Beacon: revert out-of-scope change to ${targets[0]}`
      : "Beacon: revert out-of-scope changes";
    const dir = mkdtempSync(join(tmpdir(), "beacon-"));
    const msgFile = join(dir, "msg.txt");
    writeFileSync(msgFile, msg, "utf8");
    gitMust(cwd, "commit", "-F", msgFile);
    committed = true;
  }
  return { reverted: targets.length, committed, files: targets };
}

// Rename a stash entry. Git can't rename in place, so we re-store the same
// commit under the new message, then drop the original (content stays referenced
// the whole time). Renaming moves the entry to the top of the stash list.
export function stashRename({ cwd, index = 0, message } = {}) {
  if (!message || !message.trim()) throw new Error("a stash name is required");
  const sha = gitFor(cwd)("rev-parse", `stash@{${index}}`).stdout;
  if (!sha) throw new Error(`no stash at index ${index}`);
  // Drop the entry, then re-store the same commit under the new message. The
  // commit object survives the drop (dangling until GC), so content is safe.
  gitMust(cwd, "stash", "drop", `stash@{${index}}`);
  gitMust(cwd, "stash", "store", "-m", message.trim(), sha);
  return { renamed: true, message: message.trim() };
}

// Discard a stash entry without restoring it. Destructive — the entry is gone.
export function dropStash({ cwd, index = 0 } = {}) {
  if (!isRepo(cwd)) throw new Error("not a git repository");
  const r = gitFor(cwd)("stash", "drop", `stash@{${index}}`);
  if (r.code !== 0) throw new Error(r.stderr || r.stdout || "could not delete stash");
  return { dropped: index };
}

// Files inside a specific stash entry.
export function stashDetail({ cwd, index = 0 } = {}) {
  const r = gitFor(cwd)("stash", "show", "--name-status", `stash@{${index}}`);
  const files = (r.stdout || "").split("\n").filter(Boolean).map((line) => {
    const parts = line.split(/\t/);
    return { status: STATUS_WORDS[parts[0][0]] || "changed", file: parts[parts.length - 1] };
  });
  return { index, files };
}

// ---------------------------------------------------------------------------
// PR history (GitHub, via gh — scoped to a token when given)
// ---------------------------------------------------------------------------

export function listPullRequests({ cwd, token } = {}) {
  if (!isRepo(cwd) || !ownerRepo(cwd)) return { available: false, prs: [] };
  const env = token ? { GH_TOKEN: token } : undefined;
  const r = run("gh", ["pr", "list", "--state", "all", "--limit", "30",
    "--json", "number,title,state,headRefName,author,updatedAt,url,isDraft"], { cwd, env });
  if (r.code !== 0) return { available: false, error: r.stderr || r.stdout, prs: [] };
  try { return { available: true, prs: JSON.parse(r.stdout) }; }
  catch { return { available: true, prs: [] }; }
}

export function pullRequestDetail({ cwd, number, token } = {}) {
  const env = token ? { GH_TOKEN: token } : undefined;
  const r = run("gh", ["pr", "view", String(number),
    "--json", "number,title,state,headRefName,body,url,author,commits,files,createdAt,mergedAt"], { cwd, env });
  if (r.code !== 0) throw new Error(r.stderr || r.stdout);
  const d = JSON.parse(r.stdout);
  // Normalize commits to a light-graph-friendly shape (oldest → newest as gh returns).
  d.commits = (d.commits || []).map((c) => ({
    oid: (c.oid || "").slice(0, 7),
    message: c.messageHeadline || (c.messageBody || "").split("\n")[0] || "(no message)",
    author: (c.authors && c.authors[0] && (c.authors[0].name || c.authors[0].login)) || "",
    date: c.committedDate || c.authoredDate || null,
  }));
  d.files = (d.files || []).map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions }));
  return d;
}
