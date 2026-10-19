/* todo-nag web app.
 *
 * Reads   lists/<me>.json from the private task repo (GitHub contents API).
 * Writes  by starting the same GitHub Actions the phone shortcuts use (workflow dispatch).
 * Changes show instantly here, are retried when offline, and stay marked "saving" until the
 * list on GitHub reflects them. All task logic lives in the repo's Python script, not here.
 */
"use strict";

const API = "https://api.github.com";
const KEY = { settings: "todo-nag.settings", list: "todo-nag.list", ops: "todo-nag.ops" };
const UNDO_MS = 4000;              // time to undo a tick or snooze before it is sent
const STUCK_MS = 3 * 60 * 1000;    // a sent change not visible on GitHub after this is flagged
const PRIO_NAME = { high: "High", med: "Med", low: "Low" };

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode etc. */ } };

let S = load(KEY.settings, null); // { repo, token, me, people }
let list = load(KEY.list, null);  // last lists/<me>.json
let ops = load(KEY.ops, []);      // pending changes
let lastFetch = 0;
let fetchError = null;
let laterOpen = false;
let draft = { priority: "med", to: "me", due: "" };

// ------------------------------------------------------------------ GitHub --

class ApiError extends Error {
  constructor(status, body) { super(`HTTP ${status}`); this.status = status; this.body = body; }
}

