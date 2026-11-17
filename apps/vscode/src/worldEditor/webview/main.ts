// The World Editor webview: the computer with its six sides, the blocks on its network, a map from above, the other
// computers in the folder, and a form for whatever is selected. Every change goes to the extension as edit ops on
// paths; the extension edits the text and sends the new world back, so the text document is the only state.
import "./worldEditor.css";
import type { EditOp, JsonPath } from "../jsonDoc.ts";
import {
  type AddonCatalog,
  type ComputerFacts,
  type Neighbour,
  type Thing,
  type World,
  addonOfType,
  addonsOn,
  bySide,
  computerOf,
  freeName,
  freeSide,
  linkBetween,
  mcOf,
  neighbourOf,
  thingsOf,
} from "../model.ts";
import {
  type Field,
  type Problem,
  type Schema,
  SIDES,
  type Side,
  deref,
  fieldsOf,
  isSide,
  peripheralTypes,
} from "../schema.ts";
import { h, icon, iconKind } from "./dom.ts";
import {
  type FormContext,
  firstSentence,
  keyOf,
  renderField,
  renderObject,
} from "./form.ts";
import { mapItems, renderMap } from "./map.ts";

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(s: unknown): void;
};

const vscode = acquireVsCodeApi();

interface Defaults {
  readonly mc: string;
  readonly addons: string;
}

interface State {
  schema?: Schema;
  catalog: AddonCatalog;
  schemaName: string;
  world?: World;
  parseError?: { message: string; line: number; col: number };
  problems: readonly Problem[];
  defaults: Defaults;
  file: string;
  neighbours: readonly Neighbour[];
  selected: string;
  showProblems: boolean;
  adding?: { side?: Side; filter: string; active: number };
}

const saved = (vscode.getState() ?? {}) as { selected?: string };
const state: State = {
  catalog: { defaultMc: "1.18.2", addons: [] },
  schemaName: "",
  problems: [],
  defaults: { mc: "1.18.2", addons: "" },
  file: "",
  neighbours: [],
  selected: saved.selected ?? "computer",
  showProblems: false,
};

const app = document.getElementById("app")!;

window.addEventListener("message", (e: MessageEvent) => {
  const msg = e.data as Record<string, unknown>;
  if (msg["type"] === "schema") {
    state.schema = msg["schema"] as Schema;
    state.catalog = msg["catalog"] as AddonCatalog;
    state.schemaName = String(msg["schemaName"] ?? "");
    typeIndex = undefined;
  } else if (msg["type"] === "doc") {
    state.world = msg["world"] as World | undefined;
    state.parseError = msg["parseError"] as State["parseError"];
    state.problems = (msg["problems"] as Problem[]) ?? [];
    state.defaults = msg["defaults"] as Defaults;
    state.file = String(msg["file"] ?? "");
    if (msg["neighbours"]) state.neighbours = msg["neighbours"] as Neighbour[];
    if (state.world && !keyExists(state.selected)) select("computer", false);
  }
  render();
});

function post(msg: unknown): void {
  vscode.postMessage(msg);
}

function edit(ops: EditOp[]): void {
  if (ops.length) post({ type: "edit", ops });
}

function select(key: string, draw = true): void {
  state.selected = key;
  vscode.setState({ selected: key });
  if (draw) render();
}

function keyExists(key: string): boolean {
  if (key === "computer") return true;
  if (key.startsWith("neighbour:"))
    return state.neighbours.some((n) => `neighbour:${n.file}` === key);
  return thingsOf(state.world ?? {}).some((t) => keyOf(t.path) === key);
}

// ---------------------------------------------------------------------------------------------------------------
// Peripheral types: grouped for the Add list

interface TypeEntry {
  readonly label: string;
  readonly type: string;
  readonly group: string;
  readonly description: string;
  /** Fields a new one starts with besides name and type. */
  readonly preset?: Record<string, unknown>;
  readonly addon?: string;
  readonly target: "monitor" | "player" | "peripheral";
}

let typeIndex: TypeEntry[] | undefined;

const STORAGE = new Set([
  "minecraft:chest",
  "minecraft:trapped_chest",
  "minecraft:barrel",
  "minecraft:hopper",
  "minecraft:dispenser",
  "minecraft:dropper",
  "minecraft:shulker_box",
  "minecraft:furnace",
  "inventory",
  "fluid_storage",
  "energy_storage",
]);

