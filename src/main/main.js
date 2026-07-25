// Beacon — Electron main process (ESM).
// Owns the engine and the OS-level capabilities (file dialog, shell). The
// renderer never touches Node directly; it calls these handlers over IPC.

import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { existsSync, watch } from "node:fs";
import * as beacon from "../engine/beacon-core.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Name the app so the macOS menu bar reads "Beacon" (not "Electron") in dev too.
// Must run before app is ready / any menu is built.
app.setName("Beacon");

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
  const identity = beacon.ghIdentity(token); // whichever login the token maps to
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
// happens entirely in gh / the browser — Beacon never touches the credentials.
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

// --- live repo watching -------------------------------------------------
// Watch the open repo so the UI updates AS the agent works — no commit, no
// manual refresh. Changes inside .git are ignored except the ones that mean
// something happened: a new guard flag, a commit, or a branch switch. Events
// are debounced into a single "beacon:changed" push to the renderer.
let repoWatcher = null;
let watchTimer = null;
function stopWatching() {
  clearTimeout(watchTimer);
  watchTimer = null;
  try { repoWatcher && repoWatcher.close(); } catch { /* already closed */ }
  repoWatcher = null;
}
function startWatching(sender, cwd) {
  stopWatching();
  if (!cwd) return { watching: false };
  repoWatcher = watch(cwd, { recursive: true }, (_event, filename) => {
    const f = String(filename || "").split("\\").join("/");
    if (!f || f.includes("node_modules/") || f.endsWith(".DS_Store")) return;
    if (f.startsWith(".git/")) {
      const meaningful = f.startsWith(".git/beacon/") || f === ".git/HEAD" || f.startsWith(".git/refs/");
      if (!meaningful) return;
    }
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => {
      if (!sender.isDestroyed()) sender.send("beacon:changed");
    }, 400);
  });
  return { watching: true };
}

app.whenReady().then(() => {
  // Dev dock icon (packaged builds use the bundle icon from build config).
  if (process.platform === "darwin" && app.dock) {
    try { app.dock.setIcon(join(__dirname, "..", "..", "icons", "lighthouse-glass-512.png")); } catch { /* not present in packaged app */ }
  }

  handle("beacon:pickFolder", async () => {
    const r = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle("beacon:watch", (e, cwd) => {
    try { return { ok: true, data: startWatching(e.sender, cwd) }; }
    catch (err) { return { ok: false, error: err?.message || String(err) }; }
  });

  handle("beacon:context", (cwd) => beacon.getContext(cwd));
  handle("beacon:resolveAccount", (account) => resolveAccount(account));
  handle("beacon:start", ({ cwd, name }) => beacon.start({ cwd, name }));
  handle("beacon:status", (cwd) => beacon.status({ cwd }));
  handle("beacon:review", (cwd) => beacon.review({ cwd }));

  handle("beacon:plan", ({ cwd }) =>
    beacon.plan({ cwd, anthropicKey: process.env.ANTHROPIC_API_KEY, model: process.env.BEACON_MODEL }));

  handle("beacon:ship", ({ cwd, dryRun, title, account, allowFlagged }) => {
    const { token } = resolveAccount(account);
    return beacon.ship({
      cwd,
      dryRun,
      title,
      allowFlagged,
      githubToken: token,
      anthropicKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.BEACON_MODEL,
    });
  });

  handle("beacon:openExternal", (url) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return true;
  });

  handle("beacon:detectAgents", () => detectAgents());
  handle("beacon:ghStatus", () => beacon.ghStatus());
  handle("beacon:ghAuthLogin", () => ghAuthLogin());
  handle("beacon:ghAuthSwitch", () => ghAuthSwitch());
  handle("beacon:openIn", (arg) => openIn(arg));
  handle("beacon:commit", ({ cwd, message, allowFlagged, files }) => beacon.commit({ cwd, message, allowFlagged, files }));
  handle("beacon:stash", ({ cwd, message }) => beacon.stash({ cwd, message }));
  handle("beacon:stashList", (cwd) => beacon.stashList({ cwd }));
  handle("beacon:stashPop", (cwd) => beacon.stashPop({ cwd }));
  handle("beacon:stashDetail", ({ cwd, index }) => beacon.stashDetail({ cwd, index }));
  handle("beacon:stashRename", ({ cwd, index, message }) => beacon.stashRename({ cwd, index, message }));
  handle("beacon:workingChanges", (cwd) => beacon.workingChanges({ cwd }));
  handle("beacon:discard", (cwd) => beacon.discard({ cwd }));
  handle("beacon:revertOutOfScope", ({ cwd, files }) => beacon.revertOutOfScope({ cwd, files }));
  handle("beacon:listBranches", (cwd) => beacon.listBranches({ cwd }));
  handle("beacon:checkout", ({ cwd, branch }) => beacon.checkout({ cwd, branch }));
  handle("beacon:deleteBranch", ({ cwd, branch, force }) => beacon.deleteBranch({ cwd, branch, force }));
  handle("beacon:dropStash", ({ cwd, index }) => beacon.dropStash({ cwd, index }));
  handle("beacon:branchLog", (cwd) => beacon.branchLog({ cwd }));
  handle("beacon:fetchRemote", (cwd) => beacon.fetchRemote({ cwd }));
  handle("beacon:pull", (cwd) => beacon.pull({ cwd }));
  handle("beacon:remoteState", ({ cwd, fetch }) => beacon.remoteState({ cwd, fetch }));

  handle("beacon:listPRs", ({ cwd, account }) => {
    const { token } = resolveAccount(account);
    return beacon.listPullRequests({ cwd, token });
  });
  handle("beacon:prDetail", ({ cwd, number, account }) => {
    const { token } = resolveAccount(account);
    return beacon.pullRequestDetail({ cwd, number, token });
  });

  // Standard macOS menu; the app menu (bold first item) uses app.name → "Beacon".
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
