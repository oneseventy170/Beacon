// Beacon renderer — talks to the engine only through window.beacon (preload bridge).

const $ = (id) => document.getElementById(id);
const state = {
  cwd: null, ctx: null, agents: { cursor: false, claude: false },
  selected: null, // null = empty; else {type:'branch'|'pr'|'stash', ...}
  prs: [], prsAvailable: true, stashes: [], working: [], branches: [],
  gh: { installed: false, authed: false, login: null },
  sync: { behind: 0, ahead: 0, upstream: null },
  skipSync: false, // set when the user dismisses the "pull first" onboarding step
  query: "", searchOpen: false, // list filter
  tab: "branches", // left list: "branches" (live work) | "prs" (shipped + set aside)
  collapsed: new Set(["deleted", "stashes"]), // collapsed group keys (secondary groups start closed)
};
let ghPoll = null;
const isDirty = () => state.working.length > 0;

// --- helpers ----------------------------------------------------------------
function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.remove("hidden"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), 5000); }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

// --- icons (Phosphor, regular weight — inlined so nothing loads over the wire) ---
const ICONS = {
  "pull-request": `<path d="M104,64A32,32,0,1,0,64,95v66a32,32,0,1,0,16,0V95A32.06,32.06,0,0,0,104,64ZM56,64A16,16,0,1,1,72,80,16,16,0,0,1,56,64ZM88,192a16,16,0,1,1-16-16A16,16,0,0,1,88,192Zm120-31V110.63a23.85,23.85,0,0,0-7-17L163.31,56H192a8,8,0,0,0,0-16H144a8,8,0,0,0-8,8V96a8,8,0,0,0,16,0V67.31L189.66,105a8,8,0,0,1,2.34,5.66V161a32,32,0,1,0,16,0Zm-8,47a16,16,0,1,1,16-16A16,16,0,0,1,200,208Z"/>`,
  "merge": `<path d="M208,112a32.05,32.05,0,0,0-30.69,23l-42.21-6a8,8,0,0,1-4.95-2.71L94.43,84.55A32,32,0,1,0,72,87v82a32,32,0,1,0,16,0V101.63l30,35a24,24,0,0,0,14.83,8.14l44,6.28A32,32,0,1,0,208,112ZM64,56A16,16,0,1,1,80,72,16,16,0,0,1,64,56ZM96,200a16,16,0,1,1-16-16A16,16,0,0,1,96,200Zm112-40a16,16,0,1,1,16-16A16,16,0,0,1,208,160Z"/>`,
  "branch": `<path d="M232,64a32,32,0,1,0-40,31v17a8,8,0,0,1-8,8H96a23.84,23.84,0,0,0-8,1.38V95a32,32,0,1,0-16,0v66a32,32,0,1,0,16,0V144a8,8,0,0,1,8-8h88a24,24,0,0,0,24-24V95A32.06,32.06,0,0,0,232,64ZM64,64A16,16,0,1,1,80,80,16,16,0,0,1,64,64ZM96,192a16,16,0,1,1-16-16A16,16,0,0,1,96,192ZM200,80a16,16,0,1,1,16-16A16,16,0,0,1,200,80Z"/>`,
  "circle-dashed": `<path d="M96.26,37.05A8,8,0,0,1,102,27.29a104.11,104.11,0,0,1,52,0,8,8,0,0,1-2,15.75,8.15,8.15,0,0,1-2-.26,88.09,88.09,0,0,0-44,0A8,8,0,0,1,96.26,37.05ZM53.79,55.14a104.05,104.05,0,0,0-26,45,8,8,0,0,0,15.42,4.27,88,88,0,0,1,22-38.09A8,8,0,0,0,53.79,55.14ZM43.21,151.55a8,8,0,1,0-15.42,4.28,104.12,104.12,0,0,0,26,45,8,8,0,0,0,11.41-11.22A88.14,88.14,0,0,1,43.21,151.55ZM150,213.22a88,88,0,0,1-44,0,8,8,0,1,0-4,15.49,104.11,104.11,0,0,0,52,0,8,8,0,0,0-4-15.49ZM222.65,146a8,8,0,0,0-9.85,5.58,87.91,87.91,0,0,1-22,38.08,8,8,0,1,0,11.42,11.21,104,104,0,0,0,26-45A8,8,0,0,0,222.65,146Zm-9.86-41.54a8,8,0,0,0,15.42-4.28,104,104,0,0,0-26-45,8,8,0,1,0-11.41,11.22A88,88,0,0,1,212.79,104.45Z"/>`,
  "x-circle": `<path d="M165.66,101.66,139.31,128l26.35,26.34a8,8,0,0,1-11.32,11.32L128,139.31l-26.34,26.35a8,8,0,0,1-11.32-11.32L116.69,128,90.34,101.66a8,8,0,0,1,11.32-11.32L128,116.69l26.34-26.35a8,8,0,0,1,11.32,11.32ZM232,128A104,104,0,1,1,128,24,104.11,104.11,0,0,1,232,128Zm-16,0a88,88,0,1,0-88,88A88.1,88.1,0,0,0,216,128Z"/>`,
  "pencil": `<path d="M227.31,73.37,182.63,28.68a16,16,0,0,0-22.63,0L36.69,152A15.86,15.86,0,0,0,32,163.31V208a16,16,0,0,0,16,16H92.69A15.86,15.86,0,0,0,104,219.31L227.31,96a16,16,0,0,0,0-22.63ZM92.69,208H48V163.31l88-88L180.69,120ZM192,108.68,147.31,64l24-24L216,84.68Z"/>`,
  "refresh": `<path d="M224,48V96a8,8,0,0,1-8,8H168a8,8,0,0,1,0-16h28.69L182.06,73.37a79.56,79.56,0,0,0-56.13-23.43h-.45A79.52,79.52,0,0,0,69.59,72.71,8,8,0,0,1,58.41,61.27a96,96,0,0,1,135,.79L208,76.69V48a8,8,0,0,1,16,0ZM186.41,183.29a80,80,0,0,1-112.47-.66L59.31,168H88a8,8,0,0,0,0-16H40a8,8,0,0,0-8,8v48a8,8,0,0,0,16,0V179.31l14.63,14.63A95.43,95.43,0,0,0,130,222.06h.53a95.36,95.36,0,0,0,67.07-27.33,8,8,0,0,0-11.18-11.44Z"/>`,
  "caret-down": `<path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z"/>`,
  "plus": `<path d="M224,128a8,8,0,0,1-8,8H136v80a8,8,0,0,1-16,0V136H40a8,8,0,0,1,0-16h80V40a8,8,0,0,1,16,0v80h80A8,8,0,0,1,224,128Z"/>`,
  "external": `<path d="M224,104a8,8,0,0,1-16,0V59.32l-66.33,66.34a8,8,0,0,1-11.32-11.32L196.68,48H152a8,8,0,0,1,0-16h64a8,8,0,0,1,8,8Zm-40,24a8,8,0,0,0-8,8v72H48V80h72a8,8,0,0,0,0-16H48A16,16,0,0,0,32,80V208a16,16,0,0,0,16,16H176a16,16,0,0,0,16-16V136A8,8,0,0,0,184,128Z"/>`,
  "search": `<path d="M229.66,218.34l-50.07-50.06a88.11,88.11,0,1,0-11.31,11.31l50.06,50.07a8,8,0,0,0,11.32-11.32ZM40,112a72,72,0,1,1,72,72A72.08,72.08,0,0,1,40,112Z"/>`,
  "archive": `<path d="M224,48H32A16,16,0,0,0,16,64V88a16,16,0,0,0,16,16v88a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V104a16,16,0,0,0,16-16V64A16,16,0,0,0,224,48ZM208,192H48V104H208ZM224,88H32V64H224V88ZM96,136a8,8,0,0,1,8-8h48a8,8,0,0,1,0,16H104A8,8,0,0,1,96,136Z"/>`,
  "folder": `<path d="M216,72H131.31L104,44.69A15.86,15.86,0,0,0,92.69,40H40A16,16,0,0,0,24,56V200.62A15.4,15.4,0,0,0,39.38,216H216.89A15.13,15.13,0,0,0,232,200.89V88A16,16,0,0,0,216,72ZM40,56H92.69l16,16H40ZM216,200H40V88H216Z"/>`,
  "check": `<path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z"/>`,
  "trash": `<path d="M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm96,168H64V64H192ZM112,104v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Zm48,0v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Z"/>`,
  "caret-up-down": `<path d="M181.66,170.34a8,8,0,0,1,0,11.32l-48,48a8,8,0,0,1-11.32,0l-48-48a8,8,0,0,1,11.32-11.32L128,212.69l42.34-42.35A8,8,0,0,1,181.66,170.34Zm-96-84.68L128,43.31l42.34,42.35a8,8,0,0,0,11.32-11.32l-48-48a8,8,0,0,0-11.32,0l-48,48A8,8,0,0,0,85.66,85.66Z"/>`,
  "lighthouse": `<path d="M208,80a8,8,0,0,0-8,8v16H188.85L184,55.2A8,8,0,0,0,181.32,50L138.44,11.88l-.2-.17a16,16,0,0,0-20.48,0l-.2.17L74.68,50A8,8,0,0,0,72,55.2L67.15,104H56V88a8,8,0,0,0-16,0v24a8,8,0,0,0,8,8H65.54l-9.47,94.48A16,16,0,0,0,72,232H184a16,16,0,0,0,15.92-17.56L190.46,120H208a8,8,0,0,0,8-8V88A8,8,0,0,0,208,80ZM128,24l27,24H101ZM87.24,64h81.52l4,40H136V88a8,8,0,0,0-16,0v16H83.23ZM72,216l4-40H180l4,40Zm106.39-56H77.61l4-40h92.76Z"/>`,
  "fetch": `<path d="M248,128a87.34,87.34,0,0,1-17.6,52.81,8,8,0,1,1-12.8-9.62A71.34,71.34,0,0,0,232,128a72,72,0,0,0-144,0,8,8,0,0,1-16,0,88,88,0,0,1,3.29-23.88C74.2,104,73.1,104,72,104a48,48,0,0,0,0,96H96a8,8,0,0,1,0,16H72A64,64,0,1,1,81.29,88.68,88,88,0,0,1,248,128Zm-69.66,42.34L160,188.69V128a8,8,0,0,0-16,0v60.69l-18.34-18.35a8,8,0,0,0-11.32,11.32l32,32a8,8,0,0,0,11.32,0l32-32a8,8,0,0,0-11.32-11.32Z"/>`,
  "pull": `<path d="M205.66,149.66l-72,72a8,8,0,0,1-11.32,0l-72-72a8,8,0,0,1,11.32-11.32L120,196.69V40a8,8,0,0,1,16,0V196.69l58.34-58.35a8,8,0,0,1,11.32,11.32Z"/>`,
};
function icon(name, cls = "") { return `<svg class="ico ${cls}" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">${ICONS[name] || ""}</svg>`; }
// Scope card: the Beacon lighthouse + a title and body, with any related
// content (file lists, punch lists, actions) passed as `extra` so it renders
// INSIDE the card — one bordered unit, nothing floating between cards.
// cls "alert" turns the card red (act now); the default purple reads as FYI.
// tag adds a small uppercase chip after the title ("action needed", "history"…).
function zoneCallout(title, body, { cls = "", tag = null, extra = "" } = {}) {
  const chip = tag ? `<span class="zone-tag ${tag.cls || ""}">${esc(tag.text)}</span>` : "";
  return `<div class="zone-warn ${cls}"><div class="zone-head">${icon("lighthouse", "zone-ico")}<div><p class="zone-title">${title}${chip}</p><p class="zone-body">${body}</p></div></div>${extra}</div>`;
}
function busy(btn, on, label) { if (!btn) return; if (on) { btn._label = btn.innerHTML; btn.innerHTML = `<span class="spinner"></span> ${label || ""}`.trim(); btn.disabled = true; } else { btn.innerHTML = btn._label ?? btn.innerHTML; btn.disabled = false; } }
async function call(fn, ...args) { const res = await fn(...args); if (!res.ok) { toast(res.error); throw new Error(res.error); } return res.data; }
function ago(iso) { if (!iso) return ""; const d = (Date.now() - new Date(iso).getTime()) / 1000; if (d < 60) return "just now"; if (d < 3600) return `${Math.floor(d / 60)}m ago`; if (d < 86400) return `${Math.floor(d / 3600)}h ago`; if (d < 2592000) return `${Math.floor(d / 86400)}d ago`; return new Date(iso).toLocaleDateString(); }
function renderMarkdown(md) {
  const lines = esc(md || "").split("\n"); let html = "", inList = false;
  const cl = () => { if (inList) { html += "</ul>"; inList = false; } };
  const il = (s) => s.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/_([^_]+)_/g, "<em>$1</em>");
  for (const raw of lines) { const line = raw.trimEnd();
    if (/^#{1,3}\s+/.test(line)) { cl(); html += `<h2>${il(line.replace(/^#{1,3}\s+/, ""))}</h2>`; }
    else if (/^---\s*$/.test(line)) { cl(); html += "<hr />"; }
    else if (/^\s*[-*]\s+/.test(line)) { if (!inList) { html += "<ul>"; inList = true; } const ind = line.match(/^\s*/)[0].length; html += `<li${ind >= 2 ? ' style="margin-left:14px"' : ""}>${il(line.replace(/^\s*[-*]\s+/, ""))}</li>`; }
    else if (/<details>|<\/details>|<summary>/.test(line)) { cl(); html += line; }
    else if (line === "") { cl(); }
    else { cl(); html += `<p>${il(line)}</p>`; } }
  cl(); return html;
}

