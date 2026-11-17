// player.js: run ComputerCraft carts in the browser (web/README.md). One ES module, no dependencies, no build step.
//
//   import { mountPlayer } from "/craftos/runtime/player.js";
//   const player = mountPlayer(element, { cart: "/craftos/carts/reversi.json", onEvent: (e) => console.log(e) });
//   await player.ready;
//   player.sim({ cmd: "advance", seconds: 3600 });
//   player.destroy();
//
// Each computer of a cart runs in its own Web Worker (worker.js), the engine on pthreads nested in it. The page must be
// cross-origin isolated (COOP same-origin + COEP require-corp or credentialless) for SharedArrayBuffer. This module
// draws every terminal, monitor and pixel screen on canvases with CC's font and palette, turns keys, mouse and taps
// into CC events, and routes modem traffic between the computers of a cart (a port of packages/runner/src/network.ts).

const CELL_W = 6;
const CELL_H = 9;
/** Border around a terminal, in screen pixels, coloured like its nearest cell (as CC and packages/rawterm draw it). */
const MARGIN = 2;
const TWEAKED_URL = "https://tweaked.cc";

// ---------------------------------------------------------------------------------------------------------------
// Runtime files, fetched once per runtime base and shared by every player on the page
// ---------------------------------------------------------------------------------------------------------------

const runtimes = new Map();
let liveWorkers = 0;
let livePlayers = 0;

/** How many computer workers and players are alive on this page (tests use it to check teardown). */
export function runtimeStats() {
  return { workers: liveWorkers, players: livePlayers };
}

function defaultRuntimeBase() {
  return new URL(".", import.meta.url).href;
}

