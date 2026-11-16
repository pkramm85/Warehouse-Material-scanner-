"use strict";
/* Material Scanner for Carr & Duff
   Data lives in this browser (localStorage). See README for the shared-database next step. */

// ---------- tiny helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => Math.random().toString(36).slice(2, 10);
const norm = c => String(c || "").trim().toUpperCase();
const when = ts => new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const ICON = {
  hist: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20l4-1 11-11-3-3L5 16zM14 6l3 3"/></svg>',
  fix: '<svg viewBox="0 0 24 24"><rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 13l2 2 4-4"/></svg>',
  del: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
};

// ---------- data ----------
const KEY = "cd.scanner.v1";
function load() {
  try { const d = JSON.parse(localStorage.getItem(KEY)); if (d) return d; } catch { /* fresh start */ }
  return { materials: {}, scans: [], counts: [], admins: [], me: null, lastJob: "" };
}
let db = load();
const save = () => localStorage.setItem(KEY, JSON.stringify(db));
const me = () => db.me || { name: "", email: "" };
const isAdmin = () => !!db.me && db.admins.includes(db.me.email.toLowerCase());
const unit = m => m.unit || "pcs";
const state = m => (m.qty <= 0 ? "out" : m.min > 0 && m.qty <= m.min ? "low" : "ok");

// Every stock change goes through here, so History is always complete.
function move(m, delta, type, extra = {}) {
  const before = m.qty;
  m.qty = Math.max(0, before + delta);
  const s = { id: uid(), ts: Date.now(), code: m.code, name: m.name, unit: unit(m), type, delta: m.qty - before, after: m.qty, user: me().name, ...extra };
  db.scans.push(s);
  save();
  return s;
}
const canUndo = s => isAdmin() || (s.user === me().name && Date.now() - s.ts < 15 * 60 * 1000);
function undo(id) {
  const s = db.scans.find(x => x.id === id);
  if (!s || !canUndo(s)) return toast("Only an admin can undo that scan.", true);
  const m = db.materials[s.code];
  if (m) m.qty = Math.max(0, m.qty - s.delta);
  db.scans = db.scans.filter(x => x !== s);
  save(); refresh();
}

