// The mod peripherals, written from what the emulator answered (data/emulator-peripherals.json, made by
// probe-emulator.mjs): each method's arguments and the shape of what it returned. Parameter names come from the
// emulator's own Lua source, where it has them.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const CCSIM = "rom-overlay/rom/ccsim";

/** One file per addon (packages/runner/src/addons.ts): the namespace of its classes and where its Lua lives. */
export const ADDONS = {
  "advanced-peripherals": {
    ns: "ap",
    title: "Advanced Peripherals",
    file: "advanced-peripherals",
    sources: [`${CCSIM}/ap`],
    docs: "docs/advanced-peripherals.md",
  },
  mekanism: {
    ns: "mekanism",
    title: "Mekanism",
    file: "mekanism",
    sources: [`${CCSIM}/mek`, `${CCSIM}/addons/mekanism-machines`],
    docs: "docs/mekanism-qio.md, docs/mekanism-multiblocks.md",
  },
  "mekanism-generators": {
    ns: "mekanism",
    title: "Mekanism Generators",
    file: "mekanism-generators",
    sources: [
      `${CCSIM}/addons/mekanism-generators`,
      `${CCSIM}/addons/mekanism-machines`,
      `${CCSIM}/mek`,
    ],
    docs: "docs/mekanism-multiblocks.md",
  },
  create: {
    ns: "create",
    title: "Create",
    file: "create",
    sources: [`${CCSIM}/addons/create`],
    docs: "docs/create.md",
  },
  "create-additions": {
    ns: "createAdditions",
    title: "Create Crafts & Additions",
    file: "create-additions",
    sources: [`${CCSIM}/addons/create-additions`],
    docs: "docs/create-additions.md",
  },
  "toms-peripherals": {
    ns: "toms",
    title: "Tom's Peripherals",
    file: "toms-peripherals",
    sources: [`${CCSIM}/addons/toms-peripherals`],
    docs: "docs/toms-peripherals.md",
  },
  "bigger-reactors": {
    ns: "biggerReactors",
    title: "Bigger Reactors",
    file: "bigger-reactors",
    sources: [`${CCSIM}/addons/bigger-reactors`],
    docs: "docs/bigger-reactors.md",
  },
  "extreme-reactors": {
    ns: "extremeReactors",
    title: "Extreme Reactors",
    file: "extreme-reactors",
    sources: [`${CCSIM}/addons/extreme-reactors`],
    docs: "docs/extreme-reactors.md",
  },
};

/**
 * ADDONS, plus a file for every other addon the probe found peripherals of: its name from packages/runner/src/addons.ts,
 * its Lua in rom-overlay/rom/ccsim/addons/<id>, its classes under a camelCase namespace of the id.
 */
function allAddons(peripherals, repo) {
  const all = { ...ADDONS };
  const registry = readFileSync(
    join(repo, "packages", "runner", "src", "addons.ts"),
    "utf8",
  );
  const ids = [...new Set(Object.values(peripherals).map((p) => p.addon))];
  for (const id of ids.filter((i) => i && !all[i]).sort()) {
    const named = new RegExp(
      `id: "${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}",\\s*name: "([^"]+)"`,
    ).exec(registry);
    const ns = id
      .replace(/[^A-Za-z0-9]+(.)/g, (_, c) => c.toUpperCase())
      .replace(/^[0-9]/, (d) => `_${d}`);
    all[id] = {
      ns,
      title: named ? named[1] : id,
      file: id,
      sources: [`${CCSIM}/addons/${id}`],
      docs: `docs/${id}.md`,
    };
  }
  return all;
}

/** CC:Tweaked's generic peripherals a mod block can also be, and the methods they bring (library/peripherals.lua). */
const GENERIC = {
  inventory: {
    type: "cc.Inventory",
    methods: [
      "size",
      "list",
      "getItemDetail",
      "getItemLimit",
      "pushItems",
      "pullItems",
    ],
  },
  fluid_storage: {
    type: "cc.FluidStorage",
    methods: ["tanks", "pushFluid", "pullFluid"],
  },
  energy_storage: {
    type: "cc.EnergyStorage",
    methods: ["getEnergy", "getEnergyCapacity"],
  },
};

