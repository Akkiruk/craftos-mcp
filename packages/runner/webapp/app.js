// The browser app for the emulator: plain JS, no build step. The server is packages/runner/src/webapp.ts.
"use strict";

const MARGIN = 2; // the PNG renderer's border, in unscaled pixels
const CW = 6; // a character cell, unscaled
const CH = 9;
const TERM_SCALE = 3;
const MON_SCALE = 2;
const PIX_SCALE = 4;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const kid of kids) if (kid != null) e.append(kid);
  return e;
};

async function api(path, options = {}) {
  const init = { ...options };
  if (options.json !== undefined) {
    init.method = init.method || "POST";
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(options.json);
  }
  const res = await fetch(path, init);
  const type = res.headers.get("content-type") || "";
  const body = type.includes("json") ? await res.json() : await res.text();
  if (!res.ok)
    throw new Error(typeof body === "string" ? body : JSON.stringify(body));
  return body;
}

// ───────────────────────── state ─────────────────────────

let meta = null;
let sessions = [];
let lastRun = null;
let current = null; // session id, or "lastrun"
const views = new Map(); // "<session>:<key>" -> {version, busy, canvas}
let uiData = new Map(); // window id -> ui snapshot, when the overlay is on

const sessionById = (id) => sessions.find((s) => s.id === id);
const cur = () => sessionById(current);

// ───────────────────────── tabs ─────────────────────────

let tabShape = "";
function renderTabs() {
  const shape = JSON.stringify([
    current,
    sessions.map((s) => [s.id, s.name, s.running, s.network]),
    !!lastRun,
  ]);
  if (shape === tabShape) return;
  tabShape = shape;
  const tabs = $("#tabs");
  tabs.replaceChildren();
  for (const s of sessions) {
    tabs.append(
      el(
        "button",
        {
          class: `tab${s.id === current ? " on" : ""}${s.running ? "" : " off"}`,
          onclick: () => select(s.id),
          title: `id ${s.id}`,
        },
        el("span", { class: "dot" }),
        s.name,
        s.network ? el("span", { class: "net", text: s.network }) : null,
      ),
    );
  }
  if (lastRun)
    tabs.append(
      el("button", {
        class: `tab${current === "lastrun" ? " on" : ""}`,
        onclick: () => select("lastrun"),
        text: "last run",
      }),
    );
}

function select(id) {
  if (current === id) return;
  current = id;
  tabShape = "";
  stateShape = "";
  uiData = new Map();
  for (const c of $$("#monitors > *, #pixels > *")) c.remove();
  views.clear();
  $("#editor-card").hidden = true;
  renderTabs();
  layout();
  if (id !== "lastrun") {
    refreshSide(true);
    setTimeout(() => $("#term-wrap").focus(), 0);
  }
}

function layout() {
  const s = cur();
  $("#empty").hidden = !!s || current === "lastrun";
  $("#computer").hidden = !s;
  $("#lastrun").hidden = current !== "lastrun";
  if (current === "lastrun") renderLastRun();
  if (!s) return;
  const pill = $("#status");
  pill.textContent = s.running
    ? "on"
    : s.exitCode === null
      ? "off"
      : `off (${s.exitCode})`;
  pill.className = `pill${s.running ? "" : " off"}`;
  $("#title").textContent =
    `${s.name} · ${s.advanced ? "advanced " : ""}${s.kind}${s.program ? " · " + s.program : ""}`;
  $("#start").hidden = s.running;
  $("#term-wrap").className = `bezel${s.advanced ? " advanced" : ""}`;
  fitAll();
}

// ───────────────────────── screens ─────────────────────────

/** Fetch a PNG and paint it on the canvas, one request at a time per screen. */
async function paint(key, url, canvas, version, overlay, scale) {
  const v = views.get(key) || { version: -1, busy: false };
  views.set(key, v);
  if (v.busy || v.version === version) return;
  v.busy = true;
  try {
    const res = await fetch(url);
    if (!res.ok) return;
    const bitmap = await createImageBitmap(await res.blob());
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      if (scale) {
        fitted.set(canvas, scale);
        fit(canvas, scale);
      }
    }
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bitmap, 0, 0);
    if (overlay) overlay(ctx);
    v.version = version;
  } catch {
    // the computer went away mid-request
  } finally {
    v.busy = false;
  }
}

/**
 * Size a screen for the room it has. Scaled by 1.5 with hard pixels, a pixel font's strokes come out one pixel here
 * and two there. So: a whole number of device pixels for every emulator pixel when that nearly fills the room (hard
 * pixels, as in the game); otherwise the room's full width, scaled smoothly, which keeps the strokes even.
 * `scale` is what the PNG was rendered at, and the screen is never shown larger than that.
 */
