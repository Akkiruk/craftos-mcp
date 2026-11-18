// The browser app's views: several computers side by side, the blocks around a turtle, and the messages of a
// network. Loaded after app.js and built on its helpers ($, el, api, paint, fit, select, ...); app.js calls
// craftosViews.poll() after each poll and craftosViews.selected() when another computer is picked.
// The server side is packages/runner/src/webapp-views.ts.
"use strict";

(() => {
  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(`craftos.views.${key}`);
        return raw === null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(`craftos.views.${key}`, JSON.stringify(value));
      } catch {
        // private window: the choice lasts until the page closes
      }
    },
  };
  const calm = window.matchMedia("(prefers-reduced-motion: reduce)");
  const cssColour = (name) => {
    const probe = el("span", { style: `color: var(${name})` });
    document.body.append(probe);
    const m = /(\d+)[, ]+(\d+)[, ]+(\d+)/.exec(getComputedStyle(probe).color);
    probe.remove();
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [20, 20, 20];
  };
  const hex = (rgb) => `#${rgb.toString(16).padStart(6, "0")}`;
  /** "minecraft:oak_planks" -> "Oak planks" */
  const blockTitle = (id) => {
    const path = String(id)
      .slice(String(id).indexOf(":") + 1)
      .replace(/_/g, " ");
    return path.charAt(0).toUpperCase() + path.slice(1);
  };

  // ───────────────────────── the bar that picks a view ─────────────────────────

  const screens = $("#computer .screens");
  const VIEWS = [
    {
      id: "screen",
      text: "Screen",
      title: "One computer: its screen and monitors",
    },
    {
      id: "tiles",
      text: "Side by side",
      title: "Every computer at once; click one to type on it",
    },
    {
      id: "blocks",
      text: "Blocks",
      title: "The blocks around the turtle, and where it goes",
    },
    {
      id: "network",
      text: "Network",
      title: "The computers of this network and the messages between them",
    },
  ];
  // a link can ask for a view (?view=blocks: `craftos-mcp window` opens a turtle's blocks this way)
  const linked = new URLSearchParams(location.search).get("view");
  let wanted = VIEWS.some((v) => v.id === linked)
    ? linked
    : store.get("view", "screen");
  const bar = el("nav", { class: "viewbar", "aria-label": "Views" });
  const buttons = new Map();
  for (const v of VIEWS) {
    const b = el("button", {
      class: "viewbtn",
      title: v.title,
      text: v.text,
      "data-view": v.id,
      onclick: () => {
        wanted = v.id;
        store.set("view", wanted);
        apply();
      },
    });
    buttons.set(v.id, b);
    bar.append(b);
  }
  const tilesBox = el("div", { class: "view-tiles", hidden: "" });
  const blocksBox = el("div", { class: "view-blocks", hidden: "" });
  const networkBox = el("div", { class: "view-network", hidden: "" });
  screens.prepend(bar);
  $(".toolbar", screens).after(blocksBox, networkBox, tilesBox);

  const can = (id) => {
    const s = cur();
    if (!s) return false;
    if (id === "tiles") return sessions.length > 1;
    if (id === "blocks") return !!s.blocks;
    if (id === "network") return !!s.network;
    return true;
  };
  /** The view on screen: the one asked for, or the plain screen when this computer has no such view. */
  const active = () => (can(wanted) ? wanted : "screen");

  let shown = "";
  function apply() {
    const now = active();
    let some = false;
    for (const [id, b] of buttons) {
      const ok = can(id);
      b.hidden = !ok;
      if (ok && id !== "screen") some = true;
      b.classList.toggle("on", id === now);
      b.setAttribute("aria-pressed", String(id === now));
    }
    bar.hidden = !some;
    if (now !== shown) {
      shown = now;
      screens.dataset.view = now;
      tilesBox.hidden = now !== "tiles";
      blocksBox.hidden = now !== "blocks";
      networkBox.hidden = now !== "network";
      if (now !== "tiles") tiles.leave();
      fitAll();
    }
    if (now === "tiles") tiles.render();
    if (now === "blocks") blocks.show();
    if (now === "network") network.show();
  }

  // ───────────────────────── side by side ─────────────────────────

  const tiles = (() => {
    const items = new Map(); // session id -> tile
    let hidden = new Set();
    let width = store.get("tileWidth", 420);
    const widths = store.get("tileWidths", {}); // computer name -> width it was dragged to
    const chips = el("div", { class: "vchips" });
    const size = el("input", {
      type: "range",
      min: "240",
      max: "960",
      step: "20",
      value: String(width),
      title: "How wide each computer is drawn",
      "aria-label": "Tile width",
    });
    const grid = el("div", { class: "vtiles" });
    tilesBox.append(
      el(
        "div",
        { class: "vtiles-top" },
        el("span", { class: "sub", text: "Show" }),
        chips,
        el("span", { class: "grow" }),
        el("label", { class: "inline" }, "Size ", size),
      ),
      grid,
      el("div", {
        class: "hint",
        text: "Click a computer to type on it. Drag a tile's right edge to resize it.",
      }),
    );
    size.addEventListener("input", () => {
      width = Number(size.value);
      store.set("tileWidth", width);
      for (const key of Object.keys(widths)) delete widths[key];
      store.set("tileWidths", widths);
      for (const t of items.values()) t.root.style.width = `${width}px`;
      fitAll();
    });

    const termWrap = $("#term-wrap");
    const termHome = $("#term-hint");

    function make(s) {
      const canvas = el("canvas");
      const passive = el(
        "div",
        { class: `bezel${s.advanced ? " advanced" : ""}` },
        canvas,
      );
      const body = el("div", { class: "vtile-body" }, passive);
      const mons = el("div", { class: "vtile-mons" });
      const dot = el("span", { class: "dot" });
      const name = el("b");
      const sub = el("span", { class: "sub" });
      const grip = el("div", { class: "vtile-grip", title: "Drag to resize" });
      const root = el(
        "section",
        {
          class: "vtile",
          "data-id": s.id,
          style: `width:${widths[s.name] || width}px`,
        },
        el(
          "header",
          {},
          dot,
          name,
          sub,
          el("span", { class: "grow" }),
          el("button", {
            class: "vtile-hide",
            title: "Hide this computer (bring it back from the list above)",
            "aria-label": "Hide",
            text: "×",
            onclick: (e) => {
              e.stopPropagation();
              toggle(s.id);
            },
          }),
        ),
        body,
        mons,
        grip,
      );
      root.addEventListener("mousedown", (e) => {
        if (e.target === grip || e.target.closest(".vtile-hide")) return;
        focus(s.id);
      });
      grip.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        grip.setPointerCapture(e.pointerId);
        const start = e.clientX;
        const from = root.getBoundingClientRect().width;
        const move = (m) => {
          const w = Math.round(Math.max(200, from + m.clientX - start));
          root.style.width = `${w}px`;
          widths[sessionById(s.id)?.name ?? s.name] = w;
          fitAll();
        };
        const done = () => {
          grip.removeEventListener("pointermove", move);
          store.set("tileWidths", widths);
        };
        grip.addEventListener("pointermove", move);
        grip.addEventListener("pointerup", done, { once: true });
        grip.addEventListener("pointercancel", done, { once: true });
      });
      const tile = { root, body, passive, canvas, mons, dot, name, sub };
      items.set(s.id, tile);
      grid.append(root);
      return tile;
    }

    /** Type on this computer: it becomes the app's current one, and the real terminal moves into its tile. */
    function focus(id) {
      if (current !== id) {
        // show at once what the tile showed, until the next frame arrives
        const from = items.get(id)?.canvas;
        const term = $("#term");
        if (from?.width) {
          term.width = from.width;
          term.height = from.height;
          term.getContext("2d").drawImage(from, 0, 0);
        }
        select(id);
      }
      place();
      setTimeout(() => termWrap.focus(), 0);
    }

    /** Put the real terminal in the current computer's tile. */
    function place() {
      for (const [id, t] of items) {
        const mine = id === current;
        t.root.classList.toggle("focus", mine);
        if (mine && termWrap.parentElement !== t.body) {
          const term = $("#term");
          for (const other of items.values())
            if (other !== t && other.passive.hidden) {
              // the tile the terminal leaves keeps what it showed
              other.canvas.width = term.width;
              other.canvas.height = term.height;
              if (term.width)
                other.canvas.getContext("2d").drawImage(term, 0, 0);
              other.passive.hidden = false;
            }
          t.body.append(termWrap);
          delete term.dataset.fit;
        }
        t.passive.hidden = mine;
      }
    }

    function toggle(id) {
      const visible = sessions.filter((s) => !hidden.has(s.id));
      if (!hidden.has(id) && visible.length <= 1) return; // one computer stays
      if (hidden.has(id)) hidden.delete(id);
      else hidden.add(id);
      if (hidden.has(current)) {
        const next = sessions.find((s) => !hidden.has(s.id));
        if (next) select(next.id);
      }
      render();
    }

    function screenFigure(box, key, caption, onClick) {
      let fig = box.querySelector(`[data-key="${CSS.escape(key)}"]`);
      if (!fig) {
        const canvas = el("canvas");
        fig = el(
          "figure",
          { class: "screen", "data-key": key },
          el("figcaption"),
          canvas,
        );
        canvas.addEventListener("click", (e) => onClick(canvas, e));
        box.append(fig);
      }
      fig.querySelector("figcaption").textContent = caption;
      return fig.querySelector("canvas");
    }

    let chipShape = "";
    function render() {
      hidden = new Set([...hidden].filter((id) => sessionById(id)));
      if (hidden.has(current)) hidden.delete(current);
      const shape = JSON.stringify(
        sessions.map((s) => [
          s.id,
          s.name,
          s.running,
          hidden.has(s.id),
          s.network,
        ]),
      );
      if (shape !== chipShape) {
        chipShape = shape;
        chips.replaceChildren(
          ...sessions.map((s) =>
            el(
              "button",
              {
                class: `vchip${hidden.has(s.id) ? "" : " on"}${s.running ? "" : " off"}`,
                "aria-pressed": String(!hidden.has(s.id)),
                title: hidden.has(s.id) ? `Show ${s.name}` : `Hide ${s.name}`,
                onclick: () => toggle(s.id),
              },
              el("span", { class: "dot" }),
              s.name,
              s.network ? el("span", { class: "net", text: s.network }) : null,
            ),
          ),
        );
      }
      for (const [id, t] of items)
        if (!sessionById(id) || hidden.has(id)) {
          if (termWrap.parentElement === t.body) termHome.before(termWrap);
          t.root.remove();
          items.delete(id);
        }
      for (const s of sessions) {
        if (hidden.has(s.id)) continue;
        const t = items.get(s.id) || make(s);
        t.root.classList.toggle("off", !s.running);
        t.name.textContent = s.name;
        t.sub.textContent = `${s.advanced ? "advanced " : ""}${s.kind}${s.network ? ` · ${s.network}` : ""}${s.running ? "" : " · off"}`;
        const term = s.windows.find((w) => w.peripheral === null);
        if (term && s.id !== current)
          paint(
            `tile:${s.id}:term`,
            `/api/sessions/${s.id}/window/${term.id}.png?scale=${TERM_SCALE}`,
            t.canvas,
            `${term.id}:${term.version}`,
            undefined,
            TERM_SCALE,
          );
        // its monitors, and its pixel screens
        const seen = new Set();
        for (const w of s.windows) {
          if (w.peripheral === null) continue;
          const key = `mon:${w.peripheral}`;
          seen.add(key);
          const canvas = screenFigure(
            t.mons,
            key,
            `${w.peripheral} ${w.width}x${w.height}`,
            (c, e) => {
              const live = sessionById(s.id)?.windows.find(
                (x) => x.peripheral === w.peripheral,
              );
              if (!live) return;
              const { x, y } = cellAt(c, e, MON_SCALE, live.width, live.height);
              flash(c);
              const player = $("#touch-player").value.trim();
              api(`/api/sessions/${s.id}/touch`, {
                json: {
                  monitor: w.peripheral,
                  x,
                  y,
                  ...(player ? { player } : {}),
                },
              }).catch(() => undefined);
            },
          );
          paint(
            `tile:${s.id}:${key}`,
            `/api/sessions/${s.id}/window/${w.id}.png?scale=${MON_SCALE}`,
            canvas,
            `${w.id}:${w.version}`,
            undefined,
            MON_SCALE,
          );
        }
        for (const p of s.pixels) {
          const key = `px:${p.peripheral}`;
          seen.add(key);
          const canvas = screenFigure(
            t.mons,
            key,
            `${p.peripheral} ${p.width}x${p.height} px`,
            (c, e) => {
              const live = sessionById(s.id)?.pixels.find(
                (x) => x.peripheral === p.peripheral,
              );
              if (!live) return;
              const r = c.getBoundingClientRect();
              flash(c);
              api(`/api/sessions/${s.id}/command`, {
                json: {
                  command: {
                    cmd: "tmTouch",
                    peripheral: p.peripheral,
                    x:
                      Math.floor(
                        ((e.clientX - r.left) / r.width) * live.width,
                      ) + 1,
                    y:
                      Math.floor(
                        ((e.clientY - r.top) / r.height) * live.height,
                      ) + 1,
                  },
                },
              }).catch(() => undefined);
            },
          );
          paint(
            `tile:${s.id}:${key}`,
            `/api/sessions/${s.id}/pixels/${encodeURIComponent(p.peripheral)}.png?scale=${PIX_SCALE}`,
            canvas,
            `${p.mtime}:${p.width}`,
            undefined,
            PIX_SCALE,
          );
        }
        for (const fig of [...t.mons.children])
          if (!seen.has(fig.dataset.key)) fig.remove();
      }
      place();
    }

    /** Back to one computer: the terminal goes home. */
    function leave() {
      if (termWrap.parentElement !== termHome.parentElement) {
        termHome.before(termWrap);
        delete $("#term").dataset.fit;
      }
    }

    return { render, leave };
  })();

  // ───────────────────────── network ─────────────────────────

  const network = (() => {
    const KIND_TEXT = { wireless: "wireless", ender: "ender", wired: "wired" };
    const KEEP = 3000; // messages the page remembers
    const ROWS = 400; // rows on screen at most
    let name = null;
    let seq = 0;
    let busy = false;
    let nodes = [];
    let links = [];
    let all = []; // every message kept, oldest first
    let held = []; // messages that arrived while paused
    let paused = false;
    let showRepeats = false;
    let filter = "";
    let picked = null;
    let graphShape = "";
    const places = new Map(); // node name -> {x, y}
    const dots = []; // messages on their way

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "vnet-graph");
    svg.setAttribute("viewBox", "0 0 600 340");
    svg.setAttribute("role", "img");
    const layer = (cls) => {
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.setAttribute("class", cls);
      svg.append(g);
      return g;
    };
    const linkLayer = layer("links");
    const dotLayer = layer("dots");
    const nodeLayer = layer("nodes");
    const sv = (tag, attrs = {}, text) => {
      const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
      if (text !== undefined) e.textContent = text;
      return e;
    };

    const filterBox = el("input", {
      class: "vnet-filter",
      placeholder: "Filter: a computer, a channel, a protocol, some text",
      "aria-label": "Filter messages",
    });
    const repeats = el("input", { type: "checkbox" });
    const pause = el("button", {
      class: "btn",
      text: "Pause",
      "aria-pressed": "false",
    });
    const clear = el("button", { class: "btn ghost", text: "Clear" });
    const count = el("span", { class: "sub" });
    const log = el("div", {
      class: "vnet-log",
      role: "log",
      "aria-label": "Messages",
    });
    const detail = el("div", { class: "vnet-detail", hidden: "" });
    const legend = el(
      "div",
      { class: "vnet-legend" },
      ...Object.entries(KIND_TEXT).map(([k, t]) =>
        el("span", { class: `vkind ${k}` }, el("i"), t),
      ),
    );
    networkBox.append(
      el(
        "div",
        { class: "vnet-top" },
        el("div", { class: "vnet-graph-box" }, svg, legend),
      ),
      el(
        "div",
        { class: "vnet-bar" },
        filterBox,
        el(
          "label",
          {
            class: "check",
            title:
              "rednet sends every message a second time on channel 65533, for repeaters. Tick to list those copies too.",
          },
          repeats,
          " Copies for repeaters",
        ),
        pause,
        clear,
        count,
      ),
      log,
      detail,
    );

    filterBox.addEventListener("input", () => {
      filter = filterBox.value.trim().toLowerCase();
      redrawLog();
    });
    repeats.addEventListener("change", () => {
      showRepeats = repeats.checked;
      redrawLog();
    });
    pause.addEventListener("click", () => {
      paused = !paused;
      pause.setAttribute("aria-pressed", String(paused));
      pause.classList.toggle("primary", paused);
      if (!paused) {
        const waiting = held;
        held = [];
        take(waiting, false);
      }
      status();
    });
    clear.addEventListener("click", () => {
      all = [];
      held = [];
      picked = null;
      detail.hidden = true;
      redrawLog();
    });

    const matches = (m) => {
      if (m.rednet?.repeat && !showRepeats) return false;
      if (!filter) return true;
      const text =
        `${m.from} ${m.to.join(" ")} ${m.kind} ch${m.channel} ${m.channel} ${m.rednet?.protocol ?? ""} ${m.rednet ? "rednet" : ""} ${m.preview}`.toLowerCase();
      return filter.split(/\s+/).every((word) => text.includes(word));
    };

    const clock = (at) => {
      const d = new Date(at);
      const two = (n) => String(n).padStart(2, "0");
      return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
    };
    const target = (m) =>
      m.rednet
        ? m.rednet.to === "everyone"
          ? "everyone"
          : `computer ${m.rednet.to}`
        : `channel ${m.channel}`;

    function row(m) {
      return el(
        "button",
        {
          class: `vrow${m.seq === picked ? " on" : ""}${m.to.length ? "" : " unheard"}`,
          "data-seq": String(m.seq),
          title: "Show the whole message",
          onclick: () => open(m.seq),
        },
        el("span", { class: "t", text: clock(m.at) }),
        el("span", { class: `vkind ${m.kind}` }, el("i")),
        el(
          "span",
          { class: "who" },
          el("b", { text: m.from }),
          " → ",
          m.to.length ? m.to.join(", ") : "nobody heard it",
        ),
        el("span", {
          class: "ch",
          text: m.rednet ? `rednet to ${target(m)}` : `channel ${m.channel}`,
        }),
        m.rednet?.protocol
          ? el("span", { class: "proto", text: m.rednet.protocol })
          : null,
        el("span", { class: "pre", text: m.preview }),
      );
    }

    function status() {
      const listed = all.filter(matches).length;
      count.textContent =
        (paused ? `Paused, ${held.length} waiting. ` : "") +
        (listed === all.length
          ? `${all.length} messages`
          : `${listed} of ${all.length} messages`);
      pause.textContent = paused ? "Resume" : "Pause";
    }

    function redrawLog() {
      const rows = all.filter(matches).slice(-ROWS).map(row);
      log.replaceChildren(
        ...(rows.length
          ? rows
          : [
              el("div", {
                class: "vnet-empty",
                text: all.length
                  ? "No message matches the filter."
                  : "No messages yet. They show here as the computers send them (rednet.send, modem.transmit).",
              }),
            ]),
      );
      log.scrollTop = log.scrollHeight;
      status();
    }

    /** New messages: into the list, onto the log, and along the links. */
    function take(messages, animate) {
      if (!messages.length) return;
      const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
      const wasEmpty = !log.querySelector(".vrow");
      all.push(...messages);
      if (all.length > KEEP * 1.2) all = all.slice(-KEEP);
      const fresh = messages.filter(matches);
      if (fresh.length) {
        if (wasEmpty) log.replaceChildren();
        log.append(...fresh.slice(-ROWS).map(row));
        while (log.childElementCount > ROWS) log.firstElementChild.remove();
        if (atEnd) log.scrollTop = log.scrollHeight;
      }
      if (animate) for (const m of fresh.slice(-30)) fly(m);
      status();
    }

    async function open(seqNumber) {
      picked = seqNumber;
      for (const r of $$(".vrow", log))
        r.classList.toggle("on", Number(r.dataset.seq) === picked);
      detail.hidden = false;
      detail.replaceChildren(
        el("div", { class: "sub", text: "Reading the message..." }),
      );
      let m;
      try {
        m = await api(`/api/networks/${name}/messages/${seqNumber}`);
      } catch {
        detail.replaceChildren(
          el("div", {
            class: "msg bad",
            text: "This message is no longer kept: the log holds the last 3000.",
          }),
        );
        return;
      }
      if (picked !== seqNumber) return;
      const line = (k, v) =>
        el("div", {}, el("span", { class: "k", text: `${k} ` }), v);
      detail.replaceChildren(
        el(
          "div",
          { class: "vnet-detail-head" },
          el("b", { text: `Message ${m.seq}` }),
          el("span", { class: "sub", text: clock(m.at) }),
          el("span", { class: "grow" }),
          el("button", {
            class: "btn ghost",
            text: "Copy",
            title: "Copy the message as JSON",
            onclick: () =>
              navigator.clipboard
                ?.writeText(JSON.stringify(m.message, null, 2))
                .catch(() => undefined),
          }),
          el("button", {
            class: "btn ghost",
            text: "Close",
            onclick: () => {
              picked = null;
              detail.hidden = true;
              for (const r of $$(".vrow.on", log)) r.classList.remove("on");
            },
          }),
        ),
        el(
          "div",
          { class: "vnet-facts" },
          line("from", `${m.from}, its ${m.kind} modem "${m.modem}"`),
          line(
            "heard by",
            m.to.length
              ? m.to.join(", ")
              : "nobody: no computer in reach has this channel open",
          ),
          line("channel", `${m.channel}, reply channel ${m.reply}`),
          m.rednet
            ? line(
                "rednet",
                `to ${target(m)}${m.rednet.protocol ? `, protocol "${m.rednet.protocol}"` : ", no protocol"}${m.rednet.repeat ? " (the copy for repeaters)" : ""}`,
              )
            : null,
          line(
            "sent from",
            `${m.distanceFrom.x}, ${m.distanceFrom.y}, ${m.distanceFrom.z} in ${m.distanceFrom.dimension}`,
          ),
        ),
        el("pre", {
          class: "vnet-body",
          text: JSON.stringify(m.message, null, 2),
        }),
      );
      detail.scrollIntoView({ block: "nearest" });
    }

    // ── the picture ──

    function layoutNodes() {
      places.clear();
      const W = 600;
      const H = 340;
      const n = nodes.length;
      // where the computers stand in the world, seen from above, when they stand apart; else round a circle
      const spots = new Set(nodes.map((c) => `${c.x},${c.z}`));
      if (n > 1 && spots.size === n) {
        const xs = nodes.map((c) => c.x);
        const zs = nodes.map((c) => c.z);
        const [x1, x2, z1, z2] = [
          Math.min(...xs),
          Math.max(...xs),
          Math.min(...zs),
          Math.max(...zs),
        ];
        const k = Math.min(
          (W - 180) / Math.max(x2 - x1, 1),
          (H - 130) / Math.max(z2 - z1, 1),
        );
        for (const c of nodes)
          places.set(c.name, {
            x: W / 2 + (c.x - (x1 + x2) / 2) * k,
            y: H / 2 + (c.z - (z1 + z2) / 2) * k,
          });
        return true;
      }
      nodes.forEach((c, i) => {
        const a =
          (i / Math.max(n, 1)) * Math.PI * 2 -
          Math.PI / 2 +
          (n === 2 ? Math.PI / 2 : 0);
        places.set(c.name, {
          x: W / 2 + (n > 1 ? Math.cos(a) * (W / 2 - 110) : 0),
          y: H / 2 + (n > 1 ? Math.sin(a) * (H / 2 - 62) : 0),
        });
      });
      return false;
    }

    const linkPath = (a, b, bend) => {
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      return { cx: mx - (dy / len) * bend, cy: my + (dx / len) * bend };
    };
    const BEND = { wireless: 0, ender: 26, wired: -26 };

    function drawGraph() {
      const shape = JSON.stringify([
        nodes.map((c) => [
          c.name,
          c.label,
          c.id,
          c.running,
          c.x,
          c.z,
          c.session === current,
          c.modems.map((m) => m.kind),
        ]),
        links,
      ]);
      if (shape === graphShape) return;
      graphShape = shape;
      const mapped = layoutNodes();
      svg.setAttribute(
        "aria-label",
        `${nodes.length} computers${mapped ? ", placed as they stand in the world seen from above" : ""}`,
      );
      linkLayer.replaceChildren();
      for (const l of links) {
        const a = places.get(l.a);
        const b = places.get(l.b);
        if (!a || !b) continue;
        const c = linkPath(a, b, BEND[l.kind]);
        linkLayer.append(
          sv("path", {
            class: `vlink ${l.kind}`,
            d: `M${a.x},${a.y} Q${c.cx},${c.cy} ${b.x},${b.y}`,
            "data-link": `${l.a}|${l.b}|${l.kind}`,
          }),
        );
      }
      nodeLayer.replaceChildren();
      for (const c of nodes) {
        const p = places.get(c.name);
        const g = sv("g", {
          class: `vnode${c.running ? "" : " off"}${c.session === current ? " on" : ""}`,
          transform: `translate(${p.x},${p.y})`,
          tabindex: "0",
          role: "button",
          "aria-label": `${c.name}, computer ${c.id}${c.running ? "" : ", off"}`,
        });
        const kinds = [...new Set(c.modems.map((m) => m.kind))];
        g.append(
          sv(
            "title",
            {},
            `${c.name}: computer ${c.id}${c.label ? `, label "${c.label}"` : ""}, at ${c.x}, ${c.y}, ${c.z}. Click to list its messages.`,
          ),
          sv("rect", { x: -62, y: -26, width: 124, height: 52, rx: 6 }),
          sv(
            "text",
            { class: "name", y: -6 },
            c.name.length > 15 ? `${c.name.slice(0, 14)}…` : c.name,
          ),
          sv(
            "text",
            { class: "id", y: 11 },
            `id ${c.id}${c.running ? "" : " · off"}`,
          ),
        );
        kinds.forEach((k, i) => {
          const x = (i - (kinds.length - 1) / 2) * 58;
          g.append(
            sv("rect", {
              class: `badge ${k}`,
              x: x - 27,
              y: 20,
              width: 54,
              height: 13,
              rx: 6.5,
            }),
            sv("text", { class: "badge-text", x, y: 30 }, KIND_TEXT[k]),
          );
        });
        if (!kinds.length)
          g.append(sv("text", { class: "id", y: 30 }, "no modem"));
        const pick = () => {
          filterBox.value = filter === c.name.toLowerCase() ? "" : c.name;
          filterBox.dispatchEvent(new Event("input"));
          if (c.session && c.session !== current) select(c.session);
        };
        g.addEventListener("click", pick);
        g.addEventListener(
          "keydown",
          (e) => (e.key === "Enter" || e.key === " ") && pick(),
        );
        nodeLayer.append(g);
      }
    }

    /** A message leaves its computer: a dot along the link to every computer that hears it. */
    function fly(m) {
      const a = places.get(m.from);
      if (!a) return;
      const now = performance.now();
      const text = m.rednet?.protocol || `ch ${m.channel}`;
      if (!m.to.length || calm.matches || dots.length > 60) {
        // nobody hears it (or too much is moving already): a ring round the sender
        const ring = sv("circle", {
          class: `vring ${m.kind}`,
          cx: a.x,
          cy: a.y,
          r: 30,
        });
        dotLayer.append(ring);
        dots.push({ start: now, life: 500, ring });
        for (const to of m.to) pulse(m.from, to, m.kind);
        return;
      }
      for (const to of m.to) {
        const b = places.get(to);
        if (!b) continue;
        const c = linkPath(
          a,
          b,
          a === b ? 0 : BEND[m.kind] * (m.from < to ? 1 : -1),
        );
        const g = sv("g", { class: `vdot ${m.kind}` });
        g.append(sv("circle", { r: 5 }));
        // a name on the dot while few are on their way: on a busy link the names would only pile up
        if (dots.length < 4)
          g.append(
            sv(
              "text",
              { y: -9 },
              text.length > 18 ? `${text.slice(0, 17)}…` : text,
            ),
          );
        dotLayer.append(g);
        dots.push({ start: now, life: 650, g, a, b, c });
        pulse(m.from, to, m.kind);
      }
    }
    function pulse(from, to, kind) {
      const [a, b] = from < to ? [from, to] : [to, from];
      const link =
        linkLayer.querySelector(
          `[data-link="${CSS.escape(`${a}|${b}|${kind}`)}"]`,
        ) ||
        linkLayer.querySelector(`[data-link^="${CSS.escape(`${a}|${b}|`)}"]`);
      if (!link) return;
      link.classList.remove("busy");
      void link.getBoundingClientRect();
      link.classList.add("busy");
    }
    function animate() {
      const now = performance.now();
      for (let i = dots.length - 1; i >= 0; i--) {
        const d = dots[i];
        const t = (now - d.start) / d.life;
        if (t >= 1) {
          (d.g || d.ring).remove();
          dots.splice(i, 1);
          continue;
        }
        if (d.ring) {
          d.ring.setAttribute("r", String(30 + t * 26));
          d.ring.setAttribute("opacity", String(1 - t));
        } else {
          const u = 1 - t;
          const x = u * u * d.a.x + 2 * u * t * d.c.cx + t * t * d.b.x;
          const y = u * u * d.a.y + 2 * u * t * d.c.cy + t * t * d.b.y;
          d.g.setAttribute("transform", `translate(${x},${y})`);
        }
      }
      requestAnimationFrame(animate);
    }
    requestAnimationFrame(animate);

    function reset(next) {
      name = next;
      seq = 0;
      all = [];
      held = [];
      picked = null;
      graphShape = "";
      detail.hidden = true;
      redrawLog();
    }

    async function show() {
      const s = cur();
      if (!s?.network) return;
      if (s.network !== name) reset(s.network);
      if (busy) return;
      busy = true;
      const asked = name;
      try {
        const data = await api(`/api/networks/${asked}?since=${seq}`);
        if (asked !== name) return;
        const first = seq === 0;
        seq = data.seq;
        nodes = data.nodes;
        links = data.links;
        drawGraph();
        if (paused) held.push(...data.messages);
        else take(data.messages, !first);
      } catch {
        // the network went away
      } finally {
        busy = false;
      }
    }

    return { show };
  })();

  // ───────────────────────── blocks ─────────────────────────

  const blocks = (() => {
    const FACING = ["", "north", "east", "south", "west", "up", "down"];
    const STEP = {
      north: [0, 0, -1],
      east: [1, 0, 0],
      south: [0, 0, 1],
      west: [-1, 0, 0],
      up: [0, 1, 0],
      down: [0, -1, 0],
    };
    const SIX = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    const TRAIL_SHOWN = 300; // the last steps of a turtle that are drawn: all of a long dig would hide the dig
    const GROUND_SPAN = 160; // the ground is drawn this many blocks across at most
    // A place as one number, which a Map finds much faster than a string: x and z counted from where the world was
    // first seen (half a million blocks either way), y from -128 to 383.
    const HALF = 2 ** 19;
    let originX = 0;
    let originZ = 0;
    const key = (x, y, z) =>
      ((x - originX + HALF) * (2 * HALF) + (z - originZ + HALF)) * 512 +
      (y + 128);
    const place = (k) => {
      const flat = Math.floor(k / 512);
      return [
        Math.floor(flat / (2 * HALF)) - HALF + originX,
        (k % 512) - 128,
        (flat % (2 * HALF)) - HALF + originZ,
      ];
    };

    // ── what the page knows of the world ──
    let sessionId = null;
    let seq;
    let busy = false;
    let explicit = new Map(); // "x,y,z" -> [name index or -1, facing]
    let fills = [];
    let ground = null;
    let names = [];
    let nameIndex = new Map();
    let rgbs = [];
    let alphas = [];
    let turtleName = [];
    let shapes = []; // per name: how wide, high and deep its box is drawn, and how far up or down from the middle
    let computers = new Map(); // computer id -> {x, y, z, label, on}
    let trails = new Map(); // computer id -> [x, y, z, ...]
    let main = null;
    let placed = 0;
    let dug = 0;
    let region = null; // the part of the ground that is drawn
    let followed = null;

    /** Blocks that are not a full cube are drawn smaller, so a torch reads as a torch and a slab as a slab. */
    function shapeOf(name) {
      const path = name.slice(name.indexOf(":") + 1);
      if (
        /torch$|^lever$|_sapling$|^lightning_rod$|^end_rod$|_candle$|^candle$/.test(
          path,
        )
      )
        return [0.2, 0.6, 0.2, -0.2];
      if (/_slab$/.test(path)) return [1, 0.5, 1, -0.25];
      if (
        /carpet$|pressure_plate$|^snow$|rail$|^redstone_wire$|^repeater$|^comparator$|trapdoor$|^lily_pad$/.test(
          path,
        )
      )
        return [1, 0.1, 1, -0.45];
      if (
        /^cable$|_fence$|_wall$|^chain$|iron_bars$|glass_pane$|^ladder$/.test(
          path,
        )
      )
        return [0.3, 1, 0.3, 0];
      if (/_button$/.test(path)) return [0.3, 0.2, 0.3, -0.4];
      if (
        /^(grass|fern|dandelion|poppy|wheat|carrots|potatoes|beetroots|sugar_cane|dead_bush)$|_tulip$|_mushroom$/.test(
          path,
        )
      )
        return [0.5, 0.7, 0.5, -0.15];
      if (/^chest$|^trapped_chest$|^ender_chest$/.test(path))
        return [0.88, 0.88, 0.88, -0.06];
      return [1, 1, 1, 0];
    }
    function nameOf(name, rgb, alpha) {
      let i = nameIndex.get(name);
      if (i === undefined) {
        i = names.length;
        names.push(name);
        nameIndex.set(name, i);
        rgbs.push(rgb);
        alphas.push(alpha);
        turtleName.push(/^computercraft:turtle_/.test(name));
        shapes.push(shapeOf(name));
      }
      return i;
    }
    let inFill = false; // whether the last implicitAt answered from a small box of one block (a vein of ore, say)
    function implicitAt(x, y, z) {
      for (let i = fills.length - 1; i >= 0; i--) {
        const f = fills[i];
        if (
          x >= f[0] &&
          x <= f[3] &&
          y >= f[1] &&
          y <= f[4] &&
          z >= f[2] &&
          z <= f[5]
        ) {
          inFill = f[7];
          return f[6];
        }
      }
      inFill = false;
      if (ground && y <= ground.y && y >= -64)
        return y === ground.y ? ground.top : ground.name;
      return -1;
    }
    /** The block at a place: its number in `names`, or -1 for air. */
    function at(x, y, z) {
      const e = explicit.get(key(x, y, z));
      if (e !== undefined) return e[0];
      return implicitAt(x, y, z);
    }

    // ── what is drawn ──
    let scene = null;
    let noGl = false;
    const cells = new Map(); // place -> [the block drawn there, which of its sides]
    const sideAt = new Map(); // place * 8 + side -> where that side is in scene.world
    let sideKeys = []; // and back
    let counts = []; // per block name: how many are drawn

    /** A block that hides the side of the block next to it: a whole cube you cannot see through. */
    const hides = (n) =>
      n >= 0 &&
      !turtleName[n] &&
      alphas[n] >= 1 &&
      shapes[n][0] === 1 &&
      shapes[n][1] === 1;
    let faces = 0; // which sides of the last `wants` block show
    /**
     * The block to draw at a place, or -1 when there is none or no side of it shows. A side shows where the block
     * next to it does not hide it; `faces` holds which. The ground is only drawn inside `region`.
     */
    function wants(x, y, z) {
      const e = explicit.get(key(x, y, z));
      let n;
      let boxed = false;
      if (e !== undefined) {
        n = e[0];
        if (n < 0 || turtleName[n]) return -1;
      } else {
        n = implicitAt(x, y, z);
        if (n < 0) return -1;
        boxed = inFill;
        if (
          !boxed &&
          region &&
          (x < region.x1 || x > region.x2 || z < region.z1 || z > region.z2)
        )
          return -1;
      }
      faces = 0;
      for (let i = 0; i < 6; i++) {
        const d = SIX[i];
        const m = at(x + d[0], y + d[1], z + d[2]);
        // a small box of one block inside another block (ore in stone) keeps its outside, for See through and for a
        // look from below the ground
        if (!hides(m) || (boxed && m !== n)) faces |= 1 << i;
      }
      if (!hides(n)) faces = 63; // a torch, a slab, glass: all of it
      return faces ? n : -1;
    }
    function refresh(x, y, z) {
      if (!scene) return;
      const k = key(x, y, z);
      const n = wants(x, y, z);
      const mask = n < 0 ? 0 : faces;
      const have = cells.get(k);
      const hadN = have ? have[0] : -1;
      const hadMask = have ? have[1] : 0;
      if (hadN === n && hadMask === mask) return;
      const sh = n >= 0 ? shapes[n] : null;
      const world = scene.world;
      for (let side = 0; side < 6; side++) {
        const bit = 1 << side;
        const sideKey = k * 8 + side;
        if (hadMask & bit && !(mask & bit)) {
          const index = sideAt.get(sideKey);
          sideAt.delete(sideKey);
          const moved = world.remove(index);
          if (moved >= 0) {
            // the last side took this one's place
            sideKeys[index] = sideKeys[moved];
            sideAt.set(sideKeys[index], index);
          }
          sideKeys.length = world.count;
        } else if (mask & bit && !(hadMask & bit)) {
          const index = world.add(
            x,
            y + sh[3],
            z,
            sh[0],
            sh[1],
            sh[2],
            rgbs[n],
            alphas[n],
            side,
          );
          sideAt.set(sideKey, index);
          sideKeys[index] = sideKey;
        } else if (mask & bit && hadN !== n) {
          world.set(
            sideAt.get(sideKey),
            x,
            y + sh[3],
            z,
            sh[0],
            sh[1],
            sh[2],
            rgbs[n],
            alphas[n],
            side,
          );
        }
      }
      if (hadN >= 0) counts[hadN]--;
      if (n >= 0) counts[n] = (counts[n] || 0) + 1;
      if (n < 0) cells.delete(k);
      else cells.set(k, [n, mask]);
      scene.changed = true;
    }
    function refreshAround(x, y, z) {
      refresh(x, y, z);
      for (const [dx, dy, dz] of SIX) refresh(x + dx, y + dy, z + dz);
    }

    /** The box round everything worth looking at: listed blocks, boxes of one block (not their far reaches), trails. */
    function interest() {
      const centre = focusPoint();
      let min = [Infinity, Infinity, Infinity];
      let max = [-Infinity, -Infinity, -Infinity];
      const take = (x, y, z) => {
        if (x < min[0]) min[0] = x;
        if (y < min[1]) min[1] = y;
        if (z < min[2]) min[2] = z;
        if (x > max[0]) max[0] = x;
        if (y > max[1]) max[1] = y;
        if (z > max[2]) max[2] = z;
      };
      for (const k of explicit.keys()) {
        const [x, y, z] = place(k);
        take(x, y, z);
      }
      const near = (v, c) => Math.min(Math.max(v, c - 48), c + 48);
      for (const f of fills) {
        if (f[6] < 0) continue;
        take(
          near(f[0], centre[0]),
          near(f[1], centre[1]),
          near(f[2], centre[2]),
        );
        take(
          near(f[3], centre[0]),
          near(f[4], centre[1]),
          near(f[5], centre[2]),
        );
      }
      for (const t of trails.values())
        for (let i = 0; i < t.length; i += 3) take(t[i], t[i + 1], t[i + 2]);
      if (min[0] === Infinity) {
        min = centre.slice();
        max = centre.slice();
      }
      return { min, max };
    }
    function focusPoint() {
      const t = computers.get(followed ?? main) || [...computers.values()][0];
      if (t) return [t.x, t.y, t.z];
      if (ground) return [0, ground.y + 1, 0];
      return [0, 64, 0];
    }
    function makeRegion() {
      const { min, max } = interest();
      const c = focusPoint();
      const half = GROUND_SPAN / 2;
      region = {
        x1: Math.max(min[0] - 12, c[0] - half),
        x2: Math.min(max[0] + 12, c[0] + half),
        z1: Math.max(min[2] - 12, c[2] - half),
        z2: Math.min(max[2] + 12, c[2] + half),
      };
    }
    /** Draw everything again from what is known. */
    function rebuild() {
      if (!scene) return;
      scene.world.clear();
      cells.clear();
      sideAt.clear();
      sideKeys = [];
      counts = [];
      makeRegion();
      for (const [k, e] of explicit) {
        const [x, y, z] = place(k);
        // a block, and round it the ground or box it stands in or was dug out of: their sides show now
        refresh(x, y, z);
        for (const d of SIX)
          if (!explicit.has(key(x + d[0], y + d[1], z + d[2])))
            refresh(x + d[0], y + d[1], z + d[2]);
      }
      const c = focusPoint();
      for (const f of fills) {
        if (f[6] < 0) {
          // a box of air cut out of the ground: the ground round it shows
          shell(f[0] - 1, f[1] - 1, f[2] - 1, f[3] + 1, f[4] + 1, f[5] + 1, c);
        } else shell(f[0], f[1], f[2], f[3], f[4], f[5], c);
      }
      if (ground)
        for (let x = region.x1; x <= region.x2; x++)
          for (let z = region.z1; z <= region.z2; z++) refresh(x, ground.y, z);
      scene.changed = true;
    }
    /** The outside of a box, no further than 64 blocks from `c`. */
    function shell(x1, y1, z1, x2, y2, z2, c) {
      const lo = (v, i) => Math.max(v, c[i] - 64);
      const hi = (v, i) => Math.min(v, c[i] + 64);
      [x1, y1, z1] = [lo(x1, 0), lo(y1, 1), lo(z1, 2)];
      [x2, y2, z2] = [hi(x2, 0), hi(y2, 1), hi(z2, 2)];
      for (let x = x1; x <= x2; x++)
        for (let y = y1; y <= y2; y++) {
          refresh(x, y, z1);
          if (z2 !== z1) refresh(x, y, z2);
        }
      for (let x = x1; x <= x2; x++)
        for (let z = z1 + 1; z < z2; z++) {
          refresh(x, y1, z);
          if (y2 !== y1) refresh(x, y2, z);
        }
      for (let y = y1 + 1; y < y2; y++)
        for (let z = z1 + 1; z < z2; z++) {
          refresh(x1, y, z);
          if (x2 !== x1) refresh(x2, y, z);
        }
    }

    // ── the page ──
    const mode = { flat: store.get("blocksFlat", false) };
    const canvas3 = el("canvas", {
      class: "vblocks-canvas",
      tabindex: "0",
      "aria-label": "The blocks around the turtle, in 3D",
    });
    const canvas2 = el("canvas", {
      class: "vblocks-canvas flat",
      tabindex: "0",
      "aria-label": "One layer of the blocks around the turtle, from above",
    });
    const info = el("div", { class: "vblocks-info" });
    const hover = el("div", { class: "vblocks-hover" });
    const legend = el("div", { class: "vblocks-legend" });
    const check = (text, title, on) => {
      const box = el("input", { type: "checkbox" });
      box.checked = on;
      return {
        box,
        label: el("label", { class: "check", title }, box, ` ${text}`),
      };
    };
    const follow = check(
      "Follow turtle",
      "Keep the turtle in the middle of the view",
      store.get("follow", true),
    );
    const through = check(
      "See through",
      "Draw the blocks like glass, to find a turtle that is underground",
      false,
    );
    const cut = check(
      "Cut above turtle",
      "Leave out every block above the turtle's layer",
      false,
    );
    const trail = check("Trail", "Draw the turtle's last 300 steps", true);
    const seg = (text, title, flat) =>
      el("button", {
        class: "viewbtn",
        text,
        title,
        onclick: () => {
          mode.flat = flat;
          store.set("blocksFlat", flat);
          layout();
        },
      });
    const b3 = seg("3D", "Turn it with the mouse, zoom with the wheel", false);
    const b2 = seg("Layers", "One layer at a time, seen from above", true);
    const reset = el("button", {
      class: "btn ghost",
      text: "Whole build",
      title: "Stand back to see everything the turtle built and dug",
      onclick: () => {
        follow.box.checked = false;
        flat.zoom = 0;
        if (scene) {
          const { min, max } = interest();
          scene.frame(min, max);
        }
        dirty = true;
      },
    });
    const layerDown = el("button", {
      class: "btn ghost",
      text: "Layer down",
      title: "One layer lower (Page Down)",
    });
    const layerUp = el("button", {
      class: "btn ghost",
      text: "Layer up",
      title: "One layer higher (Page Up)",
    });
    const layerText = el("span", { class: "vblocks-layer" });
    const layerHome = el("button", {
      class: "btn ghost",
      text: "Turtle's layer",
      title: "Show the layer the turtle is on, and stay with it",
    });
    const layerTools = el(
      "span",
      { class: "vblocks-layers" },
      layerDown,
      layerText,
      layerUp,
      layerHome,
    );
    const threeTools = el(
      "span",
      { class: "vblocks-three" },
      through.label,
      cut.label,
    );
    const slow = el("div", {
      class: "vblocks-slow",
      hidden: "",
      text: "3D is slow here: this browser draws it without the graphics card. Layers is quicker.",
    });
    const stage = el(
      "div",
      { class: "vblocks-stage" },
      canvas3,
      canvas2,
      hover,
      legend,
      slow,
    );
    blocksBox.append(
      el(
        "div",
        { class: "vblocks-bar" },
        el("span", { class: "viewseg" }, b3, b2),
        follow.label,
        trail.label,
        threeTools,
        layerTools,
        el("span", { class: "grow" }),
        reset,
      ),
      stage,
      info,
      el("div", {
        class: "hint vblocks-help",
        text: "3D: drag to turn, wheel to zoom, Shift+drag or right-drag to slide. Layers: drag to slide, wheel to zoom.",
      }),
    );
    const flat = { y: null, zoom: 0, cx: 0, cz: 0 };
    let dirty = true;
    const touchAll = () => {
      dirty = true;
      if (scene) scene.changed = true;
    };
    follow.box.addEventListener("change", () => {
      store.set("follow", follow.box.checked);
      touchAll();
    });
    for (const c of [through, cut, trail])
      c.box.addEventListener("change", touchAll);
    const stepLayer = (by) => {
      flat.y =
        (flat.y ??
          Math.round(shownAt(followed ?? main)?.[1] ?? focusPoint()[1])) + by;
      dirty = true;
    };
    layerDown.addEventListener("click", () => stepLayer(-1));
    layerUp.addEventListener("click", () => stepLayer(1));
    layerHome.addEventListener("click", () => {
      flat.y = null;
      dirty = true;
    });
    canvas2.addEventListener("keydown", (e) => {
      if (e.key === "PageUp") stepLayer(1);
      else if (e.key === "PageDown") stepLayer(-1);
      else return;
      e.preventDefault();
    });

    function layout() {
      if (!scene && !noGl) {
        try {
          scene = new window.craftosBlockScene.BlockScene(canvas3);
          scene.onMove = () => {
            if (scene.panned) {
              scene.panned = false;
              follow.box.checked = false;
            }
          };
          rebuild();
          if (computers.size || explicit.size) {
            const { min, max } = interest();
            scene.frame(min, max);
            scene.distance = Math.min(scene.distance, 22);
            scene.target = focusPoint();
          }
        } catch {
          noGl = true;
          scene = null;
        }
      }
      const isFlat = mode.flat || noGl;
      b3.hidden = noGl;
      b3.classList.toggle("on", !isFlat);
      b2.classList.toggle("on", isFlat);
      if (isFlat) {
        slowFrames = 0;
        slow.hidden = true;
      }
      canvas3.hidden = isFlat;
      canvas2.hidden = !isFlat;
      threeTools.hidden = isFlat;
      layerTools.hidden = !isFlat;
      touchAll();
    }

    // ── turtles, trails, blocks coming and going: rebuilt whenever they change ──
    const shownPos = new Map(); // computer id -> where it is drawn now, on its way to where it is
    const effects = []; // {x, y, z, rgb, start, out}
    function shownAt(id) {
      return shownPos.get(id);
    }
    let lastFrame = performance.now();
    function moveTurtles(now) {
      const k = Math.min(1, (now - lastFrame) / 110);
      let moving = false;
      for (const [id, c] of computers) {
        const n = explicit.get(key(c.x, c.y, c.z));
        if (!n || !turtleName[n[0]]) continue;
        const p = shownPos.get(id);
        if (
          !p ||
          Math.abs(p[0] - c.x) + Math.abs(p[1] - c.y) + Math.abs(p[2] - c.z) >
            3 ||
          calm.matches
        ) {
          if (!p || p[0] !== c.x || p[1] !== c.y || p[2] !== c.z) moving = true;
          shownPos.set(id, [c.x, c.y, c.z]);
          continue;
        }
        for (let i = 0; i < 3; i++) {
          const to = [c.x, c.y, c.z][i];
          if (Math.abs(to - p[i]) < 0.01) p[i] = to;
          else {
            p[i] += (to - p[i]) * k;
            moving = true;
          }
        }
      }
      for (const id of [...shownPos.keys()])
        if (!computers.has(id)) shownPos.delete(id);
      return moving;
    }
    function turtlesNow() {
      const out = [];
      for (const [id, c] of computers) {
        const e = explicit.get(key(c.x, c.y, c.z));
        if (!e || !turtleName[e[0]]) continue;
        out.push({
          id,
          at: shownPos.get(id) || [c.x, c.y, c.z],
          real: c,
          facing: FACING[e[1]] || "north",
          n: e[0],
        });
      }
      return out;
    }
    function drawMarks(now, accent) {
      const marks = scene.marks;
      marks.clear();
      if (trail.box.checked)
        for (const [id, t] of trails) {
          const colour = id === (followed ?? main) ? accent : 0x8fb7ff;
          // each straight run of steps is one long thin box
          let i = Math.max(0, t.length - 3 * TRAIL_SHOWN);
          while (i + 3 < t.length) {
            const d = [
              t[i + 3] - t[i],
              t[i + 4] - t[i + 1],
              t[i + 5] - t[i + 2],
            ];
            let j = i + 3;
            while (
              j + 3 < t.length &&
              t[j + 3] - t[j] === d[0] &&
              t[j + 4] - t[j + 1] === d[1] &&
              t[j + 5] - t[j + 2] === d[2] &&
              Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2]) === 1
            )
              j += 3;
            const w = 0.1;
            marks.addBox(
              (t[i] + t[j]) / 2,
              (t[i + 1] + t[j + 1]) / 2,
              (t[i + 2] + t[j + 2]) / 2,
              Math.abs(t[j] - t[i]) + w,
              Math.abs(t[j + 1] - t[i + 1]) + w,
              Math.abs(t[j + 2] - t[i + 2]) + w,
              colour,
              1,
            );
            i = j;
          }
        }
      for (const t of turtlesNow()) {
        const [x, y, z] = t.at;
        const s = STEP[t.facing] || STEP.north;
        marks.addBox(x, y, z, 0.78, 0.72, 0.78, rgbs[t.n], 1);
        // its face: a dark plate with a bright slot, on the side it looks at
        const flatX = s[0] !== 0;
        marks.addBox(
          x + s[0] * 0.4,
          y + 0.02,
          z + s[2] * 0.4,
          flatX ? 0.06 : 0.56,
          0.44,
          flatX ? 0.56 : 0.06,
          0x202020,
          1,
        );
        marks.addBox(
          x + s[0] * 0.44,
          y + 0.08,
          z + s[2] * 0.44,
          flatX ? 0.04 : 0.36,
          0.1,
          flatX ? 0.36 : 0.04,
          0x7fe07f,
          1,
        );
        // and a nose, so the way it looks shows from above too
        marks.addBox(
          x + s[0] * 0.52,
          y - 0.2,
          z + s[2] * 0.52,
          flatX ? 0.22 : 0.26,
          0.14,
          flatX ? 0.26 : 0.22,
          accent,
          1,
        );
      }
      let live = false;
      for (let i = effects.length - 1; i >= 0; i--) {
        const e = effects[i];
        const t = (now - e.start) / 320;
        if (t >= 1) {
          effects.splice(i, 1);
          continue;
        }
        live = true;
        if (e.out) {
          const s = 1 - t;
          marks.addBox(e.x, e.y, e.z, s, s, s, e.rgb, 0.85 * (1 - t));
        } else {
          const s = 1.02 + 0.25 * (1 - t);
          marks.addBox(e.x, e.y, e.z, s, s, s, 0xffffff, 0.55 * (1 - t));
        }
      }
      return live;
    }

    // ── the flat view ──
    function drawFlat(bg, fg, accent) {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(canvas2.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas2.clientHeight * dpr));
      if (canvas2.width !== w || canvas2.height !== h) {
        canvas2.width = w;
        canvas2.height = h;
      }
      const ctx = canvas2.getContext("2d");
      const css = (rgb) => `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
      ctx.fillStyle = css(bg);
      ctx.fillRect(0, 0, w, h);
      const turtles = turtlesNow();
      const mine =
        turtles.find((t) => t.id === (followed ?? main)) || turtles[0];
      const layer = flat.y ?? Math.round(mine?.real.y ?? focusPoint()[1]);
      if (!flat.zoom) {
        // first look: everything of interest fits
        const { min, max } = interest();
        flat.zoom = Math.max(
          4,
          Math.min(
            28,
            Math.floor(
              Math.min(
                w / dpr / (max[0] - min[0] + 9),
                h / dpr / (max[2] - min[2] + 9),
              ),
            ),
          ),
        );
        flat.cx = (min[0] + max[0]) / 2;
        flat.cz = (min[2] + max[2]) / 2;
        // close enough to tell the blocks apart when the view stays with the turtle anyway
        if (follow.box.checked && mine) flat.zoom = Math.max(flat.zoom, 14);
      }
      if (follow.box.checked && mine) {
        flat.cx = mine.at[0];
        flat.cz = mine.at[2];
      }
      const cell = flat.zoom * dpr;
      const sx = (x) => w / 2 + (x - flat.cx - 0.5) * cell;
      const sz = (z) => h / 2 + (z - flat.cz - 0.5) * cell;
      const x1 = Math.floor(flat.cx - w / 2 / cell) - 1;
      const x2 = Math.ceil(flat.cx + w / 2 / cell) + 1;
      const z1 = Math.floor(flat.cz - h / 2 / cell) - 1;
      const z2 = Math.ceil(flat.cz + h / 2 / cell) + 1;
      const mix = (rgb, a) => {
        const c = [(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255];
        return `rgb(${c.map((v, i) => Math.round(v * a + bg[i] * (1 - a))).join(",")})`;
      };
      for (let x = x1; x <= x2; x++)
        for (let z = z1; z <= z2; z++) {
          let n = at(x, layer, z);
          let a = 1;
          if (n >= 0 && turtleName[n]) n = -1;
          if (n < 0) {
            // air: the block below shows faintly, as a floor would
            n = at(x, layer - 1, z);
            a = 0.3;
            if (n >= 0 && turtleName[n]) n = -1;
          } else a = alphas[n] < 1 ? 0.75 : 1;
          if (n < 0) continue;
          ctx.fillStyle = mix(rgbs[n], a);
          ctx.fillRect(
            Math.floor(sx(x)),
            Math.floor(sz(z)),
            Math.ceil(cell),
            Math.ceil(cell),
          );
        }
      if (flat.zoom >= 10) {
        ctx.strokeStyle = `rgba(${fg[0]},${fg[1]},${fg[2]},0.12)`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = x1; x <= x2; x++) {
          ctx.moveTo(Math.floor(sx(x)) + 0.5, 0);
          ctx.lineTo(Math.floor(sx(x)) + 0.5, h);
        }
        for (let z = z1; z <= z2; z++) {
          ctx.moveTo(0, Math.floor(sz(z)) + 0.5);
          ctx.lineTo(w, Math.floor(sz(z)) + 0.5);
        }
        ctx.stroke();
      }
      const accentCss = hex(accent);
      if (trail.box.checked)
        for (const [id, t] of trails) {
          ctx.lineWidth = Math.max(1.5, cell * 0.16);
          ctx.lineCap = "round";
          for (
            let i = Math.max(0, t.length - 3 * TRAIL_SHOWN);
            i + 3 < t.length;
            i += 3
          ) {
            const here = t[i + 1] === layer && t[i + 4] === layer;
            ctx.strokeStyle = id === (followed ?? main) ? accentCss : "#8fb7ff";
            ctx.globalAlpha = here ? 1 : 0.22;
            ctx.beginPath();
            ctx.moveTo(sx(t[i] + 0.5), sz(t[i + 2] + 0.5));
            ctx.lineTo(sx(t[i + 3] + 0.5), sz(t[i + 5] + 0.5));
            ctx.stroke();
          }
          ctx.globalAlpha = 1;
        }
      for (const t of turtles) {
        const s = STEP[t.facing] || STEP.north;
        const px = sx(t.at[0] + 0.5);
        const pz = sz(t.at[2] + 0.5);
        const r = cell * 0.42;
        const here = Math.round(t.at[1]) === layer;
        ctx.globalAlpha = here ? 1 : 0.45;
        ctx.fillStyle = hex(rgbs[t.n]);
        ctx.strokeStyle = css(fg);
        ctx.lineWidth = Math.max(1, dpr);
        ctx.beginPath();
        // an arrowhead pointing the way it faces
        ctx.moveTo(px + s[0] * r, pz + s[2] * r);
        ctx.lineTo(
          px - s[0] * r * 0.8 - s[2] * r * 0.8,
          pz - s[2] * r * 0.8 + s[0] * r * 0.8,
        );
        ctx.lineTo(px - s[0] * r * 0.3, pz - s[2] * r * 0.3);
        ctx.lineTo(
          px - s[0] * r * 0.8 + s[2] * r * 0.8,
          pz - s[2] * r * 0.8 - s[0] * r * 0.8,
        );
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        if (!here) {
          const off = Math.round(t.at[1]) - layer;
          ctx.fillStyle = css(fg);
          ctx.font = `${Math.round(11 * dpr)}px sans-serif`;
          ctx.fillText(off > 0 ? `${off} up` : `${-off} down`, px + r, pz - r);
        }
        ctx.globalAlpha = 1;
      }
      // north is up
      ctx.fillStyle = css(fg);
      ctx.font = `${Math.round(11 * dpr)}px sans-serif`;
      ctx.fillText("N ↑", 8 * dpr, 16 * dpr);
      layerText.textContent = `y ${layer}${flat.y === null ? " (turtle)" : ""}`;
      flat.view = { cell, w, h, dpr, layer };
    }
    {
      let drag = null;
      canvas2.addEventListener("pointerdown", (e) => {
        canvas2.setPointerCapture(e.pointerId);
        drag = { x: e.clientX, y: e.clientY };
      });
      canvas2.addEventListener("pointerup", () => (drag = null));
      canvas2.addEventListener("pointermove", (e) => {
        if (drag) {
          flat.cx -= (e.clientX - drag.x) / flat.zoom;
          flat.cz -= (e.clientY - drag.y) / flat.zoom;
          drag = { x: e.clientX, y: e.clientY };
          if (follow.box.checked) follow.box.checked = false;
          dirty = true;
          return;
        }
        const r = canvas2.getBoundingClientRect();
        const x = Math.floor(
          flat.cx + 0.5 + (e.clientX - r.left - r.width / 2) / flat.zoom,
        );
        const z = Math.floor(
          flat.cz + 0.5 + (e.clientY - r.top - r.height / 2) / flat.zoom,
        );
        const y = flat.view?.layer ?? 0;
        tell(x, y, z);
      });
      canvas2.addEventListener("pointerleave", () => (hover.textContent = ""));
      canvas2.addEventListener(
        "wheel",
        (e) => {
          e.preventDefault();
          flat.zoom = Math.min(
            48,
            Math.max(3, flat.zoom * Math.exp(-e.deltaY * 0.0012)),
          );
          dirty = true;
        },
        { passive: false },
      );
    }
    function tell(x, y, z) {
      const n = at(x, y, z);
      hover.textContent =
        n < 0
          ? `Air at ${x}, ${y}, ${z}`
          : `${blockTitle(names[n])} (${names[n]}) at ${x}, ${y}, ${z}`;
    }
    {
      let asked = null;
      canvas3.addEventListener("pointermove", (e) => {
        if (e.buttons || !scene) return;
        asked = [e.clientX, e.clientY];
        requestAnimationFrame(() => {
          if (!asked || !scene) return;
          const [cx, cy] = asked;
          asked = null;
          const hit = scene.pick(cx, cy, (x, y, z) => {
            if (cells.has(key(x, y, z))) return true;
            const e2 = explicit.get(key(x, y, z));
            return !!e2 && e2[0] >= 0 && turtleName[e2[0]];
          });
          if (hit) tell(hit[0], hit[1], hit[2]);
          else hover.textContent = "";
        });
      });
      canvas3.addEventListener("pointerleave", () => (hover.textContent = ""));
    }

    // ── every frame ──
    let legendAt = 0;
    let infoText = "";
    // how long drawn frames take, to say so when this machine draws 3D slowly (no graphics card at work)
    let slowFrames = 0;
    let lastDrawn = 0;
    function frame(now) {
      requestAnimationFrame(frame);
      if (blocksBox.hidden || document.hidden) {
        lastFrame = now;
        return;
      }
      const moving = moveTurtles(now);
      lastFrame = now;
      const bg = cssColour("--bg");
      const fg = cssColour("--fg");
      const a = cssColour("--accent");
      const accent = (a[0] << 16) | (a[1] << 8) | a[2];
      const turtles = turtlesNow();
      const mine =
        turtles.find((t) => t.id === (followed ?? main)) || turtles[0];
      if (!canvas3.hidden && scene) {
        if (follow.box.checked && mine) {
          for (let i = 0; i < 3; i++)
            if (Math.abs(scene.target[i] - mine.at[i]) > 0.001) {
              scene.target[i] += (mine.at[i] - scene.target[i]) * 0.2;
              scene.changed = true;
            }
        }
        scene.background = bg.map((v) => v / 255);
        scene.seeThrough = through.box.checked;
        scene.cut = cut.box.checked && mine ? mine.at[1] + 0.5 : Infinity;
        scene.fitCanvas();
        if (moving || effects.length || dirty || scene.changed) {
          const live = drawMarks(now, accent);
          scene.changed = true;
          scene.render();
          if (live) scene.changed = true;
          // two frames in a row, each long after the one before: drawing is what takes the time
          if (now - lastDrawn < 1000)
            slowFrames = now - lastDrawn > 120 ? slowFrames + 1 : 0;
          lastDrawn = now;
          slow.hidden = slowFrames < 8;
        }
      } else if (
        !canvas2.hidden &&
        ((effects.length = 0),
        dirty ||
          moving ||
          canvas2.width !==
            Math.round(canvas2.clientWidth * (window.devicePixelRatio || 1)))
      ) {
        drawFlat(bg, fg, accent);
      }
      dirty = false;
      if (now - legendAt > 500) {
        legendAt = now;
        const where = mine
          ? `Turtle at ${mine.real.x}, ${mine.real.y}, ${mine.real.z}, facing ${mine.facing}`
          : explicit.size || ground || fills.length
            ? "No turtle in this world"
            : "Waiting for the world...";
        const text = `${where} · placed ${placed} · dug ${dug}${turtles.length > 1 ? ` · ${turtles.length} turtles` : ""}`;
        if (text !== infoText) {
          infoText = text;
          info.textContent = text;
        }
        const top = counts
          .map((c, n) => [c || 0, n])
          .filter(([c]) => c > 0)
          .sort((p, q) => q[0] - p[0])
          .slice(0, 8);
        const shape = top.map(([, n]) => n).join(",");
        if (legend.dataset.shape !== shape) {
          legend.dataset.shape = shape;
          legend.replaceChildren(
            ...top.map(([, n]) =>
              el(
                "span",
                { title: names[n] },
                el("i", { style: `background:${hex(rgbs[n])}` }),
                blockTitle(names[n]),
              ),
            ),
          );
        }
      }
    }
    requestAnimationFrame(frame);

    // ── reading the world ──
    function forget() {
      explicit = new Map();
      fills = [];
      ground = null;
      names = [];
      nameIndex = new Map();
      rgbs = [];
      alphas = [];
      turtleName = [];
      shapes = [];
      computers = new Map();
      trails = new Map();
      shownPos.clear();
      effects.length = 0;
      placed = 0;
      dug = 0;
      main = null;
      followed = null;
    }

    function take(data) {
      const first = seq === undefined;
      if (data.full) {
        forget();
        originX = data.blocks.length ? data.blocks[0] : 0;
        originZ = data.blocks.length ? data.blocks[2] : 0;
      }
      const local = data.names.map((name, i) =>
        nameOf(name, data.colours[i], data.alphas[i]),
      );
      const idx = (n) => (n < 0 ? -1 : local[n]);
      main = data.main;
      if (data.full) {
        ground = data.ground
          ? {
              y: data.ground.y,
              name: idx(data.ground.name),
              top: idx(data.ground.top),
            }
          : null;
        fills = (data.fills || []).map((f) => [
          ...f.slice(0, 6),
          idx(f[6]),
          (f[3] - f[0] + 1) * (f[4] - f[1] + 1) * (f[5] - f[2] + 1) <= 4096,
        ]);
      }
      const b = data.blocks;
      const showEffects =
        !data.full && !first && b.length <= 5 * 300 && !calm.matches;
      const now = performance.now();
      const touched = [];
      for (let i = 0; i < b.length; i += 5) {
        const [x, y, z] = [b[i], b[i + 1], b[i + 2]];
        const n = idx(b[i + 3]);
        const before = data.full ? -1 : at(x, y, z);
        explicit.set(key(x, y, z), [n, b[i + 4]]);
        if (!data.full) {
          const wasTurtle = before >= 0 && turtleName[before];
          const isTurtle = n >= 0 && turtleName[n];
          if (isTurtle && before >= 0 && !wasTurtle) dug++; // it dug its way in since the last look
          if (wasTurtle && n >= 0 && !isTurtle) placed++; // it stepped away and put a block where it stood
          if (!wasTurtle && !isTurtle && before !== n) {
            if (n < 0 && before >= 0) {
              dug++;
              if (showEffects)
                effects.push({
                  x,
                  y,
                  z,
                  rgb: rgbs[before],
                  start: now,
                  out: true,
                });
            } else if (n >= 0 && before < 0) {
              placed++;
              if (showEffects)
                effects.push({ x, y, z, rgb: rgbs[n], start: now, out: false });
            }
          }
          touched.push(x, y, z);
        }
      }
      for (const c of data.computers) computers.set(c.id, c);
      for (const [id, c] of [...computers]) {
        const e = explicit.get(key(c.x, c.y, c.z));
        if (!e || e[0] < 0) computers.delete(id);
      }
      for (const [id, steps] of Object.entries(data.trails)) {
        const t = trails.get(Number(id)) || [];
        t.push(...steps);
        if (t.length > 3 * 20000) t.splice(0, t.length - 3 * 20000);
        trails.set(Number(id), t);
      }
      seq = data.seq;
      if (data.full) {
        rebuild();
        if (scene && first) {
          const { min, max } = interest();
          scene.frame(min, max);
          scene.distance = Math.min(scene.distance, 22);
          scene.target = focusPoint();
        }
        flat.zoom = first ? 0 : flat.zoom;
      } else if (scene) {
        // the ground is drawn round where things are: when they reach its edge, draw more of it
        const c = focusPoint();
        if (
          region &&
          ground &&
          (c[0] < region.x1 + 4 ||
            c[0] > region.x2 - 4 ||
            c[2] < region.z1 + 4 ||
            c[2] > region.z2 - 4)
        )
          rebuild();
        else
          for (let i = 0; i < touched.length; i += 3)
            refreshAround(touched[i], touched[i + 1], touched[i + 2]);
      }
      touchAll();
    }

    async function show() {
      const s = cur();
      if (!s?.blocks) return;
      if (s.id !== sessionId) {
        sessionId = s.id;
        seq = undefined;
        forget();
        if (scene) rebuild();
        layout();
      }
      if (busy) return;
      busy = true;
      const asked = sessionId;
      try {
        const data = await api(
          `/api/sessions/${asked}/blocks${seq === undefined ? "" : `?since=${seq}`}`,
        );
        if (
          asked === sessionId &&
          (data.full ||
            data.blocks.length ||
            Object.keys(data.trails).length ||
            seq === undefined)
        )
          take(data);
      } catch {
        // the computer went away
      } finally {
        busy = false;
      }
    }

    return {
      show,
      /** For tests and the curious: what the view holds. */
      get scene() {
        return scene;
      },
      get stats() {
        return {
          blocks: explicit.size,
          drawn: cells.size,
          sides: scene ? scene.world.count : 0,
          placed,
          dug,
          seq,
          gl: !!scene,
        };
      },
    };
  })();

  window.craftosViews = {
    /** app.js: the computers were read again. */
    poll: apply,
    /** app.js: another computer was picked. */
    selected: apply,
    blocks,
  };
  window.addEventListener("resize", () => window.craftosViews.poll());
})();
