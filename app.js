"use strict";
/* Material Scanner for Carr & Duff
   Shared database + sign-in via Supabase. Roles are enforced by the database (supabase/schema.sql);
   the app only hides buttons a person can't use. */

// ---------- tiny helpers ----------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = c => String(c || "").trim().toUpperCase();
const when = ts => new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const ICON = {
  hist: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20l4-1 11-11-3-3L5 16zM14 6l3 3"/></svg>',
  fix: '<svg viewBox="0 0 24 24"><rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 13l2 2 4-4"/></svg>',
  bar: '<svg viewBox="0 0 24 24"><path d="M4 5v14M8 5v14M12 5v14M15 5v14M20 5v14"/></svg>',
  move: '<svg viewBox="0 0 24 24"><path d="M4 8h13M13 4l4 4-4 4M20 16H7M11 12l-4 4 4 4"/></svg>',
  del: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
};

// ---------- state + backend ----------
const S = { me: null, locs: [], allLocs: [], dest: [], cur: null, materials: {}, scans: [], counts: [], team: [], uloc: {}, detail: null };
let sb = null;
const role = () => S.me?.role;
const isManager = () => role() === "manager" || role() === "admin";
const isAdmin = () => role() === "admin";
const unit = m => m.unit || "pcs";
const state = m => (m.qty <= 0 ? "out" : m.min > 0 && m.qty <= m.min ? "low" : "ok");
const mapScan = r => ({ other: r.other_location, loc: r.location_name, id: r.id, ts: Date.parse(r.ts), user: r.user_name, userId: r.user_id, code: r.code, name: r.name, unit: r.unit, type: r.type, delta: r.delta, after: r.after_qty, job: r.job, note: r.note });
const fail = e => toast(friendly(e), true);
const friendly = e => {
  const m = (e && e.message) || String(e);
  if (/Database error saving new user/i.test(m)) return "Only @carrduff.com work emails can sign up.";
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return "No connection. Check your signal and try again.";
  return m;
};
async function rpc(fn, args) { const { data, error } = await sb.rpc(fn, args); if (error) throw error; return data; }
async function ok(q) { const r = await q; if (r.error) throw r.error; return r.data; }

async function loadAll() {
  const mine = await rpc("my_locations");
  S.allLocs = mine;
  S.locs = mine.filter(l => l.active);
  if (!S.locs.some(l => l.id === S.cur)) S.cur = (S.locs.find(l => l.id === savedLoc()) || S.locs[0])?.id || null;
  S.dest = await ok(sb.from("locations").select("id,name").eq("active", true).order("name"));
  if (!S.cur) { S.materials = {}; S.scans = []; S.counts = []; }
  else {
    const [m, st, sc, c] = await Promise.all([
      ok(sb.from("materials").select("*").order("name")),
      ok(sb.from("stock").select("*").eq("location_id", S.cur)),
      ok(sb.from("scans").select("*").eq("location_id", S.cur).order("ts", { ascending: false }).limit(1000)),
      ok(sb.from("counts").select("*").eq("location_id", S.cur).order("created_at", { ascending: false })),
    ]);
    const at = {}; st.forEach(r => (at[r.material_code] = r));
    S.materials = {}; m.forEach(r => (S.materials[r.code] = { code: r.code, name: r.name, unit: r.unit, min: at[r.code]?.min_qty ?? 0, qty: at[r.code]?.qty ?? 0 }));
    S.scans = sc.map(mapScan);
    S.counts = c.map(r => ({ id: r.id, ts: Date.parse(r.created_at), by: r.by_name, status: r.status }));
  }
  if (isAdmin()) {
    S.team = await ok(sb.from("profiles").select("*").order("created_at"));
    S.uloc = {}; (await ok(sb.from("user_locations").select("*"))).forEach(r => (S.uloc[r.user_id] ||= []).push(r.location_id));
  }
}
let reloadTimer;
function liveReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => { try { await loadAll(); refresh({ quiet: true }); } catch { /* try again on next event */ } }, 400);
}
function subscribe() {
  const ch = sb.channel("live");
  ["materials", "stock", "scans", "counts", "locations", "user_locations"].forEach(t => ch.on("postgres_changes", { event: "*", schema: "public", table: t }, liveReload));
  ch.subscribe();
}
const curName = () => S.locs.find(l => l.id === S.cur)?.name || "";
const savedLoc = () => { try { return localStorage.getItem("loc:" + S.me.id); } catch { return null; } };
const saveLoc = id => { try { localStorage.setItem("loc:" + S.me.id, id); } catch { /* private mode */ } };
const canUndo = s => isManager() || (s.userId === S.me.id && Date.now() - s.ts < 15 * 60 * 1000);
async function undo(id) {
  try { await rpc("undo_scan", { p_id: id }); await loadAll(); refresh(); } catch (e) { fail(e); }
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
  toastTimer = setTimeout(() => (t.hidden = true), undoId ? 10000 : 5000);
}
function modal(html, onSubmit) {
  const d = $("#modal");
  d.innerHTML = `<form class="mb">${html}</form>`;
  const f = $("form", d);
  f.onsubmit = async e => {
    e.preventDefault();
    const btn = $(".btn.dark, .btn.danger", f);
    if (btn) btn.disabled = true;
    try { await (onSubmit && onSubmit(new FormData(f), f)); } catch (err) { mErr(f, friendly(err)); }
    if (btn && f.isConnected) btn.disabled = false;
  };
  if (!d.open) d.showModal();
  return f;
}
const closeModal = () => $("#modal").close();
const mErr = (f, msg) => { const e = $(".err", f); if (e) e.textContent = msg; };

