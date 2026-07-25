# Beacon

A guardrail that keeps an AI coding agent inside the front-end/presentation
layer. When someone unfamiliar with the codebase — a designer, a PM — directs
an agent to build a UI change, nobody tells the agent what it *shouldn't*
touch: auth, routing, database schema, infra config. Beacon defines that
boundary automatically per branch and enforces it, instead of relying on the
agent to guess or the human to know.

Beacon is a local macOS desktop app plus a CLI. It has **no accounts and no
backend**: it drives your own `git`, the GitHub CLI (`gh`), and Claude Code's
hook system on your machine, and stores nothing of its own.

## How it works

1. **Start a branch** — describe the change in plain language; Beacon branches
   off the latest default branch and **declares the branch's scope** as its
   first commit:
   - `.beacon/scope.json` — the enforced rule: allowed path patterns
     (components, styles, views, front-end tests) and denied patterns
     (routes, auth, DB schema, API handlers, infra config).
   - a plain-language section in `CLAUDE.md` (created if missing) telling the
     agent to stop and flag any task that needs backend changes.

   Both are checked into git, so the scope declaration is visible in the PR
   diff before the reviewer looks at anything else.
2. **Edit** — open the repo in Claude Code or Cursor and direct the agent.
3. **Flag, don't block** — a Claude Code `PreToolUse` hook checks every file
   write against `scope.json` in real time. Out-of-scope writes are **allowed
   but flagged**: logged, surfaced in the session, and listed in the app — the
   guard never fights the agent mid-task. The flag also steers the agent to the
   prototype zone (below) when the UI genuinely needs backend behaviour.
4. **Review before the PR** — the branch view and the Create-PR preview show
   every flagged change with a one-click revert (per file, or all at once).
   Anything you keep ships explicitly flagged in the PR description.
5. **Create PR** — Beacon pushes and opens a pull request with a generated
   description: what changed, which components/tokens were reused, and the
   flagged files a developer should look at first.

The left rail has two tabs. **Branches** is where work happens: the working
tree, in-progress branches, and stashed changes, **updating live** — Beacon
watches the repo, so the agent's edits, new guard flags, commits, and branch
switches appear as they happen, with nothing to commit or refresh first.
**PRs** is where work goes after: in review → done / deleted. The branch view
reads like a status board: live in-scope / prototype / flagged counts, a
"what to look out for" section (flagged files with the guard's reason and
per-file revert, the prototype's backend punch list), the guard's activity
feed, and unsaved changes.

## CLI

The same engine drives a terminal workflow:

```bash
beacon start <name>      # branch + scope declaration (first commit) + guard
beacon status            # plain-language summary of changes vs default branch
beacon review            # flagged changes on this branch; revert each one
                         #   --revert <file> | --revert-all | --list
beacon ship [--dry-run]  # stage, commit, push, open an annotated PR
                         #   --title "..." | --allow-flagged
```

## Requirements

- macOS (Apple Silicon)
- `git`
- [GitHub CLI](https://cli.github.com) (`gh`) — for opening and reading pull requests
- [Claude Code](https://claude.com/claude-code) — for the real-time write guard
  (the scope declaration and review flow work without it)
- _(optional)_ `ANTHROPIC_API_KEY` for AI-written PR descriptions

## Develop

```bash
npm install
npm start        # run the app from source
```

## Build

```bash
npm run pack     # unpacked app  ->  dist/mac-arm64/Beacon.app
npm run dist     # installable   ->  dist/Beacon-<version>-arm64.dmg
```

The DMG is currently **unsigned** (`build.mac.identity: null`) — fine locally,
but a downloaded copy will trip Gatekeeper until it's signed and notarized with
an Apple Developer ID. See [Distribution](#distribution-signing).

## GitHub connection

Beacon uses the `gh` CLI for pull requests and never handles your credentials —
`gh` and the browser do the sign-in. Connect, switch accounts, or re-check from
the account chip at the top-right of the app.

## AI-assisted descriptions

PR descriptions are **deterministic by default** — Beacon parses the diff for
reused components, design tokens, and assumption markers. If `ANTHROPIC_API_KEY`
is set in the environment, the prose is written by Claude (`BEACON_MODEL`
overrides the model; default `claude-sonnet-5`). LLM failures fall back to the
deterministic text, so creating a PR is never blocked.

> A Finder-launched app doesn't inherit your shell environment, so the AI path
> only runs when the app is launched from a terminal that has `ANTHROPIC_API_KEY`
> set (e.g. `npm start`). The packaged app uses the deterministic description.

## The scope, in detail

`.beacon/scope.json` is an allowlist with a denylist that always wins: a file
is in scope iff it matches `allow` and not `deny`. The defaults cover styles,
components, pages/views, assets, tokens, and front-end build config; the
denylist protects auth, routing, APIs, servers, migrations/SQL, env files,
CI config, and lockfiles. Tune the globs per branch or per repo:

```json
{
  "branch": "update-pricing-page",
  "task": "update the pricing page",
  "allow": ["**/*.css", "**/components/**", "apps/web/**"],
  "deny": ["**/auth/**", "**/api/**", "**/*.sql"]
}
```

The scope is rewritten on every `beacon start`, so a `scope.json` inherited
from a merged branch never leaks onto a new one — and the guard checks the
declared `branch` name, so a stale file on `main` is inert.

## Prototype in front of the backend

Some UI work genuinely needs backend behaviour that doesn't exist yet. The
scope doesn't loosen for that — instead it names a third zone, `prototype`
(default `.beacon/prototype/**`), where the agent builds a **working prototype
in front of the backend**:

- fixture data plus a stubbed service/API layer with the same interface the
  real backend would expose;
- the real UI, built from the repo's **actual components, styles, and design
  tokens** — only the data behind it is fake;
- rendered separately via a sandbox entry (story, standalone page, or harness)
  inside the prototype zone — mocks never touch production entry points or
  real routes;
- the backend work needed to make it real, documented in
  `.beacon/prototype/README.md`.

The rule lives in the generated `CLAUDE.md` section, and the guard's flag
message redirects the agent there when it drifts toward real backend files.
Prototype files are tracked as their own category in `beacon status`,
`beacon review`, and the app, and the PR description gets a dedicated
"Prototype" section that lifts in the README's backend-needs list — so the
reviewing developer sees a running front end and an exact punch list to
productionize it.

## Enforcement, not just guidance

The `CLAUDE.md` section is soft guidance for the agent. The actual enforcement
is a `PreToolUse` hook installed locally (never committed): the checker lives
at `.git/beacon/guard.mjs` and is registered in `.claude/settings.local.json`
(kept out of commits via `.git/info/exclude`). It is **alert-and-flag, not a
hard block** — out-of-scope writes go through, get logged to
`.git/beacon/flags.jsonl`, and surface a warning in the Claude Code session.
`beacon review` (or the app) is where flags get resolved: revert the change,
or ship it explicitly flagged for the reviewing developer.

## Architecture

The engine in `src/engine` is UI-agnostic and drives both the CLI
(`bin/beacon.mjs`) and the Electron app (`src/main`, `src/renderer`). No
bundler and no framework — plain ES modules with a small, sandboxed preload
bridge; the renderer never touches Node directly. `beacon-guard.mjs` is the
canonical hook source, copied into each guarded repo.

## Distribution (signing)

For a public download, sign and notarize with an Apple Developer ID:

1. Set `build.mac.identity` in `package.json` to your Developer ID Application cert.
2. Provide notarization credentials via env — `APPLE_ID`,
   `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` — and electron-builder notarizes
   automatically.
3. `npm run dist`.

## License

MIT — see [LICENSE](LICENSE).