// Inline name/rename dialog (Electron blocks window.prompt). Resolves to the
// trimmed value, or null if cancelled.
function promptName({ title, initial = "", ok = "Save" }) {
  return new Promise((resolve) => {
    const overlay = $("modal"), input = $("modal-input");
    $("modal-title").textContent = title; $("modal-ok").textContent = ok;
    input.value = initial; overlay.classList.remove("hidden"); input.focus(); input.select();
    const finish = (v) => { overlay.classList.add("hidden"); cleanup(); resolve(v); };
    const onOk = () => { const v = input.value.trim(); if (!v) { input.focus(); return; } finish(v); };
    const onCancel = () => finish(null);
    const onKey = (e) => { if (e.key === "Enter") onOk(); else if (e.key === "Escape") onCancel(); };
    const onOverlay = (e) => { if (e.target === overlay) onCancel(); };
    function cleanup() { $("modal-ok").removeEventListener("click", onOk); $("modal-cancel").removeEventListener("click", onCancel); input.removeEventListener("keydown", onKey); overlay.removeEventListener("mousedown", onOverlay); }
    $("modal-ok").addEventListener("click", onOk); $("modal-cancel").addEventListener("click", onCancel);
    input.addEventListener("keydown", onKey); overlay.addEventListener("mousedown", onOverlay);
  });
}
// Stash with a required name. Returns true if it happened.
async function doStash() {
  const name = await promptName({ title: "Name this stash", ok: "Stash", initial: "" });
  if (name == null) return false;
  await call(window.beacon.stash, state.cwd, name);
  toast(`Stashed: ${name}`);
  return true;
}
// Turn a branch slug into a readable title: "stefan/update-hero" → "Update hero".
function prettyBranch(name) {
  return (name.split("/").pop() || name).replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// --- top nav (repo → branch, two linked dropdowns) --------------------------
function renderTopnav() {
  const c = state.ctx;
  const has = !!(c && c.isRepo);
  $("repo-name").textContent = has ? (c.ownerRepo || c.cwd.split("/").pop()) : "Open a repository…";
  const branchBtn = $("branch-btn");
  branchBtn.classList.toggle("hidden", !has);
  $("fetch-btn").disabled = !has;
  $("pull-btn").disabled = !has;
  if (has) {
    const onDefault = c.branch === c.defaultBranch;
    $("branch-name").textContent = onDefault ? "Working tree" : c.branch;
  }
}

// --- GitHub connection (onboarding) -----------------------------------------
async function loadGh() { try { state.gh = await call(window.beacon.ghStatus); } catch {} }
function renderGhChip() {
  const el = $("gh-status"); if (!el) return;
  const g = state.gh || {};
  if (!g.installed) {
    el.className = "gh-chip warn";
    el.innerHTML = `${icon("x-circle")}<span>GitHub CLI not found</span>`;
    el.title = "Install the GitHub CLI (gh) to open pull requests";
    el.onclick = () => window.beacon.openExternal("https://cli.github.com");
  } else if (!g.authed) {
    el.className = "gh-chip action";
    el.innerHTML = `${icon("pull-request")}<span>Connect GitHub</span>`;
    el.title = "Sign in to GitHub to open pull requests";
    el.onclick = connectGh;
  } else {
    el.className = "gh-chip ok";
    el.innerHTML = `${icon("check")}<span>${esc(g.login ? "@" + g.login : "GitHub")}</span>${icon("caret-up-down", "gh-caret")}`;
    el.title = `Connected to GitHub${g.login ? " as @" + g.login : ""}`;
    el.onclick = ghMenu;
  }
}
// Account menu on the connected chip — switch, add, or re-check.
function ghMenu() {
  const g = state.gh || {};
  openMenu($("gh-status"), [
    { header: true, label: g.login ? `Connected as @${g.login}` : "Connected to GitHub" },
    { icon: "caret-up-down", label: "Switch account", onClick: switchGhAccount },
    { icon: "pull-request", label: "Add another account", onClick: connectGh },
    { separator: true },
    { icon: "refresh", label: "Re-check", onClick: recheckGh },
  ]);
}
// `gh auth switch` in Terminal, then poll until the active login changes.
async function switchGhAccount() {
  const prev = state.gh && state.gh.login;
  try { await call(window.beacon.ghAuthSwitch); } catch { return; }
  toast("Pick an account in the Terminal window — it'll update here.");
  const el = $("gh-status");
  if (el) { el.className = "gh-chip action"; el.innerHTML = `<span class="spinner"></span><span>Switching…</span>`; el.onclick = () => recheckGh(); }
  clearInterval(ghPoll);
  let tries = 0;
  ghPoll = setInterval(async () => {
    tries++;
    await loadGh();
    if (state.gh.login && state.gh.login !== prev) { clearInterval(ghPoll); ghPoll = null; onGhConnected(); }
    else if (tries >= 40) { clearInterval(ghPoll); ghPoll = null; renderGhChip(); }
  }, 3000);
}
// Launch `gh auth login` in Terminal, then poll until the user finishes.
async function connectGh() {
  if (state.gh && !state.gh.installed) { window.beacon.openExternal("https://cli.github.com"); return; }
  try { await call(window.beacon.ghAuthLogin); } catch { return; }
  toast("Complete GitHub sign-in in the Terminal window that opened.");
  const el = $("gh-status");
  if (el) { el.className = "gh-chip action"; el.innerHTML = `<span class="spinner"></span><span>Waiting for sign-in…</span>`; el.onclick = () => recheckGh(); }
  clearInterval(ghPoll);
  let tries = 0;
  ghPoll = setInterval(async () => {
    tries++;
    await loadGh();
    if (state.gh.authed) { clearInterval(ghPoll); ghPoll = null; onGhConnected(); }
    else if (tries >= 40) { clearInterval(ghPoll); ghPoll = null; renderGhChip(); } // give up after ~2 min
  }, 3000);
}
async function recheckGh() { clearInterval(ghPoll); ghPoll = null; await loadGh(); if (state.gh.authed) onGhConnected(); else renderGhChip(); }
async function onGhConnected() {
  renderGhChip();
  toast(`Connected to GitHub${state.gh.login ? ` as @${state.gh.login}` : ""}`);
  if (state.cwd) { await loadPRs().catch(() => {}); renderList(); }
  // Advance the onboarding funnel (Connect GitHub → Select repository) if we're
  // sitting on the default pane.
  if (state.selected === null) showEmpty();
}

// --- popover menu (used by the nav dropdowns) -------------------------------
function closeMenu() {
  if (!closeMenu._el) return;
  closeMenu._el.remove(); closeMenu._el = null; closeMenu._anchor = null;
  document.removeEventListener("mousedown", closeMenu._down, true);
  document.removeEventListener("keydown", closeMenu._key, true);
}
closeMenu._down = (e) => { const a = closeMenu._anchor; if (closeMenu._el && !closeMenu._el.contains(e.target) && (!a || !a.contains(e.target))) closeMenu(); };
closeMenu._key = (e) => { if (e.key === "Escape") closeMenu(); };
function openMenu(anchor, items) {
  if (closeMenu._anchor === anchor) { closeMenu(); return; } // toggle off
  closeMenu();
  const menu = document.createElement("div");
  menu.className = "menu";
  menu.innerHTML = items.map((it, i) => {
    if (it.separator) return `<div class="menu-sep"></div>`;
    if (it.header) return `<div class="menu-header">${esc(it.label)}</div>`;
    return `<button class="menu-item ${it.checked ? "checked" : ""}" data-i="${i}">
      <span class="menu-ico">${it.icon ? icon(it.icon) : ""}</span>
      <span class="menu-label">${esc(it.label)}</span>
      ${it.checked ? icon("check", "menu-check") : ""}</button>`;
  }).join("");
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${Math.round(r.bottom + 5)}px`;
  menu.style.minWidth = `${Math.round(Math.max(200, r.width))}px`;
  // Keep the menu inside the viewport (anchors near the right edge would overflow).
  const mw = menu.offsetWidth || 200;
  let left = r.left;
  if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
  menu.style.left = `${Math.round(Math.max(8, left))}px`;
  menu.querySelectorAll(".menu-item").forEach((b) => b.addEventListener("click", () => {
    const it = items[Number(b.dataset.i)]; closeMenu(); it.onClick && it.onClick();
  }));
  closeMenu._el = menu; closeMenu._anchor = anchor;
  setTimeout(() => { document.addEventListener("mousedown", closeMenu._down, true); document.addEventListener("keydown", closeMenu._key, true); }, 0);
}
// Coordinate-anchored menu (for right-click). Reuses .menu styling + closeMenu
// machinery; positioned at the cursor and kept inside the viewport.
function openMenuAt(x, y, items) {
  closeMenu();
  const menu = document.createElement("div");
  menu.className = "menu";
  menu.innerHTML = items.map((it, i) =>
    `<button class="menu-item ${it.danger ? "danger" : ""}" data-i="${i}">
      <span class="menu-ico">${it.icon ? icon(it.icon) : ""}</span>
      <span class="menu-label">${esc(it.label)}</span></button>`).join("");
  document.body.appendChild(menu);
  const mw = menu.offsetWidth || 200, mh = menu.offsetHeight || 40;
  let left = x, top = y;
  if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
  if (top + mh > window.innerHeight - 8) top = window.innerHeight - mh - 8;
  menu.style.left = `${Math.round(Math.max(8, left))}px`;
  menu.style.top = `${Math.round(Math.max(8, top))}px`;
  menu.querySelectorAll(".menu-item").forEach((b) => b.addEventListener("click", () => {
    const it = items[Number(b.dataset.i)]; closeMenu(); it.onClick && it.onClick();
  }));
  closeMenu._el = menu; closeMenu._anchor = null;
  setTimeout(() => { document.addEventListener("mousedown", closeMenu._down, true); document.addEventListener("keydown", closeMenu._key, true); }, 0);
}

// Right-click a branch or stash row → delete it (with confirmation).
function rowContextMenu(e) {
  const li = e.target.closest && e.target.closest(".row-item");
  if (!li) return;
  const { type, id } = li.dataset;
  let items = null;
  if (type === "branch") {
    const b = state.branches.find((x) => x.name === id);
    if (!b || b.current || b.isDefault) return; // never the current or default branch
    items = [{ label: "Delete branch", icon: "trash", danger: true, onClick: () => confirmDeleteBranch(id) }];
  } else if (type === "stash") {
    items = [{ label: "Delete stash", icon: "trash", danger: true, onClick: () => confirmDropStash(Number(id)) }];
  }
  if (!items) return;
  e.preventDefault();
  openMenuAt(e.clientX, e.clientY, items);
}

// A yes/no confirmation, reusing the modal overlay with its text input hidden.
function confirmDialog({ title, ok = "Delete" }) {
  return new Promise((resolve) => {
    const overlay = $("modal"), input = $("modal-input"), okBtn = $("modal-ok");
    $("modal-title").textContent = title; okBtn.textContent = ok;
    input.classList.add("hidden"); okBtn.classList.add("danger-btn");
    overlay.classList.remove("hidden"); okBtn.focus();
    const finish = (v) => { overlay.classList.add("hidden"); input.classList.remove("hidden"); okBtn.classList.remove("danger-btn"); cleanup(); resolve(v); };
    const onOk = () => finish(true), onCancel = () => finish(false);
    const onKey = (e) => { if (e.key === "Enter") onOk(); else if (e.key === "Escape") onCancel(); };
    const onOverlay = (e) => { if (e.target === overlay) onCancel(); };
    function cleanup() { okBtn.removeEventListener("click", onOk); $("modal-cancel").removeEventListener("click", onCancel); document.removeEventListener("keydown", onKey); overlay.removeEventListener("mousedown", onOverlay); }
    okBtn.addEventListener("click", onOk); $("modal-cancel").addEventListener("click", onCancel);
    document.addEventListener("keydown", onKey); overlay.addEventListener("mousedown", onOverlay);
  });
}

async function confirmDeleteBranch(name) {
  const pretty = prettyBranch(name);
  if (!(await confirmDialog({ title: `Delete branch “${pretty}”?` }))) return;
  // Safe delete first; if git reports unmerged commits, confirm again to force.
  let res = await window.beacon.deleteBranch(state.cwd, name, false);
  if (!res.ok && /unmerged/i.test(res.error || "")) {
    if (!(await confirmDialog({ title: `“${pretty}” has commits not merged anywhere. Delete anyway?`, ok: "Delete anyway" }))) return;
    res = await window.beacon.deleteBranch(state.cwd, name, true);
  }
  if (!res.ok) { toast(res.error); return; }
  toast(`Deleted “${pretty}”`);
  await reloadRepoState(); goHome();
}

async function confirmDropStash(index) {
  if (!(await confirmDialog({ title: "Delete this stash? This can’t be undone." }))) return;
  try { await call(window.beacon.dropStash, state.cwd, index); toast("Stash deleted"); await reloadRepoState(); goHome(); } catch {}
}

// The repo button opens the OS folder picker directly (no menu — there was only
// ever one option).
async function openRepo() { const dir = await call(window.beacon.pickFolder); if (dir) await loadContext(dir); }
function branchMenu() {
  if (!(state.ctx && state.ctx.isRepo)) return;
  const def = state.ctx.defaultBranch, cur = state.ctx.branch;
  const items = state.branches.map((b) => ({
    icon: "branch",
    label: b.isDefault ? `Working tree (${b.name})` : b.name,
    checked: b.name === cur,
    onClick: () => switchBranch(b.name),
  }));
  items.push({ separator: true });
  items.push({ icon: "plus", label: "New branch…", onClick: startNewChange });
  openMenu($("branch-btn"), items);
}

// --- activity list ----------------------------------------------------------
function rowHTML({ cls, type, id, iconName, col, title, sub, tag }) {
  const s = state.selected;
  const sel = s && s.type === type && (id === undefined || s.index === id || s.number === id || s.branch === id) ? "active" : "";
  return `<li class="row-item ${cls} ${sel}" data-type="${type}" ${id !== undefined ? `data-id="${esc(String(id))}"` : ""}>
    <span class="row-ico" ${col ? `style="color:${col}"` : ""}>${icon(iconName)}</span>
    <span class="row-main"><span class="row-title">${esc(title)}${tag ? `<span class="row-tag">${esc(tag)}</span>` : ""}</span><span class="row-sub">${esc(sub)}</span></span></li>`;
}
function prRow(p) {
  const s = p.state;
  return rowHTML({
    cls: "pr", type: "pr", id: p.number,
    iconName: s === "MERGED" ? "merge" : s === "CLOSED" ? "x-circle" : p.isDraft ? "circle-dashed" : "pull-request",
    col: s === "MERGED" ? "var(--purple)" : s === "CLOSED" ? "var(--red)" : p.isDraft ? "var(--mute)" : "var(--green)",
    title: p.title,
    sub: `#${p.number} · ${p.headRefName}${p.isDraft ? " · draft" : ""} · ${ago(p.updatedAt)}`,
  });
}
// A collapsible Linear-style group: a full-width band (a "break" in the list),
// a status dot, a name and a count, then its rows.
function section(key, label, count, color, bodyHTML) {
  const collapsed = state.collapsed.has(key);
  const head = `<li class="group-head ${collapsed ? "collapsed" : ""}" data-group="${key}">${icon("caret-down", "group-chev")}<span class="group-dot" style="background:${color}"></span><span class="group-name">${label}</span><span class="group-count">${count}</span></li>`;
  return head + (collapsed ? "" : bodyHTML);
}
// Two tabs, designer-legible: BRANCHES is where work happens (working tree +
// in-progress branches + stashed changes, live-updating); PRS is where work
// goes after (in review → done / deleted).
function renderList() {
  const ul = $("rows");
  if (!state.ctx || !state.ctx.isRepo) { ul.innerHTML = `<li class="list-empty">Open a repository to see its activity.</li>`; return; }
  const q = (state.query || "").trim().toLowerCase();
  const m = (s) => !q || String(s).toLowerCase().includes(q);
  const prMatch = (p) => m(p.title) || m(p.headRefName) || m("#" + p.number);
  const prs = state.prsAvailable ? state.prs : [];
  // A branch is "shipped" once it has an open or merged PR — then it shows up as
  // that PR, not as a separate in-progress branch.
  const shipped = new Set(prs.filter((p) => p.state !== "CLOSED").map((p) => p.headRefName));
  const open = prs.filter((p) => p.state === "OPEN" && prMatch(p));
  const merged = prs.filter((p) => p.state === "MERGED" && prMatch(p));
  const closed = prs.filter((p) => p.state === "CLOSED" && prMatch(p));
  const inProgress = state.branches.filter((b) => !b.isDefault && !shipped.has(b.name) && (m(b.name) || m(prettyBranch(b.name))));
  const stashes = state.stashes.filter((s) => m(s.label));
  const showWorking = isDirty() && m(`working tree uncommitted changes ${state.ctx.branch}`);

  // When searching, drop groups that have no matches; otherwise keep them (with
  // their empty-state placeholder) so the list structure stays stable.
  const sect = (key, label, color, items, rowFn, emptyText) => {
    if (q && !items.length) return "";
    return section(key, label, items.length, color, items.length ? items.map(rowFn).join("") : `<li class="list-empty sub">${emptyText}</li>`);
  };

  let html = "";
  if (state.tab === "branches") {
    // Pinned Working tree row — uncommitted changes are always reachable here.
    if (showWorking) {
      html += rowHTML({ cls: "working", type: "working", iconName: "pencil", col: "var(--amber)",
        title: "Working tree", sub: `${state.working.length} uncommitted change${state.working.length > 1 ? "s" : ""} · on ${state.ctx.branch}` });
    }
    html += sect("inprogress", "In progress", "var(--blue)", inProgress,
      (b) => rowHTML({ cls: "branch", type: "branch", id: b.name, iconName: "branch", col: "var(--blue)",
        title: prettyBranch(b.name), sub: `${b.name}${b.date ? ` · ${ago(b.date)}` : ""}`, tag: b.current ? "current" : "" }),
      "Nothing in progress — start a new branch.");
    // Stashes are set-aside WORKING changes, so they live with branches.
    if (stashes.length) {
      html += section("stashes", "Stashes", stashes.length, "var(--mute)",
        stashes.map((s) => rowHTML({ cls: "stash", type: "stash", id: s.index, iconName: "archive", col: "var(--mute)",
          title: s.label, sub: `stash@{${s.index}}` })).join(""));
    }
  } else {
    if (!state.prsAvailable) {
      if (!q) html += state.gh && state.gh.authed
        ? `<li class="list-empty sub">No GitHub remote found for this repo.</li>`
        : `<li class="list-empty sub"><button class="linklike" data-connect>Connect GitHub</button> to track pull requests.</li>`;
    } else {
      html += sect("inreview", "In review", "var(--green)", open, prRow, "Nothing in review.");
      html += sect("done", "Done", "var(--purple)", merged, prRow, "Nothing merged yet.");
      if (closed.length) html += section("deleted", "Deleted", closed.length, "var(--red)", closed.map(prRow).join(""));
    }
  }
  if (q && !html.trim()) html = `<li class="list-empty">No matches for “${esc(state.query.trim())}”.</li>`;
  ul.innerHTML = html;
  ul.querySelectorAll(".group-head").forEach((h) => h.addEventListener("click", () => {
    const k = h.dataset.group;
    if (state.collapsed.has(k)) state.collapsed.delete(k); else state.collapsed.add(k);
    renderList();
  }));
  ul.querySelectorAll(".row-item").forEach((li) => li.addEventListener("click", () => {
    const t = li.dataset.type, id = li.dataset.id;
    if (t === "working") selectWorking();
    else if (t === "pr") selectPR(Number(id));
    else if (t === "stash") selectStash(Number(id));
    else if (t === "branch") switchBranch(id);
  }));
  const connect = ul.querySelector("[data-connect]");
  if (connect) connect.addEventListener("click", connectGh);
}
// Switch to a branch and land in the right place: the default branch is the
// "working tree" (home / empty state); a feature branch opens its activity view.
// Guarded against a dirty tree by the engine.
async function switchBranch(name) {
  if (!name) return;
  const land = () => (name === state.ctx.defaultBranch ? goHome() : selectBranch(name));
  if (state.ctx && state.ctx.branch === name) { land(); return; }
  try {
    await call(window.beacon.checkout, state.cwd, name);
    toast(`Switched to ${name}`);
    await reloadRepoState();
    land();
  } catch {}
}