async function gh(path, { method = "GET", body, raw = false } = {}, creds = S) {
  let res;
  try {
    res = await fetch(API + path, {
      method,
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${creds.token}`,
        Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "offline");
  }
  if (!res.ok) throw new ApiError(res.status, await res.text().catch(() => ""));
  return res;
}

const dispatch = (workflow, inputs) =>
  gh(`/repos/${S.repo}/actions/workflows/${workflow}/dispatches`, { method: "POST", body: { ref: "main", inputs } });

function errText(e) {
  switch (e.status) {
    case 0: return "No connection";
    case 401: return "GitHub rejected the token";
    case 403: return "The token is missing a permission";
    case 404: return "Not found on GitHub";
    case 422: return "GitHub refused the request";
    default: return `GitHub error ${e.status}`;
  }
}

// -------------------------------------------------------------------- data --

const allTasks = (l) => (l ? [...l.sections.flatMap((s) => s.tasks), ...l.later] : []);
const findTask = (id) => allTasks(list).find((t) => t.id === id);
const personName = (key) => (key === "open" ? "either of you" : key === S.me ? "you" : (S.people[key] || key));
const norm = (title) => title.split(/\s+/).filter((w) => !(w.length > 1 && "@!+".includes(w[0]))).join(" ").toLowerCase().trim();

let refreshing = null;
function refresh() {
  if (!S) return Promise.resolve();
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const res = await gh(`/repos/${S.repo}/contents/lists/${S.me}.json`, { raw: true });
      list = await res.json();
      store(KEY.list, list);
      fetchError = null;
      lastFetch = Date.now();
      reconcile();
    } catch (e) {
      fetchError = e;
    } finally {
      refreshing = null;
    }
    render();
    if (ops.some((o) => o.state === "queued")) flush();
    schedule();
  })();
  return refreshing;
}

// Drop sent changes once the list on GitHub shows them; flag ones that never show up.
function reconcile() {
  const tasks = new Map(allTasks(list).map((t) => [t.id, t]));
  const now = Date.now();
  ops = ops.filter((op) => {
    if (op.state !== "sent") return true;
    if (confirmed(op, tasks)) return false;
    if (now - op.sentAt > STUCK_MS) op.state = "stuck";
    return true;
  });
  saveOps();
}

function confirmed(op, tasks) {
  const t = tasks.get(op.taskId);
  switch (op.kind) {
    case "add": return [...tasks.values()].some((x) => x.id > op.maxId && norm(x.title) === norm(op.title));
    case "done":
    case "delete": return !t;
    case "reopen": return !!t;
    case "snooze": return !t || t.due > op.oldDue;
    case "prio": return !t || t.priority === op.arg;
    case "assign": return !t || t.assignee === op.arg;
    default: return true;
  }
}

// ----------------------------------------------------------------- changes --

const saveOps = () => store(KEY.ops, ops);

function enqueue(op, delay = 0) {
  Object.assign(op, { uid: uid(), at: Date.now(), state: "queued" });
  if (delay) op.notBefore = Date.now() + delay;
  ops.push(op);
  saveOps();
  render();
  flush();
  return op;
}

function cancel(op) {
  if (op.state === "queued") {
    ops = ops.filter((o) => o !== op);
    saveOps();
    render();
    schedule();
  } else if (op.kind === "done" && op.state === "sent") {
    enqueue({ kind: "reopen", taskId: op.taskId, title: op.title });
  }
}

async function send(op) {
  if (op.kind === "add") {
    return dispatch("add-task.yml", { title: op.title, priority: op.priority, to: op.to, due: op.due, by: S.me });
  }
  return dispatch("task-action.yml", { action: op.kind, ids: String(op.taskId), arg: op.arg ?? "", by: S.me });
}

let flushing = false;
const ready = (o) => o.state === "queued" && !(o.notBefore && Date.now() < o.notBefore);
async function flush() {
  if (flushing || !S) return;
  flushing = true;
  let offline = false;
  try {
    for (const op of [...ops]) {
      if (op.state !== "queued" || (op.notBefore && Date.now() < op.notBefore)) continue;
      try {
        await send(op);
        op.state = "sent";
        op.sentAt = Date.now();
        // A task for the other person never shows up in this list, so there is nothing to wait for.
        if (op.kind === "add" && op.forOther) ops = ops.filter((o) => o !== op);
      } catch (e) {
        if (e.status === 0) { offline = true; break; } // keep it queued, try again later
        op.state = "failed";
        op.error = errText(e);
      }
      saveOps();
      render();
    }
  } finally {
    flushing = false;
  }
  // Something may have become ready while this pass was busy sending.
  if (!offline && ops.some(ready)) setTimeout(flush, 0);
  schedule();
}

let flushTimer, pollTimer;
function schedule() {
  clearTimeout(flushTimer);
  clearTimeout(pollTimer);
  const later = ops.filter((o) => o.state === "queued" && o.notBefore > Date.now());
  if (later.length) flushTimer = setTimeout(flush, Math.min(...later.map((o) => o.notBefore)) - Date.now() + 50);
  if (document.visibilityState !== "visible" || !S) return;
  const waiting = ops.some((o) => o.state === "sent");
  pollTimer = setTimeout(refresh, waiting ? 5000 : 60000);
}

// ------------------------------------------------------------------ actions --

function tickDone(id) {
  const t = findTask(id);
  if (!t) return;
  const op = enqueue({ kind: "done", taskId: id, title: t.title }, UNDO_MS);
  toast(`Done: ${t.title}`, () => cancel(op));
}

function snooze(id, days) {
  const t = findTask(id);
  if (!t) return;
  const op = enqueue({ kind: "snooze", taskId: id, arg: String(days), oldDue: t.due, title: t.title }, UNDO_MS);
  toast(`Snoozed ${days === 1 ? "1 day" : days === 7 ? "1 week" : `${days} days`}: ${t.title}`, () => cancel(op));
}

function addTask(title) {
  const forOther = draft.to !== "me" && draft.to !== "open" && draft.to !== S.me;
  const maxId = Math.max(0, ...allTasks(list).map((t) => t.id));
  enqueue({ kind: "add", title, priority: draft.priority, to: draft.to, due: draft.due, forOther, maxId });
  if (forOther) toast(`Sent to ${S.people[draft.to] || draft.to}`);
}

// ------------------------------------------------------------------- render --

function render() {
  if (!S) return;
  renderHeader();
  renderList();
}

function rel(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

function renderHeader() {
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  $("#day").textContent = list && list.date === iso
    ? list.day
    : today.toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric" }).replace(",", "");

  const sync = $("#sync");
  const saving = ops.filter((o) => o.state === "queued" || o.state === "sent").length;
  let state = "ok", text;
  if (fetchError && fetchError.status === 0) {
    state = "offline";
    text = saving ? `Offline · ${saving} waiting` : "Offline";
  } else if (fetchError && fetchError.status !== 404) {
    state = "error";
    text = errText(fetchError);
  } else if (saving) {
    state = "busy";
    text = `Saving ${saving}…`;
  } else {
    text = lastFetch ? `Synced ${rel(lastFetch)}` : "Loading";
  }
  sync.dataset.state = state;
  $("#sync-text").textContent = text;

  const banner = $("#banner");
  if (fetchError && fetchError.status === 404) {
    banner.innerHTML = `Your list hasn't been built on GitHub yet. <button type="button" data-act="rebuild">Build it now</button>`;
    banner.hidden = false;
  } else if (fetchError && (fetchError.status === 401 || fetchError.status === 403)) {
    banner.innerHTML = `${esc(errText(fetchError))}. Check the token in Settings.`;
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}

const CHECK_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6L20.1 8.4 18.7 7z"/></svg>`;

function opNote(op) {
  if (op.state === "failed" || op.state === "stuck") {
    const msg = op.state === "failed" ? op.error : "Not saved on GitHub yet";
    return `<span class="stuck">${esc(msg)}.<button type="button" data-retry="${op.uid}">Send again</button><button type="button" data-dismiss="${op.uid}">Dismiss</button></span>`;
  }
  const dot = `<span class="syncing" aria-hidden="true"></span>`;
  switch (op.kind) {
    case "snooze": return `${dot}Snoozed ${op.arg === "1" ? "1 day" : op.arg === "7" ? "1 week" : `${op.arg} days`}`;
    case "prio": return `${dot}Priority: ${PRIO_NAME[op.arg]}`;
    case "assign": return `${dot}Moving to ${esc(personName(op.arg))}`;
    case "reopen": return `${dot}Reopening`;
    case "done": return `${dot}Marking done`;
    case "delete": return `${dot}Deleting`;
    default: return dot;
  }
}

function taskRow(t, live) {
  const mine = live.filter((o) => o.taskId === t.id);
  const finishing = mine.find((o) => o.kind === "done" || o.kind === "delete");
  const undoable = finishing && finishing.state === "queued" && finishing.notBefore > Date.now();
  if (finishing && !undoable && (finishing.state === "queued" || finishing.state === "sent")) return "";

  const parts = [];
  const latest = mine[mine.length - 1];
  if (latest && !undoable) parts.push(opNote(latest));
  else {
    parts.push(`<span class="due">${esc(t.due_text)}</span>`);
    if (t.snoozes >= 2) parts.push(`snoozed ${t.snoozes}×`);
  }
  const pending = mine.some((o) => o.state === "queued" || o.state === "sent");
  const cls = ["task", undoable ? "ticked" : "", pending && !undoable ? "pending" : ""].join(" ");
  return `<div class="row-wrap"><div class="swipe-hint" aria-hidden="true">Snooze 1 day</div>
    <div class="${cls}" data-id="${t.id}">
      <button class="check" type="button" data-act="done" aria-label="Mark done: ${esc(t.title)}">${CHECK_SVG}</button>
      <button class="body" type="button" data-act="open"><span class="t">${esc(t.title)}</span><span class="sub">${parts.join(" · ")}</span></button>
    </div></div>`;
}

function renderList() {
  const live = ops.filter((o) => o.state !== "drop");
  const out = [];

  const adds = live.filter((o) => o.kind === "add");
  if (adds.length) {
    out.push(`<section class="section" data-k="pending"><h2>Adding <span class="n">${adds.length}</span></h2>`);
    for (const op of adds) {
      const note = op.state === "failed" || op.state === "stuck" ? opNote(op) : `<span class="syncing" aria-hidden="true"></span>Saving`;
      out.push(`<div class="row-wrap"><div class="task pending" style="opacity:1"><span class="check" aria-hidden="true"></span>
        <span class="body"><span class="t">${esc(op.title)}</span><span class="sub">${note}</span></span></div></div>`);
    }
    out.push(`</section>`);
  }

  if (list) {
    for (const s of list.sections) {
      const rows = s.tasks.map((t) => taskRow(t, live)).filter(Boolean);
      if (!rows.length) continue;
      out.push(`<section class="section" data-k="${s.key}"><h2>${esc(s.text)} <span class="n">${rows.length}</span></h2>${rows.join("")}</section>`);
    }
    const laterRows = list.later.map((t) => taskRow(t, live)).filter(Boolean);
    if (laterRows.length) {
      out.push(`<section class="section" data-k="later"><button type="button" class="later-toggle" data-act="later" aria-expanded="${laterOpen}">
        ${laterOpen ? "▾" : "▸"} Later <span class="n">${laterRows.length}</span></button>${laterOpen ? laterRows.join("") : ""}</section>`);
    }
  }

  if (!out.length) {
    out.push(list
      ? `<div class="empty"><strong>Nothing on your list</strong>Add something above when it comes up.</div>`
      : `<div class="empty">Loading your list…</div>`);
  }
  $("#list").innerHTML = out.join("");
}

// -------------------------------------------------------------------- toast --

let toastTimer;
function toast(text, onUndo) {
  const el = $("#toast");
  $("#toast-text").textContent = text;
  const undo = $("#toast-undo");
  undo.hidden = !onUndo;
  undo.onclick = () => { onUndo && onUndo(); el.hidden = true; };
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, onUndo ? UNDO_MS : 2500);
}

// ---------------------------------------------------------------- composer --

function whoButtons(container, selected) {
  const others = Object.keys(S.people).filter((k) => k !== S.me);
  const opts = [["me", "Me"], ...others.map((k) => [k, S.people[k]]), ["open", "Either"]];
  container.innerHTML = opts.map(([v, n]) => `<button type="button" role="radio" data-v="${v}" aria-checked="${v === selected}">${esc(n)}</button>`).join("");
}

function syncComposer() {
  for (const seg of $$(".composer .seg")) {
    const field = seg.dataset.field;
    const value = draft[field];
    for (const b of $$("button", seg)) {
      b.setAttribute("role", "radio");
      const isPick = b.dataset.v === "pick";
      const on = isPick ? /^\d{4}-/.test(value) : b.dataset.v === value;
      b.setAttribute("aria-checked", on);
    }
  }
  const pick = $("#due-pick");
  pick.textContent = /^\d{4}-/.test(draft.due)
    ? new Date(`${draft.due}T12:00`).toLocaleDateString("en-CA", { month: "short", day: "numeric" })
    : "Date…";
  $("#add-btn").disabled = !$("#new-title").value.trim();
}

function setupComposer() {
  $(".composer").addEventListener("click", (e) => {
    const b = e.target.closest(".seg button");
    if (!b) return;
    const field = b.closest(".seg").dataset.field;
    if (b.dataset.v === "pick") {
      const input = $("#due-date");
      try { input.showPicker(); } catch { input.click(); }
      return;
    }
    draft[field] = b.dataset.v;
    syncComposer();
  });
  $("#due-date").addEventListener("change", (e) => { draft.due = e.target.value || ""; syncComposer(); });
  $("#new-title").addEventListener("input", syncComposer);
  $("#composer").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#new-title");
    const title = input.value.trim();
    if (!title) { input.focus(); return; }
    addTask(title);
    input.value = "";
    draft = { priority: "med", to: "me", due: "" };
    whoButtons($("#seg-to"), draft.to);
    syncComposer();
    input.focus();
  });
  syncComposer();
}