async function gunzipIfNeeded(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return buffer; // the server already decoded it
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

/** Fetch and prepare the runtime at `runtimeBase` (the engine, ROM and font). Cached: call it early to preload. */
export function loadRuntime(runtimeBase = defaultRuntimeBase()) {
  const base = new URL(runtimeBase, location.href).href.replace(/\/?$/, "/");
  let runtime = runtimes.get(base);
  if (runtime) return runtime;
  runtime = (async () => {
    if (!self.crossOriginIsolated)
      throw new Error(
        "this page is not cross-origin isolated: serve it with Cross-Origin-Opener-Policy: same-origin and " +
          "Cross-Origin-Embedder-Policy: require-corp (or credentialless)",
      );
    const manifest = await fetch(base + "manifest.json", {
      cache: "no-cache",
    }).then((r) => {
      if (!r.ok) throw new Error(`runtime manifest: HTTP ${r.status}`);
      return r.json();
    });
    const url = (name) =>
      `${base}${name}?v=${manifest.files[name]?.hash ?? "0"}`;
    const wasmUrl = url("craftos.wasm");
    const wasm = (async () => {
      try {
        return await WebAssembly.compileStreaming(fetch(wasmUrl));
      } catch {
        // a server that does not send application/wasm
        return WebAssembly.compile(
          await fetch(wasmUrl).then((r) => r.arrayBuffer()),
        );
      }
    })();
    const rom = fetch(url(manifest.rom))
      .then((r) => {
        if (!r.ok) throw new Error(`ROM: HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then(gunzipIfNeeded);
    const font = fetch(url("cc-font.bin"))
      .then((r) => r.arrayBuffer())
      .then((b) => new Uint8Array(b));
    const [wasmModule, romBuffer, glyphs] = await Promise.all([
      wasm,
      rom,
      font,
    ]);
    const workerUrl = `${base}worker.js?v=${manifest.files["worker.js"]?.hash ?? "0"}&js=${manifest.files["craftos.js"]?.hash ?? "0"}`;
    return {
      base,
      manifest,
      wasmModule,
      rom: romBuffer,
      glyphs,
      workerUrl,
      runtimeUrls: { "craftos.wasm": wasmUrl },
    };
  })();
  runtime.catch(() => runtimes.delete(base));
  runtimes.set(base, runtime);
  return runtime;
}

// ---------------------------------------------------------------------------------------------------------------
// Keys: browser KeyboardEvent.code to CC:Tweaked's key codes (GLFW, as the 1.101.3 keys API has them)
// ---------------------------------------------------------------------------------------------------------------

const KEYS = (() => {
  const k = {
    Space: 32,
    Quote: 39,
    Comma: 44,
    Minus: 45,
    Period: 46,
    Slash: 47,
    Semicolon: 59,
    Equal: 61,
    BracketLeft: 91,
    Backslash: 92,
    BracketRight: 93,
    Backquote: 96,
    IntlBackslash: 92,
    Escape: 256,
    Enter: 257,
    Tab: 258,
    Backspace: 259,
    Insert: 260,
    Delete: 261,
    ArrowRight: 262,
    ArrowLeft: 263,
    ArrowDown: 264,
    ArrowUp: 265,
    PageUp: 266,
    PageDown: 267,
    Home: 268,
    End: 269,
    CapsLock: 280,
    ScrollLock: 281,
    NumLock: 282,
    PrintScreen: 283,
    Pause: 284,
    NumpadDecimal: 330,
    NumpadDivide: 331,
    NumpadMultiply: 332,
    NumpadSubtract: 333,
    NumpadAdd: 334,
    NumpadEnter: 335,
    NumpadEqual: 336,
    ShiftLeft: 340,
    ControlLeft: 341,
    AltLeft: 342,
    MetaLeft: 343,
    ShiftRight: 344,
    ControlRight: 345,
    AltRight: 346,
    MetaRight: 347,
    ContextMenu: 348,
  };
  for (let i = 0; i < 26; i++) k["Key" + String.fromCharCode(65 + i)] = 65 + i;
  for (let i = 0; i < 10; i++) {
    k["Digit" + i] = 48 + i;
    k["Numpad" + i] = 320 + i;
  }
  for (let i = 1; i <= 25; i++) k["F" + i] = 289 + i;
  return k;
})();

/** Names the on-screen keys bar and player.key() accept, as in CC's keys API. */
export const KEY_NAMES = {
  up: 265,
  down: 264,
  left: 263,
  right: 262,
  enter: 257,
  space: 32,
  backspace: 259,
  tab: 258,
  escape: 256,
  delete: 261,
  home: 268,
  end: 269,
  pageUp: 266,
  pageDown: 267,
  leftCtrl: 341,
  leftShift: 340,
  leftAlt: 342,
  ...Object.fromEntries(
    [..."abcdefghijklmnopqrstuvwxyz"].map((c, i) => [c, 65 + i]),
  ),
  ...Object.fromEntries([..."0123456789"].map((c, i) => [c, 48 + i])),
};
const KEY_LABELS = {
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  enter: "Enter",
  space: "Space",
  backspace: "⌫",
  tab: "Tab",
  escape: "Esc",
};

// ---------------------------------------------------------------------------------------------------------------
// Styles (one <style> per document; everything is under .ccp, and the colours are CSS variables a site can set)
// ---------------------------------------------------------------------------------------------------------------

const CSS = `
.ccp{--ccp-bg:#1b1b1f;--ccp-fg:#e8e8e8;--ccp-dim:#9a9aa2;--ccp-button:#33333a;--ccp-button-hover:#45454e;
--ccp-accent:#d6b54a;--ccp-bezel-adv:#c9a93f;--ccp-bezel:#9c9c9c;--ccp-monitor:#c9a93f;
position:relative;display:flex;flex-direction:column;gap:6px;box-sizing:border-box;width:100%;min-width:0;
background:var(--ccp-bg);color:var(--ccp-fg);font:13px/1.3 system-ui,sans-serif;padding:8px;border-radius:6px;outline:none}
.ccp:fullscreen{border-radius:0;padding:10px}
.ccp *{box-sizing:border-box}
.ccp-bar{display:flex;flex-wrap:wrap;gap:4px;align-items:center}
.ccp-bar .ccp-spacer{flex:1}
.ccp button{font:inherit;color:var(--ccp-fg);background:var(--ccp-button);border:1px solid #0006;border-radius:4px;
padding:3px 9px;cursor:pointer;touch-action:manipulation;-webkit-user-select:none;user-select:none}
.ccp button:hover{background:var(--ccp-button-hover)}
.ccp button:active,.ccp button.ccp-down{background:var(--ccp-accent);color:#111}
.ccp-label{color:var(--ccp-dim);font-size:12px}
.ccp-stage{position:relative;display:flex;justify-content:center;align-items:center;flex:1;min-height:0;overflow:hidden}
.ccp-stations{display:flex;gap:14px;align-items:center;justify-content:center}
.ccp-station{display:flex;flex-direction:column;align-items:center;gap:4px}
.ccp-screens{display:flex;gap:10px;align-items:center;justify-content:center}
.ccp-name{color:var(--ccp-dim);font-size:12px;height:16px}
.ccp-screen{position:relative;line-height:0;border-radius:3px;background:#000}
.ccp-screen.ccp-terminal{padding:var(--ccp-pad);background:var(--ccp-bezel-adv);box-shadow:inset 0 0 0 2px #0003}
.ccp-screen.ccp-terminal.ccp-normal{background:var(--ccp-bezel)}
.ccp-screen.ccp-monitor,.ccp-screen.ccp-pixels{padding:var(--ccp-pad);background:var(--ccp-monitor);box-shadow:inset 0 0 0 2px #0003}
.ccp-screen canvas{display:block;image-rendering:pixelated;image-rendering:crisp-edges;touch-action:none}
.ccp-screen canvas.ccp-smooth{image-rendering:auto}
.ccp-screen.ccp-hidden{display:none}
.ccp-overlay{position:absolute;inset:0;display:flex;flex-direction:column;gap:8px;align-items:center;justify-content:center;
background:#000a;color:#fff;font-size:15px;text-align:center;padding:12px;z-index:2}
.ccp-overlay[hidden]{display:none}
.ccp-keys{display:flex;flex-wrap:wrap;gap:5px;justify-content:center}
.ccp-keys button{min-width:44px;min-height:40px;font-size:16px}
.ccp-keys[hidden]{display:none}
.ccp-footer{display:flex;flex-wrap:wrap;gap:8px;align-items:center;color:var(--ccp-dim);font-size:12px}
.ccp-footer a{color:var(--ccp-accent)}
.ccp-ime{position:absolute;left:0;bottom:0;width:1px;height:1px;opacity:0;border:0;padding:0;resize:none}
`;

function injectStyle(doc) {
  if (doc.getElementById("ccp-style")) return;
  const style = doc.createElement("style");
  style.id = "ccp-style";
  style.textContent = CSS;
  doc.head.appendChild(style);
}

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== false)
      el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children) if (c !== null && c !== undefined) el.append(c);
  return el;
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------------------------

/** Draw a text-mode or graphics-mode frame into `image` (an ImageData of the frame's size plus the margin). */
function drawFrame(image, frame, glyphs, cursorOn) {
  const W = image.width;
  const out = new Uint32Array(image.data.buffer);
  const pal = new Uint32Array(frame.mode === 2 ? 256 : 16);
  for (let i = 0; i < pal.length; i++) {
    let r = frame.palette[i * 3] ?? 0;
    let g = frame.palette[i * 3 + 1] ?? 0;
    let b = frame.palette[i * 3 + 2] ?? 0;
    if (frame.grayscale) r = g = b = Math.round((r + g + b) / 3);
    pal[i] = 0xff000000 | (b << 16) | (g << 8) | r;
  }
  const fw = frame.width;
  const fh = frame.height;
  const innerW = fw * CELL_W;
  const innerH = fh * CELL_H;
  if (frame.mode === 0) {
    const { text, colors } = frame;
    for (let cy = 0; cy < fh; cy++) {
      for (let cx = 0; cx < fw; cx++) {
        const i = cy * fw + cx;
        const attr = colors[i];
        const fg = pal[attr & 15];
        const bg = pal[attr >> 4];
        const g = text[i] * CELL_H;
        let o = (MARGIN + cy * CELL_H) * W + MARGIN + cx * CELL_W;
        for (let r = 0; r < CELL_H; r++, o += W) {
          const bits = glyphs[g + r];
          out[o] = bits & 32 ? fg : bg;
          out[o + 1] = bits & 16 ? fg : bg;
          out[o + 2] = bits & 8 ? fg : bg;
          out[o + 3] = bits & 4 ? fg : bg;
          out[o + 4] = bits & 2 ? fg : bg;
          out[o + 5] = bits & 1 ? fg : bg;
        }
      }
    }
    if (
      cursorOn &&
      frame.blink &&
      frame.cursorX >= 0 &&
      frame.cursorY >= 0 &&
      frame.cursorX < fw &&
      frame.cursorY < fh
    ) {
      const fg = pal[colors[frame.cursorY * fw + frame.cursorX] & 15];
      // CC's cursor is an underscore: the glyph's row 8, from row 7 of the cell
      const o =
        (MARGIN + frame.cursorY * CELL_H + CELL_H - 2) * W +
        MARGIN +
        frame.cursorX * CELL_W;
      for (let k = 0; k < CELL_W; k++) out[o + k] = fg;
    }
    // the margin takes the colour of the nearest cell's background
    const edge = (cx, cy) =>
      pal[
        colors[
          Math.min(fh - 1, Math.max(0, cy)) * fw +
            Math.min(fw - 1, Math.max(0, cx))
        ] >> 4
      ];
    for (let y = 0; y < image.height; y++) {
      const inRows = y >= MARGIN && y < MARGIN + innerH;
      for (let x = 0; x < W; x++) {
        if (inRows && x >= MARGIN && x < MARGIN + innerW) {
          x = MARGIN + innerW - 1;
          continue;
        }
        out[y * W + x] = edge(
          Math.floor((x - MARGIN) / CELL_W),
          Math.floor((y - MARGIN) / CELL_H),
        );
      }
    }
  } else {
    out.fill(0xff000000);
    const px = frame.pixels;
    for (let y = 0; y < innerH; y++) {
      const o = (MARGIN + y) * W + MARGIN;
      const p = y * innerW;
      for (let x = 0; x < innerW; x++) out[o + x] = pal[px[p + x]];
    }
  }
}

function frameText(frame) {
  if (!frame || frame.mode !== 0) return [];
  const lines = [];
  for (let y = 0; y < frame.height; y++) {
    let s = "";
    for (let x = 0; x < frame.width; x++)
      s += String.fromCharCode(frame.text[y * frame.width + x]);
    lines.push(s.replace(/\s+$/, ""));
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------------------------
// Modem router: a port of packages/runner/src/network.ts ComputerNetwork.pump. It knows no modem rules; those are in
// ccsim/modem.lua on the receiving side (range, channels, wired names), exactly as with the Node runner.
// ---------------------------------------------------------------------------------------------------------------

class Router {
  constructor() {
    this.members = [];
    this.timer = 0;
    this.outgoing = new Map();
    this.links = new Map();
    this.directoryChanged = false;
  }

  add(member) {
    // member: { name, computerId, send(name, ...params), running }
    this.members.push(
      Object.assign(member, {
        seq: 0,
        linkSeq: 0,
        entry: undefined,
        running: true,
        relay: true,
      }),
    );
  }

  remove(member) {
    this.members = this.members.filter((m) => m !== member);
  }

  /** A computer went off or came back: the directory every relay computer sees changes. */
  setRunning(member, running) {
    member.running = running;
    this.directoryChanged = true;
    this.schedule();
  }

  schedule() {
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 0);
  }

  /** Lines a computer wrote to /results/modem.out. */
  receive(from, lines) {
    if (!from.running) return;
    const live = this.members.filter((m) => m.running);
    for (const line of lines) {
      const kind = line[0];
      if (kind === "P") {
        for (const to of live) {
          if (to === from) continue;
          const batch = this.outgoing.get(to) ?? [];
          batch.push(line.slice(1));
          this.outgoing.set(to, batch);
        }
      } else if (kind === "D" && from.relay) {
        from.entry = line.slice(1);
        this.directoryChanged = true;
      } else if (kind === "M" && from.relay) {
        const target = Number(line.slice(1, line.indexOf(";")));
        const to = live.find((m) => m.relay && m.computerId === target);
        if (!to) continue; // a message for a computer that is gone is lost; the sender learns it from the directory
        const batch = this.links.get(to) ?? [];
        batch.push(line);
        this.links.set(to, batch);
      }
      // "C" (turn a computer on, reboot it) and "W" (block worlds) need the Node host; a cart has neither
    }
    this.schedule();
  }

  flush() {
    this.timer = 0;
    for (const [to, lines] of this.outgoing) {
      if (!to.running) continue;
      to.seq += 1;
      to.send("ccsim_net", to.seq, lines.join("\n"));
    }
    this.outgoing.clear();
    // the directory goes first, so a message never arrives before the link it relies on
    const directory = this.directoryChanged
      ? this.members
          .filter((m) => m.relay && m.entry !== undefined)
          .map((m) => `D${m.running ? 1 : 0};${m.entry}`)
      : [];
    this.directoryChanged = false;
    for (const to of this.members) {
      if (!to.running || !to.relay) continue;
      const lines = [...directory, ...(this.links.get(to) ?? [])];
      if (lines.length === 0) continue;
      to.linkSeq += 1;
      to.send("ccsim_link", to.linkSeq, lines.join("\n"));
    }
    this.links.clear();
  }

  close() {
    clearTimeout(this.timer);
    this.timer = 0;
    this.members = [];
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The player
// ---------------------------------------------------------------------------------------------------------------

const MONITOR_TITLE = /Monitor (.+)$/;

/**
 * Mount a player for `options.cart` (a cart object or its URL) in `element`. Returns the player at once; `ready`
 * resolves when every computer has drawn its first frame.
 *
 * Options: cart, runtimeBase (default: this module's folder), onEvent(event), toolbar (default true), keys
 * ("auto" | true | false: the on-screen keys bar; auto shows it on touch screens for carts that want keys),
 * autofocus (default true), pauseWhenHidden (default true), fit ("auto" | "fill": "fill" uses the element's own
 * height, "auto" up to 85% of the window's height; default "fill" when the element has a height).
 * runtime: a runtime the page put together itself instead of fetching one from runtimeBase (the VS Code web
 * extension does: it has no server to fetch from): { wasmModule, rom (ArrayBuffer), glyphs, workerUrl, runtimeUrls }.
 */
export function mountPlayer(element, options = {}) {
  return new Player(element, options);
}

class Player {
  constructor(element, options) {
    this.element = element;
    this.options = options;
    this.runtimeBase = options.runtimeBase ?? defaultRuntimeBase();
    this.onEvent = options.onEvent ?? (() => {});
    this.computers = [];
    this.destroyed = false;
    this.paused = false;
    this.hiddenPause = false;
    this.stats = {
      mountedAt: performance.now(),
      firstFrameMs: null,
      readyMs: null,
    };
    this.generation = 0;
    this.listeners = [];
    this.fit = options.fit ?? (element.clientHeight > 40 ? "fill" : "auto");
    livePlayers++;
    injectStyle(document);
    this.buildDom();
    if (this.fit === "fill") this.root.style.height = "100%";
    this.ready = this.start().catch((err) => {
      if (!this.destroyed) this.showError(err);
      throw err;
    });
    this.ready.catch(() => {});
  }

  emit(event) {
    try {
      this.onEvent(event);
    } catch (e) {
      console.error(e);
    }
  }

  listen(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this.listeners.push(() => target.removeEventListener(type, fn, opts));
  }

  // ---- DOM ----

  buildDom() {
    const root = h("div", { class: "ccp", tabindex: "0" });
    this.root = root;
    this.toolbar = h("div", { class: "ccp-bar" });
    this.worldBar = h("div", { class: "ccp-bar", hidden: true });
    this.stations = h("div", { class: "ccp-stations" });
    this.overlay = h("div", { class: "ccp-overlay" }, "Loading…");
    this.stage = h("div", { class: "ccp-stage" }, this.stations, this.overlay);
    this.keysBar = h("div", { class: "ccp-keys", hidden: true });
    this.status = h("span", {});
    this.ime = h("textarea", {
      class: "ccp-ime",
      autocapitalize: "off",
      autocomplete: "off",
      spellcheck: "false",
      "aria-hidden": "true",
    });
    const footer = h(
      "div",
      { class: "ccp-footer" },
      h(
        "a",
        { href: TWEAKED_URL, target: "_blank", rel: "noopener" },
        "Uses CC:Tweaked",
      ),
      h("span", { class: "ccp-spacer" }),
      this.status,
    );
    if (this.options.toolbar !== false)
      root.append(this.toolbar, this.worldBar);
    root.append(this.stage, this.keysBar, footer, this.ime);
    this.element.append(root);

    this.listen(root, "keydown", (e) => this.onKey(e, false));
    this.listen(root, "keyup", (e) => this.onKey(e, true));
    this.listen(root, "paste", (e) => {
      const text = e.clipboardData?.getData("text") ?? "";
      if (text) this.sendToFocus("paste", text.split(/\r?\n/)[0]);
      e.preventDefault();
    });
    this.listen(this.ime, "beforeinput", (e) => {
      if (e.inputType === "deleteContentBackward")
        this.tapKey(KEY_NAMES.backspace);
      else if (
        e.inputType === "insertLineBreak" ||
        e.inputType === "insertParagraph"
      )
        this.tapKey(KEY_NAMES.enter);
      else if (e.data) for (const ch of e.data) this.sendToFocus("char", ch);
      e.preventDefault();
    });
    this.listen(document, "visibilitychange", () => {
      if (this.options.pauseWhenHidden === false) return;
      this.hiddenPause = document.hidden;
      this.applyPause();
    });
    this.listen(document, "fullscreenchange", () => this.layout());
    this.listen(window, "blur", () => this.releaseAllKeys());
    this.resizeObserver = new ResizeObserver(() => this.layout());
    this.resizeObserver.observe(this.element);
    this.blinkTimer = setInterval(() => this.blink(), 400);
    this.cursorOn = true;
  }

  buildToolbar() {
    const bar = this.toolbar;
    bar.replaceChildren();
    const button = (label, title, fn) =>
      h(
        "button",
        {
          type: "button",
          title,
          onclick: (e) => {
            fn();
            this.root.focus({ preventScroll: true });
            e.preventDefault();
          },
        },
        label,
      );
    bar.append(
      button("Reset", "Start the cart again from the beginning", () =>
        this.reset(),
      ),
      button("Ctrl+T", "Terminate the running program (hold Ctrl+T)", () =>
        this.terminate(),
      ),
      button("Ctrl+R", "Reboot the computer (hold Ctrl+R)", () =>
        this.reboot(),
      ),
      button("Ctrl+S", "Shut the computer down (hold Ctrl+S)", () =>
        this.shutdown(),
      ),
    );
    this.pauseButton = button("Pause", "Pause or resume the computers", () =>
      this.paused ? this.resume() : this.pause(),
    );
    bar.append(this.pauseButton);
    if (this.computers.some((c) => c.spec.terminal === "hide")) {
      bar.append(
        button("Terminal", "Show or hide the computer's own screen", () =>
          this.toggleTerminals(),
        ),
      );
    }
    if (this.wantsKeys() || matchMedia("(pointer: coarse)").matches)
      bar.append(
        button("⌨", "Open the on-screen keyboard", () => this.openKeyboard()),
      );
    bar.append(
      h("span", { class: "ccp-spacer" }),
      button("Fullscreen", "Fullscreen", () => this.fullscreen()),
    );

    const actions = this.cart.actions ?? [];
    this.worldBar.replaceChildren();
    this.worldBar.hidden = actions.length === 0;
    if (actions.length) {
      this.worldBar.append(h("span", { class: "ccp-label" }, "World:"));
      for (const a of actions)
        this.worldBar.append(
          button(a.label, a.title ?? a.label, () =>
            this.sim(a.command, a.computer),
          ),
        );
    }
  }

  wantsKeys() {
    return Array.isArray(this.cart.keys) && this.cart.keys.length > 0;
  }

  buildKeysBar() {
    const mode = this.options.keys ?? "auto";
    const names = this.cart.keys ?? [];
    const show =
      mode === true ||
      (mode === "auto" &&
        names.length > 0 &&
        matchMedia("(pointer: coarse)").matches);
    this.keysBar.replaceChildren();
    this.keysBar.hidden = !show;
    if (!show) return;
    for (const name of names.length
      ? names
      : ["left", "up", "down", "right", "enter", "space"]) {
      const code = KEY_NAMES[name];
      if (code === undefined) continue;
      let repeat = 0;
      const stop = (b) => {
        clearTimeout(repeat);
        clearInterval(repeat);
        repeat = 0;
        if (b.classList.contains("ccp-down")) {
          b.classList.remove("ccp-down");
          this.sendToFocus("key_up", code);
        }
      };
      const b = h(
        "button",
        {
          type: "button",
          "data-key": name,
          onpointerdown: (e) => {
            e.preventDefault();
            b.setPointerCapture?.(e.pointerId);
            b.classList.add("ccp-down");
            this.sendToFocus("key", code, false);
            if (name.length === 1) this.sendToFocus("char", name);
            else if (name === "space") this.sendToFocus("char", " ");
            repeat = setTimeout(() => {
              repeat = setInterval(
                () => this.sendToFocus("key", code, true),
                80,
              );
            }, 400);
          },
          onpointerup: () => stop(b),
          onpointercancel: () => stop(b),
          oncontextmenu: (e) => e.preventDefault(),
        },
        KEY_LABELS[name] ?? name,
      );
      this.keysBar.append(b);
    }
  }

  // ---- start / stop ----

  async start() {
    const generation = ++this.generation;
    this.cart =
      typeof this.options.cart === "string"
        ? await fetch(this.options.cart).then((r) => {
            if (!r.ok) throw new Error(`cart: HTTP ${r.status}`);
            return r.json();
          })
        : this.options.cart;
    if (
      !this.cart ||
      !Array.isArray(this.cart.computers) ||
      this.cart.computers.length === 0
    )
      throw new Error("cart has no computers");
    const runtime = await (this.options.runtime ??
      loadRuntime(this.runtimeBase));
    if (this.destroyed || generation !== this.generation) return;
    this.runtime = runtime;
    this.glyphs = runtime.glyphs;
    this.buildToolbar();
    this.buildKeysBar();
    this.router = this.cart.computers.length > 1 ? new Router() : null;
    this.overlay.textContent = "Starting…";
    const started = this.cart.computers.map((spec, index) =>
      this.startComputer(spec, index),
    );
    this.layout();
    await Promise.all(started.map((c) => c.firstFrame));
    if (this.destroyed || generation !== this.generation) return;
    this.overlay.hidden = true;
    this.stats.readyMs = performance.now() - this.stats.mountedAt;
    if (this.options.autofocus !== false)
      this.root.focus({ preventScroll: true });
    this.setStatus("");
    this.emit({ type: "ready", ms: this.stats.readyMs });
  }

  startComputer(spec, index) {
    const name = spec.name ?? `computer ${spec.id ?? index}`;
    const station = h("div", { class: "ccp-station" });
    const label = h(
      "div",
      { class: "ccp-name" },
      this.cart.computers.length > 1 ? (spec.label ?? name) : "",
    );
    const screensEl = h("div", { class: "ccp-screens" });
    const offOverlay = h("div", { class: "ccp-overlay", hidden: true });
    station.append(label, screensEl);
    station.style.position = "relative";
    station.append(offOverlay);
    this.stations.append(station);

    const computer = {
      spec,
      name,
      index,
      station,
      screensEl,
      offOverlay,
      screens: new Map(), // window id or "pixels:<name>" -> screen
      worker: null,
      cmdSeq: 0,
      off: false,
      terminalShown: spec.terminal !== "hide",
    };
    let resolveFirst;
    computer.firstFrame = new Promise((r) => (resolveFirst = r));
    computer.resolveFirst = resolveFirst;
    this.computers[index] = computer;
    this.spawn(computer);
    return computer;
  }

  spawn(computer) {
    const worker = new Worker(this.runtime.workerUrl, {
      name: `craftos-${computer.name}`,
    });
    liveWorkers++;
    computer.worker = worker;
    computer.off = false;
    computer.offOverlay.hidden = true;
    worker.onmessage = (e) => this.onWorkerMessage(computer, e.data);
    worker.onerror = (e) => {
      this.emit({ type: "error", computer: computer.name, message: e.message });
      this.showError(new Error(e.message || "the computer's worker failed"));
    };
    const send = (name, ...params) =>
      worker.postMessage({ type: "event", name, params });
    computer.send = send;
    if (this.router) {
      computer.member = {
        name: computer.name,
        computerId: computer.spec.id ?? computer.index,
        send,
      };
      this.router.add(computer.member);
    }
    worker.postMessage({
      type: "start",
      computer: computer.spec,
      rom: this.runtime.rom, // structured clone: each computer gets its own copy
      wasmModule: this.runtime.wasmModule,
      runtimeUrls: this.runtime.runtimeUrls,
    });
    if (this.paused || this.hiddenPause)
      worker.postMessage({ type: "pause", on: true });
  }

  killComputer(computer) {
    clearTimeout(computer.readyFallback);
    computer.readyFallback = undefined;
    if (computer.worker) {
      computer.worker.onmessage = null;
      computer.worker.terminate();
      computer.worker = null;
      liveWorkers--;
    }
    if (this.router && computer.member) {
      this.router.remove(computer.member);
      computer.member = null;
    }
  }

  /** Start the whole cart again from its files. */
  reset() {
    if (this.destroyed) return this.ready;
    for (const c of this.computers) this.killComputer(c);
    this.router?.close();
    this.computers = [];
    this.stations.replaceChildren();
    this.overlay.hidden = false;
    this.overlay.textContent = "Starting…";
    this.emit({ type: "reset" });
    this.ready = this.start();
    this.ready.catch((err) => this.showError(err));
    return this.ready;
  }

  /** Stop everything and remove the player from the page. Safe to call twice. */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.generation++;
    for (const c of this.computers) this.killComputer(c);
    this.router?.close();
    this.computers = [];
    clearInterval(this.blinkTimer);
    this.resizeObserver.disconnect();
    for (const off of this.listeners) off();
    this.listeners = [];
    if (document.fullscreenElement === this.root)
      document.exitFullscreen().catch(() => {});
    this.root.remove();
    livePlayers--;
    this.emit({ type: "destroyed" });
  }

  // ---- messages from a computer ----

  onWorkerMessage(computer, m) {
    switch (m.type) {
      case "frames":
        for (const f of m.frames) this.onFrame(computer, f);
        break;
      case "window":
        this.onWindow(computer, m);
        break;
      case "pixels":
        this.onPixels(computer, m);
        break;
      case "net":
        if (this.router && computer.member)
          this.router.receive(computer.member, m.lines);
        this.emit({ type: "net", computer: computer.name, lines: m.lines });
        break;
      case "message":
        this.emit({
          type: "message",
          computer: computer.name,
          title: m.title,
          message: m.message,
        });
        break;
      case "off":
        computer.off = true;
        if (this.router && computer.member)
          this.router.setRunning(computer.member, false);
        computer.offOverlay.replaceChildren(
          h("div", {}, "This computer is off."),
          h(
            "button",
            { type: "button", onclick: () => this.turnOn(computer) },
            "Turn it on",
          ),
        );
        computer.offOverlay.hidden = false;
        this.emit({ type: "off", computer: computer.name });
        break;
      case "log":
        this.emit({ type: "log", computer: computer.name, text: m.text });
        break;
      case "error":
        this.emit({
          type: "error",
          computer: computer.name,
          message: m.message,
        });
        this.showError(new Error(m.message));
        break;
      case "started":
        this.emit({ type: "started", computer: computer.name });
        break;
    }
  }

  /** A computer that shut down starts again from its cart files (what it saved is gone: there is no disk here). */
  turnOn(computer) {
    this.killComputer(computer);
    for (const s of computer.screens.values()) s.el.remove();
    computer.screens.clear();
    this.spawn(computer);
  }

  screenFor(computer, key, kind, name) {
    let s = computer.screens.get(key);
    if (s) return s;
    const canvas = h("canvas", {});
    const el = h("div", { class: `ccp-screen ccp-${kind}` }, canvas);
    if (kind === "terminal" && computer.spec.advanced === false)
      el.classList.add("ccp-normal");
    s = {
      key,
      kind,
      name,
      el,
      canvas,
      ctx: canvas.getContext("2d"),
      frame: null,
      image: null,
      version: 0,
      computer,
    };
    computer.screens.set(key, s);
    this.attachInput(s);
    this.placeScreen(computer, s);
    return s;
  }

  /** Order the screens as the cart lists them (computer.screens: "terminal", "monitor:<name>", "pixels:<name>"). */
  placeScreen(computer, s) {
    const order = computer.spec.screens ?? [];
    const id = s.kind === "terminal" ? "terminal" : `${s.kind}:${s.name}`;
    s.order =
      order.indexOf(id) >= 0
        ? order.indexOf(id)
        : order.length + (s.kind === "terminal" ? 100 : 0);
    if (s.kind === "terminal" && !computer.terminalShown)
      s.el.classList.add("ccp-hidden");
    const after = [...computer.screens.values()]
      .filter((o) => o !== s && o.el.isConnected && o.order > s.order)
      .sort((a, b) => a.order - b.order)[0];
    computer.screensEl.insertBefore(s.el, after?.el ?? null);
  }

  onWindow(computer, m) {
    if (m.closing === 0) {
      const monitor = MONITOR_TITLE.exec(m.title)?.[1];
      const s = this.screenFor(
        computer,
        m.window,
        monitor ? "monitor" : "terminal",
        monitor ?? "terminal",
      );
      s.title = m.title;
    } else if (m.closing === 1 && m.window !== 0) {
      const s = computer.screens.get(m.window);
      if (s) {
        s.el.remove();
        computer.screens.delete(m.window);
        this.layout();
      }
    }
  }

  onFrame(computer, f) {
    let s = computer.screens.get(f.window);
    if (!s)
      s = this.screenFor(
        computer,
        f.window,
        f.window === 0 ? "terminal" : "monitor",
        f.window === 0 ? "terminal" : `window ${f.window}`,
      );
    const resized =
      !s.frame || s.frame.width !== f.width || s.frame.height !== f.height;
    s.frame = f;
    s.version++;
    if (resized) {
      s.canvas.width = f.width * CELL_W + MARGIN * 2;
      s.canvas.height = f.height * CELL_H + MARGIN * 2;
      s.image = s.ctx.createImageData(s.canvas.width, s.canvas.height);
      this.layout();
    }
    this.paint(s);
    this.firstFrame(computer, s);
  }

  onPixels(computer, m) {
    const s = this.screenFor(computer, `pixels:${m.name}`, "pixels", m.name);
    const resized =
      !s.frame || s.frame.width !== m.width || s.frame.height !== m.height;
    s.frame = { width: m.width, height: m.height, pixels: true };
    s.version++;
    if (resized) {
      s.canvas.width = m.width;
      s.canvas.height = m.height;
      this.layout();
    }
    s.ctx.putImageData(new ImageData(m.rgba, m.width, m.height), 0, 0);
    this.firstFrame(computer, s);
  }

  /** A computer is ready when a screen the visitor sees has drawn (a hidden terminal does not count). */
  firstFrame(computer, s) {
    if (this.stats.firstFrameMs === null)
      this.stats.firstFrameMs = performance.now() - this.stats.mountedAt;
    if (!computer.resolveFirst) return;
    if (s.el.classList.contains("ccp-hidden")) {
      // a cart whose program never opens its monitor still becomes ready, a little later
      computer.readyFallback ??= setTimeout(
        () =>
          this.firstFrame(computer, {
            el: { classList: { contains: () => false } },
          }),
        8000,
      );
      return;
    }
    clearTimeout(computer.readyFallback);
    computer.resolveFirst();
    computer.resolveFirst = null;
  }

  paint(s) {
    if (!s.frame || s.frame.pixels) return;
    drawFrame(s.image, s.frame, this.glyphs, this.cursorOn);
    s.ctx.putImageData(s.image, 0, 0);
  }

  blink() {
    this.cursorOn = !this.cursorOn;
    for (const c of this.computers)
      for (const s of c.screens.values())
        if (s.frame?.blink && s.frame.mode === 0) this.paint(s);
  }

  // ---- layout: every screen at one scale, as large as fits ----

  layout() {
    if (this.destroyed || !this.computers.length) return;
    cancelAnimationFrame(this.layoutFrame);
    this.layoutFrame = requestAnimationFrame(() => this.doLayout());
  }

  doLayout() {
    const fullscreen = document.fullscreenElement === this.root;
    const stageRect = this.stage.getBoundingClientRect();
    const width = Math.max(100, this.root.clientWidth - 16);
    let height;
    if (fullscreen || this.fit === "fill") {
      // what the root leaves for the stage once the bars are drawn
      const other = this.root.clientHeight - stageRect.height;
      height = Math.max(
        100,
        (fullscreen ? window.innerHeight : this.element.clientHeight) -
          other -
          16,
      );
    } else height = Math.max(160, Math.round(window.innerHeight * 0.85) - 120);

    const stations = this.computers.map((c) => ({
      c,
      screens: [...c.screens.values()]
        .filter((s) => s.frame && !s.el.classList.contains("ccp-hidden"))
        .sort((a, b) => a.order - b.order),
    }));
    const PAD = 8; // bezel, CSS px
    const GAP = 10;
    const SGAP = 14;
    const NAME = this.computers.length > 1 ? 20 : 0;
    const size = (s) => [s.canvas.width, s.canvas.height];
    // scale fitting `screens` in a row (or column) inside w x h, with fixed px for bezels and gaps
    const fitStation = (st, row) => {
      let nw = 0,
        nh = 0,
        fw = 0,
        fh = NAME;
      st.screens.forEach((s, i) => {
        const [w, hh] = size(s);
        if (row) {
          nw += w;
          nh = Math.max(nh, hh);
          fw += PAD * 2 + (i ? GAP : 0);
        } else {
          nh += hh;
          nw = Math.max(nw, w);
          fh += PAD * 2 + (i ? GAP : 0);
        }
      });
      if (row) fh += PAD * 2;
      else fw += PAD * 2;
      return { nw, nh, fw, fh };
    };
    let best = null;
    for (const stationsRow of [true, false])
      for (const screensRow of [true, false]) {
        const parts = stations
          .filter((st) => st.screens.length)
          .map((st) => fitStation(st, screensRow));
        if (!parts.length) continue;
        // the scale for this arrangement: total = n*s + f on each axis
        let nW = 0,
          nH = 0,
          fW = 0,
          fH = 0;
        parts.forEach((p, i) => {
          if (stationsRow) {
            nW += p.nw;
            fW += p.fw + (i ? SGAP : 0);
            nH = Math.max(nH, p.nh);
            fH = Math.max(fH, p.fh);
          } else {
            nH += p.nh;
            fH += p.fh + (i ? SGAP : 0);
            nW = Math.max(nW, p.nw);
            fW = Math.max(fW, p.fw);
          }
        });
        // max-of-sums is not exact for the cross axis, but close: solve on both axes and take the smaller
        const s = Math.min((width - fW) / nW, (height - fH) / nH);
        if (!best || s > best.s) best = { s, stationsRow, screensRow };
      }
    if (!best) return;
    const dpr = window.devicePixelRatio || 1;
    let device = Math.max(0.1, best.s * dpr);
    // whole device pixels per screen pixel when that costs little, so the font stays crisp
    if (device >= 1 && Math.floor(device) / device >= 0.75)
      device = Math.floor(device);
    const scale = device / dpr;
    this.scale = scale;
    this.stations.style.flexDirection = best.stationsRow ? "row" : "column";
    for (const st of stations) {
      st.c.screensEl.style.flexDirection = best.screensRow ? "row" : "column";
      for (const s of st.c.screens.values()) {
        if (!s.frame) continue;
        const [w, hh] = size(s);
        s.canvas.style.width = `${(w * scale).toFixed(2)}px`;
        s.canvas.style.height = `${(hh * scale).toFixed(2)}px`;
        s.canvas.classList.toggle("ccp-smooth", device < 1);
        s.el.style.setProperty("--ccp-pad", `${PAD}px`);
      }
    }
    if (this.fit !== "fill" && !fullscreen) this.stage.style.minHeight = "";
  }

  toggleTerminals() {
    for (const c of this.computers) {
      c.terminalShown = !c.terminalShown;
      for (const s of c.screens.values())
        if (s.kind === "terminal")
          s.el.classList.toggle("ccp-hidden", !c.terminalShown);
    }
    this.layout();
  }

  // ---- input ----

  /** The computer keys and pasted text go to: the last one touched or clicked, else the first. */
  focusComputer() {
    return (
      this.computers.find((c) => c === this.lastComputer && c.worker) ??
      this.computers.find((c) => c.worker)
    );
  }

  sendToFocus(name, ...params) {
    const c = this.focusComputer();
    if (c && !c.off) c.send(name, ...params);
  }

  tapKey(code) {
    this.sendToFocus("key", code, false);
    this.sendToFocus("key_up", code);
  }

  onKey(e, up) {
    if (e.target !== this.root && e.target !== this.ime) return;
    // keys the browser keeps: fullscreen, developer tools, and Ctrl+V, which becomes a paste event
    if (
      e.key === "F11" ||
      e.key === "F12" ||
      ((e.ctrlKey || e.metaKey) && e.code === "KeyV")
    )
      return;
    const code = KEYS[e.code];
    if (code === undefined) return;
    e.preventDefault();
    this.held ??= new Map();
    if (up) {
      if (!this.held.has(e.code)) return;
      this.held.delete(e.code);
      this.cancelHold(e.code);
      this.sendToFocus("key_up", code);
      return;
    }
    const repeat = this.held.has(e.code);
    this.held.set(e.code, code);
    this.sendToFocus("key", code, repeat);
    if (e.key.length === 1 && !(e.ctrlKey && !e.altKey) && !e.metaKey)
      this.sendToFocus("char", e.key);
    // CC's shortcuts: hold Ctrl+T, Ctrl+R or Ctrl+S for a second
    if (
      e.ctrlKey &&
      !repeat &&
      (e.code === "KeyT" || e.code === "KeyR" || e.code === "KeyS")
    ) {
      this.holds ??= new Map();
      const action = {
        KeyT: () => this.terminate(),
        KeyR: () => this.reboot(),
        KeyS: () => this.shutdown(),
      }[e.code];
      this.holds.set(
        e.code,
        setTimeout(() => {
          this.holds.delete(e.code);
          action();
        }, 1000),
      );
    }
  }

  cancelHold(code) {
    if (!this.holds) return;
    for (const [k, t] of this.holds)
      if (k === code || code === "ControlLeft" || code === "ControlRight") {
        clearTimeout(t);
        this.holds.delete(k);
      }
  }

  releaseAllKeys() {
    if (!this.held) return;
    for (const [k, code] of this.held) {
      this.cancelHold(k);
      this.sendToFocus("key_up", code);
    }
    this.held.clear();
  }

  openKeyboard() {
    this.ime.value = "";
    this.ime.focus({ preventScroll: true });
  }

  /** Cell (1-based) under a pointer event on a screen, or null outside it. */
  cellAt(s, e) {
    const rect = s.canvas.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * s.canvas.width;
    const py = ((e.clientY - rect.top) / rect.height) * s.canvas.height;
    if (s.kind === "pixels") {
      return {
        x: Math.min(s.frame.width, Math.max(1, Math.floor(px) + 1)),
        y: Math.min(s.frame.height, Math.max(1, Math.floor(py) + 1)),
      };
    }
    const f = s.frame;
    return {
      x: Math.min(f.width, Math.max(1, Math.floor((px - MARGIN) / CELL_W) + 1)),
      y: Math.min(
        f.height,
        Math.max(1, Math.floor((py - MARGIN) / CELL_H) + 1),
      ),
    };
  }

  attachInput(s) {
    const c = s.computer;
    const canvas = s.canvas;
    const BUTTON = { 0: 1, 1: 3, 2: 2 };
    let dragging = null;
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("pointerdown", (e) => {
      if (!s.frame || c.off) return;
      e.preventDefault();
      this.lastComputer = c;
      this.root.focus({ preventScroll: true });
      const cell = this.cellAt(s, e);
      if (s.kind === "monitor") c.send("monitor_touch", s.name, cell.x, cell.y);
      else if (s.kind === "pixels")
        this.sim(
          { cmd: "tmTouch", peripheral: s.name, x: cell.x, y: cell.y },
          c.name,
        );
      else if (c.spec.advanced !== false) {
        const button = BUTTON[e.button] ?? 1;
        dragging = { button, x: cell.x, y: cell.y };
        canvas.setPointerCapture?.(e.pointerId);
        c.send("mouse_click", button, cell.x, cell.y);
      }
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!dragging || c.off) return;
      const cell = this.cellAt(s, e);
      if (cell.x === dragging.x && cell.y === dragging.y) return;
      dragging.x = cell.x;
      dragging.y = cell.y;
      c.send("mouse_drag", dragging.button, cell.x, cell.y);
    });
    const up = (e) => {
      if (!dragging) return;
      const cell = this.cellAt(s, e);
      c.send("mouse_up", dragging.button, cell.x, cell.y);
      dragging = null;
    };
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    canvas.addEventListener(
      "wheel",
      (e) => {
        if (
          s.kind !== "terminal" ||
          c.spec.advanced === false ||
          c.off ||
          !s.frame
        )
          return;
        e.preventDefault();
        const cell = this.cellAt(s, e);
        c.send("mouse_scroll", e.deltaY > 0 ? 1 : -1, cell.x, cell.y);
      },
      { passive: false },
    );
  }

  // ---- pause ----

  applyPause() {
    const on = this.paused || this.hiddenPause;
    for (const c of this.computers)
      c.worker?.postMessage({ type: "pause", on });
    if (this.pauseButton)
      this.pauseButton.textContent = this.paused ? "Resume" : "Pause";
    this.setStatus(on ? "Paused" : "");
    this.emit({ type: on ? "paused" : "resumed" });
  }

  /** Stop every computer at its next yield (timers queue up meanwhile). */
  pause() {
    this.paused = true;
    this.applyPause();
  }

  resume() {
    this.paused = false;
    this.applyPause();
  }

  fullscreen() {
    if (document.fullscreenElement === this.root)
      return document.exitFullscreen();
    return this.root.requestFullscreen?.().catch(() => {});
  }

  setStatus(text) {
    this.status.textContent = text;
  }

  showError(err) {
    this.overlay.hidden = false;
    this.overlay.replaceChildren(
      h("div", {}, "This cart could not start."),
      h("div", { class: "ccp-label" }, String(err?.message ?? err)),
    );
    this.emit({ type: "error", message: String(err?.message ?? err) });
  }

  // ---- the public API ----

  computer(which) {
    if (which === undefined) return this.computers[0];
    if (typeof which === "number") return this.computers[which];
    return this.computers.find(
      (c) => c.name === which || c.spec.label === which,
    );
  }

  /** Queue a CC event on a computer (default: the first). */
  event(name, params = [], which) {
    this.computer(which)?.send(name, ...params);
  }

  /** A world command (packages/runner SimCommand, as craftos_sim_command takes it) to one computer (default the first). */
  sim(command, which) {
    const c = this.computer(which);
    if (!c) throw new Error(`no computer ${which}`);
    c.cmdSeq += 1;
    c.send(
      "ccsim_cmd",
      c.cmdSeq,
      typeof command === "string" ? command : JSON.stringify(command),
    );
    this.emit({ type: "sim", computer: c.name, command });
    return c.cmdSeq;
  }

  /** Press and release a key (a KEY_NAMES name or a CC key code). */
  key(key, which) {
    const code = typeof key === "number" ? key : KEY_NAMES[key];
    const c = this.computer(which);
    c?.send("key", code, false);
    c?.send("key_up", code);
  }

  /** Type text as char events. */
  type(text, which) {
    const c = this.computer(which);
    for (const ch of text) c?.send("char", ch);
  }

  /** Touch a monitor cell (1-based), as a player right-clicking it. */
  touch(monitor, x, y, which) {
    this.computer(which)?.send("monitor_touch", monitor, x, y);
  }

  terminate(which) {
    (which === undefined ? this.focusComputer() : this.computer(which))?.send(
      "terminate",
    );
  }

  reboot(which) {
    const c = which === undefined ? this.focusComputer() : this.computer(which);
    if (!c) return;
    if (c.off) this.turnOn(c);
    else this.sim({ cmd: "reboot" }, c.name);
  }

  shutdown(which) {
    const c = which === undefined ? this.focusComputer() : this.computer(which);
    if (c && !c.off) this.sim({ cmd: "shutdown" }, c.name);
  }

  /** Every screen: { computer, kind ("terminal" | "monitor" | "pixels"), name, width, height, version }. */
  screens() {
    const out = [];
    for (const c of this.computers)
      for (const s of c.screens.values())
        if (s.frame)
          out.push({
            computer: c.name,
            kind: s.kind,
            name: s.name,
            width: s.frame.width,
            height: s.frame.height,
            version: s.version,
          });
    return out;
  }

  /** The text on a screen ("terminal" or a monitor's name), one string per line, trailing spaces trimmed. */
  screenText(name = "terminal", which) {
    const c = this.computer(which);
    if (!c) return [];
    for (const s of c.screens.values())
      if (s.name === name) return frameText(s.frame);
    return [];
  }

  /** A text screen's cells: { width, height, text, colors } (colors: background << 4 | foreground), or null. */
  screenCells(name = "terminal", which) {
    const c = this.computer(which);
    for (const s of c?.screens.values() ?? [])
      if (s.name === name && s.frame && s.frame.mode === 0)
        return {
          width: s.frame.width,
          height: s.frame.height,
          text: [...s.frame.text],
          colors: [...s.frame.colors],
        };
    return null;
  }

  /** The canvas of a screen, for screenshots or a site's own layout. */
  canvas(name = "terminal", which) {
    const c = this.computer(which);
    for (const s of c?.screens.values() ?? [])
      if (s.name === name) return s.canvas;
    return null;
  }
}