/** CC:Tweaked's own peripheral types, for peripheral.find (library/peripherals.lua has the classes). */
export const CORE_TYPES = {
  monitor: "cc.Monitor",
  speaker: "cc.Speaker",
  modem: "cc.Modem",
  printer: "cc.Printer",
  drive: "cc.Drive",
  command: "cc.CommandBlock",
  computer: "cc.Computer",
  turtle: "cc.Computer",
  workbench: "cc.Workbench",
  inventory: "cc.Inventory",
  fluid_storage: "cc.FluidStorage",
  energy_storage: "cc.EnergyStorage",
  redstone_relay: "cc.RedstoneRelay",
};

const JAVA_TYPES = {
  int: "integer",
  long: "integer",
  double: "number",
  float: "number",
  String: "string",
  boolean: "boolean",
  FloatingLong: "number",
  ResourceLocation: "string",
  Item: "string",
  number: "number",
  string: "string",
  table: "table",
  function: "function",
  any: "any",
  integer: "integer",
  image: "any",
};

/**
 * Parameter names where the emulator's source has none to read (methods built in a loop, or taking `...`). Types
 * still come from the probe. Keyed by peripheral type, then method.
 */
const AR_SHAPES = {
  horizontalLine: ["minX", "maxX", "y", "color"],
  verticalLine: ["x", "minY", "maxY", "color"],
  fill: ["minX", "minY", "maxX", "maxY", "color"],
  fillGradient: ["minX", "minY", "maxX", "maxY", "colorFrom", "colorTo"],
  drawCircle: ["x", "y", "radius", "color"],
  fillCircle: ["x", "y", "radius", "color"],
  drawString: ["text", "x", "y", "color"],
  drawCenteredString: ["text", "x", "y", "color"],
  drawRightboundString: ["text", "x", "y", "color"],
};
const rod = {
  getControlRodLevel: ["index"],
  getControlRodLocation: ["index"],
  getControlRodName: ["index"],
  setActive: ["active"],
  setAllControlRodLevels: ["level"],
  setControlRodLevel: ["index", "level"],
  setControlRodName: ["index", "name"],
  setControlRodsLevels: ["levels"],
};
const turbine = {
  setActive: ["active"],
  setFluidFlowRateMax: ["rate"],
  setInductorEngaged: ["engaged"],
};
const PARAM_NAMES = {
  arController: Object.fromEntries(
    Object.entries(AR_SHAPES).flatMap(([name, args]) => [
      [name, args],
      [`${name}WithId`, ["id", ...args]],
    ]),
  ),
  inventoryManager: {
    listChest: ["direction"],
    pullItems: ["direction", "count"],
    pushItems: ["direction", "count"],
    addItemToPlayer: ["direction", "count"],
    addItemToPlayerNBT: ["direction", "count"],
    removeItemFromPlayer: ["direction", "count"],
    removeItemFromPlayerNBT: ["direction", "count"],
  },
  meBridge: { craftItem: ["item"], craftFluid: ["fluid"] },
  rsBridge: { craftItem: ["item"], craftFluid: ["fluid"] },
  redstoneIntegrator: {
    getAnalogueInput: ["side"],
    getAnalogueOutput: ["side"],
    setAnalogueOutput: ["side", "power"],
  },
  Create_SequencedGearshift: { move: ["distance"], rotate: ["angle"] },
  Create_Station: { setSchedule: ["schedule"] },
  "BigReactors-Reactor": rod,
  "BigReactors-Turbine": turbine,
  BiggerReactors_Turbine: turbine,
  electrolyticSeparator: {
    setLeftOutputDumpingMode: ["mode"],
    setRightOutputDumpingMode: ["mode"],
  },
  formulaicAssemblicator: {
    getCraftingInputSlot: ["slot"],
    getCraftingOutputSlot: ["slot"],
  },
  tm_keyboard: { setFireNativeEvents: ["enabled"] },
  tm_rsPort: { setOutput: ["direction", "value"] },
};