// ------------------------------------------------------------------- sheet --

let sheetTask = null;
function openSheet(id) {
  const t = findTask(id);
  if (!t) return;
  sheetTask = t;
  $("#sheet-title").textContent = t.title;
  $("#sheet-meta").textContent = `${t.due_text[0].toUpperCase()}${t.due_text.slice(1)} · ${PRIO_NAME[t.priority]} priority`;
  for (const b of $$("#sheet-prio button")) b.setAttribute("aria-checked", b.dataset.v === t.priority);
  whoButtons($("#sheet-who"), t.assignee === S.me ? "me" : t.assignee);
  const del = $("#sheet-delete");
  del.dataset.armed = "false";
  del.textContent = "Delete task";
  $("#sheet").showModal();
}

function setupSheet() {
  const sheet = $("#sheet");
  sheet.addEventListener("click", (e) => { if (e.target === sheet) sheet.close(); });
  $("#sheet-snooze").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    sheet.close();
    snooze(sheetTask.id, Number(b.dataset.v));
  });
  $("#sheet-prio").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || b.dataset.v === sheetTask.priority) return;
    sheet.close();
    enqueue({ kind: "prio", taskId: sheetTask.id, arg: b.dataset.v, title: sheetTask.title });
  });
  $("#sheet-who").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const target = b.dataset.v === "me" ? S.me : b.dataset.v;
    if (target === sheetTask.assignee) return;
    sheet.close();
    enqueue({ kind: "assign", taskId: sheetTask.id, arg: target, title: sheetTask.title });
  });
  $("#sheet-done").addEventListener("click", () => { sheet.close(); tickDone(sheetTask.id); });
  $("#sheet-delete").addEventListener("click", (e) => {
    const b = e.currentTarget;
    if (b.dataset.armed !== "true") {
      b.dataset.armed = "true";
      b.textContent = "Tap again to delete";
      return;
    }
    sheet.close();
    const op = enqueue({ kind: "delete", taskId: sheetTask.id, title: sheetTask.title }, UNDO_MS);
    toast(`Deleted: ${sheetTask.title}`, () => cancel(op));
  });
}

