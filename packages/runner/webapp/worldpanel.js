// The world panel: what is around the computer, built with the mouse while its program runs. The six sides, the
// blocks on its wired network and the players on the server, each with a form from the world schema. Every change
// goes to the server as a whole world; the server works out what happened (a block placed, broken, a chest filled,
// a player moving) and tells the running computer the way the game would (src/webapp-world.ts, src/world-live.ts).
// The world can be saved as a *.world.json and a saved one opened again.
//
// The model, the forms, the Add list and the edits are packages/world-editor's, which the VS Code World Editor
// uses too; the server hands them out as they are under /world-editor/. app.js tells this file which computer is
// shown (the craftos:select event); nothing else here touches app.js.
import { typeCatalog } from "/world-editor/catalog.js";
import { h, icon, iconKind } from "/world-editor/dom.js";
import {
  addOps,
  computerTitle,
  duplicateOps,
  monitorChars,
  moveToSide,
  thingTitle,
  toNetwork,
  valueAt,
} from "/world-editor/edits.js";
import { restoreFocus, snapshotFocus } from "/world-editor/focus.js";
import {
  firstSentence,
  keyOf,
  renderField,
  renderItems,
  renderObject,
} from "/world-editor/form.js";
import { applyOps, parseTree } from "/world-editor/jsonDoc.js";
import {
  addonOfType,
  addonsOn,
  bySide,
  computerOf,
  mcOf,
  thingsOf,
  worldProblems,
} from "/world-editor/model.js";
import { renderPicker } from "/world-editor/picker.js";
import {
  SIDES,
  fieldsOf,
  isSide,
  peripheralTypes,
  validate,
} from "/world-editor/schema.js";

const root = document.getElementById("world-panel");

const st = {
  id: null,
  schema: null,
  catalog: { defaultMc: "1.18.2", addons: [] },
  types: null,
  /** the world file's text, kept as it was opened so a saved file keeps its layout */
  text: "",
  world: null,
  running: true,
  problems: [],
  selected: "computer",
  adding: null,
  /** what the last change did: {steps: [{what, ok, error}], later: [...]} */
  log: null,
  pending: 0,
  /** a project file it was opened from: Save writes it back */
  file: null,
  error: "",
  /** the world as the server last said it is (JSON): a change from elsewhere shows when it differs */
  served: null,
};