// ---------- sign-in gate ----------
function gate(html) {
  const g = $("#gate");
  g.hidden = !html;
  g.innerHTML = html ? `<div class="box"><img src="assets/carr-duff-logo.png" alt="Carr &amp; Duff"><h1>Material Scanner</h1>${html}</div>` : "";
}
function authScreen(mode = "in", note = "") {
  const t = { in: "Sign in", up: "Create account", reset: "Reset password" }[mode];
  gate(`<p class="sub">${mode === "up" ? "Use your @carrduff.com email. An admin approves new accounts." : mode === "reset" ? "We'll email you a reset link." : "Sign in with your work email."}</p>
    <form class="card" id="authForm">
      ${mode === "up" ? '<label style="margin-top:0">Your name<input name="name" autocomplete="name" required></label>' : ""}
      <label ${mode === "up" ? "" : 'style="margin-top:0"'}>Work email<input name="email" type="email" autocomplete="email" inputmode="email" placeholder="name@carrduff.com" required></label>
      ${mode === "reset" ? "" : `<label>Password<input name="password" type="password" autocomplete="${mode === "up" ? "new-password" : "current-password"}" minlength="8" required></label>`}
      <div class="err" id="authErr">${esc(note)}</div>
      <button class="btn dark block" style="margin-top:14px">${t}</button>
    </form>
    <div class="alt">${mode === "in" ? '<button data-g="up">Create an account</button><button data-g="reset">Forgot password?</button>' : '<button data-g="in">Back to sign in</button>'}</div>`);
  $$("#gate [data-g]").forEach(b => (b.onclick = () => authScreen(b.dataset.g)));
  $("#authForm").onsubmit = async e => {
    e.preventDefault();
    const fd = new FormData(e.target), email = fd.get("email").trim().toLowerCase(), btn = $(".btn", e.target), err = $("#authErr");
    btn.disabled = true; err.className = "err"; err.textContent = "";
    try {
      if (mode === "in") {
        const { error } = await sb.auth.signInWithPassword({ email, password: fd.get("password") });
        if (error) throw error;
        await enter();
      } else if (mode === "up") {
        const { data, error } = await sb.auth.signUp({ email, password: fd.get("password"), options: { data: { name: fd.get("name").trim() }, emailRedirectTo: location.origin + location.pathname } });
        if (error) throw error;
        if (data.session) await enter();
        else { err.className = "ok"; err.textContent = "Check your email and tap the confirmation link, then sign in."; }
      } else {
        const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
        if (error) throw error;
        err.className = "ok"; err.textContent = "If that email has an account, a reset link is on its way.";
      }
    } catch (x) { err.textContent = /Invalid login/i.test(x.message) ? "Wrong email or password." : friendly(x); }
    btn.disabled = false;
  };
}
function newPasswordScreen() {
  gate(`<p class="sub">Choose a new password.</p><form class="card" id="pwForm"><label style="margin-top:0">New password<input name="p" type="password" minlength="8" autocomplete="new-password" required></label><div class="err" id="authErr"></div><button class="btn dark block" style="margin-top:14px">Save password</button></form>`);
  $("#pwForm").onsubmit = async e => {
    e.preventDefault();
    const { error } = await sb.auth.updateUser({ password: new FormData(e.target).get("p") });
    if (error) $("#authErr").textContent = friendly(error); else { history.replaceState(null, "", location.pathname); await enter(); }
  };
}
function pendingScreen(reason) {
  gate(`<div class="card"><h3>${reason === "off" ? "Account switched off" : reason === "noloc" ? "No location yet" : "Waiting for approval"}</h3>
    <p class="meta" style="font-size:15px">${reason === "off" ? "An admin has switched this account off." : reason === "noloc" ? "An admin needs to assign you to a location." : "Your account is created. An admin needs to approve it and give you a role."} Signed in as ${esc(S.me.email)}.</p>
    <div class="row" style="margin-top:16px"><button class="btn light" id="gSignOut">Sign out</button><button class="btn dark grow" id="gCheck">Check again</button></div></div>`);
  $("#gSignOut").onclick = signOut;
  $("#gCheck").onclick = () => enter();
}
async function signOut() { await sb.auth.signOut(); location.reload(); }

async function enter() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return authScreen("in");
  const { data: p, error } = await sb.from("profiles").select("*").eq("id", user.id).single();
  if (error || !p) { authScreen("in", "Couldn't load your account. Try signing in again."); return; }
  S.me = { id: p.id, name: p.name, email: p.email, role: p.active ? p.role : "pending", off: !p.active };
  if (S.me.role === "pending") return pendingScreen(S.me.off ? "off" : "pending");
  try { await loadAll(); } catch (e) { return authScreen("in", friendly(e)); }
  if (!S.cur && !isAdmin()) return pendingScreen("noloc");
  gate("");
  if (!enter.live) { subscribe(); enter.live = true; }
  showTab("scan");
}

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
function refresh(opts = {}) {
  if (!S.me) return;
  const lb = $("#locBar"), here = S.locs.find(l => l.id === S.cur);
  lb.innerHTML = here ? `<button ${S.locs.length > 1 ? 'data-act="pickLoc"' : ""} class="loc"><svg viewBox="0 0 24 24"><path d="M12 21s7-6.2 7-11a7 7 0 0 0-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/></svg><span>${esc(here.name)}</span>${S.locs.length > 1 ? "<small>Change</small>" : ""}</button>` : "";
  $("#av").textContent = (S.me.name || "?").split(/\s+/).map(w => w[0]).slice(0, 2).join("").toUpperCase();
  $("#meName").textContent = S.me.name;
  $("#jobs").innerHTML = [...new Set(S.scans.map(s => s.job).filter(Boolean))].slice(0, 30).map(j => `<option value="${esc(j)}">`).join("");
  if (opts.quiet && tab === "counts" && openCount && S.detail?.status === "open") return; // don't wipe numbers being typed
  if (opts.quiet && document.activeElement && /INPUT|SELECT/.test(document.activeElement.tagName) && ["stock", "history", "team"].includes(tab)) return;
  ({ scan: renderScan, stock: renderStock, history: renderHistory, counts: renderCounts, team: renderTeam, help() {} })[tab]();
}