const CRISP_FILLS = 0.75;
const fitted = new Map();
function fit(canvas, scale) {
  const frame = canvas.parentElement;
  const host = frame?.parentElement;
  if (!host || !canvas.width) return;
  const dpr = window.devicePixelRatio || 1;
  // asked on every poll: only work when the space, the zoom or the screen changed
  const seen = `${host.clientWidth}:${dpr}:${canvas.width}x${canvas.height}`;
  if (canvas.dataset.fit === seen) return;
  canvas.dataset.fit = seen;
  const px = (v) => parseFloat(v) || 0;
  const side = (cs, what) => px(cs[`${what}Left`]) + px(cs[`${what}Right`]);
  const fs = getComputedStyle(frame);
  const hs = getComputedStyle(host);
  const cs = getComputedStyle(canvas);
  // the canvas is border-box: its CSS size includes its own border
  const edgeX = px(cs.borderLeftWidth) + px(cs.borderRightWidth);
  const edgeY = px(cs.borderTopWidth) + px(cs.borderBottomWidth);
  const room =
    host.clientWidth -
    side(hs, "padding") -
    side(fs, "padding") -
    px(fs.borderLeftWidth) -
    px(fs.borderRightWidth) -
    edgeX;
  if (room <= 0) return;
  const nativeW = canvas.width / scale;
  const nativeH = canvas.height / scale;
  const most = Math.min(room, canvas.width);
  const k = Math.floor((most * dpr) / nativeW);
  const crisp = (k * nativeW) / dpr;
  if (k >= 1 && crisp >= most * CRISP_FILLS) {
    canvas.style.width = `${crisp + edgeX}px`;
    canvas.style.height = `${(k * nativeH) / dpr + edgeY}px`;
    canvas.style.imageRendering = "pixelated";
  } else {
    // on whole device pixels all the same
    const w = Math.floor(most * dpr) / dpr;
    canvas.style.width = `${w + edgeX}px`;
    canvas.style.height = `${Math.round(((w * nativeH) / nativeW) * dpr) / dpr + edgeY}px`;
    canvas.style.imageRendering = "auto";
  }
}
function fitAll() {
  for (const [canvas, scale] of fitted)
    if (canvas.isConnected) fit(canvas, scale);
    else fitted.delete(canvas);
}
// a new width, and a new zoom (which changes devicePixelRatio), both arrive as a resize
window.addEventListener("resize", fitAll);

/** Canvas pixel -> 1-based character cell. */
function cellAt(canvas, e, scale, width, height) {
  const r = canvas.getBoundingClientRect();
  // without the canvas's own border, which is not screen
  const px =
    ((e.clientX - r.left - canvas.clientLeft) * canvas.width) /
    canvas.clientWidth /
    scale;
  const py =
    ((e.clientY - r.top - canvas.clientTop) * canvas.height) /
    canvas.clientHeight /
    scale;
  return {
    x: Math.min(Math.max(Math.floor((px - MARGIN) / CW) + 1, 1), width),
    y: Math.min(Math.max(Math.floor((py - MARGIN) / CH) + 1, 1), height),
  };
}

function drawUi(ctx, win, scale) {
  const snap = uiData.get(win.id);
  if (!snap || !$("#overlay").checked) return;
  ctx.save();
  ctx.lineWidth = Math.max(1, scale - 1);
  ctx.setLineDash([4 * scale, 2 * scale]);
  ctx.font = `${5 * scale}px monospace`;
  for (const r of snap.rects) {
    const u = snap.unit === "cell" ? [CW, CH] : [1, 1];
    const x = (MARGIN + r.x * u[0]) * scale;
    const y = (MARGIN + r.y * u[1]) * scale;
    ctx.strokeStyle = "#dede6c";
    ctx.strokeRect(
      x + 0.5,
      y + 0.5,
      r.w * u[0] * scale - 1,
      r.h * u[1] * scale - 1,
    );
    ctx.fillStyle = "#dede6c";
    ctx.fillText(`${r.cx},${r.cy}`, x + 2, y + 5 * scale);
  }
  ctx.restore();
}

