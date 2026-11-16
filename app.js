"use strict";

// ---------- Storage (data stays in this browser; see README for sharing options) ----------
const KEY = "wms.v1";
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || { items: {}, log: [] }; } catch { return { items: {}, log: [] }; } };
let db = load();
const save = () => localStorage.setItem(KEY, JSON.stringify(db));
const norm = s => String(s || "").trim().toUpperCase();
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Every quantity change goes through here so the history log is always complete.
function adjust(code, delta, type, ref = "") {
  const it = db.items[code];
  if (!it) return;
  it.qty = Math.max(0, it.qty + delta);
  it.updated = Date.now();
  db.log.push({ ts: Date.now(), code, delta, type, ref, loc: it.loc });
  save();
}
function upsert(code, name, loc) {
  const it = db.items[code] || { code, name: "", qty: 0, loc: "", min: 0, updated: Date.now() };
  if (name) it.name = name;
  if (loc) it.loc = norm(loc);
  db.items[code] = it;
  save();
  return it;
}

// ---------- Tabs ----------
document.querySelectorAll("nav button").forEach(b => b.onclick = () => {
  document.querySelectorAll("nav button").forEach(x => x.classList.toggle("on", x === b));
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.id === "tab-" + b.dataset.tab));
  if (b.dataset.tab === "inventory") renderInv();
  if (b.dataset.tab === "locations") renderLocs();
  if (b.dataset.tab === "receive") refreshLocList();
});

// ---------- Scan tab ----------
function showResult(code) {
  code = norm(code);
  if (!code) return;
  const it = db.items[code];
  const box = $("result");
  if (!it) {
    box.innerHTML = `<div class="card"><h3>New item: ${esc(code)}</h3>
      <label>Name <input id="nName"></label>
      <label>Location <input id="nLoc" list="locList" autocapitalize="characters"></label>
      <label>Starting quantity <input id="nQty" type="number" min="0" value="0" inputmode="numeric"></label>
      <button id="nSave">Add item</button></div>`;
    $("nSave").onclick = () => {
      upsert(code, $("nName").value.trim() || code, $("nLoc").value);
      const q = parseInt($("nQty").value, 10) || 0;
      if (q > 0) adjust(code, q, "initial");
      showResult(code);
    };
    return;
  }
  const low = it.min && it.qty <= it.min;
  box.innerHTML = `<div class="card"><h3>${esc(it.name)}</h3>
    <div class="meta">${esc(it.code)} &middot; Location: ${esc(it.loc || "unassigned")}</div>
    <div class="qty ${low ? "low" : ""}">${it.qty}</div>
    ${low ? '<div class="meta low">At or below minimum (' + it.min + ")</div>" : ""}
    <div class="row">
      <button data-d="-1" class="ghost">-1</button><button data-d="1">+1</button>
      <button data-d="-10" class="ghost">-10</button><button data-d="10">+10</button>
    </div>
    <label>Move to location <input id="mvLoc" list="locList" autocapitalize="characters" value="${esc(it.loc)}"></label>
    <label>Minimum stock alert <input id="minQty" type="number" min="0" value="${it.min}" inputmode="numeric"></label>
    <button id="upd" class="ghost">Save location / minimum</button></div>`;
  box.querySelectorAll("[data-d]").forEach(b => b.onclick = () => { adjust(code, +b.dataset.d, "adjust"); showResult(code); });
  $("upd").onclick = () => {
    const newLoc = norm($("mvLoc").value);
    if (newLoc !== it.loc) db.log.push({ ts: Date.now(), code, delta: 0, type: "move", ref: it.loc + " -> " + newLoc, loc: newLoc });
    it.loc = newLoc;
    it.min = parseInt($("minQty").value, 10) || 0;
    save();
    showResult(code);
  };
}
$("codeInput").addEventListener("keydown", e => {
  if (e.key === "Enter") { showResult(e.target.value); e.target.value = ""; }
});

