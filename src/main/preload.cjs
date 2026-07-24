// Preload (CommonJS, sandbox-safe). Exposes a minimal, explicit API to the
// renderer via contextBridge — no Node, no ipcRenderer leaked to the page.
const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel, arg) => ipcRenderer.invoke(channel, arg);

contextBridge.exposeInMainWorld("graft", {
  pickFolder: () => invoke("graft:pickFolder"),
  context: (cwd) => invoke("graft:context", cwd),
  resolveAccount: (account) => invoke("graft:resolveAccount", account),
  start: (cwd, name) => invoke("graft:start", { cwd, name }),
  status: (cwd) => invoke("graft:status", cwd),
  plan: (cwd) => invoke("graft:plan", { cwd }),
  ship: (opts) => invoke("graft:ship", opts),
  openExternal: (url) => invoke("graft:openExternal", url),
  detectAgents: () => invoke("graft:detectAgents"),
  ghStatus: () => invoke("graft:ghStatus"),
  ghAuthLogin: () => invoke("graft:ghAuthLogin"),
  ghAuthSwitch: () => invoke("graft:ghAuthSwitch"),
  openIn: (app, cwd) => invoke("graft:openIn", { app, cwd }),
  commit: (cwd, message, allowRestricted) => invoke("graft:commit", { cwd, message, allowRestricted }),
  stash: (cwd, message) => invoke("graft:stash", { cwd, message }),
  stashList: (cwd) => invoke("graft:stashList", cwd),
  stashPop: (cwd) => invoke("graft:stashPop", cwd),
  stashDetail: (cwd, index) => invoke("graft:stashDetail", { cwd, index }),
  stashRename: (cwd, index, message) => invoke("graft:stashRename", { cwd, index, message }),
  workingChanges: (cwd) => invoke("graft:workingChanges", cwd),
  discard: (cwd) => invoke("graft:discard", cwd),
  revertRestricted: (cwd) => invoke("graft:revertRestricted", cwd),
  listBranches: (cwd) => invoke("graft:listBranches", cwd),
  checkout: (cwd, branch) => invoke("graft:checkout", { cwd, branch }),
  deleteBranch: (cwd, branch, force) => invoke("graft:deleteBranch", { cwd, branch, force }),
  dropStash: (cwd, index) => invoke("graft:dropStash", { cwd, index }),
  branchLog: (cwd) => invoke("graft:branchLog", cwd),
  fetchRemote: (cwd) => invoke("graft:fetchRemote", cwd),
  pull: (cwd) => invoke("graft:pull", cwd),
  remoteState: (cwd, fetch) => invoke("graft:remoteState", { cwd, fetch }),
  listPRs: (cwd, account) => invoke("graft:listPRs", { cwd, account }),
  prDetail: (cwd, number, account) => invoke("graft:prDetail", { cwd, number, account }),
});