// ---------- SCAN ----------
function renderScan() {
  $("#mode").className = "seg " + mode;
  $$("#mode button").forEach(b => b.classList.toggle("on", b.dataset.m === mode));
  const low = Object.values(S.materials).filter(m => m.min > 0 && m.qty <= m.min).sort((a, b) => a.qty - b.qty);
  $("#lowList").innerHTML = low.length
    ? low.map(m => `<div class="item"><div><div class="nm">${esc(m.name)}</div><div class="meta">Min ${m.min} ${esc(unit(m))}</div></div><span class="pill ${state(m)}">${m.qty}</span></div>`).join("")
    : '<div class="empty">Nothing is running low.</div>';
  const rec = S.scans.slice(0, 5);
  $("#recent").innerHTML = rec.length
    ? rec.map(s => `<div class="item"><div><div class="nm">${esc(s.name)}</div><div class="meta">${label(s)} &middot; ${when(s.ts)}${s.job ? " &middot; " + esc(s.job) : ""}</div></div></div>`).join("")
    : '<div class="empty">No scans yet.</div>';
}
const label = s => s.type === "transfer" ? (s.delta < 0 ? `Sent ${Math.abs(s.delta)} ${esc(s.unit)} to ${esc(s.other)}` : `Received ${s.delta} ${esc(s.unit)} from ${esc(s.other)}`) : s.type === "fix" ? `Count fix ${s.delta >= 0 ? "+" : ""}${s.delta}` : `${s.type === "in" ? "Checked in" : "Checked out"} ${Math.abs(s.delta)} ${esc(s.unit)}`;