// ------------------------------------------------------------- list events --

function setupList() {
  const listEl = $("#list");
  let suppressClick = false;

  listEl.addEventListener("click", (e) => {
    if (suppressClick) { suppressClick = false; return; }
    const retry = e.target.closest("[data-retry]");
    const dismiss = e.target.closest("[data-dismiss]");
    if (retry || dismiss) {
      const op = ops.find((o) => o.uid === (retry || dismiss).dataset.retry || o.uid === (retry || dismiss).dataset.dismiss);
      if (op && retry) { op.state = "queued"; delete op.notBefore; delete op.error; saveOps(); flush(); }
      if (op && dismiss) { ops = ops.filter((o) => o !== op); saveOps(); }
      render();
      return;
    }
    const act = e.target.closest("[data-act]");
    if (!act) return;
    if (act.dataset.act === "later") { laterOpen = !laterOpen; render(); return; }
    const row = act.closest(".task");
    const id = row && Number(row.dataset.id);
    if (!id) return;
    if (act.dataset.act === "done") {
      const queuedDone = ops.find((o) => o.taskId === id && o.kind === "done" && o.state === "queued");
      if (queuedDone) { cancel(queuedDone); $("#toast").hidden = true; } else tickDone(id);
    }
    if (act.dataset.act === "open") openSheet(id);
  });

  // Swipe a task left to snooze it a day.
  let drag = null;
  listEl.addEventListener("pointerdown", (e) => {
    const row = e.target.closest(".task[data-id]");
    if (!row || e.target.closest(".check")) return;
    drag = { row, x: e.clientX, y: e.clientY, dx: 0, active: false, id: e.pointerId };
  });
  listEl.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.active) {
      if (Math.abs(dy) > 10) { drag = null; return; }
      if (dx > -12) return;
      drag.active = true;
      drag.row.classList.add("dragging");
      drag.row.setPointerCapture(e.pointerId);
    }
    drag.dx = Math.min(0, dx);
    drag.row.style.transform = `translateX(${drag.dx}px)`;
  });
  const end = () => {
    if (!drag) return;
    const { row, dx, active } = drag;
    drag = null;
    if (!active) return;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 300);
    row.classList.remove("dragging");
    row.style.transform = "";
    if (dx < -90) snooze(Number(row.dataset.id), 1);
  };
  listEl.addEventListener("pointerup", end);
  listEl.addEventListener("pointercancel", end);

  $("#banner").addEventListener("click", (e) => {
    if (e.target.closest('[data-act="rebuild"]')) rebuild();
  });
  $("#sync").addEventListener("click", () => { flush(); refresh(); });
}

