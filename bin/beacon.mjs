#!/usr/bin/env node
// Beacon CLI — a thin formatter over src/engine/beacon-core.mjs.
import { createInterface } from "node:readline/promises";
import * as beacon from "../src/engine/beacon-core.mjs";

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};
const die = (m) => { console.error(`${C.red("✗ beacon:")} ${m}`); process.exit(1); };

const cwd = process.cwd();

function usage() {
  console.log(`${C.bold("beacon")} — keeps AI coding agents inside the front end

  ${C.bold("beacon start")} <name>         branch off the latest default branch, declare the
                               front-end scope (.beacon/scope.json + CLAUDE.md) as the
                               first commit, and install the flag-only Claude Code guard
  ${C.bold("beacon status")}               plain-language summary of changes vs default branch
  ${C.bold("beacon review")}               flagged (out-of-scope) changes on this branch, with
                               the option to revert each one before the PR
                               --revert <file> | --revert-all | --list
  ${C.bold("beacon ship")} [--dry-run]     stage, commit, push, open an annotated PR
                               --title "..."     override generated title
                               --allow-flagged   open the PR even with flagged changes`);
}

function printPrototype(r) {
  if (!r.prototype.length) return;
  console.log(`${C.cyan("◆")} Prototype in front of the backend — ${r.prototype.length} file${r.prototype.length > 1 ? "s" : ""} of real components on mock data:\n`);
  for (const f of r.prototype) console.log(`  ${C.cyan("◆")} ${f.file} ${C.dim(`— ${f.status}`)}`);
  if (r.protoNotes) console.log(`\n${C.bold("Backend work needed")} ${C.dim("(.beacon/prototype/README.md — included in the PR):")}\n${C.dim(r.protoNotes.split("\n").map((l) => "  " + l).join("\n"))}`);
  else console.log(`\n${C.yellow("·")} no .beacon/prototype/README.md yet — document the backend work the mocks stand in for.`);
  console.log("");
}

function printFlagged(r) {
  console.log(`\n${C.bold("Branch:")} ${r.branch}   ${C.dim(`(vs origin/${r.defaultBranch})`)}`);
  printPrototype(r);
  if (!r.flagged.length) {
    console.log(`${C.green("✓")} All ${r.totalChanges} change${r.totalChanges === 1 ? "" : "s"} on this branch are inside the declared scope${r.prototype.length ? " (or the prototype zone)" : ""}.\n`);
    return;
  }
  console.log(`${C.yellow("⚠")} ${r.flagged.length} of ${r.totalChanges} change${r.totalChanges === 1 ? "" : "s"} ${r.flagged.length === 1 ? "is" : "are"} outside this branch's scope:\n`);
  for (const f of r.flagged) {
    console.log(`  ${C.yellow("⚠")} ${C.bold(f.file)} ${C.dim(`— ${f.status}`)}`);
    if (f.flag) {
      const when = f.flag.ts ? new Date(f.flag.ts).toLocaleString() : "";
      console.log(`    ${C.dim(`flagged ${when}${f.flag.tool ? ` via ${f.flag.tool}` : ""}`)}`);
    }
    if (f.reason) console.log(`    ${C.dim(f.reason)}`);
  }
  console.log("");
}