function find(raw) {
  const code = norm(raw);
  if (!code) return;
  const m = S.materials[code];
  const box = $("#scanPanel");
  if (!m) {
    box.innerHTML = `<div class="card"><div class="top2"><div><h3>Code not found</h3><div class="meta">${esc(code)} isn't in the material list yet.${isManager() ? " Add it now." : " Ask a manager to add it."}</div></div><button class="x" data-act="clearPanel">&#10005;</button></div>
      ${isManager() ? `<button class="btn dark block" style="margin-top:14px" data-act="addNew" data-code="${esc(code)}">Add this material</button>` : ""}</div>`;
    return;
  }
  box.innerHTML = `<div class="card"><div class="top2"><div><h3>${esc(m.name)}</h3><div class="meta">${esc(m.code)} &middot; On hand ${m.qty} ${esc(unit(m))}</div></div><button class="x" data-act="clearPanel">&#10005;</button></div>
    <div class="stepper"><button type="button" data-act="step" data-d="-1">&minus;</button><input id="qty" type="number" inputmode="numeric" min="1" value="1"><button type="button" data-act="step" data-d="1">+</button></div>
    <label>Job or reason<input id="job" list="jobs" value="${esc(lastJob)}" placeholder="e.g. Smith Elementary"></label>
    <label>Note (optional)<input id="note"></label>
    <button class="go ${mode}" id="go" data-act="commit" data-code="${esc(m.code)}"></button>
    ${S.dest.length > 1 ? `<button class="btn light block" style="margin-top:10px" data-act="transfer" data-code="${esc(m.code)}">${ICON.move}Transfer to another location</button>` : ""}</div>`;
  goLabel();
  $("#qty").oninput = goLabel;
}
let lastJob = "";
function goLabel() {
  const q = parseInt($("#qty")?.value, 10) || 0;
  const g = $("#go"); if (!g) return;
  g.textContent = `${mode === "in" ? "Check in" : "Check out"} ${q} ${unit(S.materials[g.dataset.code])}`;
}
async function commit(code) {
  const m = S.materials[code];
  const q = parseInt($("#qty").value, 10);
  if (!(q > 0)) return toast("Enter a quantity above 0.", true);
  if (mode === "out" && q > m.qty) return toast(`Only ${m.qty} ${unit(m)} on hand.`, true);
  const go = $("#go"); go.disabled = true;
  try {
    lastJob = $("#job").value.trim();
    const s = await rpc("record_scan", { p_code: code, p_type: mode, p_qty: q, p_job: lastJob, p_note: $("#note").value.trim(), p_location: S.cur });
    await loadAll();
    $("#scanPanel").innerHTML = ""; $("#code").value = "";
    toast(`${mode === "in" ? "Checked in" : "Checked out"} ${q} ${unit(m)}. ${S.materials[code].qty} on hand.`, false, s.id);
    refresh();
  } catch (e) { fail(e); go.disabled = false; await loadAll().then(() => refresh()).catch(() => {}); }
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
  const all = Object.values(S.materials);
  const low = all.filter(m => state(m) === "low").length, out = all.filter(m => state(m) === "out").length;
  const q = stockQ.toLowerCase();
  const rank = { out: 0, low: 1, ok: 2 };
  const rows = all.filter(m => (!lowOnly || state(m) !== "ok") && (!q || (m.code + " " + m.name).toLowerCase().includes(q)))
    .sort((a, b) => rank[state(a)] - rank[state(b)] || a.name.localeCompare(b.name));
  const mg = isManager();
  $("#v-stock").innerHTML = `
    <h2 class="first">Stock</h2><p class="sub">What's on hand at ${esc(curName())} right now.</p>
    <div class="row wrap">
      ${mg ? `<button class="btn light sm" data-act="exportStock">Export stock</button><button class="btn light sm" data-act="import">Import counts</button><button class="btn light sm" data-act="labels">Print labels</button><button class="btn dark sm" data-act="addNew">+ Add material</button>` : ""}
    </div>
    <div class="tiles"><div><small>Materials</small><b>${all.length}</b></div><div><small>Low on stock</small><b class="lowv">${low}</b></div><div><small>Out of stock</small><b class="outv">${out}</b></div></div>
    <div class="find" style="margin-top:0"><input id="stockQ" placeholder="Search by name or code" value="${esc(stockQ)}"><button class="btn light" data-act="lowOnly" style="${lowOnly ? "background:var(--brand);color:#fff" : ""}">Low only</button></div>
    ${rows.length ? rows.map(m => `<div class="mat"><div class="head"><div><div class="nm" style="font:600 18px Barlow,Inter,sans-serif">${esc(m.name)}</div><div class="meta">${esc(m.code)}</div></div>
      <div class="qn">${m.qty} <small>${esc(unit(m))}</small>${state(m) !== "ok" ? `<div><span class="tag ${state(m)}">${state(m) === "out" ? "Out" : "Low"}</span></div>` : ""}</div></div>
      <div class="acts"><button data-act="matHist" data-code="${esc(m.code)}">${ICON.hist}History</button>${S.dest.length > 1 && m.qty > 0 ? `<button data-act="transfer" data-code="${esc(m.code)}">${ICON.move}Transfer</button>` : ""}
      ${mg ? `<button data-act="edit" data-code="${esc(m.code)}">${ICON.edit}Edit</button><button data-act="fix" data-code="${esc(m.code)}">${ICON.fix}Correct count</button><button data-act="labels" data-code="${esc(m.code)}">${ICON.bar}Label</button><button class="del" data-act="del" data-code="${esc(m.code)}">${ICON.del}Delete</button>` : ""}</div></div>`).join("")
      : `<div class="empty"><b>${all.length ? "No matches" : "No materials yet"}</b>${all.length ? "Try a different search." : mg ? "Add a material, scan a new label, or import a spreadsheet." : "A manager needs to add materials first."}</div>`}`;
  $("#stockQ").oninput = e => { stockQ = e.target.value; const p = e.target.selectionStart; renderStock(); const i = $("#stockQ"); i.focus(); i.setSelectionRange(p, p); };
}
function materialForm(code, existing) {
  const m = existing || { code, name: "", unit: "pcs", min: 0, qty: 0 };
  const f = modal(`<h3>${existing ? "Edit material" : "Add material"}</h3>
    <label>Code<input name="code" value="${esc(m.code)}" ${existing ? "readonly" : 'autocapitalize="characters"'} required></label>
    <label>Name<input name="name" value="${esc(m.name)}" placeholder='e.g. 1/2" EMT conduit' required></label>
    <div class="row"><label class="grow" style="margin-top:12px">Unit<input name="unit" value="${esc(m.unit)}" placeholder="pcs, ft, box"></label>
    <label class="grow" style="margin-top:12px">Low stock at (here)<input name="min" type="number" inputmode="numeric" min="0" value="${m.min}"></label></div>
    ${existing ? "" : `<label>Starting count at ${esc(curName())}<input name="qty" type="number" inputmode="numeric" min="0" value="0"></label>`}
    <div class="err"></div>
    <div class="row"><button type="button" class="btn light" data-act="mclose">Cancel</button><button class="btn dark">Save</button></div>`,
    async fd => {
      const c = norm(fd.get("code")), name = fd.get("name").trim(), u = fd.get("unit").trim() || "pcs", min = Math.max(0, parseInt(fd.get("min"), 10) || 0);
      if (!c || !name) return mErr(f, "Code and name are required.");
      if (existing) { await ok(sb.from("materials").update({ name, unit: u }).eq("code", c)); await rpc("set_min", { p_code: c, p_location: S.cur, p_min: min }); }
      else {
        if (S.materials[c]) return mErr(f, "That code already exists.");
        await ok(sb.from("materials").insert({ code: c, name, unit: u }));
        await rpc("set_min", { p_code: c, p_location: S.cur, p_min: min });
        const q = parseInt(fd.get("qty"), 10) || 0;
        if (q > 0) await rpc("correct_count", { p_code: c, p_location: S.cur, p_new: q, p_note: "Starting count" });
      }
      await loadAll(); closeModal();
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
    const ci = col("code"), ni = col("name"), qi = col("count", "qty", "quantity", "on hand"), ui = col("unit"), mi = col("low stock at", "min", "minimum"), li = col("location");
    if (ci < 0) return toast("The file needs a Code column.", true);
    const byName = {}; S.locs.forEach(l => (byName[l.name.trim().toLowerCase()] = l.id));
    const bad = new Set(), plan = {};
    rows.slice(1).forEach(row => {
      const code = norm(row[ci]); if (!code) return;
      const ln = li >= 0 ? (row[li] || "").trim() : "";
      const loc = ln ? byName[ln.toLowerCase()] : S.cur;
      if (!loc) { bad.add(ln); return; }
      const cnt = qi >= 0 && row[qi]?.trim() !== "" ? parseInt(row[qi], 10) : null;
      const min = mi >= 0 && row[mi]?.trim() !== "" ? parseInt(row[mi], 10) : null;
      plan[code + "|" + loc] = { code, loc, name: ni >= 0 ? row[ni].trim() : "", unit: ui >= 0 ? row[ui].trim() : "", min: Number.isNaN(min) ? null : min, cnt: Number.isNaN(cnt) ? null : cnt };
    });
    if (bad.size) return toast(`Unknown location in the file: ${[...bad].join(", ")}. Use the exact location names.`, true);
    const list = Object.values(plan);
    const codes = [...new Set(list.map(p => p.code))];
    const fresh = codes.filter(c => !S.materials[c]).length;
    modal(`<h3>Import preview</h3><p class="meta">${codes.length} materials (${fresh} new, ${codes.length - fresh} existing) across ${new Set(list.map(p => p.loc)).size} location(s). Rows without a Location go to ${esc(curName())}. Counts replace what's on hand and show in History as count fixes.</p><div class="err"></div>
      <div class="row"><button type="button" class="btn light" data-act="mclose">Cancel</button><button class="btn dark">Import</button></div>`, async () => {
      const first = {}; list.forEach(p => { first[p.code] ||= p; });
      const news = codes.filter(c => !S.materials[c]).map(c => first[c]);
      if (news.length) await ok(sb.from("materials").insert(news.map(p => ({ code: p.code, name: p.name || p.code, unit: p.unit || "pcs" }))));
      for (const p of Object.values(first).filter(p => S.materials[p.code])) {
        const patch = {}; if (p.name) patch.name = p.name; if (p.unit) patch.unit = p.unit;
        if (Object.keys(patch).length) await ok(sb.from("materials").update(patch).eq("code", p.code));
      }
      const here = {}; list.forEach(p => { if (p.loc === S.cur) here[p.code] = S.materials[p.code]?.qty ?? 0; });
      for (const p of list) {
        if (p.min !== null) await rpc("set_min", { p_code: p.code, p_location: p.loc, p_min: p.min });
        const cur = p.loc === S.cur ? here[p.code] : null;
        if (p.cnt !== null && p.cnt !== cur) await rpc("correct_count", { p_code: p.code, p_location: p.loc, p_new: p.cnt, p_note: "Imported count" });
      }
      await loadAll(); closeModal(); toast(`Imported ${list.length} rows.`); refresh();
    });
  };
  r.readAsText(file);
}

// ---------- LABELS (barcode generator) ----------
const parseCodes = txt => [...new Set(txt.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean))].slice(0, 200);
// A scanner needs bars of at least ~0.33 mm. A half-width label is ~87 mm wide, a full-width one ~188 mm.
// So codes needing more than 260 modules go full width, and more than 560 modules can't be made reliable.
function labelHTML(code) {
  const m = S.materials[norm(code)] || S.materials[code];
  try {
    const w = Code128.width(code);
    if (w > 560) throw new Error("Too long to print as a reliable barcode (about 50 characters max).");
    return `<div class="lbl${w > 260 ? " wide" : ""}"><div class="ln">${esc(m ? m.name : "")}</div>${Code128.svg(code, { module: 2, height: 60 })}<div class="lc">${esc(code)}</div></div>`;
  } catch (e) { return `<div class="lbl bad">${esc(code)}<br>${esc(e.message)}</div>`; }
}
function labelsModal(prefill) {
  const f = modal(`<h3>Barcode labels</h3><p class="meta">Type or paste SKUs, one per line. Each becomes a Code 128 barcode that the camera and Bluetooth scanners can read. Names appear when the SKU is in Stock.</p>
    <label>SKUs<textarea id="lblCodes" placeholder="PVC200&#10;EMT-050">${esc(prefill || "")}</textarea></label>
    <div class="row wrap" style="margin-top:8px"><button type="button" class="btn light sm" data-act="lblAll">Add all materials</button><button type="button" class="btn light sm" data-act="lblClear">Clear</button></div>
    <div class="lblprev" id="lblPrev"></div><div class="err"></div>
    <div class="row"><button type="button" class="btn light" data-act="mclose">Close</button><button class="btn dark">Print</button></div>`,
  () => {
    const codes = parseCodes($("#lblCodes").value);
    if (!codes.length) return mErr(f, "Enter at least one SKU.");
    $("#printArea").innerHTML = codes.map(labelHTML).join("");
    document.body.classList.add("printing");
    window.addEventListener("afterprint", () => document.body.classList.remove("printing"), { once: true });
    window.print();
  });
  const upd = () => { $("#lblPrev").innerHTML = parseCodes($("#lblCodes").value).map(labelHTML).join(""); };
  $("#lblCodes").oninput = upd; upd();
}

