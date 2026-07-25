#!/usr/bin/env node
// Beacon PreToolUse guard — installed by `beacon start` into <git-dir>/beacon/
// and registered in .claude/settings.local.json. Claude Code pipes every
// Write/Edit/MultiEdit/NotebookEdit call through here before it runs.
//
// Behaviour: ALERT-AND-FLAG, NEVER BLOCK. In-scope writes pass silently.
// Out-of-scope writes are still allowed, but the file is logged to
// flags.jsonl (next to this script) and a warning is surfaced so the change
// can be reviewed — and reverted — before a PR goes out (`beacon review`).
//
// Dependency-free on purpose: it runs via `node` in whatever repo it guards.

import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

function main() {
  let call;
  try { call = JSON.parse(readFileSync(0, "utf8")); } catch { return; }

  const toolInput = call.tool_input || {};
  const target = toolInput.file_path || toolInput.notebook_path;
  if (!target) return;

  const cwd = call.cwd || process.cwd();
  const rootRes = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (rootRes.status !== 0) return;
  const root = rootRes.stdout.trim();

  // No scope declaration → not a Beacon-scoped branch; stay out of the way.
  const scopePath = join(root, ".beacon", "scope.json");
  if (!existsSync(scopePath)) return;
  let scope;
  try { scope = JSON.parse(readFileSync(scopePath, "utf8")); } catch { return; }
  const allow = Array.isArray(scope.allow) ? scope.allow : [];
  const deny = Array.isArray(scope.deny) ? scope.deny : [];
  const prototype = Array.isArray(scope.prototype) ? scope.prototype : [".beacon/prototype/**"];

  // The scope is per-branch. After a merge, scope.json can linger on main —
  // if the declared branch isn't the one checked out, the rule doesn't apply.
  const branch = (spawnSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8" }).stdout || "").trim();
  if (scope.branch && branch && scope.branch !== branch) return;

  const abs = isAbsolute(target) ? target : resolve(cwd, target);
  const file = relative(root, abs).split("\\").join("/");
  if (file.startsWith("..")) return;                              // outside this repo
  if (file === "CLAUDE.md" || file.startsWith(".beacon/")) return; // Beacon's own files

  const g2r = (g) => new RegExp("^" + g
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\0/g, ".*") + "$");
  const firstMatch = (globs) => globs.find((x) => g2r(x).test(file));

  if (firstMatch(prototype) !== undefined) return; // the mock zone — expected work
  const denied = firstMatch(deny);
  if (!denied && firstMatch(allow) !== undefined) return; // in scope — silent pass

  const reason = denied
    ? `it matches the denied pattern "${denied}" — backend, auth, routing, DB, and infra are off-limits on this branch`
    : "it doesn't match any allowed front-end pattern for this branch";

  // Where the agent should have gone instead: the first prototype glob, as a dir.
  const protoDir = (prototype[0] || ".beacon/prototype/**").replace(/\/?\*+$/, "/");

  try {
    appendFileSync(join(dirname(fileURLToPath(import.meta.url)), "flags.jsonl"),
      JSON.stringify({ ts: new Date().toISOString(), branch, file, tool: call.tool_name || "", reason }) + "\n");
  } catch { /* logging must never break the write */ }

  // No permissionDecision: the normal permission flow continues untouched.
  // systemMessage surfaces the flag to the HUMAN; additionalContext steers the
  // AGENT toward the prototype zone (ignored gracefully by older Claude Code).
  process.stdout.write(JSON.stringify({
    systemMessage: `⚠ Beacon: ${file} is outside this branch's front-end scope (${reason}). ` +
      `The write went through but was flagged — review it with \`beacon review\` (or the Beacon app) before opening a PR.`,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: `Beacon: ${file} is outside this branch's front-end scope (${reason}). ` +
        `Do not build backend/auth/routing/schema changes on this branch. If the UI needs backend behaviour, ` +
        `prototype in front of it instead: mock the data/service layer under ${protoDir} (same interface the real ` +
        `backend would expose), build the UI from the repo's real components and tokens, render it via a sandbox ` +
        `entry inside ${protoDir}, and document the needed backend work in ${protoDir}README.md.`,
    },
  }));
}

try { main(); } catch { /* a guard failure must never block the agent */ }
process.exit(0);