// --- detail pane ------------------------------------------------------------
function showDetail(html, flush = false) {
  $("empty-state").classList.add("hidden");
  $("detail-col").classList.toggle("flush", flush);
  const d = $("detail-view"); d.classList.remove("hidden"); d.innerHTML = html; return d;
}
// A three-step onboarding progress bar (Connect GitHub → Select repo → New branch).
function onboardProgress(active) {
  const steps = ["Connect GitHub", "Select repository", "New branch"];
  return `<div class="onboard-steps">${steps.map((s, i) =>
    `<span class="ob-step ${i < active ? "done" : i === active ? "active" : ""}">${i < active ? icon("check", "ob-check") : ""}${esc(s)}</span>`
  ).join('<span class="ob-sep">›</span>')}</div>`;
}
// The default right pane, which doubles as the first-run funnel:
//   1. Connect GitHub (before we ever show "select a repo")
//   2. Select a repository
//   3. Pull latest (only if the branch is behind) → then Create a branch
function showEmpty() {
  $("detail-view").classList.add("hidden");
  $("detail-col").classList.remove("flush");
  const es = $("empty-state"); es.classList.remove("hidden");
  const g = state.gh || {};
  const repo = !!(state.ctx && state.ctx.isRepo);

  // Gate the pre-repo state on a connected GitHub account.
  if (!repo) {
    if (!g.authed) return renderConnectStep(es, g);
    return renderSelectRepoStep(es);
  }
  // Repo open: make sure they're up to date before prompting a branch.
  if (!state.skipSync && state.sync && state.sync.behind > 0 && !isDirty()) return renderUpdateStep(es);
  return renderCreateStep(es);
}
function renderConnectStep(es, g) {
  const inst = !!g.installed;
  es.innerHTML = `
    <div class="empty-illus">${icon("pull-request")}</div>
    <h2>${inst ? "Connect your GitHub account" : "Install the GitHub CLI"}</h2>
    <p class="empty-msg">${inst
      ? "Sign in once so Beacon can open pull requests for you. Beacon stores nothing — your GitHub CLI handles the sign-in."
      : "Beacon uses the GitHub CLI (gh) to open pull requests. Install it from cli.github.com, then connect."}</p>
    <button class="btn signal" id="ob-gh">${inst ? "Connect GitHub" : "Get the GitHub CLI"}</button>
    ${onboardProgress(0)}`;
  es.querySelector("#ob-gh").addEventListener("click", () => inst ? connectGh() : window.beacon.openExternal("https://cli.github.com"));
}
function renderSelectRepoStep(es) {
  es.innerHTML = `
    <div class="empty-illus">${icon("folder")}</div>
    <h2>Select a repository</h2>
    <p class="empty-msg">Choose a folder on your machine to start working.</p>
    <button class="btn primary" id="ob-repo">${icon("folder")} Select a repository</button>
    ${onboardProgress(1)}`;
  es.querySelector("#ob-repo").addEventListener("click", openRepo);
}
function renderUpdateStep(es) {
  const s = state.sync;
  es.innerHTML = `
    <div class="empty-illus">${icon("pull")}</div>
    <h2>Get up to date first</h2>
    <p class="empty-msg">${esc(state.ctx.branch)} is ${s.behind} commit${s.behind > 1 ? "s" : ""} behind ${esc(s.upstream || "origin")}. Pull the latest before starting a new branch.</p>
    <div class="create-row" style="justify-content:center">
      <button class="btn signal" id="ob-pull">Pull latest changes</button>
      <button class="btn" id="ob-skip">Skip</button>
    </div>`;
  es.querySelector("#ob-pull").addEventListener("click", async () => {
    const b = es.querySelector("#ob-pull"); busy(b, true, "Pulling");
    try { await call(window.beacon.pull, state.cwd); toast("Pulled the latest changes"); await reloadRepoState(); showEmpty(); }
    catch { busy(b, false); }
  });
  es.querySelector("#ob-skip").addEventListener("click", () => { state.skipSync = true; showEmpty(); });
}
function renderCreateStep(es) {
  const dirty = isDirty();
  es.innerHTML = `
    <div class="empty-illus">${icon("branch")}</div>
    <h2>Start a new branch</h2>
    <p class="empty-msg">Describe what you're changing — Beacon branches off the latest ${esc(state.ctx.defaultBranch)} and declares a front-end scope for the branch, so an agent that drifts outside it gets flagged.</p>
    <div class="create-row">
      <input id="create-name" class="input" type="text" placeholder="e.g. update the pricing page" autocomplete="off" ${dirty ? "disabled" : ""} />
      <button class="btn signal" id="create-start" ${dirty ? "disabled" : ""}>Create branch</button>
    </div>
    ${dirty
      ? `<p class="create-hint">You have ${state.working.length} uncommitted change${state.working.length > 1 ? "s" : ""}. <button class="linklike" id="create-goto-wt">Save or set them aside</button> first.</p>`
      : `<p class="empty-msg small">…or pick an item on the left to open it.</p>`}
    ${onboardProgress(2)}`;
  const nameEl = es.querySelector("#create-name");
  if (nameEl) {
    const go = () => startBranch(nameEl.value);
    es.querySelector("#create-start").addEventListener("click", go);
    nameEl.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    nameEl.focus();
  }
  const goWt = es.querySelector("#create-goto-wt");
  if (goWt) goWt.addEventListener("click", selectWorking);
}
// Create the branch from the inline form, then open its activity view.
async function startBranch(name) {
  if (!name || !name.trim()) return;
  if (!(state.ctx && state.ctx.isRepo)) return;
  if (isDirty()) { toast("Save or set aside your current changes first"); selectWorking(); return; }
  try {
    const r = await call(window.beacon.start, state.cwd, name.trim());
    toast(`Started ${r.branch} · front-end scope declared${r.committed ? " (first commit)" : ""}`);
    await reloadRepoState();
    selectBranch(r.branch);
  } catch {}
}
function goHome() { state.selected = null; renderList(); renderTopnav(); showEmpty(); }
// Immediate feedback while a repo loads (context + branches + PRs + fetch can take a moment).
function showLoading(msg) {
  $("rows").innerHTML = `<li class="list-empty"><span class="spinner"></span> ${esc(msg)}</li>`;
  $("detail-view").classList.add("hidden");
  $("detail-col").classList.remove("flush");
  const es = $("empty-state"); es.classList.remove("hidden");
  es.innerHTML = `<div class="loading-center"><span class="spinner big"></span><p class="empty-msg">${esc(msg)}</p></div>`;
}