async function api(path, options = {}) {
  const init = { ...options };
  if (options.json !== undefined) {
    init.method = init.method || "PUT";
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

// ───────────────────────── words ─────────────────────────

/** What a field is called in the panel: the file's key, in words. */
const LABELS = {
  name: "Name",
  size: "Slots",
  items: "Contents",
  energy: "Energy (FE)",
  energyCapacity: "Energy capacity (FE)",
  energyRate: "Energy per tick (FE)",
  capacity: "Capacity (mB)",
  fluid: "Fluid",
  tanks: "Tanks",
  dimension: "Dimension",
  blocksWide: "Blocks wide",
  blocksHigh: "Blocks high",
  textScale: "Text scale at the start",
  online: "Online",
  gamemode: "Game mode",
  maxHealth: "Most health",
  customName: "Name it reports",
  kind: "Kind",
  network: "Network id",
  computerId: "Computer id",
  label: "Label",
  position: "Where the computer is",
  environment: "Time and weather",
  x: "X",
  y: "Y",
  z: "Z",
};
function label(key) {
  if (LABELS[key]) return LABELS[key];
  const words = String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// ───────────────────────── state ─────────────────────────

function types() {
  if (!st.types) st.types = typeCatalog(st.schema ?? undefined, st.catalog);
  return st.types;
}

function setText(text) {
  st.text = text;
  try {
    st.world = parseTree(text)?.value ?? {};
    st.error = "";
  } catch (e) {
    st.error = `That world file is not JSON: ${e.message}`;
    st.world = {};
  }
  checkProblems();
}

function checkProblems() {
  if (!st.schema || !st.world) return void (st.problems = []);
  st.problems = [
    ...validate(st.schema, st.world),
    ...worldProblems(st.world, st.catalog, st.catalog.defaultMc),
  ];
}

const problemsAt = (path, exact = false) =>
  st.problems.filter(
    (p) =>
      p.path.length >= path.length &&
      path.every((seg, k) => p.path[k] === seg) &&
      (!exact || p.path.length === path.length),
  );

const ctx = {
  get root() {
    return st.schema;
  },
  edit,
  problemsAt,
  label,
};

const thingAt = (key) =>
  thingsOf(st.world ?? {}).find((t) => keyOf(t.path) === key);

/** A change made in the panel: into the text, drawn, then sent to the computer. */
function edit(ops, select) {
  if (!ops.length) return;
  setText(applyOps(st.text, ops));
  if (select !== undefined) st.selected = select;
  if (st.selected !== "computer" && !thingAt(st.selected))
    st.selected = "computer";
  render();
  push();
}

let chain = Promise.resolve();
/** Send the world as it is now; changes go one after another, in the order they were made. */
function push() {
  const id = st.id;
  const world = st.world;
  st.pending++;
  renderStatus();
  chain = chain
    .then(() => api(`/api/sessions/${id}/world`, { json: { world } }))
    .then((result) => {
      if (st.id !== id) return;
      st.log = result;
      if (result?.world) st.served = JSON.stringify(result.world);
    })
    .catch((e) => {
      if (st.id === id) st.log = { steps: [], later: [], error: e.message };
    })
    .finally(() => {
      st.pending--;
      if (st.id === id) renderStatus();
    });
}

async function load(id) {
  st.id = id;
  st.log = null;
  st.file = null;
  st.selected = "computer";
  if (!id || id === "lastrun") return render();
  try {
    const got = await api(`/api/sessions/${id}/world`);
    if (st.id !== id) return;
    st.running = got.running;
    st.served = JSON.stringify(got.world ?? {});
    setText(`${JSON.stringify(got.world ?? {}, null, 2)}\n`);
  } catch (e) {
    st.world = null;
    st.error = e.message;
  }
  render();
}

// ───────────────────────── drawing ─────────────────────────

function render() {
  if (!root) return;
  const keep = snapshotFocus([".wp-list", ".side"], document);
  root.replaceChildren(...view());
  restoreFocus(keep, pending ?? keep.key, root);
  pending = undefined;
}
let pending;

function view() {
  if (!st.id || st.id === "lastrun") return [];
  const head = h(
    "div",
    { class: "wp-head" },
    h(
      "h3",
      {},
      "Around this computer ",
      h("span", { class: "sub" }, "changes reach the running program at once"),
    ),
    h(
      "div",
      { class: "wp-tools" },
      h(
        "button",
        {
          class: "btn primary",
          "data-key": "wp:add",
          onclick: () => openAdd(),
          title: "Put a block, a monitor or a player in the world",
        },
        "+ Add",
      ),
      openMenu(),
      h(
        "button",
        {
          class: "btn",
          "data-key": "wp:save",
          onclick: save,
          title: "Save these surroundings as a .world.json file",
        },
        "Save as world file",
      ),
      st.file
        ? h(
            "button",
            {
              class: "btn ghost",
              "data-key": "wp:save-back",
              onclick: saveBack,
              title: `Write ${st.file} in your project again`,
            },
            `Save to ${st.file.split("/").pop()}`,
          )
        : null,
    ),
  );
  if (!st.world)
    return [
      h(
        "div",
        { class: "card wp" },
        head,
        h("p", { class: "msg bad" }, st.error || "Loading..."),
      ),
    ];
  return [
    h(
      "div",
      { class: "card wp" },
      head,
      !st.running
        ? h(
            "p",
            { class: "wp-note" },
            "The computer is off. You can still build a world and save it as a file; the computer feels changes only while it runs.",
          )
        : null,
      st.error ? h("p", { class: "msg bad" }, st.error) : null,
      cross(),
      network(),
      players(),
      h("div", { id: "wp-status", class: "wp-status", "aria-live": "polite" }),
    ),
    h(
      "div",
      {
        class: "card wp wp-inspector",
        "aria-label": "Settings of what is selected",
      },
      inspector(),
    ),
  ];
}

function renderStatus() {
  const box = document.getElementById("wp-status");
  if (!box) return;
  const out = [];
  if (st.pending)
    out.push(h("div", { class: "msg" }, "Telling the computer..."));
  const log = st.log;
  if (log && !st.pending) {
    if (log.error) out.push(h("div", { class: "msg bad" }, log.error));
    if (log.steps?.length)
      out.push(
        h(
          "ul",
          { class: "wp-steps", "aria-label": "What the computer saw" },
          log.steps.map((s) =>
            h(
              "li",
              { class: s.ok ? "ok" : "bad" },
              h("span", { "aria-hidden": "true" }, s.ok ? "✓ " : "✗ "),
              s.what,
              s.ok ? null : h("span", { class: "why" }, `: ${s.error}`),
            ),
          ),
        ),
      );
    if (log.later?.length)
      out.push(
        h(
          "ul",
          { class: "wp-later", "aria-label": "Kept for the next start" },
          log.later.map((t) => h("li", {}, t)),
        ),
      );
  }
  box.replaceChildren(...out);
}

const problemKeys = () =>
  new Set(
    st.problems.map((p) =>
      ["peripherals", "monitors", "players"].includes(p.path[0]) &&
      typeof p.path[1] === "number"
        ? keyOf(p.path.slice(0, 2))
        : "computer",
    ),
  );

/** The computer and its six sides. */
function cross() {
  const world = st.world;
  const things = thingsOf(world);
  const sides = bySide(things);
  const bad = problemKeys();
  const comp = computerOf(world);
  const centre = h(
    "button",
    {
      class: `wp-tile wp-computer${st.selected === "computer" ? " selected" : ""}`,
      "aria-pressed": st.selected === "computer" ? "true" : "false",
      "data-key": "tile:computer",
      onclick: () => select("computer"),
      title: "The computer itself: where it is, the time and weather",
    },
    icon(
      comp.kind === "turtle"
        ? "turtle"
        : comp.kind === "pocket"
          ? "pocket"
          : "computer",
      comp.advanced ? "advanced" : "",
    ),
    h("span", { class: "wp-tile-title" }, computerTitle(comp)),
    h("span", { class: "wp-tile-sub" }, `#${comp.id}`),
  );
  const cell = (side) =>
    tile(
      side,
      sides[side].filter((t) => t.kind !== "player"),
      bad,
    );
  return h(
    "div",
    {
      class: "wp-cross",
      role: "group",
      "aria-label": "The computer and its six sides",
    },
    // back and top above, left and right beside, bottom and front below: the computer seen from above and in front
    h(
      "div",
      { class: "wp-cross-row" },
      h("div", { class: "wp-cell" }, cell("back")),
      h("div", { class: "wp-cell" }, cell("top")),
      h("div", { class: "wp-cell" }),
    ),
    h(
      "div",
      { class: "wp-cross-row" },
      h("div", { class: "wp-cell" }, cell("left")),
      h("div", { class: "wp-cell" }, centre),
      h("div", { class: "wp-cell" }, cell("right")),
    ),
    h(
      "div",
      { class: "wp-cross-row" },
      h("div", { class: "wp-cell" }),
      h("div", { class: "wp-cell" }, cell("bottom")),
      h("div", { class: "wp-cell" }, cell("front")),
    ),
  );
}

function tile(side, on, bad) {
  const t = on[0];
  if (!t)
    return h(
      "button",
      {
        class: "wp-tile is-empty",
        "data-key": `tile:${side}`,
        onclick: () => openAdd(side),
        "aria-label": `Nothing on the ${side}. Put something on the ${side}`,
        title: `Put something on the ${side}`,
      },
      h("span", { class: "wp-side" }, side),
      h("span", { class: "wp-plus", "aria-hidden": "true" }, "+"),
    );
  const key = keyOf(t.path);
  const a = addonOfType(st.catalog, t.type);
  return h(
    "button",
    {
      class: `wp-tile${st.selected === key ? " selected" : ""}${bad.has(key) || on.length > 1 ? " problem" : ""}`,
      "aria-pressed": st.selected === key ? "true" : "false",
      "data-key": `tile:${side}`,
      onclick: () => select(key),
      onkeydown: (e) => deleteKey(e, t),
      title: `${thingTitle(st.world, t)} on the ${side}. Delete takes it away`,
    },
    h("span", { class: "wp-side" }, side),
    icon(t.kind === "monitor" ? "monitor" : iconKind(t.type, t.modem)),
    h("span", { class: "wp-tile-title" }, short(t)),
    on.length > 1
      ? h("span", { class: "wp-tile-sub warn" }, `+${on.length - 1} more here`)
      : a
        ? h("span", { class: "wp-tile-sub" }, a.name)
        : null,
  );
}

/** A tile's title: the friendly name of storage blocks, else the editors' title. */
function short(t) {
  const entry = types().find(
    (e) => e.type === t.type && e.target === "peripheral" && e.type !== "modem",
  );
  if (t.kind === "peripheral" && !t.modem && entry && entry.label !== t.type)
    return entry.label.replace(/ \(.*\)$/, "");
  return thingTitle(st.world, t);
}

function listRow(t, bad) {
  const key = keyOf(t.path);
  const pos =
    t.x !== undefined ? ` at ${t.x}, ${t.y ?? "?"}, ${t.z ?? "?"}` : "";
  return h(
    "li",
    {},
    h(
      "button",
      {
        class: `wp-row${st.selected === key ? " selected" : ""}${bad.has(key) ? " problem" : ""}`,
        "aria-pressed": st.selected === key ? "true" : "false",
        "data-key": `row:${key}`,
        onclick: () => select(key),
        onkeydown: (e) => deleteKey(e, t),
      },
      icon(
        t.kind === "monitor"
          ? "monitor"
          : t.kind === "player"
            ? "player"
            : iconKind(t.type, t.modem),
      ),
      h(
        "span",
        { class: "wp-row-main" },
        t.kind === "player" ? t.name || "(no name)" : t.name || "(no name)",
        h(
          "span",
          { class: "sub" },
          t.kind === "player"
            ? `${valueAt(st.world, [...t.path, "online"]) === false ? " offline" : ""}${pos}`
            : ` ${short(t)}${pos}`,
        ),
      ),
      bad.has(key) ? h("span", { class: "wp-badge bad" }, "problem") : null,
    ),
  );
}

function network() {
  const things = thingsOf(st.world).filter(
    (t) => t.kind !== "player" && !t.side,
  );
  const bad = problemKeys();
  const wired = thingsOf(st.world).some((t) => t.side && t.modem === "wired");
  return h(
    "section",
    { class: "wp-section", "aria-labelledby": "wp-net-h" },
    h(
      "h4",
      { id: "wp-net-h" },
      "On the wired network ",
      h("span", { class: "wp-count" }, String(things.length)),
    ),
    things.length
      ? h(
          "ul",
          { class: "wp-list" },
          things.map((t) => listRow(t, bad)),
        )
      : h(
          "p",
          { class: "hint" },
          "Nothing yet. Blocks here have a network name such as minecraft:chest_0 instead of a side.",
        ),
    things.length && !wired
      ? h(
          "p",
          { class: "wp-note" },
          "In the game these need a wired modem on one of the computer's sides, with cable to each block.",
        )
      : null,
    h(
      "button",
      {
        class: "btn ghost small",
        "data-key": "wp:add-net",
        onclick: () => openAdd(undefined, "network"),
      },
      "+ Put a block on the network",
    ),
  );
}

function players() {
  const list = thingsOf(st.world).filter((t) => t.kind === "player");
  const bad = problemKeys();
  return h(
    "section",
    { class: "wp-section", "aria-labelledby": "wp-pl-h" },
    h(
      "h4",
      { id: "wp-pl-h" },
      "Players ",
      h("span", { class: "wp-count" }, String(list.length)),
    ),
    list.length
      ? h(
          "ul",
          { class: "wp-list" },
          list.map((t) => listRow(t, bad)),
        )
      : h(
          "p",
          { class: "hint" },
          "Nobody on the server. Player detectors and chat boxes see the players here.",
        ),
    h(
      "button",
      {
        class: "btn ghost small",
        "data-key": "wp:add-player",
        onclick: () => {
          const entry = types().find((t) => t.target === "player");
          if (entry) add(entry);
        },
      },
      "+ Add a player",
    ),
  );
}

// ───────────────────────── the selected thing ─────────────────────────

function select(key) {
  st.selected = key;
  render();
}

function deleteKey(e, t) {
  if (
    e.key === "Delete" ||
    (e.key === "Backspace" && (e.metaKey || e.ctrlKey))
  ) {
    e.preventDefault();
    remove(t);
  }
}

function remove(t) {
  pending = t.side ? `tile:${t.side}` : "wp:add";
  edit([{ op: "remove", path: t.path }], "computer");
}

function inspector() {
  const t = st.selected === "computer" ? undefined : thingAt(st.selected);
  if (!t) return computerInspector();
  const schema = st.schema;
  const value = valueAt(st.world, t.path) ?? {};
  const a = addonOfType(st.catalog, t.type);
  const typeDesc = peripheralTypes(schema).find(
    (x) => x.type === t.type,
  )?.description;
  const head = h(
    "div",
    { class: "wp-ins-head" },
    icon(
      t.kind === "monitor"
        ? "monitor"
        : t.kind === "player"
          ? "player"
          : iconKind(t.type, t.modem),
      "big",
    ),
    h(
      "div",
      { class: "grow" },
      h("h3", {}, t.kind === "player" ? t.name || "Player" : short(t)),
      h(
        "div",
        { class: "sub" },
        t.kind === "player"
          ? "A player on the server"
          : `${t.side ? `On the ${t.side} of the computer` : `On the wired network as ${t.name}`}${t.kind === "peripheral" ? ` · ${t.type}${a ? ` from ${a.name}` : ""}` : ""}`,
      ),
    ),
  );
  const actions = h(
    "div",
    { class: "wp-actions" },
    t.kind === "player" ? null : whereSelect(t),
    h(
      "button",
      {
        class: "btn small",
        "data-key": "ins:dup",
        onclick: () => {
          const { ops, path } = duplicateOps(st.world, t);
          pending = `row:${keyOf(path)}`;
          edit(ops, keyOf(path));
        },
        title: "Put another one just like it in the world",
      },
      "Copy",
    ),
    h(
      "button",
      {
        class: "btn danger small",
        "data-key": "ins:remove",
        onclick: () => remove(t),
        title:
          t.kind === "player"
            ? "The player logs out and leaves the list"
            : "Break the block: the computer gets peripheral_detach",
      },
      t.kind === "player" ? "Remove" : "Break it",
    ),
  );
  const desc =
    typeDesc && t.kind === "peripheral"
      ? h("p", { class: "hint", title: typeDesc }, firstSentence(typeDesc))
      : null;
  let form;
  if (t.kind === "monitor") form = monitorForm(t, value);
  else if (t.kind === "player")
    form = renderObject(ctx, t.path, schema.definitions?.PlayerSpec, value, {
      showAllUpTo: 0,
    });
  else
    form = renderObject(ctx, t.path, schema.definitions?.Peripheral, value, {
      skip: new Set(["name", "type"]),
      custom: {
        items: (p, v, f) =>
          renderItems(ctx, p, v, f, Number(value.size) || undefined),
      },
      showAllUpTo: 16,
    });
  return [head, actions, desc, form].filter(Boolean);
}

/** Where it is: a side, or the wired network. */
function whereSelect(t) {
  const sel = h(
    "select",
    { "data-key": "ins:where", "aria-label": "Where it is" },
    SIDES.map((s) =>
      h("option", { value: s, selected: t.side === s }, `On the ${s}`),
    ),
    h("option", { value: "", selected: !t.side }, "On the wired network"),
  );
  sel.addEventListener("change", () => {
    const ops = sel.value
      ? moveToSide(st.world, t, sel.value, keyOf)
      : toNetwork(st.world, t);
    pending = "ins:where";
    edit(ops);
  });
  const parts = [sel];
  if (!t.side) {
    const input = h("input", {
      type: "text",
      value: t.name,
      "data-key": "ins:netname",
      "aria-label": "Its name on the network",
      title: "Its name on the network: peripheral.wrap finds it by this name",
      spellcheck: "false",
      size: 14,
    });
    input.addEventListener("change", () => {
      const v = input.value.trim();
      if (v && v !== t.name)
        edit([{ op: "set", path: [...t.path, "name"], value: v }]);
    });
    parts.push(input);
  }
  return h("span", { class: "wp-where" }, ...parts);
}

function monitorForm(t, m) {
  const schema = st.schema;
  const w = Number(m.blocksWide ?? 1) || 1;
  const hh = Number(m.blocksHigh ?? 1) || 1;
  const scale = Number(m.textScale ?? 1) || 1;
  const { cols, rows } = monitorChars(w, hh, scale);
  const normal = m.advanced === false;
  const kind = h(
    "div",
    { class: "wp-kind", role: "radiogroup", "aria-label": "Kind of monitor" },
    [
      [false, "Advanced monitor", "colours, and players can touch it"],
      [true, "Normal monitor", "greys only, no touches"],
    ].map(([isNormal, text, sub]) => {
      const input = h("input", {
        type: "radio",
        name: "wp-monitor-kind",
        checked: normal === isNormal,
        "data-key": `ins:kind:${isNormal ? "normal" : "advanced"}`,
      });
      input.addEventListener("change", () =>
        edit([
          isNormal
            ? { op: "set", path: [...t.path, "advanced"], value: false }
            : { op: "remove", path: [...t.path, "advanced"] },
        ]),
      );
      return h(
        "label",
        { class: "check" },
        input,
        text,
        h("span", { class: "sub" }, ` ${sub}`),
      );
    }),
  );
  const preview = h("div", {
    class: `wp-monitor${normal ? " normal" : ""}`,
    "aria-hidden": "true",
  });
  const unit = Math.min(160 / w, 70 / hh, 30);
  preview.style.width = `${unit * w}px`;
  preview.style.height = `${unit * hh}px`;
  preview.style.setProperty("--bw", String(w));
  preview.style.setProperty("--bh", String(hh));
  return h(
    "div",
    {},
    kind,
    h(
      "div",
      { class: "wp-monitor-box" },
      preview,
      h(
        "div",
        { class: "sub" },
        `${w}×${hh} blocks: ${cols}×${rows} characters at text scale ${scale}`,
      ),
    ),
    renderObject(ctx, t.path, schema.definitions?.MonitorSpec, m, {
      skip: new Set(["name", "advanced"]),
    }),
  );
}

const COMPUTER_KEYS = ["position", "environment", "label"];
const HANDLED = new Set([
  "$schema",
  "monitors",
  "peripherals",
  "players",
  ...COMPUTER_KEYS,
]);

function computerInspector() {
  const schema = st.schema;
  const world = st.world;
  const comp = computerOf(world);
  const top = fieldsOf(schema, schema, world);
  const field = (k) =>
    top.find((f) => f.key === k) ?? { key: k, schema: {}, required: false };
  const mc = mcOf(world, st.catalog.defaultMc);
  const on = addonsOn(world, st.catalog, mc);
  return [
    h(
      "div",
      { class: "wp-ins-head" },
      icon(
        comp.kind === "turtle"
          ? "turtle"
          : comp.kind === "pocket"
            ? "pocket"
            : "computer",
        "big",
      ),
      h(
        "div",
        { class: "grow" },
        h("h3", {}, computerTitle(comp)),
        h(
          "div",
          { class: "sub" },
          `#${comp.id} at ${comp.x}, ${comp.y}, ${comp.z} · Minecraft ${mc} · ${on.size} mod${on.size === 1 ? "" : "s"}`,
        ),
      ),
    ),
    h(
      "p",
      { class: "hint" },
      "Click a side to put a block there, or pick one to change it. Moving the computer moves its modems too.",
    ),
    ...COMPUTER_KEYS.map((k) => renderField(ctx, [k], field(k), world[k])),
    h(
      "details",
      { class: "wp-more" },
      h("summary", {}, "More world settings"),
      h(
        "p",
        { class: "hint" },
        "These are kept in the world file; a computer started from the file has them.",
      ),
      renderObject(ctx, [], schema, world, { skip: HANDLED, showAllUpTo: 0 }),
    ),
  ];
}

// ───────────────────────── adding ─────────────────────────

let layer = null;
let opener = null;

function openAdd(side, where) {
  opener = document.activeElement;
  st.adding = { side, filter: "", active: 0 };
  const world = st.world;
  const close = () => {
    st.adding = null;
    layer?.remove();
    layer = null;
    if (opener && document.contains(opener)) opener.focus();
  };
  const picker = renderPicker({
    state: st.adding,
    types: types(),
    addonsOn: addonsOn(world, st.catalog, mcOf(world, st.catalog.defaultMc)),
    pick: (entry, s) => {
      close();
      add(entry, s, where);
    },
    close,
    title: side
      ? `Put something on the ${side}`
      : where === "network"
        ? "Put a block on the wired network"
        : undefined,
  });
  layer = h("div", { class: "wp-layer" }, picker);
  document.body.append(layer);
  layer.querySelector("input")?.focus();
}

function add(entry, side, where) {
  const world = st.world;
  let { ops, path } = addOps(world, entry, st.catalog, side);
  // "on the network" asked for: a modem or a monitor does not take a free side then
  if (where === "network" && !side && entry.target !== "player") {
    const pushOp = ops.find((o) => o.op === "push");
    const list = entry.target === "monitor" ? "monitors" : "peripherals";
    if (pushOp && isSide(pushOp.value?.name)) {
      const used = new Set(thingsOf(world).map((t) => t.name));
      const base = entry.target === "monitor" ? "monitor" : entry.type;
      let n = 0;
      while (used.has(`${base}_${n}`)) n++;
      pushOp.value = { ...pushOp.value, name: `${base}_${n}` };
    }
    path = [list, path[1]];
  }
  const key = keyOf(path);
  pending = `row:${key}`;
  edit(ops, key);
  // a side tile, not a row, when it went on a side
  const t = thingAt(key);
  if (t?.side) {
    pending = `tile:${t.side}`;
    render();
  }
}

// ───────────────────────── files ─────────────────────────

function openMenu() {
  const sel = h(
    "select",
    {
      class: "wp-open",
      "data-key": "wp:open",
      "aria-label": "Open a world file",
      title: "Load a .world.json: the computer gets every block in it at once",
    },
    h("option", { value: "" }, "Open a world file..."),
    h("option", { value: "@disk" }, "From this PC..."),
  );
  if (projectFiles.length)
    sel.append(
      h(
        "optgroup",
        { label: "In your project" },
        projectFiles.map((f) => h("option", { value: f }, f)),
      ),
    );
  sel.addEventListener("focus", refreshProjectFiles, { once: true });
  sel.addEventListener("change", async () => {
    const v = sel.value;
    sel.value = "";
    if (v === "@disk") return pickFromDisk();
    if (v) {
      try {
        const text = await api(`/api/world-file?path=${encodeURIComponent(v)}`);
        openText(text, v);
      } catch (e) {
        st.error = `Could not open ${v}: ${e.message}`;
        render();
      }
    }
  });
  return sel;
}

let projectFiles = [];
async function refreshProjectFiles() {
  try {
    const { files } = await api("/api/world-files");
    if (JSON.stringify(files) !== JSON.stringify(projectFiles)) {
      projectFiles = files;
      const sel = root.querySelector(".wp-open");
      if (sel && document.activeElement !== sel) render();
    }
  } catch {
    // the server is restarting
  }
}

function pickFromDisk() {
  const input = h("input", {
    type: "file",
    accept: ".json,application/json",
    class: "wp-file",
  });
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    input.remove();
    if (file) openText(await file.text(), null);
  });
  document.body.append(input);
  input.click();
}

/** A world file opened: it replaces the panel's world, and the computer gets the difference at once. */
function openText(text, projectPath) {
  try {
    const value = parseTree(text)?.value;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("a world file holds one JSON object");
  } catch (e) {
    st.error = `That is not a world file: ${e.message}`;
    return render();
  }
  setText(text);
  st.file = projectPath;
  st.selected = "computer";
  pending = "wp:open";
  render();
  push();
}

async function fileName() {
  try {
    const { sessions } = await api("/api/sessions");
    const s = sessions.find((x) => x.id === st.id);
    const base = (s?.name || "world").replace(/[^\w.-]+/g, "_");
    return `${base}.world.json`;
  } catch {
    return "world.world.json";
  }
}

async function save() {
  const text = st.text.endsWith("\n") ? st.text : `${st.text}\n`;
  const name = st.file?.split("/").pop() || (await fileName());
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [
          {
            description: "World file",
            accept: { "application/json": [".world.json", ".json"] },
          },
        ],
      });
      const out = await handle.createWritable();
      await out.write(text);
      await out.close();
      return note(`Saved as ${handle.name}`);
    } catch (e) {
      if (e?.name === "AbortError") return;
      // no access to the file system: a download instead
    }
  }
  const a = h("a", {
    href: URL.createObjectURL(new Blob([text], { type: "application/json" })),
    download: name,
  });
  document.body.append(a);
  a.click();
  a.remove();
  note(`Downloaded ${name}`);
}

