// Sim commands without JSON: forms for the world commands people use most, on the Sim commands tab above the JSON
// box. Each form is there only when the computer's command list (GET /api/sessions/<id>/commands, the same list the
// box fills from) has its command, and sends the fields that command takes. Names to pick from (players,
// inventories, sides) come from the computer's sim state. Every command sent here also lands in the JSON box, so the
// box shows what to write for it. app.js says which computer is shown (the craftos:select event).
(() => {
  const panel = document.querySelector('.panel[data-panel="commands"]');
  if (!panel) return;
  const jsonCard = panel.querySelector(".card");
  const SIDES = ["top", "bottom", "left", "right", "front", "back"];
  const BLOCKS = [
    "minecraft:chest",
    "minecraft:barrel",
    "minecraft:hopper",
    "minecraft:furnace",
    "speaker",
    "printer",
    "drive",
    "modem",
  ];

  let current = null;
  let commands = new Map(); // cmd -> its fields, from the command list
  let names = { players: [], inventories: [], peripherals: [] };

  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids) if (k != null) e.append(k);
    return e;
  };

  const root = el("div", { class: "card sf", id: "sim-forms" });
  jsonCard?.before(root);
  // the JSON box is for everything else now
  const jsonTitle = jsonCard?.querySelector("h3");
  if (jsonTitle) jsonTitle.textContent = "Any other command, as JSON";

  /** "{player, x, y, z, dimension?}" -> [{name: "player", optional: false}, ...] */
  function fieldsOf(args) {
    return String(args ?? "")
      .replace(/^\{|\}$/g, "")
      .split(",")
      .map((p) => /^\s*(\w+)(\??)/.exec(p))
      .filter(Boolean)
      .map((m) => ({ name: m[1], optional: !!m[2] }));
  }

  async function post(cmd, out) {
    if (!current) return;
    out.className = "msg";
    out.textContent = "sending...";
    const box = document.getElementById("cmd-text");
    if (box) box.value = JSON.stringify(cmd);
    let result;
    try {
      // a jump is the whole world's, as the time bar's (app.js command)
      const jump = cmd.cmd === "advance";
      const res = await fetch(
        jump
          ? "/api/clock"
          : `/api/sessions/${encodeURIComponent(current)}/command`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            jump
              ? {
                  action: "jump",
                  amount: Math.round(Number(cmd.seconds) * 1000),
                }
              : { command: cmd },
          ),
        },
      );
      const body = await res.text();
      try {
        result = JSON.parse(body);
      } catch {
        // the clock's errors are plain text
        result = { error: body || `HTTP ${res.status}` };
      }
      if (!res.ok && !result.error) result.error = `HTTP ${res.status}`;
    } catch (e) {
      result = { error: e.message };
    }
    out.className = `msg ${result.error ? "bad" : "ok"}`;
    out.textContent = result.error ? result.error : "done";
    clearTimeout(out.t);
    out.t = setTimeout(() => (out.textContent = ""), 5000);
    refreshNames();
    return result;
  }

  /** post, and Join adds a player the world has not seen yet, as `sim join` does in the computer */
  async function send(cmd, out) {
    if (!cmd.__orAdd) return post(cmd, out);
    const { __orAdd, ...plain } = cmd;
    const r = await post(plain, out);
    if (r?.error === "unknown player")
      return post({ cmd: "addPlayer", name: plain.player, online: true }, out);
    return r;
  }

  const has = (cmd, ...fields) => {
    const f = commands.get(cmd);
    return !!f && fields.every((n) => f.some((x) => x.name === n));
  };

  const input = (attrs) => el("input", attrs);
  const num = (name, value, label, extra = {}) =>
    el(
      "label",
      { class: "sf-f" },
      label,
      input({ name, type: "number", value, ...extra }),
    );
  const text = (name, label, attrs = {}) =>
    el("label", { class: "sf-f grow" }, label, input({ name, ...attrs }));
  const datalist = (id, values) =>
    el("datalist", { id }, ...values.map((v) => el("option", { value: v })));

  function form(title, help, body, buttons) {
    const out = el("span", { class: "msg", role: "status" });
    const f = el(
      "form",
      { class: "sf-form", onsubmit: (e) => e.preventDefault() },
      el(
        "h4",
        {},
        title,
        help ? el("span", { class: "sub", text: ` ${help}` }) : null,
      ),
      el("div", { class: "sf-row" }, ...body),
      el(
        "div",
        { class: "sf-row" },
        ...buttons.map(([label, make, cls]) =>
          el("button", {
            type: label === buttons[0][0] ? "submit" : "button",
            class: `btn ${cls ?? ""}`,
            text: label,
            onclick: async (e) => {
              e.preventDefault();
              const data = Object.fromEntries(new FormData(f).entries());
              const cmd = make(data);
              if (typeof cmd === "string") {
                out.className = "msg bad";
                out.textContent = cmd;
                return;
              }
              const btn = e.currentTarget;
              btn.disabled = true;
              try {
                await send(cmd, out);
              } finally {
                btn.disabled = false;
              }
            },
          }),
        ),
        out,
      ),
    );
    return f;
  }

  const need = (value, what) =>
    String(value ?? "").trim() ? null : `type ${what} first`;

  function build() {
    const parts = [];
    parts.push(
      el(
        "h3",
        {},
        "Change the world",
        el("span", { class: "sub", text: " no JSON needed" }),
      ),
      datalist("sf-players", names.players),
      datalist("sf-inventories", names.inventories),
      datalist("sf-peripherals", names.peripherals),
      datalist("sf-blocks", BLOCKS),
    );

    if (has("join", "player") || has("addPlayer", "name"))
      parts.push(
        form(
          "Players",
          "someone logs in or out",
          [
            text("player", "Name", {
              list: "sf-players",
              placeholder: "Alice",
              autocomplete: "off",
            }),
          ],
          [
            [
              "Join",
              (d) =>
                need(d.player, "a name") ?? {
                  cmd: "join",
                  player: d.player.trim(),
                  __orAdd: true,
                },
            ],
            [
              "Leave",
              (d) =>
                need(d.player, "a name") ?? {
                  cmd: "leave",
                  player: d.player.trim(),
                },
              "ghost",
            ],
          ],
        ),
      );

    if (has("setPlayerPos", "player", "x", "y", "z"))
      parts.push(
        form(
          "Move a player",
          "where they stand",
          [
            text("player", "Name", {
              list: "sf-players",
              placeholder: "Alice",
              autocomplete: "off",
            }),
            num("x", 0, "X"),
            num("y", 64, "Y"),
            num("z", 0, "Z"),
          ],
          [
            [
              "Move",
              (d) =>
                need(d.player, "a name") ?? {
                  cmd: "setPlayerPos",
                  player: d.player.trim(),
                  x: Number(d.x) || 0,
                  y: Number(d.y) || 0,
                  z: Number(d.z) || 0,
                },
            ],
          ],
        ),
      );

    if (has("setItem", "peripheral", "slot"))
      parts.push(
        form(
          "Give an item",
          "put it in a chest's slot",
          [
            text("peripheral", "Inventory", {
              list: "sf-inventories",
              placeholder: names.inventories[0] ?? "chest_0",
              autocomplete: "off",
            }),
            num("slot", 1, "Slot", { min: 1 }),
            text("item", "Item", {
              placeholder: "minecraft:diamond",
              autocomplete: "off",
            }),
            num("count", 1, "Count", { min: 1, max: 64 }),
          ],
          [
            [
              "Put in",
              (d) =>
                need(d.peripheral, "an inventory") ??
                need(d.item, "an item") ?? {
                  cmd: "setItem",
                  peripheral: d.peripheral.trim(),
                  slot: Number(d.slot) || 1,
                  item: {
                    name: itemName(d.item),
                    count: Math.max(1, Number(d.count) || 1),
                  },
                },
            ],
            [
              "Empty the slot",
              (d) =>
                need(d.peripheral, "an inventory") ?? {
                  cmd: "setItem",
                  peripheral: d.peripheral.trim(),
                  slot: Number(d.slot) || 1,
                  item: null,
                },
              "ghost",
            ],
          ],
        ),
      );

    if (
      has("attachPeripheral", "peripheral") &&
      has("detachPeripheral", "name")
    )
      parts.push(
        form(
          "Place a block",
          "next to the computer, live",
          [
            el(
              "label",
              { class: "sf-f" },
              "Side",
              el(
                "select",
                { name: "side" },
                ...SIDES.map((s) => el("option", { value: s, text: s })),
              ),
            ),
            text("type", "Block", {
              list: "sf-blocks",
              placeholder: "minecraft:chest",
              autocomplete: "off",
            }),
          ],
          [
            [
              "Place",
              (d) =>
                need(d.type, "a block") ?? {
                  cmd: "attachPeripheral",
                  peripheral: blockSpec(d.side, d.type.trim()),
                },
            ],
            [
              "Break",
              (d) => ({ cmd: "detachPeripheral", name: d.side }),
              "ghost",
            ],
          ],
        ),
      );

    if (has("setEnvironment", "values"))
      parts.push(
        form(
          "Weather",
          "rain and thunder, for detectors and modem range",
          [],
          [
            [
              "Clear",
              () => ({
                cmd: "setEnvironment",
                values: { raining: false, thunder: false },
              }),
            ],
            [
              "Rain",
              () => ({
                cmd: "setEnvironment",
                values: { raining: true, thunder: false },
              }),
              "ghost",
            ],
            [
              "Thunder",
              () => ({
                cmd: "setEnvironment",
                values: { raining: true, thunder: true },
              }),
              "ghost",
            ],
          ],
        ),
      );

    if (has("advance", "seconds"))
      parts.push(
        form(
          "Time",
          "jump the whole world's clock in computer time: the timers on the way fire in order and the programs run between them (pause and speed are in the bar at the bottom)",
          [num("seconds", 10, "Seconds", { min: 0, step: 1 })],
          [
            [
              "Advance",
              (d) => ({
                cmd: "advance",
                seconds: Math.max(0, Number(d.seconds) || 0),
              }),
            ],
            ["+1 min", () => ({ cmd: "advance", seconds: 60 }), "ghost"],
            ["+1 hour", () => ({ cmd: "advance", seconds: 3600 }), "ghost"],
          ],
        ),
      );

    if (parts.length <= 5)
      parts.push(
        el("p", {
          class: "sub",
          text: "This computer has no simulated world, so there is nothing to change.",
        }),
      );
    root.replaceChildren(...parts);
  }

  /** "diamond" is minecraft:diamond, as /give takes it */
  const itemName = (s) => {
    const t = String(s).trim();
    return t.includes(":") ? t : `minecraft:${t}`;
  };

  /** What attachPeripheral places for a block name: short names a player says, a chest's slots, a printer's supplies. */
  function blockSpec(side, type) {
    const short = {
      chest: "minecraft:chest",
      barrel: "minecraft:barrel",
      hopper: "minecraft:hopper",
      furnace: "minecraft:furnace",
    };
    const t = short[type] ?? type;
    const spec = { name: side, type: t };
    if (/^minecraft:(chest|trapped_chest|barrel|shulker_box)$/.test(t))
      spec.size = 27;
    if (t === "minecraft:hopper") spec.size = 5;
    if (t === "minecraft:furnace") spec.size = 3;
    if (t === "printer") Object.assign(spec, { ink: 64, paper: 64 });
    return spec;
  }

  async function refreshNames() {
    if (!current) return;
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(current)}/state`,
      );
      if (!res.ok) return;
      const state = await res.json();
      const players = (state.live?.players ?? [])
        .map((p) => p?.name)
        .filter(Boolean);
      const next = {
        players: [...new Set(players)].sort(),
        inventories: Object.keys(state.inventories ?? {}).sort(),
        peripherals: (state.live?.peripherals ?? [])
          .map((p) => p?.name)
          .filter(Boolean),
      };
      if (JSON.stringify(next) === JSON.stringify(names)) return;
      names = next;
      for (const [id, values] of [
        ["sf-players", names.players],
        ["sf-inventories", names.inventories],
        ["sf-peripherals", names.peripherals],
      ]) {
        const list = document.getElementById(id);
        list?.replaceChildren(...values.map((v) => el("option", { value: v })));
      }
    } catch {
      // the computer is starting
    }
  }

  async function load() {
    commands = new Map();
    if (current && current !== "lastrun") {
      try {
        const res = await fetch(
          `/api/sessions/${encodeURIComponent(current)}/commands`,
        );
        const data = res.ok ? await res.json() : { commands: [] };
        for (const c of data.commands ?? [])
          commands.set(c.cmd, fieldsOf(c.args));
      } catch {
        // none yet
      }
      await refreshNames();
    }
    build();
  }

  document.addEventListener("craftos:select", (e) => {
    current = e.detail?.id ?? null;
    load();
  });
  setInterval(() => !panel.hidden && refreshNames(), 2000);
  build();
})();
