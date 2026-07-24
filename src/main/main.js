// Devsigner — Electron main process (ESM).
// Owns the engine and the OS-level capabilities (file dialog, shell). The
// renderer never touches Node directly; it calls these handlers over IPC.

import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as graft from "../engine/graft-core.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Name the app so the macOS menu bar reads "Devsigner" (not "Electron") in dev too.
// Must run before app is ready / any menu is built.
app.setName("Devsigner");

// A Finder-launched app inherits a minimal PATH (no Homebrew), so tools like
// `gh` (and a Homebrew `git`) wouldn't resolve. Add the usual install dirs so
// everything the engine shells out to is found whether launched from Finder or a shell.
{
  const extra = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", `${process.env.HOME}/.local/bin`];
  const parts = (process.env.PATH || "").split(":").filter(Boolean);
  for (const p of extra) if (!parts.includes(p)) parts.push(p);
  process.env.PATH = parts.join(":");
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#1b1a18",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(join(__dirname, "..", "renderer", "index.html"));
  return win;
}

// Resolve the gh token for a named account (empty = active account). This is
// how the UI pins PRs to a specific GitHub identity (e.g. oneseventy170).
function resolveAccount(account) {
  let token;
  if (account && account.trim()) {
    const r = spawnSync("gh", ["auth", "token", "--user", account.trim()], { encoding: "utf8" });
    if (r.status === 0) token = r.stdout.trim();
  }
  const identity = graft.ghIdentity(token); // whichever login the token maps to
  return { token, identity };
}

const onPath = (cmd) => spawnSync("which", [cmd], { encoding: "utf8" }).status === 0;

// Which AI coding agents are installed, so the UI only offers real ones.
function detectAgents() {
  return {
    cursor: existsSync("/Applications/Cursor.app") || onPath("cursor"),
    claude: onPath("claude"),
  };
}

// Open the repo folder in an AI coding agent.
function openIn({ app: which, cwd }) {
  if (/["']/.test(cwd)) throw new Error("repo path contains quotes; open it manually");
  if (which === "cursor") {
    if (existsSync("/Applications/Cursor.app")) spawn("open", ["-a", "Cursor", cwd], { detached: true, stdio: "ignore" }).unref();
    else spawn("cursor", [cwd], { detached: true, stdio: "ignore" }).unref();
    return { launched: "cursor" };
  }
  if (which === "claude") {
    // Open Terminal in the repo and start Claude Code.
    const osa = `tell application "Terminal"\n  do script "cd '${cwd}' && claude"\n  activate\nend tell`;
    spawn("osascript", ["-e", osa], { detached: true, stdio: "ignore" }).unref();
    return { launched: "claude" };
  }
  throw new Error(`unknown agent: ${which}`);
}

// Open the user's Terminal running `gh auth login` (browser flow). The sign-in
// happens entirely in gh / the browser — Devsigner never touches the credentials.
function ghTerminal(cmd) {
  const osa = `tell application "Terminal"\n  do script "${cmd}"\n  activate\nend tell`;
  spawn("osascript", ["-e", osa], { detached: true, stdio: "ignore" }).unref();
  return { launched: true };
}
function ghAuthLogin() { return ghTerminal("gh auth login --web --git-protocol https --hostname github.com"); }
function ghAuthSwitch() { return ghTerminal("gh auth switch"); }

// Wrap an engine call so the renderer always gets {ok, data|error}.
const handle = (channel, fn) =>
  ipcMain.handle(channel, async (_e, arg) => {
    try {
      return { ok: true, data: await fn(arg) };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

app.whenReady().then(() => {
  // Dev dock icon (packaged builds use the bundle icon from build config).
  if (process.platform === "darwin" && app.dock) {
    try { app.dock.setIcon(join(__dirname, "..", "..", "icons", "lighthouse-glass-512.png")); } catch { /* not present in packaged app */ }
  }

  handle("graft:pickFolder", async () => {
    const r = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return r.canceled ? null : r.filePaths[0];
  });

  handle("graft:context", (cwd) => graft.getContext(cwd));
  handle("graft:resolveAccount", (account) => resolveAccount(account));
  handle("graft:start", ({ cwd, name }) => graft.start({ cwd, name }));
  handle("graft:status", (cwd) => graft.status({ cwd }));

  handle("graft:plan", ({ cwd }) =>
    graft.plan({ cwd, anthropicKey: process.env.ANTHROPIC_API_KEY, model: process.env.DEVSIGNER_MODEL }));

  handle("graft:ship", ({ cwd, dryRun, title, account, allowRestricted }) => {
    const { token } = resolveAccount(account);
    return graft.ship({
      cwd,
      dryRun,
      title,
      allowRestricted,
      githubToken: token,
      anthropicKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.DEVSIGNER_MODEL,
    });
  });

  handle("graft:openExternal", (url) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return true;
  });

  handle("graft:detectAgents", () => detectAgents());
  handle("graft:ghStatus", () => graft.ghStatus());
  handle("graft:ghAuthLogin", () => ghAuthLogin());
  handle("graft:ghAuthSwitch", () => ghAuthSwitch());
  handle("graft:openIn", (arg) => openIn(arg));
  handle("graft:commit", ({ cwd, message, allowRestricted }) => graft.commit({ cwd, message, allowRestricted }));
  handle("graft:stash", ({ cwd, message }) => graft.stash({ cwd, message }));
  handle("graft:stashList", (cwd) => graft.stashList({ cwd }));
  handle("graft:stashPop", (cwd) => graft.stashPop({ cwd }));
  handle("graft:stashDetail", ({ cwd, index }) => graft.stashDetail({ cwd, index }));
  handle("graft:stashRename", ({ cwd, index, message }) => graft.stashRename({ cwd, index, message }));
  handle("graft:workingChanges", (cwd) => graft.workingChanges({ cwd }));
  handle("graft:discard", (cwd) => graft.discard({ cwd }));
  handle("graft:revertRestricted", (cwd) => graft.revertRestricted({ cwd }));
  handle("graft:listBranches", (cwd) => graft.listBranches({ cwd }));
  handle("graft:checkout", ({ cwd, branch }) => graft.checkout({ cwd, branch }));
  handle("graft:deleteBranch", ({ cwd, branch, force }) => graft.deleteBranch({ cwd, branch, force }));
  handle("graft:dropStash", ({ cwd, index }) => graft.dropStash({ cwd, index }));
  handle("graft:branchLog", (cwd) => graft.branchLog({ cwd }));
  handle("graft:fetchRemote", (cwd) => graft.fetchRemote({ cwd }));
  handle("graft:pull", (cwd) => graft.pull({ cwd }));
  handle("graft:remoteState", ({ cwd, fetch }) => graft.remoteState({ cwd, fetch }));

  handle("graft:listPRs", ({ cwd, account }) => {
    const { token } = resolveAccount(account);
    return graft.listPullRequests({ cwd, token });
  });
  handle("graft:prDetail", ({ cwd, number, account }) => {
    const { token } = resolveAccount(account);
    return graft.pullRequestDetail({ cwd, number, token });
  });

  // Standard macOS menu; the app menu (bold first item) uses app.name → "Devsigner".
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: "appMenu" },
        { role: "editMenu" },
        { role: "viewMenu" },
        { role: "windowMenu" },
      ]),
    );
  }

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