// Camera scanning uses the browser's built-in BarcodeDetector (Chrome/Android, recent Edge).
// Where it's missing (e.g. Safari), the typed/Bluetooth-scanner input above still works.
let stream = null, scanning = false;
async function startCam() {
  if (!("BarcodeDetector" in window)) { $("camMsg").textContent = "Camera scanning isn't supported in this browser. Use the code box (works with Bluetooth/USB scanners)."; return; }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  } catch { $("camMsg").textContent = "Camera blocked. Allow camera access and use https or localhost."; return; }
  const v = $("video");
  v.srcObject = stream; v.hidden = false; await v.play();
  $("camBtn").hidden = true; $("camStop").hidden = false; $("camMsg").textContent = "Point at a barcode or QR code.";
  const det = new BarcodeDetector();
  scanning = true;
  let last = "", lastT = 0;
  (async function loop() {
    while (scanning) {
      try {
        const found = await det.detect(v);
        if (found.length) {
          const val = found[0].rawValue;
          if (val !== last || Date.now() - lastT > 3000) { last = val; lastT = Date.now(); navigator.vibrate && navigator.vibrate(60); showResult(val); }
        }
      } catch { /* frame not ready */ }
      await new Promise(r => setTimeout(r, 250));
    }
  })();
}
function stopCam() {
  scanning = false;
  if (stream) stream.getTracks().forEach(t => t.stop());
  $("video").hidden = true; $("camBtn").hidden = false; $("camStop").hidden = true;
}
$("camBtn").onclick = startCam;
$("camStop").onclick = stopCam;

// ---------- Inventory tab ----------
function renderInv() {
  const q = $("search").value.trim().toLowerCase();
  const rows = Object.values(db.items)
    .filter(i => !q || (i.code + " " + i.name + " " + i.loc).toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));
  $("invList").innerHTML = rows.length ? rows.map(i => `<div class="card"><h3>${esc(i.name)}</h3>
    <div class="meta">${esc(i.code)} &middot; ${esc(i.loc || "unassigned")}</div>
    <div class="qty ${i.min && i.qty <= i.min ? "low" : ""}">${i.qty}</div></div>`).join("") : '<p class="hint">No items yet. Scan one to add it.</p>';
}
$("search").oninput = renderInv;

function download(name, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
}
const csv = rows => rows.map(r => r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(",")).join("\n");
$("exportBtn").onclick = () => download("inventory.csv", csv([["code", "name", "qty", "location", "min"],
  ...Object.values(db.items).map(i => [i.code, i.name, i.qty, i.loc, i.min])]));
$("logBtn").onclick = () => download("history.csv", csv([["time", "code", "change", "type", "ref", "location"],
  ...db.log.map(l => [new Date(l.ts).toISOString(), l.code, l.delta, l.type, l.ref, l.loc])]));

// ---------- Receive tab ----------
$("rcBtn").onclick = () => {
  const code = norm($("rcCode").value), po = $("poInput").value.trim();
  const qty = parseInt($("rcQty").value, 10);
  if (!code || !(qty > 0)) { $("rcMsg").textContent = "Enter a code and a quantity above 0."; return; }
  const isNew = !db.items[code];
  upsert(code, $("rcName").value.trim() || (isNew ? code : ""), $("rcLoc").value);
  adjust(code, qty, "receive", po);
  $("rcMsg").textContent = `Received ${qty} of ${code}${po ? " on " + po : ""}. On hand: ${db.items[code].qty}.`;
  $("rcCode").value = ""; $("rcName").value = ""; $("rcQty").value = 1; $("rcCode").focus();
};

// ---------- Locations tab ----------
function refreshLocList() {
  const locs = [...new Set(Object.values(db.items).map(i => i.loc).filter(Boolean))].sort();
  $("locList").innerHTML = locs.map(l => `<option value="${esc(l)}">`).join("");
}
function renderLocs() {
  const by = {};
  Object.values(db.items).forEach(i => (by[i.loc || "UNASSIGNED"] ||= []).push(i));
  const keys = Object.keys(by).sort();
  $("locView").innerHTML = keys.length ? keys.map(k => `<div class="card"><h3>${esc(k)}</h3>
    <div class="meta">${by[k].length} item(s), ${by[k].reduce((s, i) => s + i.qty, 0)} units</div>
    ${by[k].map(i => `<div>${esc(i.name)} <span class="meta">(${esc(i.code)})</span>: <b>${i.qty}</b></div>`).join("")}</div>`).join("")
    : '<p class="hint">No locations yet.</p>';
}

refreshLocList();