function updateScreens() {
  const s = cur();
  if (!s) return;
  const overlayOn = $("#overlay").checked;
  const uiStamp = overlayOn ? uiData.stamp || 0 : 0;
  const term = s.windows.find((w) => w.peripheral === null);
  if (term) {
    termSize = { width: term.width, height: term.height };
    paint(
      `${s.id}:term`,
      `/api/sessions/${s.id}/window/${term.id}.png?scale=${TERM_SCALE}`,
      $("#term"),
      `${term.id}:${term.version}:${uiStamp}`,
      (ctx) => drawUi(ctx, term, TERM_SCALE),
      TERM_SCALE,
    );
  }
  // monitors
  const mons = s.windows.filter((w) => w.peripheral !== null);
  $("#monitors-box").hidden = mons.length === 0;
  const box = $("#monitors");
  const seen = new Set();
  for (const w of mons) {
    const key = `mon:${w.peripheral}`;
    seen.add(key);
    let fig = box.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (!fig) {
      const canvas = el("canvas");
      fig = el(
        "figure",
        { class: "screen", "data-key": key },
        el("figcaption"),
        canvas,
      );
      canvas.addEventListener("click", (e) => {
        const live = cur()?.windows.find((x) => x.peripheral === w.peripheral);
        if (!live) return;
        const { x, y } = cellAt(canvas, e, MON_SCALE, live.width, live.height);
        flash(canvas);
        const player = $("#touch-player").value.trim();
        post(`/touch`, {
          monitor: w.peripheral,
          x,
          y,
          ...(player ? { player } : {}),
        });
      });
      box.append(fig);
    }
    fig.querySelector("figcaption").innerHTML =
      `<b>${escapeHtml(w.peripheral)}</b> ${w.width}x${w.height}${w.mode ? " pixels" : ""}`;
    paint(
      `${s.id}:${key}`,
      `/api/sessions/${s.id}/window/${w.id}.png?scale=${MON_SCALE}`,
      fig.querySelector("canvas"),
      `${w.id}:${w.version}:${uiStamp}`,
      (ctx) => drawUi(ctx, w, MON_SCALE),
      MON_SCALE,
    );
  }
  for (const fig of [...box.children])
    if (!seen.has(fig.dataset.key)) fig.remove();
  // pixel screens
  $("#pixels-box").hidden = s.pixels.length === 0;
  const pbox = $("#pixels");
  const pseen = new Set();
  for (const p of s.pixels) {
    const key = `px:${p.peripheral}`;
    pseen.add(key);
    let fig = pbox.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (!fig) {
      const canvas = el("canvas");
      fig = el(
        "figure",
        { class: "screen", "data-key": key },
        el("figcaption"),
        canvas,
      );
      canvas.addEventListener("click", (e) => {
        const live = cur()?.pixels.find((x) => x.peripheral === p.peripheral);
        if (!live) return;
        const r = canvas.getBoundingClientRect();
        const x = Math.floor(((e.clientX - r.left) / r.width) * live.width) + 1;
        const y =
          Math.floor(((e.clientY - r.top) / r.height) * live.height) + 1;
        flash(canvas);
        command({ cmd: "tmTouch", peripheral: p.peripheral, x, y }).then((r) =>
          worldMsg(r),
        );
      });
      pbox.append(fig);
    }
    fig.querySelector("figcaption").innerHTML =
      `<b>${escapeHtml(p.peripheral)}</b> ${p.width}x${p.height} px`;
    paint(
      `${s.id}:${key}`,
      `/api/sessions/${s.id}/pixels/${encodeURIComponent(p.peripheral)}.png?scale=${PIX_SCALE}`,
      fig.querySelector("canvas"),
      `${p.mtime}:${p.width}`,
      undefined,
      PIX_SCALE,
    );
  }
  for (const fig of [...pbox.children])
    if (!pseen.has(fig.dataset.key)) fig.remove();
}