// ---------- HISTORY ----------
function renderHistory() {
  const q = histQ.toLowerCase();
  const rows = S.scans.filter(s => (histFilter === "all" || s.type === histFilter) && (!q || [s.name, s.code, s.job, s.user, s.note].join(" ").toLowerCase().includes(q)));
  $("#v-history").innerHTML = `
    <div class="top2"><div><h2 class="first">History</h2><p class="sub">Every check-in, check-out, transfer and count correction at this location.</p></div>
    ${isManager() ? '<button class="btn light sm" data-act="exportHist">Export CSV</button>' : ""}</div>
    <input id="histQ" placeholder="Search material, code, job or person" value="${esc(histQ)}">
    <div class="chips">${[["all", "All"], ["in", "In"], ["out", "Out"], ["transfer", "Transfers"], ["fix", "Fixes"]].map(([k, l]) => `<button data-act="hf" data-k="${k}" class="${histFilter === k ? "on" : ""}">${l}</button>`).join("")}</div>
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
  const c = S.counts.find(x => x.id === openCount);
  if (c) return renderCountDetail(c, v);
  const grp = st => S.counts.filter(c => c.status === st);
  const card = c => `<div class="card" data-act="openCount" data-id="${c.id}" style="cursor:pointer"><div class="top2"><div><h3>${cname(c)}</h3><div class="meta">Started by ${esc(c.by)}</div></div><span class="badge ${c.status === "review" ? "wait" : ""}">${{ open: "Counting", review: "Needs approval", done: "Done" }[c.status]}</span></div></div>`;
  v.innerHTML = `<div class="top2"><div><h2 class="first">Counts</h2><p class="sub">Count what's on the shelf at ${esc(curName())}. Expected numbers stay hidden. A manager approves the differences.</p></div>
    ${isManager() ? '<button class="btn dark sm" data-act="newCount">+ New count</button>' : ""}</div>
    ${S.counts.length ? ["review", "open", "done"].map(st => grp(st).map(card).join("")).join("")
      : `<div class="empty"><b>No counts yet</b>${isManager() ? 'Start a count, pick the materials, then count what is on the shelf.<br><button class="btn light" data-act="newCount">Start a count</button>' : "A manager starts a count and it shows up here."}</div>`}`;
}
async function loadDetail(c) {
  S.detail = { id: c.id, status: c.status, lines: [], loading: true };
  renderCounts();
  try {
    let lines;
    if (c.status === "open") lines = await rpc("count_lines_for_counter", { p_count: c.id });
    else if (isManager()) lines = await ok(sb.from("count_lines").select("*").eq("count_id", c.id));
    else lines = [];
    S.detail = { id: c.id, status: c.status, lines: lines || [] };
  } catch (e) { fail(e); S.detail = { id: c.id, status: c.status, lines: [] }; }
  if (openCount === c.id) renderCounts();
}
function renderCountDetail(c, v) {
  const d = S.detail && S.detail.id === c.id ? S.detail : null;
  const back = `<button class="btn light sm" data-act="backCounts">&larr; Back</button>`;
  if (!d || d.loading) { v.innerHTML = `${back}<h2>${cname(c)}</h2><div class="empty">Loading&hellip;</div>`; return; }
  const nm = code => esc(S.materials[code]?.name || code);
  if (c.status === "open") {
    v.innerHTML = `${back}<h2>${cname(c)}</h2><p class="sub">Enter what's on the shelf. Leave blank to skip a material.</p>
      <div class="card cnt"><table>${d.lines.map(l => `<tr><td>${esc(l.name || l.code)}<div class="meta">${esc(l.code)}</div></td><td style="text-align:right"><input data-id="${l.id}" type="number" inputmode="numeric" min="0" value="${l.counted ?? ""}"></td></tr>`).join("")}</table></div>
      <button class="btn dark block" style="margin-top:14px" data-act="sendCount" data-id="${c.id}">Send for approval</button>`;
  } else if (!isManager()) {
    v.innerHTML = `${back}<h2>${cname(c)}</h2><div class="empty"><b>${c.status === "done" ? "Finished" : "Sent for approval"}</b>${c.status === "done" ? "A manager has reviewed this count." : "A manager will review the differences."}</div>`;
  } else {
    const rows = d.lines.filter(l => l.counted !== null);
    v.innerHTML = `${back}<h2>${cname(c)}</h2><p class="sub">${c.status === "done" ? "Finished." : "Approve sets stock to the counted number. Reject leaves it alone."}</p>
      <div class="card cnt"><table><tr><th>Material</th><th>Expected</th><th>Counted</th><th>Diff</th></tr>${rows.map(l => { const df = l.counted - l.expected; return `<tr><td>${nm(l.code)}</td><td>${l.expected}</td><td>${l.counted}</td><td>${df > 0 ? "+" : ""}${df}</td></tr>${l.res === "pending" ? `<tr><td colspan="4"><button class="btn dark sm" data-act="approveLine" data-id="${l.id}">Approve</button> <button class="btn light sm" data-act="rejectLine" data-id="${l.id}">Reject</button></td></tr>` : `<tr><td colspan="4" class="meta">${l.res === "rejected" ? "Rejected" : "Approved"}</td></tr>`}`; }).join("") || '<tr><td class="meta">Nothing was counted.</td></tr>'}</table></div>
      ${c.status === "review" ? `<button class="btn dark block" style="margin-top:14px" data-act="approveAll" data-id="${c.id}">Approve all</button>` : ""}`;
  }
}
async function afterCountChange() {
  await loadAll();
  const c = S.counts.find(x => x.id === openCount);
  if (c) await loadDetail(c); else refresh();
}

// ---------- TEAM ----------
const ROLE_NOTE = {
  warehouse: "You can scan material in and out, see stock and history, and count.",
  manager: "You can also add and edit materials, correct counts, approve counts, import and export.",
  admin: "You can do everything, including approving people and setting roles.",
};
function renderTeam() {
  const me = `<div class="card"><div class="top2"><div><h3>${esc(S.me.name)}</h3><div class="meta">${esc(S.me.email)}</div></div><span class="role">${esc(role())}</span></div><p class="meta" style="margin-top:10px">${ROLE_NOTE[role()]}</p></div>`;
  if (!isAdmin()) { $("#v-team").innerHTML = `<h2 class="first">Team</h2><p class="sub">Your access.</p>${me}<p class="meta" style="margin-top:12px">Locations: ${S.locs.map(l => esc(l.name)).join(", ") || "none yet"}</p>`; return; }
  const sorted = [...S.team].sort((a, b) => (a.role === "pending" ? -1 : 0) - (b.role === "pending" ? -1 : 0) || a.name.localeCompare(b.name));
  const lname = id => S.allLocs.find(l => l.id === id)?.name;
  $("#v-team").innerHTML = `<h2 class="first">Team</h2><p class="sub">New sign-ups wait here until you give them a role and a location. Warehouse scans and counts. Manager also edits stock and approves counts. Admin also manages people and locations.</p>${me}
    <div class="top2 ctr"><h2 style="margin-bottom:0">Locations</h2><button class="btn dark sm" data-act="locForm">+ Add location</button></div>
    ${S.allLocs.map(l => `<div class="item"><div><div class="nm">${esc(l.name)} ${l.active ? "" : '<span class="role pending">Off</span>'}</div></div><button class="btn light sm" data-act="locForm" data-id="${l.id}">Edit</button></div>`).join("")}
    <h2>People</h2>
    ${sorted.map(p => `<div class="item"><div><div class="nm">${esc(p.name)} ${p.role === "pending" ? '<span class="role pending">Needs approval</span>' : ""}${p.active ? "" : ' <span class="role pending">Off</span>'}</div><div class="meta">${esc(p.email)}</div>
      ${p.role === "admin" ? '<div class="meta">All locations</div>' : p.role === "pending" ? "" : `<button class="link" data-act="userLocs" data-id="${p.id}">${(S.uloc[p.id] || []).map(lname).filter(Boolean).map(esc).join(", ") || "No locations. Tap to assign"}</button>`}</div>
      ${p.id === S.me.id ? '<span class="role">You</span>' : `<select class="rsel" data-act="setRole" data-id="${p.id}">${["pending", "warehouse", "manager", "admin"].map(r => `<option value="${r}" ${p.role === r ? "selected" : ""}>${r === "pending" ? "No access" : r[0].toUpperCase() + r.slice(1)}</option>`).join("")}<option value="off" ${!p.active ? "selected" : ""}>Switch off</option></select>`}</div>`).join("")}`;
}

// ---------- profile ----------
function profile() {
  modal(`<h3>${esc(S.me.name)}</h3><p class="meta">${esc(S.me.email)}</p><p style="margin-top:10px"><span class="role">${esc(role())}</span></p><p class="meta" style="margin-top:10px">${ROLE_NOTE[role()]}</p>
    <div class="row"><button type="button" class="btn light" data-act="mclose">Close</button><button type="button" class="btn dark" data-act="signOut">Sign out</button></div>`);
}

// ---------- events ----------
const run = fn => async (...a) => { try { await fn(...a); } catch (e) { fail(e); } };
const A = {
  tab: d => showTab(d.t),
  mode: d => { mode = d.m; renderScan(); const g = $("#go"); if (g) { g.className = "go " + mode; goLabel(); } },
  startCam, stopCam,
  clearPanel: () => ($("#scanPanel").innerHTML = ""),
  step: d => { const q = $("#qty"); q.value = Math.max(1, (parseInt(q.value, 10) || 1) + +d.d); goLabel(); },
  commit: d => commit(d.code),
  undo: async d => { $("#toast").hidden = true; await undo(d.id); },
  addNew: d => materialForm(d.code),
  edit: d => materialForm(d.code, S.materials[d.code]),
  matHist: d => { histQ = d.code; histFilter = "all"; showTab("history"); },
  fix: d => {
    const m = S.materials[d.code];
    const f = modal(`<h3>Correct count</h3><p class="meta">${esc(m.name)} &middot; currently ${m.qty} ${esc(unit(m))}</p>
      <label>What's really on the shelf<input name="n" type="number" inputmode="numeric" min="0" value="${m.qty}" required></label><div class="err"></div>
      <div class="row"><button type="button" class="btn light" data-act="mclose">Cancel</button><button class="btn dark">Save</button></div>`, async fd => {
      const n = parseInt(fd.get("n"), 10); if (Number.isNaN(n) || n < 0) return mErr(f, "Enter a number, 0 or higher.");
      if (n !== m.qty) await rpc("correct_count", { p_code: d.code, p_location: S.cur, p_new: n });
      await loadAll(); closeModal(); refresh();
    });
  },
  del: d => {
    const m = S.materials[d.code];
    modal(`<h3>Delete ${esc(m.name)}?</h3><p class="meta">The material is removed from Stock. Its scans stay in History.</p><div class="err"></div>
      <div class="row"><button type="button" class="btn light" data-act="mclose">Cancel</button><button class="btn danger">Delete</button></div>`, async () => { await ok(sb.from("materials").delete().eq("code", d.code)); await loadAll(); closeModal(); refresh(); });
  },
  lowOnly: () => { lowOnly = !lowOnly; renderStock(); },
  exportStock: () => download("stock.csv", toCSV([["Code", "Name", "Count", "Unit", "Low stock at", "Location"], ...Object.values(S.materials).map(m => [m.code, m.name, m.qty, unit(m), m.min, curName()])])),
  exportHist: () => download("history.csv", toCSV([["Time", "Location", "Person", "Type", "Code", "Material", "Change", "Unit", "Job", "Note"], ...S.scans.map(s => [new Date(s.ts).toISOString(), s.loc || "", s.user, s.type, s.code, s.name, s.delta, s.unit, s.job || "", s.note || ""])])),
  labels: d => labelsModal(d.code || ""),
  lblAll: () => { $("#lblCodes").value = Object.keys(S.materials).join("\n"); $("#lblCodes").dispatchEvent(new Event("input")); },
  lblClear: () => { $("#lblCodes").value = ""; $("#lblCodes").dispatchEvent(new Event("input")); },
  import: () => {
    modal(`<h3>Import counts</h3><p class="meta">Choose a CSV with these headings: Code, Name, Count, Unit, Low stock at, Location. Only Code is required. Leave Location blank to use the location you are in.</p>
      <input id="file" type="file" accept=".csv,text/csv" style="padding-top:12px">
      <div class="row"><button type="button" class="btn light" data-act="sheet">Download count sheet</button><button type="button" class="btn light" data-act="mclose">Cancel</button></div>`);
    $("#file").onchange = e => e.target.files[0] && importFlow(e.target.files[0]);
  },
  sheet: () => download("count-sheet.csv", toCSV([["Code", "Name", "Count", "Unit", "Low stock at", "Location"], ["EXAMPLE-001", "1/2 in EMT conduit", 100, "ft", 20, curName()]])),
  hf: d => { histFilter = d.k; renderHistory(); },
  newCount: () => {
    const mats = Object.values(S.materials);
    if (!mats.length) return toast("Add some materials first.", true);
    const f = modal(`<h3>New count</h3>
      <div class="radio" style="margin-top:12px"><label><input type="radio" name="w" value="all" checked> All materials</label><label style="margin-top:10px"><input type="radio" name="w" value="low"> Low stock only</label><label style="margin-top:10px"><input type="radio" name="w" value="pick"> Pick materials</label></div>
      <div class="pick">${mats.map(m => `<label><input type="checkbox" name="p" value="${esc(m.code)}">${esc(m.name)}</label>`).join("")}</div><div class="err"></div>
      <div class="row"><button type="button" class="btn light" data-act="mclose">Cancel</button><button class="btn dark">Start count</button></div>`, async fd => {
      const w = fd.get("w"); const codes = w === "all" ? mats.map(m => m.code) : w === "low" ? mats.filter(m => state(m) !== "ok").map(m => m.code) : fd.getAll("p");
      if (!codes.length) return mErr(f, "No materials match. Pick at least one.");
      openCount = await rpc("create_count", { p_location: S.cur, p_codes: codes });
      await loadAll(); closeModal(); S.detail = null;
      const c = S.counts.find(x => x.id === openCount); if (c) await loadDetail(c); else refresh();
    });
  },
  openCount: d => { openCount = d.id; const c = S.counts.find(x => x.id === d.id); S.detail = null; loadDetail(c); },
  backCounts: () => { openCount = null; S.detail = null; renderCounts(); },
  sendCount: async d => {
    const lines = $$("#v-counts input[data-id]").map(i => ({ id: i.dataset.id, counted: i.value === "" ? null : Math.max(0, parseInt(i.value, 10) || 0) }));
    await rpc("submit_count", { p_count: d.id, p_lines: lines });
    toast("Sent for approval."); await afterCountChange();
  },
  approveLine: async d => { await rpc("resolve_line", { p_line: d.id, p_approve: true }); await afterCountChange(); },
  rejectLine: async d => { await rpc("resolve_line", { p_line: d.id, p_approve: false }); await afterCountChange(); },
  approveAll: async d => { await rpc("approve_all", { p_count: d.id }); await afterCountChange(); },
  pickLoc: () => modal(`<h3>Where are you?</h3><div class="list" style="margin-top:12px">${S.locs.map(l => `<button type="button" class="btn ${l.id === S.cur ? "dark" : "light"} block" style="margin-top:8px" data-act="setLoc" data-id="${l.id}">${esc(l.name)}</button>`).join("")}</div>`),
  setLoc: async d => { S.cur = d.id; saveLoc(d.id); openCount = null; S.detail = null; histQ = ""; $("#scanPanel").innerHTML = ""; closeModal(); await loadAll(); refresh(); },
  transfer: d => {
    const m = S.materials[d.code], dests = S.dest.filter(l => l.id !== S.cur);
    if (!dests.length) return toast("There's no other location to send to yet.", true);
    const f = modal(`<h3>Transfer ${esc(m.name)}</h3><p class="meta">${esc(curName())} has ${m.qty} ${esc(unit(m))}. It moves right away and both locations update.</p>
      <label>Send to<select name="to">${dests.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join("")}</select></label>
      <label>Quantity<input name="q" type="number" inputmode="numeric" min="1" value="1" required></label>
      <label>Note (optional)<input name="note"></label><div class="err"></div>
      <div class="row"><button type="button" class="btn light" data-act="mclose">Cancel</button><button class="btn dark">Transfer</button></div>`, async fd => {
      const q = parseInt(fd.get("q"), 10), to = fd.get("to");
      if (!(q > 0)) return mErr(f, "Enter a quantity above 0.");
      if (q > m.qty) return mErr(f, `Only ${m.qty} ${unit(m)} on hand here.`);
      await rpc("transfer_stock", { p_code: d.code, p_from: S.cur, p_to: to, p_qty: q, p_note: (fd.get("note") || "").trim() });
      await loadAll(); closeModal(); $("#scanPanel").innerHTML = ""; $("#code").value = "";
      toast(`Sent ${q} ${unit(m)} to ${dests.find(l => l.id === to).name}.`); refresh();
    });
  },
  locForm: d => {
    const l = d.id ? S.allLocs.find(x => x.id === d.id) : null;
    const f = modal(`<h3>${l ? "Edit location" : "Add location"}</h3>
      <label>Name<input name="n" value="${esc(l?.name || "")}" placeholder="e.g. 2100 Byberry" required></label>
      ${l ? `<label style="display:flex;gap:10px;align-items:center;margin-top:14px"><input type="checkbox" name="a" style="width:auto;min-height:0" ${l.active ? "checked" : ""}> Active (uncheck to switch it off)</label>` : ""}
      <div class="err"></div><div class="row"><button type="button" class="btn light" data-act="mclose">Cancel</button><button class="btn dark">Save</button></div>`, async fd => {
      const n = (fd.get("n") || "").trim(); if (!n) return mErr(f, "Enter a name.");
      if (l) await rpc("update_location", { p_id: l.id, p_name: n, p_active: !!fd.get("a") }); else await rpc("create_location", { p_name: n });
      await loadAll(); closeModal(); refresh();
    });
  },
  userLocs: d => {
    const p = S.team.find(x => x.id === d.id), have = S.uloc[d.id] || [];
    modal(`<h3>${esc(p.name)}</h3><p class="meta">Pick every location this person can work in.</p>
      <div class="pick" style="max-height:none">${S.allLocs.filter(l => l.active).map(l => `<label><input type="checkbox" name="l" value="${l.id}" ${have.includes(l.id) ? "checked" : ""}>${esc(l.name)}</label>`).join("")}</div><div class="err"></div>
      <div class="row"><button type="button" class="btn light" data-act="mclose">Cancel</button><button class="btn dark">Save</button></div>`, async fd => {
      await rpc("set_user_locations", { p_user: d.id, p_locations: fd.getAll("l") });
      await loadAll(); closeModal(); renderTeam(); toast("Saved.");
    });
  },
  editMe: profile,
  signOut,
  mclose: closeModal,
};
document.addEventListener("click", e => { const b = e.target.closest("[data-act]"); if (b && b.tagName !== "SELECT" && A[b.dataset.act]) { e.preventDefault(); run(A[b.dataset.act])(b.dataset, b); } });
document.addEventListener("change", run(async e => {
  const s = e.target.closest("select[data-act=setRole]"); if (!s) return;
  const off = s.value === "off";
  await rpc("set_role", { p_user: s.dataset.id, p_role: off ? "pending" : s.value, p_active: !off });
  await loadAll(); renderTeam(); toast("Saved.");
}));
$("#codeForm").addEventListener("submit", e => { e.preventDefault(); find($("#code").value); });

// ---------- start ----------
(async function boot() {
  if (!window.supabase) { gate('<div class="card"><h3>Can\'t reach the service</h3><p class="meta">Check your connection and reload the page.</p></div>'); return; }
  sb = window.supabase.createClient(window.APP_CONFIG.url, window.APP_CONFIG.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  sb.auth.onAuthStateChange(ev => { if (ev === "PASSWORD_RECOVERY") newPasswordScreen(); });
  const { data: { session } } = await sb.auth.getSession();
  if (session) await enter(); else authScreen("in");
})();