// ---------- csv ----------
function parseCSV(t) {
  const rows = []; let row = [], f = "", q = false;
  t = t.replace(/^﻿/, "");
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && t[i + 1] === "\n") i++; row.push(f); f = ""; if (row.some(x => x.trim())) rows.push(row); row = []; }
    else f += c;
  }
  row.push(f); if (row.some(x => x.trim())) rows.push(row);
  return rows;
}
const toCSV = rows => "﻿" + rows.map(r => r.map(v => '"' + String(v ?? "").replace(/"/g, '""') + '"').join(",")).join("\r\n");
function download(name, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- toast + modal ----------
let toastTimer;
function toast(msg, isErr, undoId) {
  const t = $("#toast");
  t.className = isErr ? "err" : "";
  t.innerHTML = `<span>${esc(msg)}</span>${undoId ? `<button data-act="undo" data-id="${undoId}">Undo</button>` : ""}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), undoId ? 10000 : 4000);
}
let locked = false;
$("#modal").addEventListener("cancel", e => { if (locked) e.preventDefault(); });
function modal(html, onSubmit, lock) {
  const d = $("#modal");
  locked = !!lock;
  d.innerHTML = `<form class="mb">${html}</form>`;
  const f = $("form", d);
  f.onsubmit = e => { e.preventDefault(); onSubmit && onSubmit(new FormData(f), f); };
  if (!d.open) d.showModal();
  return f;
}
const closeModal = () => { locked = false; $("#modal").close(); };
const mErr = (f, msg) => { $(".err", f).textContent = msg; };

// ---------- navigation ----------
let tab = "scan", mode = "out", histFilter = "all", histQ = "", stockQ = "", lowOnly = false, openCount = null;
function showTab(t) {
  if (t !== "scan") stopCam();
  tab = t;
  $$(".view").forEach(v => v.classList.toggle("active", v.id === "v-" + t));
  $$(".tabs button").forEach(b => b.classList.toggle("on", b.dataset.t === t));
  refresh();
  window.scrollTo(0, 0);
}
function refresh() {
  $("#av").textContent = (me().name || "?").split(/\s+/).map(w => w[0]).slice(0, 2).join("").toUpperCase();
  $("#meName").textContent = me().name;
  $("#jobs").innerHTML = [...new Set(db.scans.map(s => s.job).filter(Boolean))].slice(-30).map(j => `<option value="${esc(j)}">`).join("");
  ({ scan: renderScan, stock: renderStock, history: renderHistory, counts: renderCounts, team: renderTeam, help() {} })[tab]();
}

// ---------- SCAN ----------
function renderScan() {
  $("#mode").className = "seg " + mode;
  $$("#mode button").forEach(b => b.classList.toggle("on", b.dataset.m === mode));
  const low = Object.values(db.materials).filter(m => m.min > 0 && m.qty <= m.min).sort((a, b) => a.qty - b.qty);
  $("#lowList").innerHTML = low.length
    ? low.map(m => `<div class="item"><div><div class="nm">${esc(m.name)}</div><div class="meta">Min ${m.min} ${esc(unit(m))}</div></div><span class="pill ${state(m)}">${m.qty}</span></div>`).join("")
    : '<div class="empty">Nothing is running low.</div>';
  const rec = db.scans.slice(-5).reverse();
  $("#recent").innerHTML = rec.length
    ? rec.map(s => `<div class="item"><div><div class="nm">${esc(s.name)}</div><div class="meta">${label(s)} &middot; ${when(s.ts)}${s.job ? " &middot; " + esc(s.job) : ""}</div></div></div>`).join("")
    : '<div class="empty">No scans yet.</div>';
}
const label = s => s.type === "fix" ? `Count fix ${s.delta >= 0 ? "+" : ""}${s.delta}` : `${s.type === "in" ? "Checked in" : "Checked out"} ${Math.abs(s.delta)} ${esc(s.unit)}`;

function find(raw) {
  const code = norm(raw);
  if (!code) return;
  const m = db.materials[code];
  const box = $("#scanPanel");
  if (!m) {
    box.innerHTML = `<div class="card"><div class="top2"><div><h3>Code not found</h3><div class="meta">${esc(code)} isn't in the material list yet. Add it now.</div></div><button class="x" data-act="clearPanel">&#10005;</button></div>
      <button class="btn dark block" style="margin-top:14px" data-act="addNew" data-code="${esc(code)}">Add this material</button></div>`;
    return;
  }
  box.innerHTML = `<div class="card"><div class="top2"><div><h3>${esc(m.name)}</h3><div class="meta">${esc(m.code)} &middot; On hand ${m.qty} ${esc(unit(m))}</div></div><button class="x" data-act="clearPanel">&#10005;</button></div>
    <div class="stepper"><button type="button" data-act="step" data-d="-1">&minus;</button><input id="qty" type="number" inputmode="numeric" min="1" value="1"><button type="button" data-act="step" data-d="1">+</button></div>
    <label>Job or reason<input id="job" list="jobs" value="${esc(db.lastJob)}" placeholder="e.g. Smith Elementary"></label>
    <label>Note (optional)<input id="note"></label>
    <button class="go ${mode}" id="go" data-act="commit" data-code="${esc(m.code)}"></button></div>`;
  goLabel();
  $("#qty").oninput = goLabel;
}
function goLabel() {
  const q = parseInt($("#qty")?.value, 10) || 0;
  const g = $("#go"); if (!g) return;
  const m = db.materials[g.dataset.code];
  g.textContent = `${mode === "in" ? "Check in" : "Check out"} ${q} ${unit(m)}`;
}
function commit(code) {
  const m = db.materials[code];
  const q = parseInt($("#qty").value, 10);
  if (!(q > 0)) return toast("Enter a quantity above 0.", true);
  if (mode === "out" && q > m.qty) return toast(`Only ${m.qty} ${unit(m)} on hand.`, true);
  db.lastJob = $("#job").value.trim();
  const s = move(m, mode === "in" ? q : -q, mode, { job: db.lastJob, note: $("#note").value.trim() });
  $("#scanPanel").innerHTML = ""; $("#code").value = "";
  toast(`${mode === "in" ? "Checked in" : "Checked out"} ${q} ${unit(m)}. ${m.qty} on hand.`, false, s.id);
  refresh();
}

// camera: native BarcodeDetector where available, ZXing (loaded on demand) everywhere else
let stream = null, scanning = false, reader = null;
const loadZX = () => new Promise((res, rej) => {
  if (window.ZXing) return res();
  const s = document.createElement("script");
  s.src = "https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js";
  s.onload = res; s.onerror = rej; document.head.appendChild(s);
});
async function startCam() {
  const cam = $("#cam"), v = $("#video");
  cam.classList.add("live");
  try {
    if ("BarcodeDetector" in window) {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      v.srcObject = stream; await v.play();
      const det = new BarcodeDetector(); scanning = true;
      (async function loop() {
        while (scanning) {
          try { const r = await det.detect(v); if (r.length) return onRead(r[0].rawValue); } catch { /* frame not ready */ }
          await new Promise(r => setTimeout(r, 200));
        }
      })();
    } else {
      await loadZX();
      reader = new ZXing.BrowserMultiFormatReader();
      await reader.decodeFromConstraints({ video: { facingMode: "environment" } }, "video", r => { if (r) onRead(r.getText()); });
    }
  } catch {
    stopCam();
    $("#camMsg").textContent = "Couldn't open the camera. Allow camera access, or type the code below.";
  }
}
function stopCam() {
  scanning = false;
  try { reader && reader.reset(); } catch { /* already stopped */ }
  reader = null;
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null;
  $("#cam").classList.remove("live");
}
function onRead(text) {
  navigator.vibrate && navigator.vibrate(80);
  stopCam();
  $("#code").value = text;
  find(text);
}

// ---------- STOCK ----------
function renderStock() {
  const all = Object.values(db.materials);
  const low = all.filter(m => state(m) === "low").length, out = all.filter(m => state(m) === "out").length;
  const q = stockQ.toLowerCase();
  const rank = { out: 0, low: 1, ok: 2 };
  const rows = all.filter(m => (!lowOnly || state(m) !== "ok") && (!q || (m.code + " " + m.name).toLowerCase().includes(q)))
    .sort((a, b) => rank[state(a)] - rank[state(b)] || a.name.localeCompare(b.name));
  const ad = isAdmin();
  $("#v-stock").innerHTML = `
    <h2 class="first">Stock</h2><p class="sub">What's on hand right now.</p>
    <div class="row wrap">
      ${ad ? `<button class="btn light sm" data-act="exportStock">Export stock</button><button class="btn light sm" data-act="import">Import counts</button><button class="btn dark sm" data-act="addNew">+ Add material</button>` : ""}
    </div>
    <div class="tiles"><div><small>Materials</small><b>${all.length}</b></div><div><small>Low on stock</small><b class="lowv">${low}</b></div><div><small>Out of stock</small><b class="outv">${out}</b></div></div>
    <div class="find" style="margin-top:0"><input id="stockQ" placeholder="Search by name or code" value="${esc(stockQ)}"><button class="btn light" data-act="lowOnly" style="${lowOnly ? "background:var(--brand);color:#fff" : ""}">Low only</button></div>
    ${rows.length ? rows.map(m => `<div class="mat"><div class="head"><div><div class="nm" style="font:600 18px Barlow,Inter,sans-serif">${esc(m.name)}</div><div class="meta">${esc(m.code)}</div></div>
      <div class="qn">${m.qty} <small>${esc(unit(m))}</small>${state(m) !== "ok" ? `<div><span class="tag ${state(m)}">${state(m) === "out" ? "Out" : "Low"}</span></div>` : ""}</div></div>
      <div class="acts"><button data-act="matHist" data-code="${esc(m.code)}">${ICON.hist}History</button>
      ${ad ? `<button data-act="edit" data-code="${esc(m.code)}">${ICON.edit}Edit</button><button data-act="fix" data-code="${esc(m.code)}">${ICON.fix}Correct count</button><button class="del" data-act="del" data-code="${esc(m.code)}">${ICON.del}Delete</button>` : ""}</div></div>`).join("")
      : `<div class="empty"><b>${all.length ? "No matches" : "No materials yet"}</b>${all.length ? "Try a different search." : "Scan a new label to add one, or import a spreadsheet."}</div>`}`;
  $("#stockQ").oninput = e => { stockQ = e.target.value; const p = e.target.selectionStart; renderStock(); const i = $("#stockQ"); i.focus(); i.setSelectionRange(p, p); };
}
function materialForm(code, existing) {
  const m = existing || { code, name: "", unit: "pcs", min: 0, qty: 0 };
  const f = modal(`<h3>${existing ? "Edit material" : "Add material"}</h3>
    <label>Code<input name="code" value="${esc(m.code)}" ${existing ? "readonly" : 'autocapitalize="characters"'} required></label>
    <label>Name<input name="name" value="${esc(m.name)}" placeholder='e.g. 1/2" EMT conduit' required></label>
    <div class="row"><label class="grow" style="margin-top:12px">Unit<input name="unit" value="${esc(m.unit)}" placeholder="pcs, ft, box"></label>
    <label class="grow" style="margin-top:12px">Low stock at<input name="min" type="number" inputmode="numeric" min="0" value="${m.min}"></label></div>
    ${existing ? "" : `<label>Starting count<input name="qty" type="number" inputmode="numeric" min="0" value="0"></label>`}
    <div class="err"></div>
    <div class="row"><button type="button" class="btn light" data-act="mclose">Cancel</button><button class="btn dark">Save</button></div>`,
    fd => {
      const c = norm(fd.get("code")), name = fd.get("name").trim();
      if (!c || !name) return mErr(f, "Code and name are required.");
      if (!existing && db.materials[c]) return mErr(f, "That code already exists.");
      const mat = existing || (db.materials[c] = { code: c, qty: 0 });
      mat.name = name; mat.unit = fd.get("unit").trim() || "pcs"; mat.min = Math.max(0, parseInt(fd.get("min"), 10) || 0);
      if (!existing) { const q = parseInt(fd.get("qty"), 10) || 0; if (q > 0) move(mat, q, "fix", { note: "Starting count" }); }
      save(); closeModal();
      if (tab === "scan" && !existing) { $("#code").value = c; find(c); }
      refresh();
    });
}
function importFlow(file) {
  const r = new FileReader();
  r.onload = () => {
    const rows = parseCSV(String(r.result));
    if (rows.length < 2) return toast("That file has no rows.", true);
    const head = rows[0].map(h => h.trim().toLowerCase());
    const col = (...n) => head.findIndex(h => n.includes(h));
    const ci = col("code"), ni = col("name"), qi = col("count", "qty", "quantity", "on hand"), ui = col("unit"), mi = col("low stock at", "min", "minimum");
    if (ci < 0) return toast("The file needs a Code column.", true);
    const plan = [];
    rows.slice(1).forEach(row => {
      const code = norm(row[ci]); if (!code) return;
      const cnt = qi >= 0 && row[qi]?.trim() !== "" ? parseInt(row[qi], 10) : null;
      plan.push({ code, name: ni >= 0 ? row[ni].trim() : "", unit: ui >= 0 ? row[ui].trim() : "", min: mi >= 0 && row[mi]?.trim() !== "" ? parseInt(row[mi], 10) : null, cnt: Number.isNaN(cnt) ? null : cnt });
    });
    const fresh = plan.filter(p => !db.materials[p.code]).length;
    modal(`<h3>Import preview</h3><p class="meta">${plan.length} rows: ${fresh} new, ${plan.length - fresh} existing. Counts replace what's on hand and show in History as count fixes.</p>
      <div class="row"><button type="button" class="btn light" data-act="mclose">Cancel</button><button class="btn dark">Import</button></div>`, () => {
      plan.forEach(p => {
        const m = db.materials[p.code] || (db.materials[p.code] = { code: p.code, name: p.name || p.code, unit: "pcs", min: 0, qty: 0 });
        if (p.name) m.name = p.name; if (p.unit) m.unit = p.unit; if (p.min !== null && !Number.isNaN(p.min)) m.min = p.min;
        if (p.cnt !== null && p.cnt !== m.qty) move(m, p.cnt - m.qty, "fix", { note: "Imported count" });
      });
      save(); closeModal(); toast(`Imported ${plan.length} rows.`); refresh();
    });
  };
  r.readAsText(file);
}

// ---------- HISTORY ----------
function renderHistory() {
  const q = histQ.toLowerCase();
  const rows = db.scans.slice().reverse().filter(s => (histFilter === "all" || s.type === histFilter) && (!q || [s.name, s.code, s.job, s.user, s.note].join(" ").toLowerCase().includes(q)));
  $("#v-history").innerHTML = `
    <div class="top2"><div><h2 class="first">History</h2><p class="sub">Every check-in, check-out and count correction.</p></div>
    ${isAdmin() ? '<button class="btn light sm" data-act="exportHist">Export CSV</button>' : ""}</div>
    <input id="histQ" placeholder="Search material, code, job or person" value="${esc(histQ)}">
    <div class="chips">${[["all", "All"], ["in", "Check in"], ["out", "Check out"], ["fix", "Corrections"]].map(([k, l]) => `<button data-act="hf" data-k="${k}" class="${histFilter === k ? "on" : ""}">${l}</button>`).join("")}</div>
    ${rows.length ? rows.map(s => `<div class="hrow"><div class="t"><span>${esc(s.name)}</span><span class="d ${s.type === "fix" ? "fix" : s.delta >= 0 ? "pos" : "neg"}">${s.delta >= 0 ? "+" : ""}${s.delta} ${esc(s.unit)}</span></div>
      <div class="meta">${label(s)} &middot; ${esc(s.user)} &middot; ${when(s.ts)}${s.job ? "<br>Job: " + esc(s.job) : ""}${s.note ? "<br>" + esc(s.note) : ""}</div>
      ${canUndo(s) ? `<button class="link" data-act="undo" data-id="${s.id}">Remove this scan</button>` : ""}</div>`).join("")
      : `<div class="empty"><b>No scans yet</b>Scans show up here as soon as someone checks material in or out.<br><button class="btn dark" data-act="tab" data-t="scan">Go to Scan</button></div>`}`;
  $("#histQ").oninput = e => { histQ = e.target.value; const p = e.target.selectionStart; renderHistory(); const i = $("#histQ"); i.focus(); i.setSelectionRange(p, p); };
}

// ---------- COUNTS ----------
const cname = c => `Count &middot; ${when(c.ts)}`;
function renderCounts() {
  const v = $("#v-counts");
  const c = db.counts.find(x => x.id === openCount);
  if (c) return renderCountDetail(c, v);
  const grp = st => db.counts.filter(c => c.status === st).reverse();
  const card = c => `<div class="card" data-act="openCount" data-id="${c.id}" style="cursor:pointer"><div class="top2"><div><h3>${cname(c)}</h3><div class="meta">${c.lines.length} materials &middot; started by ${esc(c.by)}</div></div><span class="badge ${c.status === "review" ? "wait" : ""}">${{ open: "Counting", review: "Needs approval", done: "Done" }[c.status]}</span></div></div>`;
  v.innerHTML = `<div class="top2"><div><h2 class="first">Counts</h2><p class="sub">Pick materials and count them. Counters don't see stock. An admin approves the differences.</p></div>
    ${isAdmin() ? '<button class="btn dark sm" data-act="newCount">+ New count</button>' : ""}</div>
    ${db.counts.length ? ["review", "open", "done"].map(st => grp(st).map(card).join("")).join("")
      : `<div class="empty"><b>No counts yet</b>Start a count, pick the materials, then scan labels and enter what's on the shelf.${isAdmin() ? '<br><button class="btn light" data-act="newCount">Start a count</button>' : ""}</div>`}`;
}
function renderCountDetail(c, v) {
  const back = `<button class="btn light sm" data-act="backCounts">&larr; Back</button>`;
  if (c.status === "open") {
    v.innerHTML = `${back}<h2>${cname(c)}</h2><p class="sub">Enter what's on the shelf. Leave blank to skip a material.</p>
      <div class="card cnt"><table>${c.lines.map((l, i) => { const m = db.materials[l.code]; return `<tr><td>${esc(m ? m.name : l.code)}<div class="meta">${esc(l.code)}</div></td><td style="text-align:right"><input data-i="${i}" type="number" inputmode="numeric" min="0" value="${l.counted ?? ""}"></td></tr>`; }).join("")}</table></div>
      <button class="btn dark block" style="margin-top:14px" data-act="sendCount" data-id="${c.id}">Send for approval</button>`;
  } else {
    const diff = c.lines.filter(l => l.counted !== null);
    v.innerHTML = `${back}<h2>${cname(c)}</h2><p class="sub">${c.status === "done" ? "Finished." : isAdmin() ? "Approve sets stock to the counted number. Reject leaves it alone." : "Waiting for an admin to approve."}</p>
      <div class="card cnt"><table><tr><th>Material</th><th>Expected</th><th>Counted</th><th>Diff</th></tr>${diff.map(l => { const d = l.counted - l.expected; const m = db.materials[l.code]; return `<tr><td>${esc(m ? m.name : l.code)}</td><td>${l.expected}</td><td>${l.counted}</td><td>${d > 0 ? "+" : ""}${d}</td></tr>${l.res === "pending" && isAdmin() ? `<tr><td colspan="4"><button class="btn dark sm" data-act="approveLine" data-id="${c.id}" data-code="${esc(l.code)}">Approve</button> <button class="btn light sm" data-act="rejectLine" data-id="${c.id}" data-code="${esc(l.code)}">Reject</button></td></tr>` : `<tr><td colspan="4" class="meta">${l.res === "pending" ? "Waiting" : l.res === "rejected" ? "Rejected" : "Approved"}</td></tr>`}`; }).join("")}</table></div>
      ${c.status === "review" && isAdmin() ? `<button class="btn dark block" style="margin-top:14px" data-act="approveAll" data-id="${c.id}">Approve all</button>` : ""}`;
  }
}
function settleCount(c) {
  if (c.lines.every(l => l.counted === null || l.res !== "pending")) c.status = "done";
  save(); refresh();
}
function applyLine(c, l) {
  const m = db.materials[l.code], d = l.counted - l.expected;
  l.res = "approved";
  if (m && d !== 0) move(m, d, "fix", { note: `Cycle count: expected ${l.expected}, counted ${l.counted}` });
}

// ---------- TEAM ----------
function renderTeam() {
  const list = db.admins;
  $("#v-team").innerHTML = `<h2 class="first">Team</h2><p class="sub">Everyone who can open the app can scan. Admins can also add and edit materials, correct counts, remove scans, approve counts and export.</p>
    ${isAdmin() ? `<form id="adminForm"><label style="margin-top:0">Add an admin<input id="adminEmail" type="email" placeholder="name@carrduff.com" required></label><button class="btn dark block" style="margin-top:10px">Add admin</button></form>` : ""}
    <h2>Admins</h2>
    ${list.map(e => `<div class="item"><div class="nm">${esc(e)}</div>${isAdmin() && e !== me().email.toLowerCase() ? `<button class="link" data-act="rmAdmin" data-e="${esc(e)}">Remove</button>` : ""}</div>`).join("") || '<div class="empty">No admins yet.</div>'}
    <p class="sub" style="margin-top:18px">Roles are stored on this device for now. Shared sign-in comes with the shared database.</p>`;
  const f = $("#adminForm");
  if (f) f.onsubmit = e => { e.preventDefault(); const v = $("#adminEmail").value.trim().toLowerCase(); if (v && !db.admins.includes(v)) { db.admins.push(v); save(); } refresh(); };
}

// ---------- first run / profile ----------
function profile(first) {
  const f = modal(`<h3>${first ? "Welcome" : "Your profile"}</h3><p class="meta">${first ? "Tell us who you are. This goes on every scan." : "Update your name or email."}</p>
    <label>Name<input name="name" value="${esc(me().name)}" required autocomplete="name"></label>
    <label>Work email<input name="email" type="email" value="${esc(me().email)}" required autocomplete="email"></label>
    <div class="err"></div>
    <div class="row">${first ? "" : '<button type="button" class="btn light" data-act="mclose">Cancel</button>'}<button class="btn dark">Save</button></div>`,
    fd => {
      const name = fd.get("name").trim(), email = fd.get("email").trim().toLowerCase();
      if (!name || !email) return mErr(f, "Enter your name and email.");
      db.me = { name, email };
      if (!db.admins.length) db.admins.push(email); // the first person to set up the app is its admin
      save(); closeModal(); refresh();
    }, first);
}

// ---------- events ----------
const A = {
  tab: d => showTab(d.t),
  mode: d => { mode = d.m; renderScan(); const g = $("#go"); if (g) { g.className = "go " + mode; goLabel(); } },
  startCam, stopCam,
  clearPanel: () => ($("#scanPanel").innerHTML = ""),
  step: d => { const q = $("#qty"); q.value = Math.max(1, (parseInt(q.value, 10) || 1) + +d.d); goLabel(); },
  commit: d => commit(d.code),
  undo: d => { undo(d.id); $("#toast").hidden = true; },
  addNew: d => materialForm(d.code),
  edit: d => materialForm(d.code, db.materials[d.code]),
  matHist: d => { histQ = d.code; histFilter = "all"; showTab("history"); },
  fix: d => {
    const m = db.materials[d.code];
    const f = modal(`<h3>Correct count</h3><p class="meta">${esc(m.name)} &middot; currently ${m.qty} ${esc(unit(m))}</p>
      <label>What's really on the shelf<input name="n" type="number" inputmode="numeric" min="0" value="${m.qty}" required></label><div class="err"></div>
      <div class="row"><button type="button" class="btn light" data-act="mclose">Cancel</button><button class="btn dark">Save</button></div>`, fd => {
      const n = parseInt(fd.get("n"), 10); if (Number.isNaN(n) || n < 0) return mErr(f, "Enter a number, 0 or higher.");
      if (n !== m.qty) move(m, n - m.qty, "fix", { note: `Count corrected ${m.qty} to ${n}` });
      closeModal(); refresh();
    });
  },
  del: d => {
    const m = db.materials[d.code];
    modal(`<h3>Delete ${esc(m.name)}?</h3><p class="meta">The material is removed from Stock. Its scans stay in History.</p>
      <div class="row"><button type="button" class="btn light" data-act="mclose">Cancel</button><button class="btn danger">Delete</button></div>`, () => { delete db.materials[d.code]; save(); closeModal(); refresh(); });
  },
  lowOnly: () => { lowOnly = !lowOnly; renderStock(); },
  exportStock: () => download("stock.csv", toCSV([["Code", "Name", "Count", "Unit", "Low stock at"], ...Object.values(db.materials).map(m => [m.code, m.name, m.qty, unit(m), m.min])])),
  exportHist: () => download("history.csv", toCSV([["Time", "Person", "Type", "Code", "Material", "Change", "Unit", "Job", "Note"], ...db.scans.map(s => [new Date(s.ts).toISOString(), s.user, s.type, s.code, s.name, s.delta, s.unit, s.job || "", s.note || ""])])),
  import: () => {
    modal(`<h3>Import counts</h3><p class="meta">Choose a CSV with these headings: Code, Name, Count, Unit, Low stock at. Only Code is required.</p>
      <input id="file" type="file" accept=".csv,text/csv" style="padding-top:12px">
      <div class="row"><button type="button" class="btn light" data-act="sheet">Download count sheet</button><button type="button" class="btn light" data-act="mclose">Cancel</button></div>`);
    $("#file").onchange = e => e.target.files[0] && importFlow(e.target.files[0]);
  },
  sheet: () => download("count-sheet.csv", toCSV([["Code", "Name", "Count", "Unit", "Low stock at"], ["EXAMPLE-001", "1/2 in EMT conduit", 100, "ft", 20]])),
  hf: d => { histFilter = d.k; renderHistory(); },
  newCount: () => {
    const mats = Object.values(db.materials);
    if (!mats.length) return toast("Add some materials first.", true);
    const f = modal(`<h3>New count</h3>
      <div class="radio" style="margin-top:12px"><label><input type="radio" name="w" value="all" checked> All materials</label><label style="margin-top:10px"><input type="radio" name="w" value="low"> Low stock only</label><label style="margin-top:10px"><input type="radio" name="w" value="pick"> Pick materials</label></div>
      <div class="pick">${mats.map(m => `<label><input type="checkbox" name="p" value="${esc(m.code)}">${esc(m.name)}</label>`).join("")}</div><div class="err"></div>
      <div class="row"><button type="button" class="btn light" data-act="mclose">Cancel</button><button class="btn dark">Start count</button></div>`, fd => {
      const w = fd.get("w"); let codes = w === "all" ? mats.map(m => m.code) : w === "low" ? mats.filter(m => state(m) !== "ok").map(m => m.code) : fd.getAll("p");
      if (!codes.length) return mErr(f, "No materials match. Pick at least one.");
      const c = { id: uid(), ts: Date.now(), by: me().name, status: "open", lines: codes.map(code => ({ code, expected: db.materials[code].qty, counted: null, res: "pending" })) };
      db.counts.push(c); save(); openCount = c.id; closeModal(); refresh();
    });
  },
  openCount: d => { openCount = d.id; renderCounts(); },
  backCounts: () => { openCount = null; renderCounts(); },
  sendCount: d => {
    const c = db.counts.find(x => x.id === d.id);
    $$("#v-counts input[data-i]").forEach(i => { const n = parseInt(i.value, 10); c.lines[+i.dataset.i].counted = Number.isNaN(n) ? null : Math.max(0, n); });
    c.lines.forEach(l => { if (l.counted !== null && l.counted === l.expected) l.res = "approved"; }); // matches need no approval
    c.status = "review"; settleCount(c);
  },
  approveLine: d => { const c = db.counts.find(x => x.id === d.id), l = c.lines.find(x => x.code === d.code); applyLine(c, l); settleCount(c); },
  rejectLine: d => { const c = db.counts.find(x => x.id === d.id), l = c.lines.find(x => x.code === d.code); l.res = "rejected"; settleCount(c); },
  approveAll: d => { const c = db.counts.find(x => x.id === d.id); c.lines.filter(l => l.counted !== null && l.res === "pending").forEach(l => applyLine(c, l)); settleCount(c); },
  rmAdmin: d => { db.admins = db.admins.filter(e => e !== d.e); save(); refresh(); },
  editMe: () => profile(false),
  mclose: closeModal,
};
document.addEventListener("click", e => { const b = e.target.closest("[data-act]"); if (b && A[b.dataset.act]) { e.preventDefault(); A[b.dataset.act](b.dataset, b); } });
$("#codeForm").addEventListener("submit", e => { e.preventDefault(); find($("#code").value); });

// ---------- start ----------
refresh();
if (!db.me) profile(true);