function flash(canvas) {
  canvas.classList.add("flash");
  setTimeout(() => canvas.classList.remove("flash"), 150);
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

function renderLastRun() {
  const box = $("#lastrun");
  if (!lastRun)
    return box.replaceChildren(el("p", { class: "sub", text: "No run yet." }));
  const shape = JSON.stringify(lastRun);
  if (box.dataset.shape === shape) return;
  box.dataset.shape = shape;
  const grid = el("div", { class: "grid" });
  for (const scr of lastRun.screens) {
    grid.append(
      el(
        "figure",
        { class: "screen" },
        el("figcaption", {
          text: scr.peripheral
            ? `${scr.pixel ? "GPU" : "monitor"} ${scr.peripheral}`
            : "terminal",
        }),
        el("img", {
          src: `/api/last-run/${scr.index}.png?t=${Date.now()}`,
          style: "image-rendering:pixelated;max-width:100%",
        }),
      ),
    );
  }
  box.replaceChildren(el("h2", { text: `Last run: ${lastRun.label}` }), grid);
}

// ───────────────────────── input ─────────────────────────

let termSize = { width: 51, height: 19 };
const queue = [];
let flushing = Promise.resolve();
function send(events) {
  const id = current;
  queue.push(...events);
  flushing = flushing.then(async () => {
    const batch = queue.splice(0);
    if (batch.length && sessionById(id))
      await api(`/api/sessions/${id}/input`, { json: { events: batch } }).catch(
        () => undefined,
      );
  });
}
function post(sub, body) {
  const id = current;
  return api(`/api/sessions/${id}${sub}`, { json: body || {} }).catch((e) =>
    worldMsg({ error: e.message }),
  );
}
function command(cmd) {
  return api(`/api/sessions/${current}/command`, {
    json: { command: cmd },
  }).catch((e) => ({ applied: false, error: e.message }));
}

// KeyboardEvent.code -> the name of the key in CC's keys API (rawterm's Keys)
const CODE_KEYS = {
  Space: "space",
  Quote: "apostrophe",
  Comma: "comma",
  Minus: "minus",
  Period: "period",
  Slash: "slash",
  Semicolon: "semicolon",
  Equal: "equals",
  BracketLeft: "leftBracket",
  Backslash: "backslash",
  BracketRight: "rightBracket",
  Backquote: "grave",
  Escape: "escape",
  Enter: "enter",
  Tab: "tab",
  Backspace: "backspace",
  Insert: "insert",
  Delete: "delete",
  ArrowRight: "right",
  ArrowLeft: "left",
  ArrowDown: "down",
  ArrowUp: "up",
  PageUp: "pageUp",
  PageDown: "pageDown",
  Home: "home",
  End: "end",
  CapsLock: "capsLock",
  ScrollLock: "scrollLock",
  NumLock: "numLock",
  PrintScreen: "printScreen",
  Pause: "pause",
  NumpadDecimal: "numPadDecimal",
  NumpadDivide: "numPadDivide",
  NumpadMultiply: "numPadMultiply",
  NumpadSubtract: "numPadSubtract",
  NumpadAdd: "numPadAdd",
  NumpadEnter: "numPadEnter",
  ShiftLeft: "leftShift",
  ControlLeft: "leftCtrl",
  AltLeft: "leftAlt",
  ShiftRight: "rightShift",
  ControlRight: "rightCtrl",
  AltRight: "rightAlt",
};
const DIGITS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
];
function keyName(code) {
  if (CODE_KEYS[code]) return CODE_KEYS[code];
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1].toLowerCase();
  m = /^Digit(\d)$/.exec(code);
  if (m) return DIGITS[Number(m[1])];
  m = /^Numpad(\d)$/.exec(code);
  if (m) return `numPad${m[1]}`;
  m = /^F(\d{1,2})$/.exec(code);
  if (m && Number(m[1]) <= 12) return `f${m[1]}`;
  return null;
}

/**
 * Shown in a frame (the VS Code extension's Run in CraftOS panel), this page would swallow the editor's own
 * shortcuts: the command palette, quick open, the side bar, closing the tab. Those go to the frame's owner, which
 * hands them to the editor, and not to the computer. In a browser tab of its own nothing changes.
 */