function types(): TypeEntry[] {
  if (typeIndex) return typeIndex;
  const all = state.schema ? peripheralTypes(state.schema) : [];
  const describe = (t: string): string =>
    all.find((x) => x.type === t)?.description ?? "";
  const cc = "CC:Tweaked";
  const out: TypeEntry[] = [
    {
      label: "Monitor",
      type: "monitor",
      group: cc,
      description: "A monitor wall: 1x1 up to 8x6 blocks.",
      target: "monitor",
    },
    {
      label: "Wireless modem",
      type: "modem",
      group: cc,
      description: "Reaches wireless modems within 64 blocks (384 high up).",
      target: "peripheral",
    },
    {
      label: "Ender modem",
      type: "modem",
      group: cc,
      description: "Reaches every wireless modem, any distance, any dimension.",
      preset: { kind: "ender" },
      target: "peripheral",
    },
    {
      label: "Wired modem",
      type: "modem",
      group: cc,
      description:
        "Joins a wired network by its id, or through cables at `block`.",
      preset: { kind: "wired", network: "main" },
      target: "peripheral",
    },
    {
      label: "Speaker",
      type: "speaker",
      group: cc,
      description: describe("speaker"),
      target: "peripheral",
    },
    {
      label: "Disk drive",
      type: "drive",
      group: cc,
      description: describe("drive"),
      target: "peripheral",
    },
    {
      label: "Redstone relay",
      type: "redstone_relay",
      group: cc,
      description: describe("redstone_relay"),
      target: "peripheral",
    },
    {
      label: "Player",
      type: "player",
      group: cc,
      description:
        "Someone on the server: detectors, chat boxes and inventory managers see them.",
      target: "player",
    },
  ];
  for (const t of STORAGE)
    out.push({
      label: t,
      type: t,
      group: "Storage (any mod's blocks)",
      description: describe(t),
      target: "peripheral",
    });
  const taken = new Set([
    "modem",
    "speaker",
    "drive",
    "redstone_relay",
    ...STORAGE,
  ]);
  for (const a of state.catalog.addons)
    for (const t of a.types) {
      if (taken.has(t)) continue;
      taken.add(t);
      out.push({
        label: t,
        type: t,
        group: a.name,
        addon: a.id,
        description: describe(t),
        target: "peripheral",
      });
    }
  for (const t of all)
    if (!taken.has(t.type))
      out.push({
        label: t.type,
        type: t.type,
        group: "Other types",
        description: t.description,
        target: "peripheral",
      });
  typeIndex = out;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Edits

function thingAt(key: string): Thing | undefined {
  return thingsOf(state.world ?? {}).find((t) => keyOf(t.path) === key);
}

function valueAt(path: JsonPath): unknown {
  let v: unknown = state.world;
  for (const seg of path)
    v =
      v && typeof v === "object"
        ? (v as Record<string | number, unknown>)[seg]
        : undefined;
  return v;
}

/** Ops that put `thing` on `side`; whatever was there takes the thing's old place. */
function moveToSide(thing: Thing, side: Side): EditOp[] {
  const world = state.world ?? {};
  const occupant = bySide(thingsOf(world))[side].find(
    (t) => t.kind !== "player" && keyOf(t.path) !== keyOf(thing.path),
  );
  const ops: EditOp[] = [
    { op: "set", path: [...thing.path, "name"], value: side },
  ];
  if (occupant) {
    const back = thing.side ?? freeName(world, occupant.type);
    ops.push({ op: "set", path: [...occupant.path, "name"], value: back });
  }
  return ops;
}

function toNetwork(thing: Thing): EditOp[] {
  if (!thing.side) return [];
  return [
    {
      op: "set",
      path: [...thing.path, "name"],
      value: freeName(state.world ?? {}, thing.type),
    },
  ];
}

function remove(thing: Thing): void {
  edit([{ op: "remove", path: thing.path }]);
  select("computer", false);
}

function duplicate(thing: Thing): void {
  const world = state.world ?? {};
  const copy = JSON.parse(JSON.stringify(valueAt(thing.path))) as Record<
    string,
    unknown
  >;
  const list = thing.path[0] as string;
  if (thing.kind === "player") copy["name"] = `${thing.name} 2`;
  else copy["name"] = freeName(world, thing.type);
  const index = (Array.isArray(world[list]) ? (world[list] as unknown[]) : [])
    .length;
  edit([{ op: "push", path: [list], value: copy }]);
  select(keyOf([list, index]), false);
}

function add(entry: TypeEntry, side?: Side): void {
  const world = state.world ?? {};
  const comp = computerOf(world);
  const ops: EditOp[] = [];
  const count = (key: string): number =>
    Array.isArray(world[key]) ? (world[key] as unknown[]).length : 0;
  let newKey: string;
  if (entry.target === "player") {
    const n = count("players");
    ops.push({
      op: "push",
      path: ["players"],
      value: {
        name: n ? `Player${n + 1}` : "Alice",
        x: comp.x + 2,
        y: comp.y,
        z: comp.z,
      },
    });
    newKey = keyOf(["players", n]);
  } else if (entry.target === "monitor") {
    const name = side ?? freeSide(world) ?? freeName(world, "monitor");
    ops.push({
      op: "push",
      path: ["monitors"],
      value: { name, blocksWide: 3, blocksHigh: 2 },
    });
    newKey = keyOf(["monitors", count("monitors")]);
    if (side) ops.unshift(...clear(side));
  } else {
    const name =
      side ??
      (entry.type === "modem" ? freeSide(world) : undefined) ??
      freeName(world, entry.type);
    ops.push({
      op: "push",
      path: ["peripherals"],
      value: { name, type: entry.type, ...(entry.preset ?? {}) },
    });
    newKey = keyOf(["peripherals", count("peripherals")]);
    if (side) ops.unshift(...clear(side));
    // switch the addon on when the world lists its addons
    if (
      entry.addon &&
      Array.isArray(world["addons"]) &&
      !(world["addons"] as unknown[]).includes(entry.addon)
    ) {
      const a = state.catalog.addons.find((x) => x.id === entry.addon);
      ops.push({ op: "push", path: ["addons"], value: entry.addon });
      for (const need of a?.requires ?? [])
        if (!(world["addons"] as unknown[]).includes(need))
          ops.push({ op: "push", path: ["addons"], value: need });
    }
  }
  state.adding = undefined;
  select(newKey, false);
  edit(ops);
}

/** Whatever is on `side` moves to the network, to make room. */
function clear(side: Side): EditOp[] {
  return bySide(thingsOf(state.world ?? {}))
    [side].filter((t) => t.kind !== "player")
    .flatMap(toNetwork);
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering

function problemsAt(path: JsonPath, exact = false): Problem[] {
  return state.problems.filter(
    (p) =>
      p.path.length >= path.length &&
      path.every((seg, k) => p.path[k] === seg) &&
      (!exact || p.path.length === path.length),
  );
}

const ctx: FormContext = {
  get root() {
    return state.schema!;
  },
  edit,
  problemsAt,
};

/** The thing (or the computer) a problem belongs to. */
function ownerOf(p: Problem): string {
  if (
    (p.path[0] === "peripherals" ||
      p.path[0] === "monitors" ||
      p.path[0] === "players") &&
    typeof p.path[1] === "number"
  )
    return keyOf(p.path.slice(0, 2));
  return "computer";
}

function computerTitle(c: ComputerFacts): string {
  const adv = c.advanced ? "Advanced " : "";
  if (c.kind === "turtle") return `${adv}Turtle`;
  if (c.kind === "pocket") return `${adv}Pocket Computer`;
  if (c.kind === "android") return "Android";
  if (c.kind === "drone") return "Drone";
  return `${adv}Computer`;
}

function thingTitle(t: Thing): string {
  if (t.kind === "monitor") {
    const m = (valueAt(t.path) ?? {}) as Record<string, unknown>;
    return `Monitor ${m["blocksWide"] ?? 1}×${m["blocksHigh"] ?? 1}`;
  }
  if (t.kind === "player") return t.name || "Player";
  if (t.modem) return `${t.modem[0]!.toUpperCase()}${t.modem.slice(1)} modem`;
  return t.type || "(no type)";
}

function render(): void {
  const keep = snapshotFocus();
  app.replaceChildren(...view());
  restoreFocus(keep);
  // what is on screen, for the integration test (and nothing else)
  if (state.world || state.parseError)
    post({
      type: "rendered",
      tiles: document.querySelectorAll(".cross .tile:not(.empty)").length,
      rows: document.querySelectorAll(".rows .row").length,
      problems: state.problems.length,
      parseError: !!state.parseError,
    });
}

function view(): Node[] {
  if (!state.schema || (!state.world && !state.parseError))
    return [h("p", { class: "loading" }, "Loading the world...")];
  if (state.parseError || !state.world) {
    const e = state.parseError!;
    return [
      h(
        "div",
        { class: "broken", role: "alert" },
        h("h2", {}, "This file is not a world the editor can read"),
        h("p", {}, `Line ${e.line}, column ${e.col}: ${e.message}`),
        h(
          "p",
          { class: "muted" },
          "Fix it in the text editor; this view comes back when the JSON parses.",
        ),
        h(
          "button",
          { onclick: () => post({ type: "showText" }) },
          "Open the Text Editor",
        ),
      ),
    ];
  }
  return [
    toolbar(),
    h(
      "div",
      { class: "layout" },
      h("main", { class: "scene", "aria-label": "The world" }, scene()),
      h(
        "aside",
        { class: "inspector", "aria-label": "Properties" },
        inspector(),
      ),
    ),
    state.adding ? addDialog() : null,
  ].filter((n): n is HTMLElement => !!n);
}

function toolbar(): HTMLElement {
  const n = state.problems.length;
  const world = state.world!;
  const mc = mcOf(world, state.defaults.mc);
  const on = addonsOn(world, state.catalog, mc, state.defaults.addons);
  return h(
    "header",
    { class: "toolbar" },
    h(
      "div",
      { class: "title" },
      h("strong", {}, state.file),
      h(
        "span",
        { class: "muted" },
        ` Minecraft ${mc}${world["version"] === undefined ? " (default)" : ""} · ${on.size} addon${on.size === 1 ? "" : "s"} on${
          // the schema's name only when the file brings its own
          world["$schema"] === undefined ? "" : ` · schema ${state.schemaName}`
        }`,
      ),
    ),
    h(
      "div",
      { class: "actions" },
      h(
        "button",
        {
          class: "primary",
          onclick: () => openAdd(),
          title: "Add a block, monitor or player (A)",
          "data-key": "tb:add",
        },
        "+ Add",
      ),
      h(
        "button",
        {
          class: n ? "problems-button has" : "problems-button",
          "aria-expanded": state.showProblems ? "true" : "false",
          "data-key": "tb:problems",
          onclick: () => {
            state.showProblems = !state.showProblems;
            render();
          },
        },
        n ? `${n} problem${n === 1 ? "" : "s"}` : "No problems",
      ),
      h(
        "button",
        {
          class: "secondary",
          onclick: () => post({ type: "showText" }),
          "data-key": "tb:text",
          title: "Open this file as text beside the editor",
        },
        "Show Text",
      ),
    ),
    state.showProblems && n ? problemsPanel() : null,
  );
}

function problemsPanel(): HTMLElement {
  return h(
    "ul",
    { class: "problems", "aria-label": "Problems" },
    state.problems.map((p) =>
      h(
        "li",
        {},
        h(
          "button",
          {
            class: "link",
            onclick: () => {
              select(ownerOf(p), false);
              pendingFocus = keyOf(p.path);
              render();
            },
          },
          h("code", {}, p.path.length ? p.path.join(".") : "(file)"),
          " ",
          p.message,
        ),
      ),
    ),
  );
}

let pendingFocus: string | undefined;

function scene(): Node[] {
  const world = state.world!;
  const things = thingsOf(world);
  const sides = bySide(things);
  const comp = computerOf(world);
  const problemKeys = new Set(state.problems.map(ownerOf));
  const tile = (side: Side): HTMLElement =>
    sideTile(
      side,
      sides[side].filter((t) => t.kind !== "player"),
      problemKeys,
    );
  const computerTile = h(
    "button",
    {
      class: `tile computer-tile${state.selected === "computer" ? " selected" : ""}${problemKeys.has("computer") ? " problem" : ""}`,
      "aria-pressed": state.selected === "computer" ? "true" : "false",
      "data-key": "tile:computer",
      onclick: () => select("computer"),
      title: "The computer: its id, label, version and mods",
    },
    icon(
      comp.kind === "turtle"
        ? "turtle"
        : comp.kind === "pocket"
          ? "pocket"
          : "computer",
      comp.advanced ? "advanced" : "",
    ),
    h("span", { class: "tile-title" }, computerTitle(comp)),
    h(
      "span",
      { class: "tile-sub" },
      `#${comp.id}${comp.label ? ` · ${comp.label}` : ""}`,
    ),
  );
  const cross = h(
    "div",
    {
      class: "cross",
      role: "group",
      "aria-label": "The computer and its six sides",
    },
    h("div", { class: "cell c-top" }, tile("top")),
    h("div", { class: "cell c-back" }, tile("back")),
    h("div", { class: "cell c-left" }, tile("left")),
    h("div", { class: "cell c-centre" }, computerTile),
    h("div", { class: "cell c-right" }, tile("right")),
    h("div", { class: "cell c-front" }, tile("front")),
    h("div", { class: "cell c-bottom" }, tile("bottom")),
  );

  const network = things.filter((t) => t.kind !== "player" && !t.side);
  const players = things.filter((t) => t.kind === "player");
  const netList = h(
    "section",
    { class: "panel network", "aria-labelledby": "net-h" },
    h(
      "h3",
      { id: "net-h" },
      "On the network",
      h("span", { class: "count" }, String(network.length)),
    ),
    h(
      "p",
      { class: "hint" },
      "Blocks named like minecraft:chest_0 rather than a side: the computer reaches them through a wired modem. Drop a side's block here to move it off that side.",
    ),
    h(
      "ul",
      { class: "rows" },
      network.map((t) => row(t, problemKeys)),
    ),
    h(
      "button",
      {
        class: "secondary small",
        onclick: () => openAdd(),
        "data-key": "net:add",
      },
      "+ Add a block",
    ),
  );
  dropTarget(netList, (thing) => toNetwork(thing));

  const playerList = h(
    "section",
    { class: "panel players", "aria-labelledby": "pl-h" },
    h(
      "h3",
      { id: "pl-h" },
      "Players",
      h("span", { class: "count" }, String(players.length)),
    ),
    players.length
      ? h(
          "ul",
          { class: "rows" },
          players.map((t) => row(t, problemKeys)),
        )
      : h("p", { class: "hint" }, "Nobody on the server yet."),
    h(
      "button",
      {
        class: "secondary small",
        "data-key": "pl:add",
        onclick: () => add(types().find((t) => t.target === "player")!),
      },
      "+ Add a player",
    ),
  );

  const mine = neighbourOf(state.file, world);
  const range =
    typeof (world["config"] as Record<string, unknown> | undefined)?.[
      "modemRange"
    ] === "number"
      ? (world["config"] as Record<string, number>)["modemRange"]!
      : 64;
  const links = state.neighbours.map((n) => linkBetween(mine, n, range));
  const items = mapItems(
    comp,
    `#${comp.id}`,
    things,
    state.neighbours,
    links,
    state.selected,
    keyOf,
    problemKeys,
  );
  const map = h(
    "section",
    { class: "panel map-panel", "aria-labelledby": "map-h" },
    h(
      "h3",
      { id: "map-h" },
      "Map",
      h(
        "span",
        { class: "muted small" },
        ` y ${comp.y} · ${comp.dimension.replace(/^minecraft:/, "")}`,
      ),
    ),
    renderMap(items, {
      select: (i) => select(i.key),
      move: (i, x, z) => {
        if (i.kind === "computer")
          edit([
            { op: "set", path: [comp.at, "x"], value: x },
            { op: "set", path: [comp.at, "z"], value: z },
          ]);
        else if (i.kind === "thing") {
          const t = thingAt(i.key)!;
          edit([
            { op: "set", path: [...t.path, "x"], value: x },
            { op: "set", path: [...t.path, "z"], value: z },
          ]);
        } else
          post({
            type: "editOther",
            file: i.key.slice("neighbour:".length),
            ops: [
              { op: "set", path: ["position", "x"], value: x },
              { op: "set", path: ["position", "z"], value: z },
            ],
          });
        pendingFocus = `map:${i.key}`;
      },
    }),
    h(
      "p",
      { class: "hint" },
      "Things with an x and z. Drag them, or focus one and use the arrow keys (Shift: 10 blocks).",
    ),
  );

  const others = h(
    "section",
    { class: "panel neighbours", "aria-labelledby": "nb-h" },
    h(
      "h3",
      { id: "nb-h" },
      "Other computers here",
      h("span", { class: "count" }, String(state.neighbours.length)),
    ),
    h(
      "p",
      { class: "hint" },
      "One world file is one computer. The world files next to this one are the other computers a network test can start with it.",
    ),
    h(
      "ul",
      { class: "rows" },
      state.neighbours.map((n, k) => {
        const key = `neighbour:${n.file}`;
        const name = n.file.split(/[\\/]/).pop()!;
        const sameId = n.computer.id === comp.id;
        return h(
          "li",
          {},
          h(
            "button",
            {
              class: `row${state.selected === key ? " selected" : ""}`,
              "aria-pressed": state.selected === key ? "true" : "false",
              "data-key": `row:${key}`,
              onclick: () => select(key),
            },
            icon(
              n.computer.kind === "turtle"
                ? "turtle"
                : n.computer.kind === "pocket"
                  ? "pocket"
                  : "computer",
            ),
            h(
              "span",
              { class: "row-main" },
              name,
              h("span", { class: "muted" }, ` #${n.computer.id}`),
            ),
            h(
              "span",
              {
                class: `badge ${links[k] ? "ok" : "off"}${sameId ? " warn" : ""}`,
              },
              sameId
                ? "same id"
                : links[k]
                  ? `${links[k]} link`
                  : "not reached",
            ),
          ),
        );
      }),
    ),
    h(
      "button",
      {
        class: "secondary small",
        "data-key": "nb:add",
        onclick: () => post({ type: "newComputer" }),
      },
      "+ Add a computer",
    ),
  );

  return [cross, netList, playerList, map, others];
}

function sideTile(
  side: Side,
  on: readonly Thing[],
  problemKeys: ReadonlySet<string>,
): HTMLElement {
  const t = on[0];
  let el: HTMLElement;
  if (!t) {
    el = h(
      "button",
      {
        class: "tile empty",
        "data-key": `tile:${side}`,
        onclick: () => openAdd(side),
        title: `Put something on the ${side} side`,
      },
      h("span", { class: "side-name" }, side),
      h("span", { class: "tile-plus", "aria-hidden": "true" }, "+"),
      h(
        "span",
        { class: "sr-only" },
        `Empty. Add something on the ${side} side`,
      ),
    );
  } else {
    const key = keyOf(t.path);
    const value = (valueAt(t.path) ?? {}) as Record<string, unknown>;
    el = h(
      "button",
      {
        class: `tile${state.selected === key ? " selected" : ""}${problemKeys.has(key) || on.length > 1 ? " problem" : ""}`,
        "aria-pressed": state.selected === key ? "true" : "false",
        "data-key": `tile:${side}`,
        draggable: "true",
        onclick: () => select(key),
        onkeydown: (e: Event) => deleteKey(e as KeyboardEvent, t),
        title: `${thingTitle(t)} on the ${side} side`,
      },
      h("span", { class: "side-name" }, side),
      t.kind === "monitor"
        ? monitorGlyph(value)
        : icon(iconKind(t.type, t.modem)),
      h("span", { class: "tile-title" }, thingTitle(t)),
      on.length > 1
        ? h(
            "span",
            { class: "tile-sub warn" },
            `+${on.length - 1} more on this side`,
          )
        : addonBadge(t),
    );
    drag(el, t);
  }
  dropTarget(el, (thing) =>
    thing.side === side ? [] : moveToSide(thing, side),
  );
  return el;
}

function addonBadge(t: Thing): HTMLElement | null {
  const a = addonOfType(state.catalog, t.type);
  return a ? h("span", { class: "tile-sub" }, a.name) : null;
}

function monitorGlyph(m: Record<string, unknown>): HTMLElement {
  const w = Math.max(1, Math.min(8, Number(m["blocksWide"] ?? 1) || 1));
  const hh = Math.max(1, Math.min(6, Number(m["blocksHigh"] ?? 1) || 1));
  const glyph = h("span", { class: "monitor-glyph", "aria-hidden": "true" });
  const unit = Math.min(30 / w, 20 / hh, 7);
  glyph.style.setProperty("width", `${unit * w}px`);
  glyph.style.setProperty("height", `${unit * hh}px`);
  return glyph;
}

function row(t: Thing, problemKeys: ReadonlySet<string>): HTMLElement {
  const key = keyOf(t.path);
  const pos =
    t.x !== undefined ? ` · ${t.x}, ${t.y ?? "?"}, ${t.z ?? "?"}` : "";
  const b = h(
    "button",
    {
      class: `row${state.selected === key ? " selected" : ""}${problemKeys.has(key) ? " problem" : ""}`,
      "aria-pressed": state.selected === key ? "true" : "false",
      "data-key": `row:${key}`,
      draggable: t.kind === "player" ? undefined : "true",
      onclick: () => select(key),
      onkeydown: (e: Event) => deleteKey(e as KeyboardEvent, t),
    },
    t.kind === "monitor" ? icon("monitor") : icon(iconKind(t.type, t.modem)),
    h(
      "span",
      { class: "row-main" },
      t.kind === "player" ? t.name : t.name || "(no name)",
      h(
        "span",
        { class: "muted" },
        `${t.kind === "player" ? "" : ` ${thingTitle(t)}`}${pos}`,
      ),
    ),
    problemKeys.has(key) ? h("span", { class: "badge err" }, "problem") : null,
  );
  if (t.kind !== "player") drag(b, t);
  return h("li", {}, b);
}

function deleteKey(e: KeyboardEvent, t: Thing): void {
  if (
    e.key === "Delete" ||
    (e.key === "Backspace" && (e.metaKey || e.ctrlKey))
  ) {
    e.preventDefault();
    remove(t);
  }
}

let dragging: Thing | undefined;

function drag(el: HTMLElement, t: Thing): void {
  el.addEventListener("dragstart", (e) => {
    dragging = t;
    e.dataTransfer?.setData("text/plain", keyOf(t.path));
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  });
  el.addEventListener("dragend", () => {
    dragging = undefined;
  });
}

function dropTarget(el: HTMLElement, ops: (thing: Thing) => EditOp[]): void {
  el.addEventListener("dragover", (e) => {
    if (!dragging) return;
    e.preventDefault();
    el.classList.add("drop");
  });
  el.addEventListener("dragleave", () => el.classList.remove("drop"));
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove("drop");
    if (dragging) edit(ops(dragging));
    dragging = undefined;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Inspector

function inspector(): Node[] {
  if (state.selected.startsWith("neighbour:")) return neighbourInspector();
  const t = state.selected === "computer" ? undefined : thingAt(state.selected);
  if (!t) return computerInspector();
  const root = state.schema!;
  const value = valueAt(t.path);
  const a = addonOfType(state.catalog, t.type);
  const typeDesc = peripheralTypes(root).find(
    (x) => x.type === t.type,
  )?.description;
  const head = h(
    "div",
    { class: "inspector-head" },
    t.kind === "monitor"
      ? icon("monitor", "big")
      : icon(iconKind(t.type, t.modem), "big"),
    h(
      "div",
      { class: "grow" },
      h("h2", {}, thingTitle(t)),
      h(
        "div",
        { class: "muted" },
        t.kind === "player"
          ? "Player"
          : a
            ? a.name
            : t.kind === "monitor"
              ? "CC:Tweaked monitor"
              : STORAGE.has(t.type) ||
                  !peripheralTypes(root).some((x) => x.type === t.type)
                ? "Inventory, tank or battery: CC:Tweaked's generic peripherals, any mod's block"
                : "CC:Tweaked",
      ),
    ),
  );
  const actions = h(
    "div",
    { class: "inspector-actions" },
    h(
      "button",
      {
        class: "secondary small",
        onclick: () => post({ type: "showText", path: t.path }),
        "data-key": "ins:text",
      },
      "Show in Text",
    ),
    h(
      "button",
      {
        class: "secondary small",
        onclick: () => duplicate(t),
        "data-key": "ins:dup",
      },
      "Duplicate",
    ),
    h(
      "button",
      {
        class: "danger small",
        onclick: () => remove(t),
        "data-key": "ins:remove",
        title: "Remove (Delete)",
      },
      "Remove",
    ),
  );
  const desc = typeDesc
    ? h("p", { class: "type-desc", title: typeDesc }, firstSentence(typeDesc))
    : null;
  let form: HTMLElement;
  if (t.kind === "monitor") {
    form = h(
      "div",
      {},
      monitorPreview(value as Record<string, unknown>),
      renderObject(ctx, t.path, root.definitions?.["MonitorSpec"], value, {
        custom: { name: nameField(t) },
      }),
    );
  } else if (t.kind === "player") {
    form = renderObject(ctx, t.path, root.definitions?.["PlayerSpec"], value, {
      showAllUpTo: 0,
    });
  } else {
    form = renderObject(ctx, t.path, root.definitions?.["Peripheral"], value, {
      custom: { name: nameField(t), type: typeField(t) },
      showAllUpTo: 16,
    });
  }
  return [head, actions, desc, form].filter((n): n is HTMLElement => !!n);
}

function monitorPreview(m: Record<string, unknown>): HTMLElement {
  const w = Number(m["blocksWide"] ?? 1) || 1;
  const hh = Number(m["blocksHigh"] ?? 1) || 1;
  const scale = Number(m["textScale"] ?? 1) || 1;
  // CC:Tweaked's MonitorBlockEntity: (64 * blocks - 20) / (6 or 9 * scale) characters
  const cols = Math.max(1, Math.round((64 * w - 20) / (6 * scale)));
  const rows = Math.max(1, Math.round((64 * hh - 20) / (9 * scale)));
  const screen = h("div", { class: "monitor-screen", "aria-hidden": "true" });
  const unit = Math.min(200 / Math.max(w, 1), 90 / Math.max(hh, 1), 40);
  screen.style.setProperty("width", `${unit * w}px`);
  screen.style.setProperty("height", `${unit * hh}px`);
  screen.style.setProperty("--bw", String(w));
  screen.style.setProperty("--bh", String(hh));
  for (let k = 0; k < Math.min(w * hh, 48); k++) screen.append(h("span", {}));
  return h(
    "div",
    { class: "monitor-preview" },
    screen,
    h(
      "div",
      { class: "muted" },
      `${w}×${hh} blocks, ${cols}×${rows} characters at text scale ${scale}`,
    ),
  );
}

/** The name: a side of the computer, or a name on its network. */
function nameField(t: Thing) {
  return (path: JsonPath, value: unknown, field: Field): HTMLElement => {
    const name = typeof value === "string" ? value : "";
    const onSide = isSide(name);
    const problems = problemsAt(path);
    const sel = h(
      "select",
      { id: "f-name", "data-key": keyOf(path), "aria-label": "Where it is" },
      SIDES.map((sd) =>
        h("option", { value: sd, selected: name === sd }, `${sd} side`),
      ),
      h("option", { value: "", selected: !onSide }, "on the network"),
    );
    sel.addEventListener("change", () => {
      if (sel.value) edit(moveToSide(t, sel.value as Side));
      else edit(toNetwork(t));
    });
    const input = h("input", {
      type: "text",
      value: name,
      "data-key": `${keyOf(path)}#text`,
      "aria-label": "Network name",
      spellcheck: "false",
    });
    input.addEventListener("change", () =>
      edit([{ op: "set", path, value: input.value }]),
    );
    const desc = deref(state.schema!, field.schema)?.description ?? "";
    return h(
      "div",
      { class: `field is-set${problems.length ? " has-problem" : ""}` },
      h(
        "div",
        { class: "field-row" },
        h(
          "label",
          { for: "f-name", title: desc },
          "name",
          h("span", { class: "req" }, " *"),
        ),
        h("div", { class: "grow pair" }, sel, onSide ? null : input),
        h("span", { class: "icon-button-space" }),
      ),
      h(
        "div",
        { class: "field-desc" },
        onSide
          ? `On the computer's ${name} side.`
          : "On the computer's wired network: peripheral.wrap finds it by this name.",
      ),
      problems.length
        ? h(
            "ul",
            { class: "field-problems", role: "alert" },
            problems.map((p) => h("li", {}, p.message)),
          )
        : null,
    );
  };
}

function typeField(t: Thing) {
  return (path: JsonPath, value: unknown): HTMLElement => {
    const problems = problemsAt(path);
    const input = h("input", {
      id: "f-type",
      type: "text",
      list: "all-types",
      value: typeof value === "string" ? value : "",
      "data-key": keyOf(path),
      spellcheck: "false",
    });
    input.addEventListener("change", () =>
      edit([{ op: "set", path, value: input.value }]),
    );
    return h(
      "div",
      { class: `field is-set${problems.length ? " has-problem" : ""}` },
      h(
        "div",
        { class: "field-row" },
        h(
          "label",
          { for: "f-type" },
          "type",
          h("span", { class: "req" }, " *"),
        ),
        h(
          "div",
          { class: "grow" },
          input,
          h(
            "datalist",
            { id: "all-types" },
            peripheralTypes(state.schema!).map((x) =>
              h("option", { value: x.type }),
            ),
          ),
        ),
        h("span", { class: "icon-button-space" }),
      ),
      h(
        "div",
        { class: "field-desc" },
        t.type && !peripheralTypes(state.schema!).some((x) => x.type === t.type)
          ? "Not a type the emulator knows: with size, items, tanks or energy it is a generic block of your own naming."
          : "Any type the schema knows; the fields below follow it.",
      ),
      problems.length
        ? h(
            "ul",
            { class: "field-problems", role: "alert" },
            problems.map((p) => h("li", {}, p.message)),
          )
        : null,
    );
  };
}

const COMPUTER_KEYS = [
  "computerId",
  "label",
  "advanced",
  "position",
  "terminal",
];
const HANDLED = new Set([
  "$schema",
  "monitors",
  "peripherals",
  "players",
  "addons",
  "version",
  "kind",
  "turtle",
  ...COMPUTER_KEYS,
]);

function computerInspector(): Node[] {
  const root = state.schema!;
  const world = state.world!;
  const comp = computerOf(world);
  const top = fieldsOf(root, root, world);
  const field = (k: string): Field =>
    top.find((f) => f.key === k) ?? { key: k, schema: {}, required: false };
  const head = h(
    "div",
    { class: "inspector-head" },
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
      h("h2", {}, computerTitle(comp)),
      h(
        "div",
        { class: "muted" },
        `Computer #${comp.id} at ${comp.x}, ${comp.y}, ${comp.z}`,
      ),
    ),
  );
  const kindSelect = h(
    "select",
    { id: "f-kind", "data-key": "computer:kind" },
    h(
      "option",
      { value: "computer", selected: comp.kind === "computer" },
      "Computer",
    ),
    h(
      "option",
      { value: "pocket", selected: comp.kind === "pocket" },
      "Pocket computer",
    ),
    h(
      "option",
      { value: "turtle", selected: comp.kind === "turtle" },
      "Turtle",
    ),
    comp.kind === "android" || comp.kind === "drone"
      ? h(
          "option",
          { value: comp.kind, selected: true, disabled: true },
          comp.kind === "android" ? "Android" : "Drone",
        )
      : null,
  );
  kindSelect.addEventListener("change", () => {
    const v = kindSelect.value;
    const ops: EditOp[] = [];
    if (v !== "turtle" && world["turtle"] !== undefined)
      ops.push({ op: "remove", path: ["turtle"] });
    if (v === "turtle") {
      if (world["kind"] !== undefined)
        ops.push({ op: "remove", path: ["kind"] });
      ops.push({
        op: "set",
        path: ["turtle"],
        value: world["advanced"] === false ? { advanced: false } : {},
      });
    } else if (v === "pocket")
      ops.push({ op: "set", path: ["kind"], value: "pocket" });
    else if (world["kind"] !== undefined)
      ops.push({ op: "remove", path: ["kind"] });
    edit(ops);
  });
  const kindRow = h(
    "div",
    { class: "field is-set" },
    h(
      "div",
      { class: "field-row" },
      h("label", { for: "f-kind" }, "is a"),
      kindSelect,
      h("span", { class: "icon-button-space" }),
    ),
    h(
      "div",
      { class: "field-desc" },
      comp.kind === "turtle"
        ? "A turtle: its world is blocks, fills and ground (turtle settings below)."
        : comp.kind === "pocket"
          ? "A pocket computer: 26x20 terminal unless terminal says otherwise."
          : "A computer block.",
    ),
  );
  const basics = h(
    "section",
    { class: "group" },
    h("h3", {}, "This computer"),
    kindRow,
    COMPUTER_KEYS.filter(
      (k) => !(k === "advanced" && comp.kind === "turtle"),
    ).map((k) => renderField(ctx, [k], field(k), world[k])),
  );
  const mods = h(
    "section",
    { class: "group" },
    h("h3", {}, "Minecraft and mods"),
    versionField(field("version")),
    addonsField(),
  );
  const turtle =
    world["turtle"] !== undefined
      ? h(
          "section",
          { class: "group" },
          h("h3", {}, "Turtle"),
          renderObject(
            ctx,
            ["turtle"],
            field("turtle").schema,
            world["turtle"],
            { showAllUpTo: 0 },
          ),
        )
      : null;
  const more = h(
    "section",
    { class: "group" },
    h("h3", {}, "More settings"),
    h(
      "p",
      { class: "hint" },
      "The world's other keys: the ones set in this file, and a list to add any other the schema has.",
    ),
    renderObject(ctx, [], root, world, { skip: HANDLED, showAllUpTo: 0 }),
  );
  return [head, basics, mods, turtle, more].filter(
    (n): n is HTMLElement => !!n,
  );
}

function versionField(field: Field): HTMLElement {
  const world = state.world!;
  const v = world["version"];
  if (v !== undefined && typeof v !== "string")
    return renderField(ctx, ["version"], field, v);
  const root = state.schema!;
  const s = deref(root, field.schema);
  const opts = s?.anyOf?.find((a) => a.enum);
  const sel = h(
    "select",
    { id: "f-version", "data-key": keyOf(["version"]) },
    h("option", { value: "" }, `default (${state.defaults.mc})`),
    (opts?.enum ?? []).map((e, k) =>
      h(
        "option",
        { value: String(e), selected: v === e },
        opts?.enumDescriptions?.[k] ?? String(e),
      ),
    ),
  );
  sel.addEventListener("change", () =>
    edit([
      sel.value
        ? { op: "set", path: ["version"], value: sel.value }
        : { op: "remove", path: ["version"] },
    ]),
  );
  const problems = problemsAt(["version"]);
  return h(
    "div",
    {
      class: `field${v !== undefined ? " is-set" : ""}${problems.length ? " has-problem" : ""}`,
    },
    h(
      "div",
      { class: "field-row" },
      h("label", { for: "f-version" }, "version"),
      sel,
      h("span", { class: "icon-button-space" }),
    ),
    h(
      "div",
      { class: "field-desc" },
      "Picks the ROM, CC:Tweaked's behaviour and the mod versions.",
    ),
    problems.length
      ? h(
          "ul",
          { class: "field-problems", role: "alert" },
          problems.map((p) => h("li", {}, p.message)),
        )
      : null,
  );
}

function addonsField(): HTMLElement {
  const world = state.world!;
  const spec = world["addons"];
  const mc = mcOf(world, state.defaults.mc);
  const on = addonsOn(world, state.catalog, mc, state.defaults.addons);
  const used = new Set(
    thingsOf(world)
      .map((t) => addonOfType(state.catalog, t.type)?.id)
      .filter(Boolean),
  );
  for (const a of state.catalog.addons)
    if (a.worldKeys?.some((k) => k in world)) used.add(a.id);
  const mode =
    spec === undefined
      ? "default"
      : spec === "all"
        ? "all"
        : spec === "none"
          ? "none"
          : "pick";
  const setMode = (m: string): void => {
    if (m === "default") edit([{ op: "remove", path: ["addons"] }]);
    else if (m === "all" || m === "none")
      edit([{ op: "set", path: ["addons"], value: m }]);
    else
      edit([
        {
          op: "set",
          path: ["addons"],
          value: [...on].filter((id) =>
            state.catalog.addons.some((a) => a.id === id),
          ),
        },
      ]);
  };
  const radios = h(
    "div",
    { class: "radios", role: "radiogroup", "aria-label": "Which mods" },
    (
      [
        [
          "default",
          state.defaults.addons
            ? `Default (setting: ${state.defaults.addons})`
            : "Default (every addon)",
        ],
        ["all", "Every addon"],
        ["none", "Only CC:Tweaked"],
        ["pick", "These:"],
      ] as const
    ).map(([m, label]) => {
      const input = h("input", {
        type: "radio",
        name: "addon-mode",
        value: m,
        checked: mode === m,
        "data-key": `addons:${m}`,
      });
      input.addEventListener("change", () => setMode(m));
      return h("label", { class: "radio" }, input, label);
    }),
  );
  const toggle = (id: string, want: boolean): void => {
    if (Array.isArray(spec)) {
      const k = spec.indexOf(id);
      if (want && k < 0) {
        const a = state.catalog.addons.find((x) => x.id === id);
        const ops: EditOp[] = [{ op: "push", path: ["addons"], value: id }];
        for (const need of a?.requires ?? [])
          if (!spec.includes(need))
            ops.push({ op: "push", path: ["addons"], value: need });
        edit(ops);
      } else if (!want && k >= 0) edit([{ op: "remove", path: ["addons", k] }]);
      return;
    }
    const next = [...on].filter(
      (x) => state.catalog.addons.some((a) => a.id === x) && x !== id,
    );
    if (want) next.push(id);
    edit([{ op: "set", path: ["addons"], value: next }]);
  };
  const list = h(
    "ul",
    { class: "addons", "aria-label": "Addons" },
    state.catalog.addons.map((a) => {
      const released = a.versions[mc] !== undefined;
      const box = h("input", {
        type: "checkbox",
        checked: on.has(a.id),
        "data-key": `addon:${a.id}`,
        disabled: !released && !on.has(a.id),
      });
      box.addEventListener("change", () => toggle(a.id, box.checked));
      return h(
        "li",
        {},
        h(
          "label",
          {
            class: `addon${on.has(a.id) ? " on" : ""}`,
            title: `${a.id}${a.types.length ? `: ${a.types.length} block types` : ""}${a.requires?.length ? `; needs ${a.requires.join(", ")}` : ""}`,
          },
          box,
          h(
            "span",
            { class: "grow" },
            a.name,
            released
              ? h("span", { class: "muted" }, ` ${a.versions[mc]}`)
              : h("span", { class: "muted" }, ` no release for ${mc}`),
          ),
          used.has(a.id)
            ? h(
                "span",
                { class: `badge ${on.has(a.id) ? "ok" : "err"}` },
                "used",
              )
            : null,
        ),
      );
    }),
  );
  const problems = problemsAt(["addons"]);
  return h(
    "div",
    {
      class: `field${spec !== undefined ? " is-set" : ""}${problems.length ? " has-problem" : ""}`,
    },
    h("div", { class: "field-label" }, "addons"),
    h(
      "div",
      { class: "field-desc" },
      "Mods besides CC:Tweaked. A block of an addon that is off stops the world at boot.",
    ),
    radios,
    state.catalog.addons.length
      ? list
      : h(
          "p",
          { class: "hint" },
          "This build has no addon list; edit addons in the text.",
        ),
    problems.length
      ? h(
          "ul",
          { class: "field-problems", role: "alert" },
          problems.map((p) => h("li", {}, `${p.path.join(".")}: ${p.message}`)),
        )
      : null,
  );
}

function neighbourInspector(): Node[] {
  const file = state.selected.slice("neighbour:".length);
  const n = state.neighbours.find((x) => x.file === file);
  if (!n) return computerInspector();
  const mine = neighbourOf(state.file, state.world!);
  const link = linkBetween(mine, n);
  const name = file.split(/[\\/]/).pop()!;
  const c = n.computer;
  return [
    h(
      "div",
      { class: "inspector-head" },
      icon(
        c.kind === "turtle"
          ? "turtle"
          : c.kind === "pocket"
            ? "pocket"
            : "computer",
        "big",
      ),
      h(
        "div",
        { class: "grow" },
        h("h2", {}, name),
        h(
          "div",
          { class: "muted" },
          `${computerTitle(c)} #${c.id} at ${c.x}, ${c.y}, ${c.z}`,
        ),
      ),
    ),
    h(
      "div",
      { class: "inspector-actions" },
      h(
        "button",
        {
          class: "primary small",
          "data-key": "nb:open",
          onclick: () => post({ type: "openFile", file: name }),
        },
        "Open in World Editor",
      ),
    ),
    h(
      "section",
      { class: "group" },
      h("h3", {}, "Network"),
      h(
        "p",
        {},
        link
          ? `This computer reaches it by ${link} modem.`
          : "Their modems do not reach each other: give both an ender modem, wireless modems within range, or wired modems on one network id.",
      ),
      h(
        "p",
        { class: "muted" },
        `Its modems: ${n.modems.length ? n.modems.join(", ") : "none"}${n.networks.length ? `; wired networks ${n.networks.join(", ")}` : ""}.`,
      ),
      c.id === computerOf(state.world!).id
        ? h(
            "p",
            { class: "warn" },
            "It has this computer's id: give each computer on a network its own computerId.",
          )
        : null,
    ),
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// The Add list

function openAdd(side?: Side): void {
  state.adding = { side, filter: "", active: 0 };
  pendingFocus = "add:search";
  render();
}

function matches(): TypeEntry[] {
  const f = state.adding!.filter.trim().toLowerCase();
  let list = types();
  if (state.adding?.side) list = list.filter((t) => t.target !== "player");
  if (!f) return list;
  return list.filter((t) =>
    `${t.label} ${t.type} ${t.group} ${t.description}`
      .toLowerCase()
      .includes(f),
  );
}

function addDialog(): HTMLElement {
  const a = state.adding!;
  const list = matches();
  const world = state.world!;
  const on = addonsOn(
    world,
    state.catalog,
    mcOf(world, state.defaults.mc),
    state.defaults.addons,
  );
  const custom =
    a.filter.trim() && !list.some((t) => t.type === a.filter.trim())
      ? a.filter.trim()
      : undefined;
  const entries: TypeEntry[] = custom
    ? [
        ...list,
        {
          label: `${custom} (a block of your own naming)`,
          type: custom,
          group: "Your own",
          description: "A generic block: give it size/items, tanks or energy.",
          target: "peripheral",
          preset: { size: 9 },
        },
      ]
    : list;
  a.active = Math.max(0, Math.min(a.active, entries.length - 1));
  const close = (): void => {
    state.adding = undefined;
    pendingFocus = a.side ? `tile:${a.side}` : "tb:add";
    render();
  };
  const search = h("input", {
    type: "search",
    placeholder:
      "Search 260+ block types: chest, modem, playerDetector, mekanism...",
    value: a.filter,
    "data-key": "add:search",
    "aria-label": "Search block types",
    "aria-controls": "add-list",
    "aria-activedescendant": entries.length ? `add-${a.active}` : undefined,
    role: "combobox",
    "aria-expanded": "true",
  });
  search.addEventListener("input", () => {
    a.filter = search.value;
    a.active = 0;
    render();
  });
  search.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      a.active = Math.max(
        0,
        Math.min(
          entries.length - 1,
          a.active + (e.key === "ArrowDown" ? 1 : -1),
        ),
      );
      render();
      document
        .getElementById(`add-${a.active}`)
        ?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = entries[a.active];
      if (pick) add(pick, a.side);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });
  let group = "";
  const items: HTMLElement[] = [];
  entries.forEach((t, k) => {
    if (t.group !== group) {
      group = t.group;
      const addonOff = t.addon && !on.has(t.addon);
      items.push(
        h(
          "li",
          { class: "group-head", role: "presentation" },
          group,
          addonOff
            ? h("span", { class: "badge off" }, "off in this world")
            : null,
        ),
      );
    }
    items.push(
      h(
        "li",
        {
          id: `add-${k}`,
          role: "option",
          class: `option${k === a.active ? " active" : ""}`,
          "aria-selected": k === a.active ? "true" : "false",
          onclick: () => add(t, a.side),
          onmousemove: () => {
            if (a.active !== k) {
              a.active = k;
              for (const el of Array.from(
                document.querySelectorAll(".option.active"),
              ))
                el.classList.remove("active");
              document.getElementById(`add-${k}`)?.classList.add("active");
            }
          },
        },
        t.target === "monitor"
          ? icon("monitor")
          : icon(
              iconKind(
                t.type,
                (t.preset?.["kind"] as string | undefined) ??
                  (t.type === "modem" ? "wireless" : undefined),
              ),
            ),
        h(
          "span",
          { class: "option-main" },
          h("span", { class: "option-label" }, t.label),
          t.description
            ? h("span", { class: "option-desc" }, firstSentence(t.description))
            : null,
        ),
      ),
    );
  });
  return h(
    "div",
    {
      class: "overlay",
      onclick: (e: Event) => {
        if (e.target === e.currentTarget) close();
      },
    },
    h(
      "div",
      {
        class: "dialog",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": a.side ? `Add on the ${a.side} side` : "Add a block",
        // Tab stays in the dialog: the search box and the close button
        onkeydown: (e: Event) => {
          const k = e as KeyboardEvent;
          if (k.key !== "Tab") return;
          const stops = Array.from(
            document.querySelectorAll<HTMLElement>(
              ".dialog input, .dialog button",
            ),
          );
          const i = stops.indexOf(document.activeElement as HTMLElement);
          k.preventDefault();
          stops[
            (i + (k.shiftKey ? -1 : 1) + stops.length) % stops.length
          ]?.focus();
        },
      },
      h(
        "div",
        { class: "dialog-head" },
        h(
          "h2",
          {},
          a.side
            ? `Put on the ${a.side} side`
            : "Add a block, monitor or player",
        ),
        h(
          "button",
          { class: "icon-button", "aria-label": "Close", onclick: close },
          "×",
        ),
      ),
      search,
      h(
        "ul",
        {
          id: "add-list",
          class: "options",
          role: "listbox",
          "aria-label": "Block types",
        },
        items.length ? items : h("li", { class: "hint" }, "Nothing matches."),
      ),
      h(
        "p",
        { class: "hint" },
        a.side
          ? "It goes on that side; whatever was there moves to the network."
          : "Monitors and modems take a free side; other blocks go on the network, named like minecraft:chest_0.",
      ),
    ),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Focus and scroll survive a redraw

interface Snapshot {
  key?: string;
  start?: number | null;
  end?: number | null;
  value?: string;
  dirty?: boolean;
  scroll: Record<string, number>;
}

function snapshotFocus(): Snapshot {
  const el = document.activeElement as HTMLElement | null;
  const scroll: Record<string, number> = {};
  for (const sel of [".scene", ".inspector", ".options"]) {
    const s = document.querySelector(sel);
    if (s) scroll[sel] = s.scrollTop;
  }
  const key = el?.getAttribute?.("data-key") ?? undefined;
  const out: Snapshot = { key, scroll };
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    try {
      out.start = el.selectionStart;
      out.end = el.selectionEnd;
    } catch {
      // number inputs have no selection
    }
    out.value = el.value;
    out.dirty = el.value !== el.defaultValue && el.type !== "search";
  }
  return out;
}

function restoreFocus(s: Snapshot): void {
  for (const [sel, top] of Object.entries(s.scroll)) {
    const el = document.querySelector(sel);
    if (el) el.scrollTop = top;
  }
  const want = pendingFocus ?? s.key;
  pendingFocus = undefined;
  if (!want) return;
  const el = Array.from(
    document.querySelectorAll<HTMLElement>("[data-key]"),
  ).find((e) => e.getAttribute("data-key") === want);
  if (!el) return;
  el.focus({ preventScroll: want !== s.key });
  if (want !== s.key) el.scrollIntoView({ block: "nearest" });
  if (
    want === s.key &&
    (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
  ) {
    if (s.dirty && s.value !== undefined) el.value = s.value;
    try {
      if (s.start != null) el.setSelectionRange(s.start, s.end ?? s.start);
    } catch {
      // number inputs
    }
  }
}

document.addEventListener("keydown", (e) => {
  const target = e.target as HTMLElement;
  const typing =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement;
  if (
    !typing &&
    !state.adding &&
    (e.key === "a" || e.key === "A") &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey &&
    state.world
  ) {
    e.preventDefault();
    openAdd();
  } else if (e.key === "Escape" && state.adding) {
    state.adding = undefined;
    render();
  }
});

post({ type: "ready" });