// "Open in <agent>" buttons for making edits, if a supported agent is installed.
function agentButtonsHTML() {
  const a = state.agents; let html = "";
  if (a.cursor) html += `<button class="btn small" data-agent="cursor">Open in Cursor</button>`;
  if (a.claude) html += `<button class="btn small" data-agent="claude">Open in Claude Code</button>`;
  return html;
}
function bindAgents(root) {
  root.querySelectorAll("button[data-agent]").forEach((b) => b.addEventListener("click", async () => {
    try { await call(window.beacon.openIn, b.dataset.agent, state.cwd); toast(`Opening in ${b.dataset.agent}…`); } catch {}
  }));
}

// The branch activity view — the main working surface. Shows what's happened on
// this branch (saves + change counts), with a sticky action bar: save / stash /
// restore on the left, Create PR on the right.
async function selectBranch(name, sel) {
  const token = sel || { type: "branch", branch: name };
  state.selected = token;
  renderList(); renderTopnav();
  showDetail(`<div class="branch-view"><div class="branch-scroll"><div class="muted"><span class="spinner"></span> Loading…</div></div></div>`, true);
  let log = { commits: [] }, rv = null;
  await loadWorking().catch(() => {});
  try { log = await call(window.beacon.branchLog, state.cwd); } catch {}
  try { rv = await call(window.beacon.review, state.cwd); } catch {}
  if (state.selected !== token) return; // user navigated away while loading
  renderBranchView(name, log, rv);
}
// The Working tree row → the current branch's activity view (commit / stash /
// restore live in its action bar), with the Working tree row kept highlighted.
function selectWorking() { if (state.ctx && state.ctx.isRepo) selectBranch(state.ctx.branch, { type: "working" }); }
function renderBranchView(name, log, rv) {
  const commits = log.commits || [];
  const dirty = isDirty();
  const files = rv ? rv.files : state.working;
  const changed = files.length;
  const ozFiles = rv ? rv.flagged : state.working.filter((f) => f.outOfScope);
  const ozTotal = ozFiles.length;
  const protoFiles = rv ? rv.prototype : state.working.filter((f) => f.prototype);
  const inScope = changed - ozTotal - protoFiles.length;
  const agents = agentButtonsHTML();

  // The status band: today's numbers as labelled stats (deliberately NOT the
  // dotted mono line the Saves history uses), with the live pulse and scope
  // pills docked right. Everything here moves as the agent works — nothing
  // needs to be saved/committed to show up.
  const adds = rv && rv.stat ? (rv.stat.match(/(\d+) insertions?\(/) || [])[1] : null;
  const dels = rv && rv.stat ? (rv.stat.match(/(\d+) deletions?\(/) || [])[1] : null;
  const strip = `
    <div class="stat-row">
      <div class="stat"><span class="stat-num">${commits.length}</span><span class="stat-label">save${commits.length !== 1 ? "s" : ""}</span></div>
      <div class="stat"><span class="stat-num">${changed}</span><span class="stat-label">file${changed !== 1 ? "s" : ""} changed</span></div>
      ${adds || dels ? `<div class="stat"><span class="stat-num"><span class="add">+${adds || 0}</span> <span class="del">−${dels || 0}</span></span><span class="stat-label">lines</span></div>` : ""}
      <div class="stat-live">
        <span class="live-dot" title="Beacon is watching this repo — updates appear as files change"></span>
        <span class="live-label">watching live</span>
        <span class="scope-pill ${inScope ? "on-in" : ""}">${inScope} in scope</span>
        <span class="scope-pill ${protoFiles.length ? "on-proto" : ""}">${protoFiles.length} prototype</span>
        <span class="scope-pill ${ozTotal ? "on-flag" : ""}">${ozTotal} flagged</span>
      </div>
    </div>`;

  // WHAT TO LOOK OUT FOR — the current state, colour-coded for a designer:
  // RED card = decide something before the PR. PURPLE card = good to know,
  // nothing to do. Green line = all clear.
  const zoneNote = ozTotal ? zoneCallout(
    "Flagged — decide before the PR",
    `Nothing was blocked, but ${ozTotal === 1 ? "this change" : "these changes"} sit${ozTotal === 1 ? "s" : ""} outside the front-end scope declared for this branch. Revert what shouldn't ship; anything kept is flagged for the developer in the PR.`,
    { cls: "alert", tag: { text: "action needed", cls: "act" },
      extra: `<ul class="files flagged">${ozFiles.map((f) => `<li><span class="dot red"></span><div class="flag-main"><span class="file-name">${esc(f.file)}</span><span class="flag-reason">${esc(f.reason || "outside the declared scope")}</span></div><span class="file-status">${esc(f.status)}</span><button class="btn small danger-btn" data-revert-file="${esc(f.file)}">Revert</button></li>`).join("")}</ul>` }) : "";
  const protoNote = protoFiles.length ? zoneCallout(
    "Prototype — built in front of the backend",
    `${protoFiles.length} file${protoFiles.length > 1 ? "s" : ""} under <code>.beacon/prototype/</code> render the repo's real components on mock data instead of touching the backend.`,
    { tag: { text: "nothing to do", cls: "fyi" },
      extra: `<ul class="files">${protoFiles.map((f) => `<li><span class="dot mute"></span><span class="file-name">${esc(f.file)}</span><span class="file-status">${esc(f.status)}</span></li>`).join("")}</ul>`
        + (rv && rv.protoNotes ? `<div class="proto-notes"><div class="proto-notes-h">Backend work needed to make it real</div>${renderMarkdown(rv.protoNotes)}</div>` : "") }) : "";
  const allClear = !ozTotal && !protoFiles.length && changed
    ? `<div class="all-clear">${icon("check")} Everything on this branch is inside the declared front-end scope.</div>` : "";

  // WHAT BEACON NOTICED — pure history, rendered as a boxed watch log (mono
  // time column, tool keycap, severity edge) so it can't be mistaken for the
  // Saves timeline. Nothing here is actionable; resolved drifts stay, dimmed
  // and struck through, so the story stays complete.
  const events = (rv && rv.events) || [];
  const drift = events.length ? `
    <div class="detail-section-h">What Beacon noticed <span class="zone-tag mute">history</span></div>
    <div class="section-hint">What Beacon noticed while the agent worked — anything you've already dealt with stays here, dimmed.</div>
    <div class="watchlog">${events.map((e) => `<div class="wl-row ${e.resolved ? "resolved" : ""}" title="${esc(e.reason || "")}"><span class="wl-time">${esc(ago(e.ts))}</span><span class="wl-tool">${esc(e.tool || "write")}</span><span class="wl-text">went outside the scope — <code>${esc(e.file)}</code></span><span class="wl-state">${e.resolved ? "resolved" : "still flagged"}</span></div>`).join("")}</div>` : "";

  // Each unsaved row gets its own Save — commit just that file, leaving the
  // rest of the working tree untouched (same button style as the per-row Revert).
  const unsaved = dirty ? `
    <div class="detail-section-h">Unsaved changes (${state.working.length})</div>
    <ul class="files">${state.working.map((f) => `<li><span class="dot ${f.outOfScope ? "red" : f.prototype ? "mute" : "green"}"></span><span class="file-name">${esc(f.file)}</span><span class="file-status">${esc(f.status)}${f.outOfScope ? " · out of scope" : f.prototype ? " · prototype" : ""}</span><button class="btn small" data-save-file="${esc(f.file)}" title="Save (commit) just this file">Save</button></li>`).join("")}</ul>` : "";

  const saves = commits.length
    ? `<div class="graph">${commits.map((c) => `<div class="commit"><div class="commit-msg">${esc(c.message)}</div><div class="commit-meta">${esc(c.oid)} · ${esc(ago(c.date))} · ${c.files} file${c.files !== 1 ? "s" : ""} · <span class="add">+${c.additions}</span> <span class="del">−${c.deletions}</span></div></div>`).join("")}</div>`
    : `<div class="muted">No saves yet. Make your edits, then Save to record the first one.</div>`;

  const onDefault = !!(state.ctx && name === state.ctx.defaultBranch);
  const canPR = !onDefault && (commits.length > 0 || dirty);
  const view = showDetail(`
    <div class="branch-view">
      <div class="branch-scroll">
        <h1 class="detail-title">${esc(prettyBranch(name))}</h1>
        ${strip}
        ${agents ? `<div class="agents-row">${agents}</div>` : ""}
        <div class="detail-section-h">What to look out for</div>
        ${zoneNote}
        ${protoNote}
        ${allClear || (!changed ? `<div class="muted">No changes yet — open the repo in an agent and direct it; edits show up here as they happen.</div>` : "")}
        ${unsaved}
        <div class="detail-section-h">Saves</div>
        ${saves}
        ${drift}
      </div>
      <div class="action-bar">
        <div class="ab-left">
          <input id="ab-msg" class="input ab-msg" type="text" placeholder="Describe what you changed…" autocomplete="off" ${dirty ? "" : "disabled"} />
          <button class="btn primary small" id="ab-save" ${dirty ? "" : "disabled"}>Save</button>
          <button class="btn small" id="ab-stash" ${dirty ? "" : "disabled"}>Stash</button>
          <button class="btn small" id="ab-restore" ${state.stashes.length ? "" : "disabled"}>Restore stash</button>
          <button class="btn small danger-btn" id="ab-revert" ${ozTotal ? "" : "disabled"} title="Revert every change Beacon flagged as out of scope">Revert flagged</button>
        </div>
        <div class="ab-right">
          <button class="btn primary" id="ab-createpr" ${canPR ? "" : "disabled"}>${icon("pull-request")} Create PR</button>
        </div>
      </div>
    </div>`, true);

  bindAgents(view);
  const reRender = async () => { await reloadRepoState(); selectBranch(name); };
  view.querySelector("#ab-save").addEventListener("click", async () => {
    const msg = view.querySelector("#ab-msg").value.trim();
    const btn = view.querySelector("#ab-save"); busy(btn, true, "Saving");
    try { const r = await call(window.beacon.commit, state.cwd, msg, true); toast(r.flagged ? `Saved · ${r.flagged} file${r.flagged > 1 ? "s" : ""} flagged as out of scope` : "Saved"); await reRender(); } catch { busy(btn, false); }
  });
  view.querySelector("#ab-msg").addEventListener("keydown", (e) => { if (e.key === "Enter") view.querySelector("#ab-save").click(); });
  view.querySelector("#ab-stash").addEventListener("click", async () => { try { if (await doStash()) await reRender(); } catch {} });
  view.querySelector("#ab-restore").addEventListener("click", async () => { const b = view.querySelector("#ab-restore"); busy(b, true, ""); try { await call(window.beacon.stashPop, state.cwd); toast("Stash restored"); await reRender(); } catch { busy(b, false); } });
  const rz = view.querySelector("#ab-revert");
  if (rz) rz.addEventListener("click", async () => { busy(rz, true, "Reverting"); try { const res = await call(window.beacon.revertOutOfScope, state.cwd); toast(res.reverted ? `Reverted ${res.reverted} flagged change${res.reverted > 1 ? "s" : ""}${res.committed ? " · new commit" : ""}` : "No flagged changes to revert"); await reRender(); } catch { busy(rz, false); } });
  // Per-file revert on the flagged list — the one-click undo for a single drift.
  view.querySelectorAll("button[data-revert-file]").forEach((b) => b.addEventListener("click", async () => {
    const file = b.dataset.revertFile;
    busy(b, true, "");
    try { const res = await call(window.beacon.revertOutOfScope, state.cwd, [file]); toast(res.reverted ? `Reverted ${file}${res.committed ? " · new commit" : ""}` : "Nothing to revert"); await reRender(); }
    catch { busy(b, false); }
  }));
  // Per-file save on the unsaved list — commit only that file. Uses the message
  // from the bar if one is typed, else a sensible per-file default.
  view.querySelectorAll("button[data-save-file]").forEach((b) => b.addEventListener("click", async () => {
    const file = b.dataset.saveFile;
    const msgEl = view.querySelector("#ab-msg");
    const msg = msgEl ? msgEl.value.trim() : "";
    busy(b, true, "");
    try { const r = await call(window.beacon.commit, state.cwd, msg, true, [file]); toast(r.flagged ? `Saved ${file} · flagged as out of scope` : `Saved ${file}`); await reRender(); }
    catch { busy(b, false); }
  }));
  view.querySelector("#ab-createpr").addEventListener("click", () => createPR());
}

// Create PR: gate on a connected GitHub, then preview the AI-generated PR and
// open it for real on confirm.
async function createPR() {
  const modal = $("ship-modal"), preview = $("ship-preview"), confirm = $("ship-confirm"), cancel = $("ship-cancel");
  const mt = modal.querySelector(".modal-title");
  if (mt) mt.textContent = state.ctx && state.ctx.branch ? `Create pull request · ${state.ctx.branch}` : "Create pull request";
  modal.classList.remove("hidden");
  confirm.classList.remove("hidden");

  const close = () => { modal.classList.add("hidden"); cleanup(); };
  let onConfirm;
  const onCancel = () => close();
  const onOverlay = (e) => { if (e.target === modal) close(); };
  function cleanup() { confirm.className = "btn primary"; cancel.removeEventListener("click", onCancel); confirm.removeEventListener("click", onConfirm); modal.removeEventListener("mousedown", onOverlay); }

  if (!(state.gh && state.gh.authed)) {
    // Not connected — turn the modal into a connect prompt.
    const inst = !!(state.gh && state.gh.installed);
    preview.innerHTML = `<div class="connect-panel">${icon("pull-request", "cp-ico")}<div><div class="cp-title">${inst ? "Connect GitHub to open a pull request" : "GitHub CLI not found"}</div><p class="muted">${inst ? "Sign in once and Beacon can push your branch and open the PR for you. Beacon stores nothing — your GitHub CLI handles the sign-in." : "Install the GitHub CLI (gh) from cli.github.com, then connect your account here."}</p></div></div>`;
    confirm.textContent = inst ? "Connect GitHub" : "Get the GitHub CLI";
    confirm.disabled = false;
    onConfirm = () => { close(); connectGh(); };
  } else {
    let annotation = null;
    let blocked = false;
    const renderPreview = async () => {
      preview.innerHTML = `<div class="muted"><span class="spinner"></span> Analyzing your changes…</div>`;
      confirm.className = "btn primary";
      confirm.textContent = "Create pull request";
      confirm.disabled = true;
      try {
        const r = await call(window.beacon.ship, { cwd: state.cwd, dryRun: true });
        annotation = r.annotation;
        blocked = !!(r.flagged && r.flagged.length);
        const n = r.flagged ? r.flagged.length : 0;
        // The pre-PR review: everything Beacon flagged, each with its own
        // revert. Whatever is kept ships flagged in the PR description.
        const warn = blocked ? zoneCallout(
          "Flagged — decide before the PR",
          `${n} change${n > 1 ? "s" : ""} ${n > 1 ? "are" : "is"} outside the front-end scope declared for this branch. Revert what shouldn't ship; anything you keep is flagged for the reviewer in the PR description.`,
          { cls: "alert", tag: { text: "action needed", cls: "act" },
            extra: `<ul class="files flagged">${r.flagged.map((f) => `<li><span class="dot red"></span><span class="file-name">${esc(f)}</span><button class="btn small danger-btn" data-revert-file="${esc(f)}">Revert</button></li>`).join("")}</ul>`
              + `<div class="callout-row"><button class="btn small danger-btn" id="revert-oz">Revert all flagged</button></div>` }) : "";
        preview.innerHTML = `${warn}<div class="preview-head"><span class="badge dim">${esc(r.annotation.source)}</span></div><div class="preview-body">${renderMarkdown(r.annotation.body)}</div>`;
        confirm.className = "btn primary";
        confirm.textContent = blocked ? "Create PR & flag" : "Create pull request";
        confirm.disabled = false;
        const revert = async (btn, files, doneMsg) => {
          busy(btn, true, "Reverting");
          try { const res = await call(window.beacon.revertOutOfScope, state.cwd, files); toast(res.reverted ? doneMsg(res) : "Nothing to revert"); await reloadRepoState(); await renderPreview(); }
          catch { busy(btn, false); }
        };
        const rz = preview.querySelector("#revert-oz");
        if (rz) rz.addEventListener("click", () => revert(rz, undefined, (res) => `Reverted ${res.reverted} flagged change${res.reverted > 1 ? "s" : ""}`));
        preview.querySelectorAll("button[data-revert-file]").forEach((b) =>
          b.addEventListener("click", () => revert(b, [b.dataset.revertFile], () => `Reverted ${b.dataset.revertFile}`)));
      } catch { preview.innerHTML = `<div class="muted">Couldn't analyze the changes on this branch.</div>`; }
    };
    await renderPreview();
    onConfirm = async () => {
      busy(confirm, true, "Creating");
      try {
        const r = await call(window.beacon.ship, { cwd: state.cwd, dryRun: false, title: annotation && annotation.title, allowFlagged: blocked });
        toast(`Pull request created: ${r.prUrl}`);
        close();
        await reloadRepoState();
        goHome();
      } catch { busy(confirm, false); }
    };
  }
  cancel.addEventListener("click", onCancel);
  confirm.addEventListener("click", onConfirm);
  modal.addEventListener("mousedown", onOverlay);
}

async function selectPR(number) {
  state.selected = { type: "pr", number }; renderList(); renderTopnav();
  showDetail(`<div class="muted">Loading #${number}…</div>`);
  try {
    const dd = await call(window.beacon.prDetail, state.cwd, number, "");
    const badge = dd.mergedAt ? '<span class="badge dim">merged</span>' : `<span class="badge green">open</span>`;
    const commits = (dd.commits || []).map((c) => `<div class="commit"><div class="commit-msg">${esc(c.message)}</div><div class="commit-meta">${esc(c.oid)} · ${esc(c.author)} · ${esc(ago(c.date))}</div></div>`).join("");
    const files = (dd.files || []).map((f) => `<li><span class="file-name">${esc(f.path)}</span> <span class="file-status"><span class="add">+${f.additions}</span> <span class="del">−${f.deletions}</span></span></li>`).join("");
    const d = showDetail(`
      <h1 class="detail-title">${esc(dd.title)}</h1>
      <div class="detail-meta">${badge}<span>#${dd.number}</span><span>·</span><span>${esc(dd.headRefName)}</span><span>·</span><span>${esc(dd.author?.login || dd.author?.name || "")}</span></div>
      <div class="detail-section-h">Description</div><div class="detail-body">${renderMarkdown(dd.body) || "<span class='muted'>No description.</span>"}</div>
      <div class="detail-section-h">Saves (${(dd.commits || []).length})</div><div class="graph">${commits || "<span class='muted'>No commits.</span>"}</div>
      <div class="detail-section-h">Files (${(dd.files || []).length})</div><ul class="files">${files || "<li class='muted'>none</li>"}</ul>
      <div class="detail-actions"><button class="btn" data-ext="${esc(dd.url)}">${icon("external")} Open on GitHub</button></div>`);
    d.querySelector("[data-ext]").addEventListener("click", (e) => window.beacon.openExternal(e.currentTarget.dataset.ext));
  } catch {}
}
async function selectStash(index) {
  state.selected = { type: "stash", index }; renderList(); renderTopnav();
  try {
    const dd = await call(window.beacon.stashDetail, state.cwd, index);
    const s = state.stashes.find((x) => x.index === index);
    const d = showDetail(`
      <h1 class="detail-title">${esc(s ? s.label : `stash@{${index}}`)}</h1>
      <div class="detail-meta"><span class="badge dim">stash@{${index}}</span><span>stashed changes</span></div>
      <div class="detail-section-h">Files (${dd.files.length})</div>
      <ul class="files">${dd.files.map((f) => `<li><span class="dot mute"></span><span class="file-name">${esc(f.file)}</span><span class="file-status">${esc(f.status)}</span></li>`).join("") || "<li class='muted'>none</li>"}</ul>
      <div class="detail-actions"><button class="btn primary" id="stash-restore">Restore these changes</button><button class="btn" id="stash-rename">Rename</button></div>`);
    d.querySelector("#stash-restore").addEventListener("click", async () => { try { await call(window.beacon.stashPop, state.cwd, index); toast("Stash restored"); await reloadRepoState(); goHome(); } catch {} });
    d.querySelector("#stash-rename").addEventListener("click", async () => {
      const name = await promptName({ title: "Rename stash", ok: "Rename", initial: s ? s.label : "" });
      if (name == null) return;
      try { await call(window.beacon.stashRename, state.cwd, index, name); toast("Stash renamed"); await reloadRepoState(); selectStash(0); } catch {}
    });
  } catch {}
}

// --- loaders ----------------------------------------------------------------
async function loadPRs() { const r = await call(window.beacon.listPRs, state.cwd, ""); state.prsAvailable = r.available; state.prs = r.prs || []; }
async function loadStashes() { const list = await call(window.beacon.stashList, state.cwd); state.stashes = list.map((l) => { const m = l.match(/^stash@\{(\d+)\}:\s*(.*)$/); return { index: m ? Number(m[1]) : 0, label: m ? m[2] : l }; }); }
async function loadWorking() { const w = await call(window.beacon.workingChanges, state.cwd); state.working = w.files || []; }
async function loadBranches() { const r = await call(window.beacon.listBranches, state.cwd); state.branches = r.branches || []; }
async function loadSync(fetch = false) { try { state.sync = await call(window.beacon.remoteState, state.cwd, fetch); } catch { state.sync = { behind: 0, ahead: 0, upstream: null }; } }

// Reload everything derived from the repo (after any tree-changing action).
// Recomputes ahead/behind from existing refs (no network fetch).
async function reloadRepoState() {
  state.ctx = await call(window.beacon.context, state.cwd);
  await Promise.all([loadWorking().catch(() => {}), loadStashes().catch(() => {}), loadPRs().catch(() => {}), loadBranches().catch(() => {}), loadSync(false).catch(() => {})]);
  renderTopnav(); renderList();
}

// --- transitions ------------------------------------------------------------
// "New branch" → clear the selection and surface the creation form (showEmpty
// renders it and focuses the name field).
function startNewChange() { if (state.ctx && state.ctx.isRepo) goHome(); }
async function loadContext(cwd) {
  state.cwd = cwd; state.selected = null; state.skipSync = false;
  showLoading(`Opening ${cwd.split("/").pop()}…`);
  state.ctx = await call(window.beacon.context, cwd);
  // On open, fetch once so the "pull first" gate reflects the real remote.
  await Promise.all([loadPRs().catch(() => {}), loadStashes().catch(() => {}), loadWorking().catch(() => {}), loadBranches().catch(() => {}), loadGh().catch(() => {}), loadSync(true).catch(() => {})]);
  renderTopnav(); renderGhChip(); renderList(); showEmpty();
  // Watch the repo so the UI tracks the agent's writes as they happen.
  window.beacon.watch(cwd).catch(() => {});
}

// --- live updates -------------------------------------------------------
// The main process watches the open repo and pings here whenever files (or
// guard flags, commits, branch switches) change. Refresh whatever is showing —
// no save, no commit, no manual refresh needed. The save-message input is
// preserved so a live update never eats what the user is typing.
let liveTimer = null;
window.beacon.onChanged(() => {
  if (!state.cwd) return;
  clearTimeout(liveTimer);
  liveTimer = setTimeout(async () => {
    const msgEl = $("ab-msg");
    const keep = msgEl ? { value: msgEl.value, focused: document.activeElement === msgEl } : null;
    try {
      await reloadRepoState();
      const s = state.selected;
      if (s && (s.type === "branch" || s.type === "working")) {
        await selectBranch(s.type === "branch" ? s.branch : state.ctx.branch, s);
        const el = $("ab-msg");
        if (el && keep && keep.value && !el.value) el.value = keep.value;
        if (el && keep && keep.focused) el.focus();
      } else if (s === null) {
        showEmpty();
      }
    } catch { /* transient git state (mid-operation) — the next ping catches up */ }
  }, 250);
});

// --- wiring -----------------------------------------------------------------
$("repo-btn").addEventListener("click", openRepo);
$("branch-btn").addEventListener("click", branchMenu);
// Reload repo state and re-open the current branch view (if one is showing).
async function refreshView() {
  await reloadRepoState();
  const s = state.selected;
  if (s && s.type === "branch") selectBranch(s.branch);
}
$("list-refresh").addEventListener("click", () => { if (state.cwd) refreshView(); });
$("rows").addEventListener("contextmenu", rowContextMenu);
// Activity search: toggle a filter input in the list header.
function toggleSearch(force) {
  state.searchOpen = force !== undefined ? force : !state.searchOpen;
  const inp = $("list-search"), tabs = $("list-tabs");
  inp.classList.toggle("hidden", !state.searchOpen);
  tabs.classList.toggle("hidden", state.searchOpen);
  if (state.searchOpen) { inp.focus(); inp.select(); }
  else if (state.query) { state.query = ""; inp.value = ""; renderList(); }
}
// Branches ↔ PRs tab switch.
document.querySelectorAll(".list-tab").forEach((t) => t.addEventListener("click", () => {
  if (state.tab === t.dataset.tab) return;
  state.tab = t.dataset.tab;
  document.querySelectorAll(".list-tab").forEach((x) => x.classList.toggle("active", x === t));
  renderList();
}));
$("list-search-btn").addEventListener("click", () => toggleSearch());
$("list-search").addEventListener("input", (e) => { state.query = e.target.value; renderList(); });
$("list-search").addEventListener("keydown", (e) => { if (e.key === "Escape") toggleSearch(false); });
$("fetch-btn").addEventListener("click", async () => {
  if (!state.cwd) return;
  const b = $("fetch-btn"); busy(b, true, "Fetching");
  try { await call(window.beacon.fetchRemote, state.cwd); toast("Fetched the latest from GitHub"); await refreshView(); }
  finally { busy(b, false); }
});
$("pull-btn").addEventListener("click", async () => {
  if (!state.cwd) return;
  const b = $("pull-btn"); busy(b, true, "Pulling");
  try { const r = await call(window.beacon.pull, state.cwd); toast(r.note && /already up to date/i.test(r.note) ? "Already up to date" : "Pulled the latest changes"); await refreshView(); }
  finally { busy(b, false); }
});

// --- init -------------------------------------------------------------------
(async () => { try { state.agents = await call(window.beacon.detectAgents); } catch {} await loadGh().catch(() => {}); renderTopnav(); renderGhChip(); renderList(); showEmpty(); })();