async function rebuild() {
  try {
    await dispatch("digest.yml", { slot: "refresh" });
    toast("Rebuilding your list on GitHub. Give it about 30 seconds.");
    setTimeout(refresh, 25000);
  } catch (e) {
    toast(errText(e));
  }
}

// ---------------------------------------------------------------- settings --

function setupSettings() {
  const dlg = $("#settings");
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  $("#open-settings").addEventListener("click", () => {
    $("#settings-info").textContent = `${S.people[S.me] || S.me} on this phone · ${S.repo}`;
    $("#settings-actions").href = `https://github.com/${S.repo}/actions`;
    dlg.showModal();
  });
  $("#settings-refresh").addEventListener("click", () => { dlg.close(); rebuild(); });
  $("#settings-person").addEventListener("click", () => {
    dlg.close();
    showSetup({ repo: S.repo, token: S.token, people: S.people });
  });
  $("#settings-signout").addEventListener("click", () => {
    dlg.close();
    localStorage.removeItem(KEY.settings);
    localStorage.removeItem(KEY.list);
    localStorage.removeItem(KEY.ops);
    S = null; list = null; ops = [];
    showSetup();
  });
}

// ------------------------------------------------------------------- setup --

function showSetup(known) {
  $("#app").hidden = true;
  $("#setup").hidden = false;
  $("#setup-error").textContent = "";
  if (known) choosePerson(known);
  else { $("#setup-form").hidden = false; $("#setup-who").hidden = true; }
}