const TIERS = ["basic", "advanced", "elite", "ultimate", "creative"];
const KEYWORDS = new Set(
  "and break do else elseif end false for function goto if in local nil not or repeat return then true until while".split(
    " ",
  ),
);
const isName = (s) => /^[A-Za-z_]\w*$/.test(s) && !KEYWORDS.has(s);
// a Lua name cannot start with a digit: SwitchCraft's "3d_printer" becomes _3dPrinter
const pascal = (s) =>
  s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("")
    .replace(/^[0-9]/, (d) => `_${d}`);

function luaFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) luaFiles(full, out);
    else if (name.endsWith(".lua") && name !== "fonts.lua") out.push(full);
  }
  return out;
}

const splitArgs = (s) =>
  s
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);

/** Argument names of every function a source folder defines by a method's name: name -> [{ args, java? }]. */
function harvest(dirs, repo) {
  const found = Object.create(null);
  const add = (name, entry) => (found[name] ??= []).push(entry);
  for (const dir of dirs) {
    for (const file of luaFiles(join(repo, dir))) {
      const text = readFileSync(file, "utf8");
      // Mekanism's way: name = { { "int", "String" }, function(c, a, b) ... or name = E.void({ ... }, function(c, a)
      for (const m of text.matchAll(
        /([A-Za-z_]\w*)\s*=\s*(?:[\w.]+\(\s*)?\{?\s*\{([^{}]*)\}\s*,\s*function\s*\(([^)]*)\)/g,
      )) {
        const types = [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
        add(m[1], { args: splitArgs(m[3]).slice(1), java: types });
      }
      for (const m of text.matchAll(
        /function\s+[\w.]+\.([A-Za-z_]\w*)\s*\(([^)]*)\)/g,
      ))
        add(m[1], { args: splitArgs(m[2]) });
      for (const m of text.matchAll(
        /([A-Za-z_]\w*)\s*=\s*(?:[\w.]+\(\s*)?function\s*\(([^)]*)\)/g,
      ))
        add(m[1], { args: splitArgs(m[2]) });
      for (const m of text.matchAll(
        /([A-Za-z_]\w*)\s*=\s*\{\s*fn\s*=\s*function\s*\(([^)]*)\)/g,
      ))
        add(m[1], { args: splitArgs(m[2]) });
    }
  }
  return found;
}

/** Mekanism's enums (mek/java.lua): name -> values. */
function mekanismEnums(repo) {
  const file = join(repo, CCSIM, "mek", "java.lua");
  if (!existsSync(file)) return {};
  const text = readFileSync(file, "utf8");
  const at = text.indexOf("local ENUMS = {");
  if (at < 0) return {};
  const block = text.slice(at, text.indexOf("\n  }", at));
  const enums = {};
  for (const m of block.matchAll(
    /(\w+)\s*=\s*\{((?:\s*"[A-Z0-9_]+",?)+)\s*\}/g,
  )) {
    enums[m[1]] = [...m[2].matchAll(/"([A-Z0-9_]+)"/g)].map((x) => x[1]);
  }
  return enums;
}

export function writeMods(peripherals, repo, warn) {
  const enums = mekanismEnums(repo);
  const usedEnums = new Set();
  const counts = { types: 0, classes: 0, methods: 0 };
  const findOverloads = [];
  const files = {};

  for (const [addonId, addon] of Object.entries(allAddons(peripherals, repo))) {
    const mine = Object.entries(peripherals).filter(
      ([, p]) => p.addon === addonId,
    );
    if (mine.length === 0) {
      warn(`no peripherals probed for ${addonId}`);
      continue;
    }
    const names = harvest(addon.sources, repo);
    const records = new Map(); // structural key -> class name
    const recordLines = [];

    const fieldName = (k) => (isName(k) ? k : `["${k}"]`);

    function shapeType(shape, owner, hint) {
      if (!shape) return "any";
      const parts = [];
      let nil = false;
      for (const p of shape.prims) {
        if (p === "nil") nil = true;
        else if (p === "integer") parts.push("number");
        else if (!parts.includes(p)) parts.push(p);
      }
      if (shape.fields) {
        const keys = Object.keys(shape.fields).sort();
        // keys that are not names (item ids, coordinates) are data: a map
        const odd = keys.filter((k) => !/^[A-Za-z_]\w*$/.test(k)).length;
        if (shape.array || odd * 2 > keys.length) {
          const inner = { prims: [], seen: 0 };
          for (const k of keys) mergeShape(inner, shape.fields[k]);
          if (shape.array) mergeShape(inner, shape.array);
          parts.push(
            `table<${shape.array ? "string|integer" : "string"}, ${shapeType(inner, owner, hint)}>`,
          );
        } else {
          const fields = keys.map((k) => {
            const f = shape.fields[k];
            const optional = f.seen < shape.records || f.prims.includes("nil");
            const t = shapeType(
              { ...f, prims: f.prims.filter((p) => p !== "nil") },
              owner,
              hint + pascal(k),
            );
            return { k, optional, t: t.replace(/\?$/, "") };
          });
          const simple =
            fields.length <= 4 &&
            fields.every((f) => !f.t.includes("{") && f.t.length < 30);
          if (simple)
            parts.push(
              `{ ${fields.map((f) => `${fieldName(f.k)}${f.optional ? "?" : ""}: ${f.t}`).join(", ")} }`,
            );
          else {
            const key = fields
              .map((f) => `${f.k}${f.optional ? "?" : ""}:${f.t}`)
              .join(";");
            let name = records.get(key);
            if (!name) {
              name = `${owner}.${hint}`;
              let n = 2;
              while ([...records.values()].includes(name))
                name = `${owner}.${hint}${n++}`;
              records.set(key, name);
              recordLines.push(
                [
                  `---@class ${name}`,
                  ...fields.map(
                    (f) =>
                      `---@field ${fieldName(f.k)}${f.optional ? "?" : ""} ${f.t}`,
                  ),
                ].join("\n"),
              );
            }
            parts.push(name);
          }
        }
      } else if (shape.array) {
        // one of a list: Filters -> Filter, Entities -> Entity
        const one = hint.replace(/ies$/, "y").replace(/([^s])s$/, "$1");
        const inner = shapeType(
          shape.array,
          owner,
          one === hint ? `${hint}Entry` : one,
        );
        parts.push(
          /[|? ]/.test(inner) &&
            !inner.startsWith("{") &&
            !inner.startsWith("table<")
            ? `(${inner})[]`
            : `${inner}[]`,
        );
      } else if (shape.empty) parts.push("table");
      if (parts.length === 0) return nil ? "nil" : "any";
      const type = parts.join("|");
      return nil
        ? parts.length === 1 && !type.startsWith("{")
          ? `${type}?`
          : `${type}|nil`
        : type;
    }

    function paramType(p) {
      const raw = p.type ?? "any";
      if (enums[raw]) {
        usedEnums.add(raw);
        return `mekanism.${raw}`;
      }
      const types = raw
        .split("|")
        .map((t) => JAVA_TYPES[t] ?? JAVA_TYPES[t.toLowerCase()]);
      if (types.some((t) => !t)) return "any";
      return [...new Set(types)].join("|");
    }

    function signature(method, m, type) {
      const forced = PARAM_NAMES[type]?.[method];
      let params = (Array.isArray(m.params) ? m.params : []).map((p) =>
        typeof p === "string" ? { type: p } : { ...p },
      );
      const candidates = (names[method] ?? []).map((c) => ({
        ...c,
        args: c.args.filter(
          (a, i) => !(i === 0 && (a === "self" || a === "_")),
        ),
      }));
      const java = params.some((p) => p.java);
      let pick;
      if (
        java ||
        candidates.some(
          (c) => c.java && c.java.length === params.length && params.length > 0,
        )
      ) {
        pick = candidates.find(
          (c) => c.java && c.java.length === params.length,
        );
        // the source says the Java type of every parameter, the probe only of those it got past
        if (pick)
          params = params.map((p, i) =>
            p.type === "any" || !p.type ? { ...p, type: pick.java[i] } : p,
          );
      } else {
        pick = candidates
          .filter((c) => !c.java && c.args.length >= params.length)
          .sort((a, b) => b.args.length - a.args.length)[0];
      }
      const out = [];
      const used = new Set();
      const unique = (name) => {
        let n = isName(name) ? name : "arg";
        while (used.has(n)) n += "_";
        used.add(n);
        return n;
      };
      params.forEach((p, i) => {
        if (p.vararg) return out.push({ name: "...", type: paramType(p) });
        const fromSource =
          pick?.args[i] && pick.args[i] !== "..." ? pick.args[i] : undefined;
        out.push({
          name: unique(forced?.[i] ?? p.name ?? fromSource ?? `arg${i + 1}`),
          type: paramType(p),
          opt: !!p.opt,
        });
      });
      // arguments the source takes that the probe never needed: optional
      if (pick && !pick.java) {
        for (let i = params.length; i < pick.args.length; i++) {
          if (pick.args[i] === "...") out.push({ name: "...", type: "any" });
          else out.push({ name: unique(pick.args[i]), type: "any", opt: true });
        }
      }
      const called = m.counts && m.counts.length > 0;
      // a call that never went through and no source to read: accept anything
      if (!called && !pick && params.length === 0)
        out.push({ name: "...", type: "any" });
      return out;
    }

    function renderMethod(local, owner, method, m, type) {
      const lines = [];
      const params = signature(method, m, type);
      for (const p of params) {
        lines.push(
          p.name === "..."
            ? `---@param ... ${p.type}`
            : `---@param ${p.name}${p.opt ? "?" : ""} ${p.type}`,
        );
      }
      const called = m.counts && m.counts.length > 0;
      if (!called) lines.push("---@return any ...");
      else {
        const least = Math.min(...m.counts);
        m.returns.forEach((shape, i) => {
          let t = shapeType(
            shape,
            owner,
            pascal(method.replace(/^(get|list)/, "")) || pascal(method),
          );
          if (
            i >= least &&
            t !== "any" &&
            t !== "nil" &&
            !t.endsWith("?") &&
            !t.endsWith("|nil")
          )
            t = /[|{ ]/.test(t) ? `${t}|nil` : `${t}?`;
          lines.push(`---@return ${t}`);
        });
      }
      lines.push(
        `function ${local}.${method}(${params.map((p) => p.name).join(", ")}) end`,
      );
      return lines.join("\n");
    }

    // classes: one per distinct set of rendered methods; tiers of one block share a class
    const rendered = [];
    for (const [type, p] of mine) {
      const stripped = type.replace(
        /^(Create_|BiggerReactors_|BigReactors-|tm_)/,
        "",
      );
      const tier = TIERS.find(
        (t) => stripped.startsWith(t) && /[A-Z]/.test(stripped[t.length] ?? ""),
      );
      const baseName = pascal(tier ? stripped.slice(tier.length) : stripped);
      rendered.push({ type, p, tier, baseName });
    }
    // render each base name once (from its first type), compare the rest by their method lists and shapes
    const classes = new Map(); // body -> { className, types }
    const order = [];
    const classBlocks = [];
    for (const item of rendered) {
      const className = `${addon.ns}.${item.baseName}`;
      const parents = item.p.types.slice(1).filter((t) => GENERIC[t]);
      const skip = new Set(parents.flatMap((t) => GENERIC[t].methods));
      const methods = Object.keys(item.p.methods)
        .filter((m) => !skip.has(m) && isName(m))
        .sort();
      const body = methods
        .map((m) =>
          renderMethod("P", className, m, item.p.methods[m], item.type),
        )
        .join("\n\n");
      const key = `${parents.join(",")}\n${body}`;
      const same = classes.get(key);
      if (same) {
        same.types.push(item.type);
        if (same.className !== className && !same.aliases.includes(className))
          same.aliases.push(className);
        continue;
      }
      let name = className;
      let n = 2;
      while (order.some((c) => c.className === name))
        name = `${className}${n++}`;
      const entry = {
        className: name,
        types: [item.type],
        aliases: [],
        parents,
        body,
        methods: methods.length,
      };
      classes.set(key, entry);
      order.push(entry);
    }
    for (const c of order) {
      const local = c.className.split(".").pop();
      const parents = c.parents.map((t) => GENERIC[t].type);
      const lines = [
        `---${addon.title}: ${c.types.map((t) => `\`${t}\``).join(", ")}, as craftos-mcp emulates ${c.types.length > 1 ? "them" : "it"}.`,
        `---@class ${c.className}${parents.length ? ": " + parents.join(", ") : ""}`,
        `local ${local} = {}`,
        "",
        c.body.replace(/^function P\./gm, `function ${local}.`),
      ];
      for (const alias of c.aliases)
        lines.push("", `---@class ${alias}: ${c.className}`);
      classBlocks.push(lines.join("\n"));
      // and the names a later Minecraft version reports for the same blocks (data `renamed`, from byVersion)
      const later = c.types.flatMap((t) =>
        Object.values(peripherals[t]?.renamed ?? {}),
      );
      findOverloads.push({
        types: [...new Set([...c.types, ...later])],
        type: c.className,
      });
      counts.classes++;
      counts.methods += c.methods;
      counts.types += c.types.length;
    }

    const out = [
      "---@meta",
      "",
      `-- Generated by packages/cc-types/scripts/generate.mjs from data/emulator-peripherals.json: what the craftos-mcp`,
      `-- emulator answered when every method of every ${addon.title} peripheral was called (${addon.docs}).`,
      "-- Do not edit: run probe-emulator.mjs and generate.mjs again.",
      "",
    ];
    if (recordLines.length) out.push(recordLines.join("\n\n"), "");
    out.push(classBlocks.join("\n\n"), "");
    files[`${addon.file}.lua`] = out.join("\n");
  }

  if (usedEnums.size) {
    const lines = [
      "---@meta",
      "",
      "-- Generated by packages/cc-types/scripts/generate.mjs from the emulator's Mekanism enums. Do not edit.",
      "",
    ];
    for (const name of [...usedEnums].sort()) {
      lines.push(
        `---Mekanism's ${name}: a name in any case, or its position counted from 0.`,
        `---@alias mekanism.${name} ${enums[name].map((v) => `"${v}"`).join("|")}|string|integer`,
        "",
      );
    }
    files["mekanism-enums.lua"] = lines.join("\n");
  }
  return { files, counts, findOverloads };
}

function mergeShape(into, from) {
  if (!from) return into;
  into.seen += from.seen ?? 1;
  for (const p of from.prims ?? [])
    if (!into.prims.includes(p)) into.prims.push(p);
  if (from.empty) into.empty = true;
  if (from.array)
    into.array = mergeShape(into.array ?? { prims: [], seen: 0 }, from.array);
  if (from.fields) {
    into.fields ??= {};
    into.records = (into.records ?? 0) + (from.records ?? 1);
    for (const [k, v] of Object.entries(from.fields))
      into.fields[k] = mergeShape(into.fields[k] ?? { prims: [], seen: 0 }, v);
  }
  return into;
}