const embedded = window.parent !== window;
function editorShortcut(e) {
  if (e.key === "F1") return true;
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return false;
  if (e.shiftKey)
    // Ctrl+Shift+C and V stay copy and paste
    return (
      (/^Key[A-Z]$/.test(e.code) && e.code !== "KeyC" && e.code !== "KeyV") ||
      e.code === "Tab" ||
      e.code === "Backquote"
    );
  return /^(Key[PBJWK]|Digit\d|Backquote|Backslash|Comma|Tab|PageUp|PageDown)$/.test(
    e.code,
  );
}
if (embedded)
  window.addEventListener(
    "keydown",
    (e) => {
      if (!editorShortcut(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      window.parent.postMessage(
        {
          type: "craftos-key",
          key: e.key,
          code: e.code,
          keyCode: e.keyCode,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          metaKey: e.metaKey,
          repeat: e.repeat,
        },
        "*",
      );
    },
    true,
  );

const held = new Set();
const term = $("#term-wrap");
term.addEventListener("keydown", (e) => {
  if (!cur()) return;
  const ctrl = e.ctrlKey || e.metaKey;
  if (
    ctrl &&
    !e.repeat &&
    (e.code === "KeyR" || e.code === "KeyS" || e.code === "KeyT")
  ) {
    e.preventDefault();
    shortcut(e.code.slice(3).toLowerCase());
    return;
  }
  if (ctrl && e.code === "KeyV") return; // the browser fires a paste event
  const name = keyName(e.code);
  if (!name) return;
  e.preventDefault();
  held.add(name);
  const events = [{ type: "key", key: name, held: e.repeat }];
  if (e.key.length === 1 && !ctrl && !e.altKey && e.key.charCodeAt(0) < 256)
    events.push({ type: "char", text: e.key });
  send(events);
});
term.addEventListener("keyup", (e) => {
  const name = keyName(e.code);
  if (!name || !held.has(name)) return;
  held.delete(name);
  e.preventDefault();
  send([{ type: "keyup", key: name }]);
});
term.addEventListener("blur", () => {
  if (held.size) send([...held].map((key) => ({ type: "keyup", key })));
  held.clear();
});
term.addEventListener("paste", (e) => {
  e.preventDefault();
  const text = e.clipboardData?.getData("text") ?? "";
  if (text) send([{ type: "paste", text }]);
});

// mouse on the terminal: advanced computers only, as in the game
const canvasTerm = $("#term");
let dragCell = null;
function mouse(kind, e) {
  const s = cur();
  if (!s || !s.advanced) return null;
  const c = cellAt(canvasTerm, e, TERM_SCALE, termSize.width, termSize.height);
  const button = e.button === 2 ? 2 : e.button === 1 ? 3 : 1;
  return { type: "mouse", kind, button, ...c };
}
canvasTerm.addEventListener("mousedown", (e) => {
  term.focus();
  e.preventDefault();
  const ev = mouse("click", e);
  if (ev) {
    dragCell = ev;
    send([ev]);
  }
});
canvasTerm.addEventListener("mousemove", (e) => {
  if (!dragCell || !e.buttons) return;
  const ev = mouse("drag", e);
  if (ev && (ev.x !== dragCell.x || ev.y !== dragCell.y)) {
    ev.button = dragCell.button;
    dragCell = ev;
    send([ev]);
  }
});
window.addEventListener("mouseup", (e) => {
  if (!dragCell) return;
  const ev = mouse("up", e);
  if (ev) send([{ ...ev, button: dragCell.button }]);
  dragCell = null;
});
canvasTerm.addEventListener("contextmenu", (e) => e.preventDefault());
canvasTerm.addEventListener(
  "wheel",
  (e) => {
    const ev = mouse("scroll", e);
    if (!ev) return;
    e.preventDefault();
    send([{ ...ev, dir: e.deltaY < 0 ? -1 : 1 }]);
  },
  { passive: false },
);

async function shortcut(which) {
  const btn = $(`.toolbar [data-act="${which}"]`);
  btn?.classList.add("busy");
  await post("/shortcut", { key: which });
  btn?.classList.remove("busy");
}

for (const b of $$("[data-act]")) {
  b.addEventListener("click", async () => {
    const act = b.dataset.act;
    if (act === "t" || act === "r" || act === "s") return shortcut(act);
    if (act === "start") return post("/start");
    if (act === "paste") {
      let text = "";
      try {
        text = await navigator.clipboard.readText();
      } catch {
        text = prompt("Text to paste:") || "";
      }
      if (text) send([{ type: "paste", text }]);
      term.focus();
      return;
    }
    if (act === "close") {
      const s = cur();
      if (!s || !confirm(`Turn off and remove ${s.name}?`)) return;
      await api(`/api/sessions/${s.id}`, { method: "DELETE" }).catch(
        () => undefined,
      );
      current = null;
      poll(true);
    }
  });
}
$("#overlay").addEventListener("change", () => {
  views.forEach((v) => (v.version = -1));
  if ($("#overlay").checked) fetchUi();
});

async function fetchUi() {
  const s = cur();
  if (!s || !$("#overlay").checked) return;
  try {
    const snaps = await api(`/api/sessions/${s.id}/ui`);
    const next = new Map(snaps.map((x) => [x.window, x]));
    next.stamp = (uiData.stamp || 0) + 1;
    uiData = next;
  } catch {
    // gone
  }
}

// ───────────────────────── world panel ─────────────────────────

for (const b of $$(".side-tabs button")) {
  b.addEventListener("click", () => {
    for (const x of $$(".side-tabs button")) x.classList.toggle("on", x === b);
    for (const p of $$(".panel"))
      p.hidden = p.dataset.panel !== b.dataset.panel;
    refreshSide(true);
  });
}
const panel = () => $(".side-tabs button.on").dataset.panel;

function worldMsg(result) {
  const m = $("#world-msg");
  if (!result) return;
  m.className = `msg ${result.error ? "bad" : "ok"}`;
  m.textContent = result.error ? result.error : "done";
  clearTimeout(worldMsg.t);
  worldMsg.t = setTimeout(() => (m.textContent = ""), 4000);
}

for (const b of $$("[data-world]")) {
  b.addEventListener("click", async () => {
    const player = $("#p-name").value.trim();
    const act = b.dataset.world;
    let cmd;
    if (act === "addPlayer")
      cmd = { cmd: "addPlayer", name: player, online: true };
    else if (act === "join" || act === "leave") cmd = { cmd: act, player };
    else if (act === "chat")
      cmd = { cmd: "chat", player, message: $("#p-chat").value };
    else if (act === "advance")
      cmd = { cmd: "advance", seconds: Number($("#c-seconds").value) || 0 };
    else if (act === "setItem" || act === "clearItem") {
      const item =
        act === "clearItem"
          ? null
          : {
              name: $("#i-item").value.trim(),
              count: Number($("#i-count").value) || 1,
            };
      cmd = {
        cmd: "setItem",
        peripheral: $("#i-periph").value.trim(),
        slot: Number($("#i-slot").value) || 1,
        item,
      };
    }
    if (!player && ["addPlayer", "join", "leave", "chat"].includes(act))
      return worldMsg({ error: "type a player name first" });
    b.classList.add("busy");
    worldMsg(await command(cmd));
    b.classList.remove("busy");
    if (act === "chat") $("#p-chat").value = "";
    refreshSide(true);
  });
}
for (const b of $$("[data-advance]"))
  b.addEventListener("click", async () =>
    worldMsg(
      await command({ cmd: "advance", seconds: Number(b.dataset.advance) }),
    ),
  );
$("#p-chat").addEventListener(
  "keydown",
  (e) => e.key === "Enter" && $('[data-world="chat"]').click(),
);

let stateShape = "";
const openPaths = new Set([
  "",
  "players",
  "balances",
  "inventories",
  "turtle",
  "peripherals",
]);
function tree(value, key, path) {
  if (value !== null && typeof value === "object") {
    const entries = Array.isArray(value)
      ? value.map((v, i) => [String(i), v])
      : Object.entries(value);
    const d = el("details");
    if (openPaths.has(path)) d.open = true;
    d.addEventListener("toggle", () =>
      d.open ? openPaths.add(path) : openPaths.delete(path),
    );
    d.append(
      el(
        "summary",
        {},
        key === null ? "state" : key,
        " ",
        el("span", {
          class: "n",
          text: Array.isArray(value)
            ? `[${entries.length}]`
            : `{${entries.length}}`,
        }),
      ),
    );
    for (const [k, v] of entries)
      d.append(tree(v, k, path ? `${path}.${k}` : k));
    return d;
  }
  const cls =
    typeof value === "string"
      ? "s"
      : typeof value === "number"
        ? "num"
        : typeof value === "boolean"
          ? "b"
          : "nil";
  return el(
    "div",
    { class: "leaf" },
    el("span", { class: "k", text: `${key}: ` }),
    el("span", {
      class: cls,
      text: typeof value === "string" ? JSON.stringify(value) : String(value),
    }),
  );
}

let commandsFor = "";
let commandList = [];
async function refreshSide(force) {
  const s = cur();
  if (!s) return;
  const which = panel();
  if (which === "world") {
    try {
      const state = await api(`/api/sessions/${s.id}/state`);
      const shape = JSON.stringify(state);
      $("#state-age").textContent = new Date().toLocaleTimeString();
      if (shape !== stateShape || force) {
        stateShape = shape;
        $("#state").replaceChildren(tree(state, null, ""));
        const players = new Set([
          ...Object.keys(state.balances || {}),
          ...(state.players ? Object.keys(state.players) : []),
        ]);
        $("#player-list").replaceChildren(
          ...[...players].map((p) => el("option", { value: p })),
        );
        $("#inv-list").replaceChildren(
          ...Object.keys(state.inventories || {}).map((p) =>
            el("option", { value: p }),
          ),
        );
      }
    } catch {
      // not ready yet
    }
  } else if (which === "commands") {
    if (commandsFor !== s.id || force) {
      commandsFor = s.id;
      try {
        commandList = (await api(`/api/sessions/${s.id}/commands`)).commands;
      } catch {
        commandList = [];
      }
      renderCommands();
    }
  } else if (which === "files" && force) {
    loadFiles();
  }
}

function template(c) {
  const out = { cmd: c.cmd };
  const inner = c.args.replace(/^\{|\}$/g, "");
  for (const part of inner.split(",")) {
    const m = /^\s*(\w+)(\??)/.exec(part);
    if (!m || m[2]) continue;
    const name = m[1];
    out[name] =
      /^(x|y|z|slot|seconds|amount|energy|rate|level|value|count|blocksWide|blocksHigh|tank|ticks|speed)$/.test(
        name,
      )
        ? 0
        : /^(active|connected|powered|loaded|online|available)$/.test(name)
          ? true
          : "";
  }
  return out;
}

function renderCommands() {
  const f = $("#cmd-filter").value.toLowerCase();
  const list = $("#cmd-list");
  list.replaceChildren(
    ...commandList
      .filter(
        (c) =>
          !f ||
          `${c.cmd} ${c.args} ${c.help} ${c.addon || ""}`
            .toLowerCase()
            .includes(f),
      )
      .map((c) =>
        el(
          "li",
          {
            onclick: () =>
              ($("#cmd-text").value = JSON.stringify(
                template(c),
                null,
                1,
              ).replace(/\n\s*/g, " ")),
          },
          c.addon ? el("span", { class: "m", text: c.addon }) : null,
          el("span", { class: "c", text: c.cmd }),
          " ",
          el("span", { class: "a", text: c.args }),
          c.help ? el("span", { class: "h", text: c.help }) : null,
        ),
      ),
  );
}
$("#cmd-filter").addEventListener("input", renderCommands);
$("#cmd-send").addEventListener("click", async () => {
  const out = $("#cmd-result");
  let cmd;
  try {
    cmd = JSON.parse($("#cmd-text").value);
  } catch (e) {
    out.className = "msg bad";
    out.textContent = `not JSON: ${e.message}`;
    return;
  }
  out.className = "msg";
  out.textContent = "sending...";
  const r = await command(cmd);
  out.className = `msg ${r.error ? "bad" : "ok"}`;
  out.textContent = r.error ? r.error : "applied";
});
$("#cmd-text").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("#cmd-send").click();
});