function choosePerson(creds) {
  $("#setup-form").hidden = true;
  $("#setup-who").hidden = false;
  $("#setup-people").innerHTML = Object.entries(creds.people)
    .map(([k, n]) => `<button type="button" data-k="${esc(k)}">${esc(n)}</button>`).join("");
  $("#setup-people").onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    S = { ...creds, me: b.dataset.k };
    store(KEY.settings, S);
    if (list && list.person !== S.me) { list = null; store(KEY.list, null); }
    start();
  };
}

function setupSetup() {
  $("#setup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const repo = $("#setup-repo").value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\/$/, "");
    const token = $("#setup-token").value.trim();
    const err = $("#setup-error");
    err.textContent = "Checking…";
    try {
      const res = await gh(`/repos/${repo}/contents/config.json`, { raw: true }, { repo, token });
      const cfg = await res.json();
      err.textContent = "";
      choosePerson({ repo, token, people: cfg.people || {} });
    } catch (ex) {
      err.textContent = {
        0: "No connection. Try again when you're online.",
        401: "GitHub didn't accept that token. Copy it again and paste the whole thing.",
        403: "That token can't read the repo. Give it Contents: Read-only on this repo.",
        404: "Couldn't find the repo. Check its name (owner/name), and that the token has access to it.",
      }[ex.status] || `Couldn't connect (${errText(ex)}).`;
    }
  });
}

// ------------------------------------------------------------------- start --

function start() {
  $("#setup").hidden = true;
  $("#app").hidden = false;
  whoButtons($("#seg-to"), draft.to);
  render();
  refresh();
  flush();

  const params = new URLSearchParams(location.search);
  const shared = [params.get("title"), params.get("text"), params.get("url")].filter(Boolean).join(" ").trim();
  if (shared) $("#new-title").value = shared;
  if (params.has("add") || shared) { $("#new-title").focus(); syncComposer(); }
  if (location.search) history.replaceState(null, "", location.pathname);
}

setupSetup();
setupComposer();
setupSheet();
setupSettings();
setupList();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && S) { refresh(); flush(); } else schedule();
});
window.addEventListener("online", () => { if (S) { flush(); refresh(); } });

if (S && S.token && S.me) start(); else showSetup();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* app still works without offline cache */ });
}
