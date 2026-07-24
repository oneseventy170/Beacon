// Devsigner engine — pure logic, no console output, no process.exit.
// Every function takes an options object (always including `cwd`, the repo to
// operate on) and RETURNS structured data or throws an Error. Both the CLI and
// the Electron app consume this module.

import { existsSync, readFileSync, writeFileSync, mkdtempSync, chmodSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
// Editable-zone config
//
// The zone is an ALLOWLIST: a designer may edit files matching `editablePaths`
// (the front end — styles, components, pages, assets, tokens, …) and may create
// new files there. `restrictedPaths` is a denylist that ALWAYS WINS, so backend/
// auth/routing/DB/config stay protected even when they'd otherwise match the
// allowlist (e.g. a `routes/` folder full of .tsx). A file is editable iff it
// matches the allowlist AND not the denylist; everything else is restricted.
// ---------------------------------------------------------------------------

// The front end: what a designer can freely edit and add to.
export const DEFAULT_EDITABLE = [
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
  // repo root or nested. Backend configs stay restricted — their directory
  // (apps/web-server, …) wins on the denylist below.
  "*.config.js", "*.config.cjs", "*.config.mjs", "*.config.ts", "tsconfig*.json",
  "**/*.config.js", "**/*.config.cjs", "**/*.config.mjs", "**/*.config.ts", "**/tsconfig*.json",
];

// Never editable, even if matched above. Denylist wins.
export const DEFAULT_RESTRICTED = [
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

function loadConfig(cwd) {
  const root = gitMust(cwd, "rev-parse", "--show-toplevel");
  const path = join(root, ".devsignerrc.json");
  let editable = DEFAULT_EDITABLE;
  let restricted = DEFAULT_RESTRICTED;
  if (existsSync(path)) {
    try {
      const cfg = JSON.parse(readFileSync(path, "utf8"));
      if (Array.isArray(cfg.editablePaths)) editable = cfg.editablePaths;
      if (Array.isArray(cfg.restrictedPaths)) restricted = cfg.restrictedPaths;
      else if (Array.isArray(cfg.sensitivePaths)) restricted = cfg.sensitivePaths; // legacy alias
    } catch {
      /* malformed config — fall back to defaults */
    }
  }
  return { editablePaths: editable, restrictedPaths: restricted };
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

// Restricted = outside the editable zone. Devsigner's own config is always allowed.
function isRestricted(file, cfg) {
  if (file === ".devsignerrc.json") return false;
  return !(matchesAny(file, cfg.editablePaths) && !matchesAny(file, cfg.restrictedPaths));
}

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
  const root = gitMust(cwd, "rev-parse", "--show-toplevel");
  let out = "";
  for (const f of untrackedFiles(cwd)) {
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

  return [...merged.entries()].map(([file, code]) => ({
    file,
    status: STATUS_WORDS[code] || "changed",
    sensitive: isRestricted(file, cfg), // "sensitive" == outside the editable zone
  }));
}

function fullDiff(cwd, base) {
  const git = gitFor(cwd);
  const committed = git("diff", `${base}...HEAD`).stdout || "";
  const uncommitted = git("diff", "HEAD").stdout || "";
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
  const cfg = loadConfig(cwd);
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

// --- editable-zone setup (runs on `start`) ---------------------------------

const GUARD_MARK = "devsigner-editable-zone-guard";

// Write a .devsignerrc.json designating the editable zone, if one doesn't exist.
export function ensureZoneConfig(cwd) {
  const root = gitMust(cwd, "rev-parse", "--show-toplevel");
  const path = join(root, ".devsignerrc.json");
  if (existsSync(path)) return { created: false, path };
  const cfg = {
    _comment:
      "Devsigner editable zone. A designer may freely edit and create files matching editablePaths (the front end). restrictedPaths always wins (backend, auth, routing, DB, config). Commits touching restricted files are blocked by Devsigner's pre-commit hook. Tune these globs for your repo.",
    editablePaths: DEFAULT_EDITABLE,
    restrictedPaths: DEFAULT_RESTRICTED,
  };
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
  return { created: true, path };
}

function hooksDir(cwd) {
  const r = run("git", ["rev-parse", "--path-format=absolute", "--git-path", "hooks"], { cwd });
  if (r.code === 0 && r.stdout) return r.stdout;
  return join(gitMust(cwd, "rev-parse", "--git-dir"), "hooks"); // fallback
}

// The zone checker — a self-contained ESM script dropped in .git/hooks. It reads
// .devsignerrc.json (or the baked-in defaults) and blocks commits that stage files
// outside the editable zone. Kept dependency-free so it works wherever git runs.
function zoneCheckSource() {
  return `#!/usr/bin/env node
// ${GUARD_MARK} — managed by Devsigner. Blocks commits outside the editable zone.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).stdout.trim();
let editable = ${JSON.stringify(DEFAULT_EDITABLE)};
let restricted = ${JSON.stringify(DEFAULT_RESTRICTED)};
const cfgPath = join(root, ".devsignerrc.json");
if (existsSync(cfgPath)) {
  try {
    const c = JSON.parse(readFileSync(cfgPath, "utf8"));
    if (Array.isArray(c.editablePaths)) editable = c.editablePaths;
    if (Array.isArray(c.restrictedPaths)) restricted = c.restrictedPaths;
    else if (Array.isArray(c.sensitivePaths)) restricted = c.sensitivePaths;
  } catch {}
}
const g2r = (g) => new RegExp("^" + g.replace(/[.+^\${}()|[\\]\\\\]/g, "\\\\$&").replace(/\\*\\*/g, "\\0").replace(/\\*/g, "[^/]*").replace(/\\0/g, ".*") + "$");
const any = (f, gs) => gs.some((x) => g2r(x).test(f));
const restrictedFile = (f) => f !== ".devsignerrc.json" && !(any(f, editable) && !any(f, restricted));
const staged = spawnSync("git", ["diff", "--cached", "--name-only"], { encoding: "utf8" }).stdout.split("\\n").filter(Boolean);
const bad = staged.filter(restrictedFile);
if (bad.length) {
  process.stderr.write("\\n\\x1b[31m\\u2717 Devsigner: commit blocked \\u2014 these files are outside the editable zone (front end):\\x1b[0m\\n");
  for (const f of bad) process.stderr.write("    " + f + "\\n");
  process.stderr.write("\\nBackend, auth, routing, DB, and config are protected. A developer should make\\nthese changes. To adjust the zone, edit .devsignerrc.json.\\nTo bypass once (not recommended): git commit --no-verify\\n\\n");
  process.exit(1);
}
`;
}

function preCommitWrapper() {
  return `#!/bin/sh
# ${GUARD_MARK} — managed by Devsigner
HOOKDIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if ! command -v node >/dev/null 2>&1; then
  echo "graft: node not found on PATH; skipping editable-zone check" >&2
  exit 0
fi
exec node "$HOOKDIR/devsigner-zone-check.mjs"
`;
}

// Install the pre-commit guard (idempotent). Backs up a pre-existing, non-Devsigner
// pre-commit hook to pre-commit.pre-graft so we never silently clobber one.
export function installZoneGuard(cwd) {
  const dir = hooksDir(cwd);
  const pre = join(dir, "pre-commit");
  let backedUp = false;
  if (existsSync(pre)) {
    const cur = readFileSync(pre, "utf8");
    if (!cur.includes(GUARD_MARK)) {
      writeFileSync(join(dir, "pre-commit.pre-graft"), cur);
      backedUp = true;
    }
  }
  writeFileSync(join(dir, "devsigner-zone-check.mjs"), zoneCheckSource());
  chmodSync(join(dir, "devsigner-zone-check.mjs"), 0o755);
  writeFileSync(pre, preCommitWrapper());
  chmodSync(pre, 0o755);
  return { hooksDir: dir, backedUp };
}

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

  // Designate the editable zone and install the commit-time guard.
  const zone = ensureZoneConfig(cwd);
  const guard = installZoneGuard(cwd);
  return {
    branch: slug,
    base: `origin/${def}`,
    zoneCreated: zone.created,
    guardInstalled: true,
    hooksBackedUp: guard.backedUp,
  };
}

// ---------------------------------------------------------------------------
// Annotations (deterministic + optional LLM)
// ---------------------------------------------------------------------------

function titleFromBranch(branch) {
  return branch.replace(/^(feat|fix|chore|style)\//, "").replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function buildDeterministic({ branch, files, signal }) {
  const sensitive = files.filter((f) => f.sensitive);
  const editable = files.filter((f) => !f.sensitive);

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
  if (sensitive.length) flags.push(`- **Touches sensitive paths** (outside the designer editable zone):\n${sensitive.map((f) => `  - \`${f.file}\` (${f.status})`).join("\n")}`);
  if (signal.assumptions.length) flags.push(`- **Assumption markers found**:\n${signal.assumptions.map((a) => `  - \`${a}\``).join("\n")}`);
  const deletions = files.filter((f) => f.status === "deleted");
  if (deletions.length) flags.push(`- **${deletions.length} file(s) deleted** — confirm nothing depends on them.`);
  if (!flags.length) flags.push("- Nothing risky auto-detected. Standard review still recommended.");

  const body = `## What changed

${whatChanged}

<details><summary>All changed files (${files.length})</summary>

${files.map((f) => `- \`${f.file}\` — ${f.status}${f.sensitive ? "  ⚠️ sensitive" : ""}`).join("\n")}
</details>

## Why this approach

${why.join("\n")}

## Flag for review

${flags.join("\n")}

---
_Generated by Devsigner. Editable-zone files: ${editable.length} · sensitive files: ${sensitive.length}._`;

  return { title: titleFromBranch(branch), body, source: "deterministic" };
}

async function enrichWithLLM({ branch, files, signal, diff, anthropicKey, model }) {
  if (!anthropicKey) return null;
  const useModel = model || "claude-sonnet-5";
  const prompt = `You are writing a GitHub PR description for a change made by a designer using a tool called Devsigner.
The audience is a developer who needs to review quickly and trust the change.

Branch: ${branch}
Changed files:
${files.map((f) => `- ${f.file} (${f.status})${f.sensitive ? " [SENSITIVE]" : ""}`).join("\n")}
Auto-detected reused components: ${signal.components.join(", ") || "none"}
Auto-detected reused tokens/vars: ${signal.tokens.join(", ") || "none"}
Assumption markers: ${signal.assumptions.join(" | ") || "none"}

Unified diff (may be truncated):
\`\`\`diff
${diff.slice(0, 12000)}
\`\`\`

Return ONLY valid JSON: {"title":"...","body":"..."} where body is GitHub markdown with exactly these
sections: "## What changed" (plain language), "## Why this approach" (name reused components/patterns/tokens),
and "## Flag for review" (risky or assumption-based items, especially sensitive-path changes). Be concise.`;

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
      return { title: json.title, body: `${json.body}\n\n---\n_Generated by Devsigner (Claude ${useModel})._`, source: `claude:${useModel}` };
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
  const llm = await enrichWithLLM({ branch: s.branch, files: s.files, signal: s.signal, diff, anthropicKey, model });
  const annotation = llm || buildDeterministic({ branch: s.branch, files: s.files, signal: s.signal });
  return { ...s, annotation };
}

// ---------------------------------------------------------------------------
// Public: ship
// ---------------------------------------------------------------------------

function createPrViaGh({ cwd, title, body, base, head, token }) {
  const dir = mkdtempSync(join(tmpdir(), "devsigner-"));
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
      "user-agent": "devsigner-app",
    },
    body: JSON.stringify({ title, body, base, head }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`GitHub API PR create failed (${res.status}): ${data.message || JSON.stringify(data)}`);
  return data.html_url;
}

// dryRun: returns {branch, defaultBranch, files, annotation} with zero side effects.
// real:   stages, commits, pushes, opens PR. githubToken scopes the gh/REST call.
export async function ship({ cwd, dryRun = false, title, anthropicKey, model, githubToken, allowRestricted = false } = {}) {
  if (!isRepo(cwd)) throw new Error("not a git repository");
  const branch = currentBranch(cwd);
  const def = defaultBranch(cwd);
  if (!branch) throw new Error("detached HEAD — checkout a branch first");
  if (branch === def) throw new Error(`on ${def} — run start first; graft won't ship to the default branch`);

  const p = await plan({ cwd, anthropicKey, model });
  if (!p.files.length) throw new Error("no changes to ship on this branch");
  const finalTitle = title || p.annotation.title;
  const restricted = p.files.filter((f) => f.sensitive).map((f) => f.file);

  if (dryRun) {
    // Preview never mutates; surface restricted files as a warning, don't throw.
    return { dryRun: true, branch, defaultBranch: def, files: p.files, restricted, annotation: { ...p.annotation, title: finalTitle } };
  }

  // Enforce the editable zone before doing anything (the pre-commit hook is the
  // other line of defense; this gives a clean error even if the hook was bypassed).
  // allowRestricted is the explicit "create PR anyway" override from the UI. The
  // out-of-zone files are still flagged for the reviewer in the PR body.
  if (restricted.length && !allowRestricted) {
    throw new Error(
      `blocked: ${restricted.length} file(s) are outside the editable zone (front end). A developer should make these changes:\n${restricted.map((f) => `  ${f}`).join("\n")}`
    );
  }

  // Stage + commit. When overriding the zone, also skip the pre-commit guard hook
  // (it would otherwise reject the out-of-zone files).
  gitMust(cwd, "add", "-A");
  let committed = false;
  if (gitFor(cwd)("diff", "--cached", "--quiet").code !== 0) {
    const msg = [finalTitle, "", ...p.files.map((f) => `- ${f.status}: ${f.file}`)].join("\n");
    const dir = mkdtempSync(join(tmpdir(), "devsigner-"));
    const msgFile = join(dir, "msg.txt");
    writeFileSync(msgFile, msg, "utf8");
    const commitArgs = ["commit", "-F", msgFile];
    if (restricted.length && allowRestricted) commitArgs.push("--no-verify");
    gitMust(cwd, ...commitArgs);
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

// Stage everything and commit. Out-of-zone files are allowed but flagged: the UI
// passes allowRestricted so a designer can save freely (and the change shows in the
// save list); the out-of-zone files are surfaced in the branch view and PR instead
// of blocking. allowRestricted also skips the pre-commit guard hook.
export function commit({ cwd, message, allowRestricted = false }) {
  if (!isRepo(cwd)) throw new Error("not a git repository");
  const s = status({ cwd, fetch: false });
  if (!s.files.length) throw new Error("nothing to commit — no changes yet");
  const restricted = s.files.filter((f) => f.sensitive).map((f) => f.file);
  if (restricted.length && !allowRestricted) {
    throw new Error(`can't commit — ${restricted.length} file(s) outside the editable zone:\n${restricted.map((f) => `  ${f}`).join("\n")}`);
  }
  gitMust(cwd, "add", "-A");
  const dir = mkdtempSync(join(tmpdir(), "devsigner-"));
  const msgFile = join(dir, "msg.txt");
  writeFileSync(msgFile, (message && message.trim()) || "Update", "utf8");
  const args = ["commit", "-F", msgFile];
  if (restricted.length && allowRestricted) args.push("--no-verify");
  gitMust(cwd, ...args);
  return { committed: true, message: (message && message.trim()) || "Update", files: s.files.length, restricted: restricted.length };
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
export function workingChanges({ cwd } = {}) {
  if (!isRepo(cwd)) throw new Error("not a git repository");
  const cfg = loadConfig(cwd);
  const r = gitFor(cwd)("status", "--porcelain");
  const files = (r.stdout || "").split("\n").filter(Boolean).map((line) => {
    const x = line.slice(0, 2);
    let file = line.slice(3);
    if (file.includes(" -> ")) file = file.split(" -> ")[1]; // renames
    file = file.replace(/^"|"$/g, "");
    let status = "modified";
    if (x === "??" || x.includes("A")) status = "added";
    else if (x.includes("D")) status = "deleted";
    else if (x.includes("R")) status = "renamed";
    return { file, status, sensitive: isRestricted(file, cfg) };
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

// Revert ALL changes outside the editable zone on this branch — uncommitted AND
// already-committed — back to the base (default branch), leaving in-zone work
// untouched. Anything that was committed is undone with one new commit (no history
// rewrite, so it's safe on a pushed branch / open PR). The escape hatch to get a
// branch back to only touching the editable area.
export function revertRestricted({ cwd } = {}) {
  if (!isRepo(cwd)) throw new Error("not a git repository");
  const root = gitMust(cwd, "rev-parse", "--show-toplevel");
  const cfg = loadConfig(cwd);
  const base = baseRef(cwd, defaultBranch(cwd));
  const g = gitFor(cwd);

  // Every path that differs from base: committed, staged, unstaged, or untracked.
  const paths = new Set();
  for (const range of [`${base}...HEAD`, "HEAD", "--cached"]) {
    for (const p of (g("diff", "--name-only", range).stdout || "").split("\n").filter(Boolean)) paths.add(p);
  }
  for (const p of untrackedFiles(cwd)) paths.add(p);
  const restricted = [...paths].filter((f) => isRestricted(f, cfg));
  if (!restricted.length) return { reverted: 0, committed: false, files: [] };

  for (const f of restricted) {
    if (g("cat-file", "-e", `${base}:${f}`).code === 0) {
      g("checkout", base, "--", f); // restore the base version (stages it)
    } else if (g("cat-file", "-e", `HEAD:${f}`).code === 0) {
      g("rm", "-f", "--", f); // added & committed on the branch → stage a deletion
    } else {
      try { rmSync(join(root, f), { force: true }); } catch { /* already gone */ }
      g("reset", "-q", "--", f); // untracked new file → just remove it, unstaged
    }
  }

  // If undoing committed changes staged anything, land it as one commit. --no-verify
  // because the staged paths are (by definition) outside the zone the hook guards.
  let committed = false;
  if (g("diff", "--cached", "--quiet").code !== 0) {
    const dir = mkdtempSync(join(tmpdir(), "devsigner-"));
    const msgFile = join(dir, "msg.txt");
    writeFileSync(msgFile, "Revert changes outside the editable zone", "utf8");
    gitMust(cwd, "commit", "--no-verify", "-F", msgFile);
    committed = true;
  }
  return { reverted: restricted.length, committed, files: restricted };
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