// ───────────────────────── files ─────────────────────────

let editing = null;
async function loadFiles() {
  const s = cur();
  if (!s) return;
  try {
    const { dir, entries } = await api(`/api/sessions/${s.id}/files`);
    $("#files-dir").textContent = dir;
    $("#files-dir").title = dir;
    const list = $("#files");
    list.replaceChildren(
      ...entries.map((e) => {
        const depth = e.path.split("/").length - 1;
        const name = e.path.split("/").pop();
        const li = el(
          "li",
          {
            class: e.kind === "directory" ? "dir" : "",
            style: `padding-left:${4 + depth * 14}px`,
          },
          e.kind === "directory" ? `${name}/` : name,
        );
        if (e.kind !== "directory") {
          li.append(el("span", { class: "size", text: `${e.size} B` }));
          li.addEventListener("click", () => openFile(e.path));
        }
        return li;
      }),
    );
    if (!entries.length)
      list.append(el("li", { class: "dir", text: "(no files yet)" }));
  } catch (e) {
    $("#files").replaceChildren(el("li", { class: "dir", text: e.message }));
  }
}
async function openFile(path) {
  const s = cur();
  editing = { id: s.id, path };
  $("#editor-card").hidden = false;
  $("#editor-name").textContent = path;
  $("#editor-msg").textContent = "";
  $("#editor").value = await api(
    `/api/sessions/${s.id}/file?path=${encodeURIComponent(path)}`,
  ).catch((e) => `-- ${e.message}`);
}
async function saveFile(reboot) {
  if (!editing) return;
  const res = await fetch(
    `/api/sessions/${editing.id}/file?path=${encodeURIComponent(editing.path)}`,
    { method: "PUT", body: $("#editor").value },
  );
  $("#editor-msg").className = `msg ${res.ok ? "ok" : "bad"}`;
  $("#editor-msg").textContent = res.ok ? "saved" : await res.text();
  if (res.ok && reboot) await post("/reboot");
  loadFiles();
}
$("#editor-save").addEventListener("click", () => saveFile(false));
$("#editor-save-reboot").addEventListener("click", () => saveFile(true));
$("#files-refresh").addEventListener("click", loadFiles);
$("#files-sync").addEventListener("click", async () => {
  await post("/sync");
  loadFiles();
});

