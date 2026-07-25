// Preload (CommonJS, sandbox-safe). Exposes a minimal, explicit API to the
// renderer via contextBridge — no Node, no ipcRenderer leaked to the page.
const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel, arg) => ipcRenderer.invoke(channel, arg);

contextBridge.exposeInMainWorld("beacon", {
  pickFolder: () => invoke("beacon:pickFolder"),
  watch: (cwd) => invoke("beacon:watch", cwd),
  onChanged: (cb) => ipcRenderer.on("beacon:changed", () => cb()),
  context: (cwd) => invoke("beacon:context", cwd),
  resolveAccount: (account) => invoke("beacon:resolveAccount", account),
  start: (cwd, name) => invoke("beacon:start", { cwd, name }),
  status: (cwd) => invoke("beacon:status", cwd),
  review: (cwd) => invoke("beacon:review", cwd),
  plan: (cwd) => invoke("beacon:plan", { cwd }),
  ship: (opts) => invoke("beacon:ship", opts),
  openExternal: (url) => invoke("beacon:openExternal", url),
  detectAgents: () => invoke("beacon:detectAgents"),
  ghStatus: () => invoke("beacon:ghStatus"),
  ghAuthLogin: () => invoke("beacon:ghAuthLogin"),
  ghAuthSwitch: () => invoke("beacon:ghAuthSwitch"),
  openIn: (app, cwd) => invoke("beacon:openIn", { app, cwd }),
  commit: (cwd, message, allowFlagged, files) => invoke("beacon:commit", { cwd, message, allowFlagged, files }),
  stash: (cwd, message) => invoke("beacon:stash", { cwd, message }),
  stashList: (cwd) => invoke("beacon:stashList", cwd),
  stashPop: (cwd) => invoke("beacon:stashPop", cwd),
  stashDetail: (cwd, index) => invoke("beacon:stashDetail", { cwd, index }),
  stashRename: (cwd, index, message) => invoke("beacon:stashRename", { cwd, index, message }),
  workingChanges: (cwd) => invoke("beacon:workingChanges", cwd),
  discard: (cwd) => invoke("beacon:discard", cwd),
  revertOutOfScope: (cwd, files) => invoke("beacon:revertOutOfScope", { cwd, files }),
  listBranches: (cwd) => invoke("beacon:listBranches", cwd),
  checkout: (cwd, branch) => invoke("beacon:checkout", { cwd, branch }),
  deleteBranch: (cwd, branch, force) => invoke("beacon:deleteBranch", { cwd, branch, force }),
  dropStash: (cwd, index) => invoke("beacon:dropStash", { cwd, index }),
  branchLog: (cwd) => invoke("beacon:branchLog", cwd),
  fetchRemote: (cwd) => invoke("beacon:fetchRemote", cwd),
  pull: (cwd) => invoke("beacon:pull", cwd),
  remoteState: (cwd, fetch) => invoke("beacon:remoteState", { cwd, fetch }),
  listPRs: (cwd, account) => invoke("beacon:listPRs", { cwd, account }),
  prDetail: (cwd, number, account) => invoke("beacon:prDetail", { cwd, number, account }),
});