function printRevert(res) {
  if (!res.reverted) { console.log(C.dim("Nothing reverted.")); return; }
  console.log(`${C.green("✓")} reverted ${res.reverted} out-of-scope change${res.reverted > 1 ? "s" : ""}${res.committed ? C.dim(" · undone with a new commit") : ""}`);
  for (const f of res.files) console.log(`  ${C.dim("·")} ${f}`);
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  if (!beacon.isRepo(cwd) && cmd !== "help" && cmd !== undefined) die("not inside a git repository");

  switch (cmd) {
    case "start": {
      const name = rest.join(" ").trim();
      if (!name) die("usage: beacon start <branch name>");
      const r = beacon.start({ cwd, name });
      console.log(`${C.green("✓")} on new branch ${C.bold(r.branch)} (from ${r.base}).`);
      console.log(`  ${C.dim(`· wrote ${r.scopePath} — the enforced front-end scope for this branch`)}`);
      console.log(`  ${C.dim(`· ${r.claudeMdCreated ? "created" : "updated"} CLAUDE.md — plain-language guidance for the agent`)}`);
      if (r.committed) console.log(`  ${C.dim("· committed both as the branch's first commit (visible in the PR diff)")}`);
      if (r.guardInstalled) console.log(`  ${C.dim("· installed the Claude Code guard — out-of-scope writes are flagged, never blocked")}`);
      else console.log(`  ${C.yellow(`· guard not installed: ${r.guardNote || "unknown reason"}`)}`);
      if (r.legacyGuardRemoved) console.log(`  ${C.yellow("· removed the old commit-blocking pre-commit guard (Beacon flags instead)")}`);
      break;
    }
    case "status": {
      const s = beacon.status({ cwd });
      console.log(`\n${C.bold("Branch:")} ${s.branch}   ${C.dim(`(vs origin/${s.defaultBranch})`)}`);
      console.log(`${C.bold("Diff:")}   ${s.stat || "no committed changes vs base"}\n`);
      if (!s.files.length) { console.log(C.dim("No changes yet.")); break; }
      console.log(C.bold(`Changed files (${s.files.length}):`));
      for (const f of s.files) {
        const mark = f.outOfScope ? C.yellow("⚠") : f.prototype ? C.cyan("◆") : C.green("●");
        const note = C.dim(`— ${f.status}${f.outOfScope ? " (out of scope)" : f.prototype ? " (prototype)" : ""}`);
        console.log(`  ${mark} ${f.file} ${note}`);
      }
      if (s.signal.components.length) console.log(`\n${C.bold("Reuses components:")} ${s.signal.components.join(", ")}`);
      if (s.signal.tokens.length) console.log(`${C.bold("Reuses tokens:")} ${s.signal.tokens.join(", ")}`);
      if (s.signal.assumptions.length) console.log(C.yellow(`${s.signal.assumptions.length} assumption marker(s)`));
      console.log("");
      break;
    }
    case "review": {
      const listOnly = rest.includes("--list");
      const revertAll = rest.includes("--revert-all");
      const ri = rest.indexOf("--revert");
      const one = ri >= 0 ? rest[ri + 1] : undefined;
      const r = beacon.review({ cwd });
      printFlagged(r);
      if (!r.flagged.length) break;

      if (one) {
        if (!r.flagged.some((f) => f.file === one)) die(`"${one}" isn't a flagged file on this branch`);
        printRevert(beacon.revertOutOfScope({ cwd, files: [one] }));
      } else if (revertAll) {
        printRevert(beacon.revertOutOfScope({ cwd, files: r.flagged.map((f) => f.file) }));
      } else if (!listOnly && process.stdin.isTTY) {
        // Walk the flags one by one — revert each, or keep it (it stays flagged
        // in the PR description if it ships).
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const chosen = [];
        for (const f of r.flagged) {
          const a = (await rl.question(`Revert ${C.bold(f.file)} back to origin/${r.defaultBranch}? ${C.dim("[y/N]")} `)).trim().toLowerCase();
          if (a === "y" || a === "yes") chosen.push(f.file);
        }
        rl.close();
        if (chosen.length) printRevert(beacon.revertOutOfScope({ cwd, files: chosen }));
        else console.log(C.dim("Nothing reverted — flagged files will be called out in the PR description."));
      } else {
        console.log(C.dim("Revert with: beacon review --revert <file>   or   beacon review --revert-all"));
      }
      break;
    }
    case "ship": {
      const dryRun = rest.includes("--dry-run");
      const allowFlagged = rest.includes("--allow-flagged");
      const ti = rest.indexOf("--title");
      const title = ti >= 0 ? rest[ti + 1] : undefined;
      const githubToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
      const r = await beacon.ship({ cwd, dryRun, title, allowFlagged, githubToken, anthropicKey: process.env.ANTHROPIC_API_KEY });
      if (dryRun) {
        console.log(`\n${C.bold("── DRY RUN ──")}  (${r.annotation.source})`);
        console.log(`${C.bold("Title:")} ${r.annotation.title}\n`);
        console.log(r.annotation.body);
        console.log(`\n${C.dim("(nothing committed, pushed, or opened.)")}`);
      } else {
        console.log(`${C.green("✓")} committed=${r.committed} pushed=${r.pushed}`);
        console.log(`${C.green("✓")} PR opened (${r.via}): ${r.prUrl}`);
      }
      break;
    }
    case "help": case "--help": case "-h": case undefined:
      usage(); break;
    default:
      die(`unknown command "${cmd}"`);
  }
}

main().catch((e) => die(e.message || String(e)));