// ───────────────────────── new computer ─────────────────────────

const dlg = $("#dlg");
const form = $("#form");
function openForm() {
  $("#form-error").textContent = "";
  dlg.showModal();
}
$("#new").addEventListener("click", openForm);
$("#new2").addEventListener("click", openForm);
$("#cancel").addEventListener("click", () => dlg.close());

function monRow(m = {}) {
  const row = el(
    "div",
    { class: "mon-row" },
    el("input", { class: "mname", placeholder: "name", value: m.name || "" }),
    el("input", {
      type: "number",
      min: "1",
      max: String(meta?.monitorLimit.width ?? 8),
      value: String(m.blocksWide || 1),
      title: "blocks wide",
    }),
    "x",
    el("input", {
      type: "number",
      min: "1",
      max: String(meta?.monitorLimit.height ?? 6),
      value: String(m.blocksHigh || 1),
      title: "blocks high",
    }),
    "blocks, scale",
    el("input", {
      type: "number",
      min: "0.5",
      max: "5",
      step: "0.5",
      value: String(m.textScale || 1),
      title: "text scale",
    }),
    el("button", {
      type: "button",
      class: "btn ghost",
      text: "x",
      onclick: () => row.remove(),
    }),
  );
  $("#mon-rows").append(row);
}
$("#mon-add").addEventListener("click", () => {
  const n = $$(".mon-row").length;
  monRow({
    name: n === 0 ? "top" : `monitor_${n}`,
    blocksWide: 2,
    blocksHigh: 1,
  });
});

form.elements.count.addEventListener(
  "input",
  () => ($("#modem-wrap").hidden = Number(form.elements.count.value) <= 1),
);