async function saveBack() {
  try {
    await api(`/api/world-file?path=${encodeURIComponent(st.file)}`, {
      method: "PUT",
      body: st.text,
    });
    note(`Saved ${st.file}`);
  } catch (e) {
    note(`Could not save: ${e.message}`, true);
  }
}

function note(text, bad = false) {
  st.log = { steps: [], later: [], ...(bad ? { error: text } : {}) };
  renderStatus();
  const box = document.getElementById("wp-status");
  if (box && !bad) box.prepend(h("div", { class: "msg ok" }, text));
}

// ───────────────────────── wiring ─────────────────────────

document.addEventListener("craftos:select", (e) => {
  const id = e.detail?.id ?? null;
  if (id !== st.id) load(id);
});

// the computer turned on or off, or its world changed elsewhere (`attach` or `sim join` in the shell, a program, the
// MCP tools): the panel follows. Not while a change of its own is on its way, nor over a world file opened to edit.
setInterval(async () => {
  if (!st.id || st.id === "lastrun" || document.hidden) return;
  if (root.closest("[hidden]")) return;
  try {
    const id = st.id;
    const got = await api(`/api/sessions/${id}/world`);
    if (st.id !== id) return;
    let changed = false;
    if (got.running !== st.running) {
      st.running = got.running;
      changed = true;
    }
    const served = JSON.stringify(got.world ?? {});
    if (served !== st.served && st.pending === 0 && !st.file) {
      st.served = served;
      setText(`${JSON.stringify(got.world ?? {}, null, 2)}\n`);
      if (st.selected !== "computer" && !thingAt(st.selected))
        st.selected = "computer";
      changed = true;
    }
    if (changed) render();
  } catch {
    // closed, or the server restarting
  }
}, 2000);

async function start() {
  try {
    const meta = await api("/api/world-editor");
    st.schema = meta.schema;
    st.catalog = meta.catalog;
    st.types = null;
    checkProblems();
  } catch (e) {
    st.error = `The world panel could not load the world schema: ${e.message}`;
  }
  refreshProjectFiles();
  // a computer may already be shown before this module ran: app.js's `current` (a global of the classic script)
  // eslint-disable-next-line no-undef
  const shown = typeof current === "string" ? current : null;
  if (shown && !st.id) return load(shown);
  render();
}
start();

// for the tests and anyone scripting the page
window.craftosWorldPanel = {
  get state() {
    return st;
  },
  load,
};