function setAddons(list) {
  const all = meta.addons.map((a) => a.id);
  const on =
    list === "all"
      ? all
      : list === "none"
        ? []
        : Array.isArray(list)
          ? list
          : meta.addons.filter((a) => a.on).map((a) => a.id);
  for (const box of $$("#addons input"))
    box.checked = on.includes(box.value) && !box.disabled;
}
// the Minecraft version: each mod shows its version there, and a mod with no release for it cannot be ticked
function showVersion(mc) {
  for (const a of meta.addons) {
    const box = $(`#addons input[value="${a.id}"]`);
    const ver = (a.versions || {})[mc];
    box.disabled = !ver;
    if (!ver) box.checked = false;
    const label = box.closest("label");
    label.classList.toggle("off", !ver);
    $(".ver", label).textContent = ver
      ? ` ${ver.split(" ")[0]}`
      : ` (none for ${mc})`;
  }
}
form.elements.version.addEventListener("change", () =>
  showVersion(form.elements.version.value),
);
form.elements.worldFile.addEventListener("change", async () => {
  const name = form.elements.worldFile.value;
  let world = {};
  if (name)
    world = await api(`/api/worlds/${encodeURIComponent(name)}`).catch(
      () => ({}),
    );
  form.elements.world.value = JSON.stringify(world, null, 2);
  const mc =
    typeof world.version === "string" ? world.version : world.version?.mc;
  if (mc && meta.versions.some((v) => v.mc === mc)) {
    form.elements.version.value = mc;
    showVersion(mc);
  }
  setAddons(world.addons);
  const mons = world.monitors;
  if (Array.isArray(mons)) {
    $("#mon-rows").replaceChildren();
    mons.forEach(monRow);
  }
});
// ticking an addon also ticks what it needs
$("#addons").addEventListener("change", (e) => {
  const a = meta.addons.find((x) => x.id === e.target.value);
  if (e.target.checked)
    for (const r of a?.requires || [])
      $(`#addons input[value="${r}"]`).checked = true;
  else
    for (const x of meta.addons)
      if (x.requires.includes(e.target.value))
        $(`#addons input[value="${x.id}"]`).checked = false;
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#form-error");
  err.textContent = "";
  let world;
  try {
    world = JSON.parse(form.elements.world.value || "{}");
    if (typeof world !== "object" || world === null || Array.isArray(world))
      throw new Error("the world must be a JSON object");
  } catch (x) {
    err.textContent = `World JSON: ${x.message}`;
    return;
  }
  delete world.monitors;
  const monitors = $$(".mon-row").map((r) => {
    const [name, w, h, scale] = $$("input", r).map((i) => i.value);
    return {
      name: name.trim(),
      blocksWide: Number(w) || 1,
      blocksHigh: Number(h) || 1,
      ...(Number(scale) && Number(scale) !== 1
        ? { textScale: Number(scale) }
        : {}),
    };
  });
  const body = {
    name: form.elements.name.value.trim() || undefined,
    kind: form.elements.kind.value,
    advanced: form.elements.advanced.checked,
    world,
    addons: $$("#addons input:checked").map((i) => i.value),
    version: form.elements.version.value || undefined,
    monitors,
    program: form.elements.program.value.trim() || undefined,
    timeScale: Number(form.elements.timeScale.value) || 1,
    count: Number(form.elements.count.value) || 1,
    modem: form.elements.modem.value,
  };
  const btn = $("#create");
  btn.disabled = true;
  btn.textContent = "Starting...";
  try {
    const { ids } = await api("/api/sessions", { json: body });
    dlg.close();
    await poll(true);
    select(ids[0]);
  } catch (x) {
    err.textContent = x.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Create";
  }
});

// ───────────────────────── polling ─────────────────────────

let pollBusy = false;
async function poll(force) {
  if (pollBusy && !force) return;
  pollBusy = true;
  try {
    const data = await api("/api/sessions");
    sessions = data.sessions;
    lastRun = data.lastRun;
    if (current && current !== "lastrun" && !sessionById(current))
      current = null;
    if (!current && sessions.length) select(sessions[0].id);
    renderTabs();
    layout();
    updateScreens();
  } catch {
    // server restarting
  } finally {
    pollBusy = false;
  }
}

async function init() {
  meta = await api("/api/meta");
  if (meta.problems.length) {
    $("#problems").hidden = false;
    $("#problems").textContent = meta.problems.join("\n");
  }
  const sel = form.elements.worldFile;
  for (const w of meta.worlds) sel.append(el("option", { value: w, text: w }));
  $("#programs").replaceChildren(
    ...meta.programs.map((p) => el("option", { value: p })),
  );
  $("#addons").replaceChildren(
    ...meta.addons.map((a) =>
      el(
        "label",
        {
          class: "check",
          title: a.requires.length ? `needs ${a.requires.join(", ")}` : a.id,
        },
        el("input", { type: "checkbox", value: a.id }),
        a.name,
        el("span", { class: "ver", text: ` ${a.version.split(" ")[0]}` }),
      ),
    ),
  );
  form.elements.version.replaceChildren(
    ...meta.versions.map((v) =>
      el("option", { value: v.mc, text: `${v.mc} (CC:Tweaked ${v.cc})` }),
    ),
  );
  form.elements.version.value = meta.version;
  showVersion(meta.version);
  setAddons(undefined);
  await poll(true);
  setInterval(poll, 120);
  setInterval(() => refreshSide(false), 1000);
  setInterval(() => $("#overlay").checked && fetchUi(), 500);
}
init();
