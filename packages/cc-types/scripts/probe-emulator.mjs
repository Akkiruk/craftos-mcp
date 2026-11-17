// Ask the emulator itself what it has: every global and cc.* module of both CC:Tweaked versions, and every method of
// every peripheral it can build, with the arguments each one asks for and the shape of what it returns.
//
//   npm run build && node packages/cc-types/scripts/probe-emulator.mjs
//
// Needs the engine (engine/build, or CRAFTOS_ENGINE) and both ROMs (rom/cc-1.101.3, rom/cc-1.121.0). Writes
// packages/cc-types/data/emulator-globals.json and emulator-peripherals.json, which generate.mjs and check.mjs read,
// so neither of them needs the engine.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const DATA = join(HERE, "..", "data");
const { ADDONS, loadConfig, runProgram } = await import(
  new URL("../../runner/dist/index.js", import.meta.url).href
);

/** The demo worlds have each block set up with something in it, so getters answer with real values. */
const DEMO_WORLDS = [
  "advanced-peripherals-demo",
  "ap-extra-demo",
  "generic-storage-demo",
  "mekanism-qio-demo",
  "mekanism-multiblocks-demo",
  "create-demo",
  "bigger-reactors-demo",
  "extreme-reactors-demo",
  "toms-peripherals-demo",
];

const workspace = mkdtempSync(join(tmpdir(), "cc-types-probe-"));
copyFileSync(join(HERE, "probe.lua"), join(workspace, "probe.lua"));
process.env.CRAFTOS_WORKSPACE = workspace;
const config = loadConfig();

function findFile(dir, name) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === name) return full;
    if (statSync(full).isDirectory()) {
      const hit = findFile(full, name);
      if (hit) return hit;
    }
  }
  return undefined;
}

async function probe(label, world, timeoutMs = 600_000) {
  const result = await runProgram(config, {
    program: "probe.lua",
    world: {
      ...world,
    },
    monitors: [{ name: "monitor_0", width: 2, height: 2 }],
    timeoutMs,
    timeScale: 50,
    keepRuntime: true,
  });
  const file =
    result.runtimeDir && findFile(result.runtimeDir, "probe-out.jsonl");
  const screen = result.screens?.[0]?.lines?.filter((l) => l.trim()).join("\n");
  // a block the sim refuses stops ccsim before any peripheral is attached, though the program still completes
  const refused = /ccsim failed to start/.test(screen ?? "");
  if (result.status !== "completed" || !file || refused) {
    const error = new Error(
      `${label}: ${refused ? "ccsim failed to start" : result.status}\n${screen ?? ""}\n${result.stderr ?? ""}`,
    );
    error.screen = screen ?? "";
    throw error;
  }
  const lines = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  rmSync(result.runtimeDir, { recursive: true, force: true });
  console.log(
    `${label}: ${lines.filter((l) => l.kind === "peripheral").length} peripherals`,
  );
  return lines;
}

// ===== shapes: what one value looked like, merged over every time it was seen =====

function emptyShape() {
  return { prims: [], seen: 0 };
}

function merge(into, raw) {
  into.seen++;
  if (typeof raw === "string") {
    if (raw === "integer" && into.prims.includes("number")) return into;
    if (raw === "number")
      into.prims = into.prims.filter((p) => p !== "integer");
    if (!into.prims.includes(raw)) into.prims.push(raw);
    return into;
  }
  if (raw.empty) {
    into.empty = true;
    return into;
  }
  if (raw.array) {
    into.array ??= emptyShape();
    for (const item of arr(raw.array)) merge(into.array, item);
    return into;
  }
  if (raw.fields) {
    into.fields ??= {};
    into.records = (into.records ?? 0) + 1;
    for (const [key, value] of Object.entries(raw.fields))
      merge((into.fields[key] ??= emptyShape()), value);
    return into;
  }
  return into;
}

// an empty Lua table comes out of serialiseJSON as {}
const arr = (x) => (Array.isArray(x) ? x : []);
const sortKeys = (o) =>
  Object.fromEntries(
    Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );

// ===== run =====

const globals = {};
const modules = {};
const peripherals = {};

/** withPeripherals: keep its peripherals; else it is a plain computer (no mods), whose globals and modules count. */
function take(lines, mc, withPeripherals) {
  for (const line of lines) {
    // the library types CC:Tweaked itself: a mod's own globals (Advanced Math's matrix, CIDE's cide_dbg) stay out
    if (line.kind === "globals" && !withPeripherals)
      globals[mc] = {
        host: line.host,
        version: line.version,
        globals: sortKeys(line.globals),
      };
    if (line.kind === "module" && !withPeripherals)
      (modules[mc] ??= {})[line.name] = sortKeys(line.fields);
    if (line.kind !== "peripheral" || !withPeripherals) continue;
    // A bare block is named "<world type>_9". When the type it reports belongs to another addon (Finer Peripherals'
    // chat box says "chatBox", as Advanced Peripherals' does), it is kept under its own world type, so the two mods'
    // methods stay apart.
    const addonOf = (t) => ADDONS.find((a) => a.types.includes(t))?.id;
    const worldType =
      typeof line.name === "string" && line.name.endsWith("_9")
        ? line.name.slice(0, -2)
        : undefined;
    const type =
      worldType &&
      addonOf(worldType) &&
      addonOf(worldType) !== addonOf(line.types[0])
        ? worldType
        : line.types[0];
    const p = (peripherals[type] ??= {
      // the addon it belongs to (packages/runner/src/addons.ts); none for CC:Tweaked's own and plain blocks
      addon: addonOf(type),
      types: line.types,
      order: arr(line.order),
      methods: {},
    });
    for (const [name, found] of Object.entries(line.methods)) {
      const m = (p.methods[name] ??= { params: [], returns: [], counts: [] });
      const known = (list) =>
        list.length * 100 + list.filter((p) => p.type !== "any").length;
      if (known(arr(found.params)) > known(m.params)) m.params = found.params;
      for (const call of arr(found.calls)) {
        if (!m.counts.includes(call.count)) m.counts.push(call.count);
        arr(call.returns).forEach((r, i) =>
          merge((m.returns[i] ??= emptyShape()), r),
        );
      }
      if (arr(found.calls).length === 0 && found.error && !m.error)
        m.error = found.error;
      if (found.timeout) m.timeout = true;
      if (found.skipped) m.skipped = true;
    }
  }
}

for (const name of DEMO_WORLDS) {
  const world = JSON.parse(
    readFileSync(join(REPO, "worlds", `${name}.json`), "utf8"),
  );
  take(await probe(name, world), "1.18.2", true);
}

// every type no demo world has, as a bare block, and the blocks of CC:Tweaked itself
const bare = [
  { name: "back", type: "modem" },
  { name: "top", type: "modem", kind: "wired" },
  { name: "computer_7", type: "computer", id: 7 },
  {
    name: "minecraft:chest_0",
    type: "minecraft:chest",
    size: 27,
    items: { 1: { name: "minecraft:stone", count: 3 } },
  },
  { name: "energy_0", type: "energy_storage", energy: 10, energyCapacity: 100 },
  {
    name: "tank_0",
    type: "fluid_storage",
    tanks: [{ name: "minecraft:water", amount: 1000, capacity: 4000 }],
  },
];
/** The least a block needs before the sim builds it at all (an empty Plethora interface is no peripheral). */
const BARE_FIXTURES = {
  neuralInterface: {
    owner: "Steve",
    modules: [
      "plethora:scanner",
      "plethora:sensor",
      "plethora:introspection",
      "plethora:glasses",
      "plethora:laser",
    ],
  },
  manipulator: {
    mark: 2,
    modules: [
      "plethora:scanner",
      "plethora:sensor",
      "plethora:introspection",
      "plethora:glasses",
      "plethora:laser",
    ],
  },
};
// a mod with no 1.18.2 release is probed on the oldest version it has
const probeVersion = (a) =>
  a.versions["1.18.2"] ? "1.18.2" : Object.keys(a.versions).sort()[0];
const all = ADDONS.filter((a) => probeVersion(a) === "1.18.2").flatMap(
  (a) => a.types,
);
for (const type of all)
  if (!peripherals[type])
    bare.push({ name: `${type}_9`, type, ...BARE_FIXTURES[type] });
// a bare block of every type too: an empty machine answers differently (nil where a demo one has a value)
const everything = [
  ...bare,
  ...all
    .filter((t) => !bare.some((b) => b.type === t))
    .map((type) => ({ name: `${type}_9`, type, ...BARE_FIXTURES[type] })),
];
/**
 * probe, dropping a block the sim refuses to build bare (it names it, as "(name_9)") and trying again without it,
 * so one block that needs fields of its own does not cost every other type its probe.
 */
async function probeBare(label, world, dropped = [], timeoutMs = undefined) {
  let list = world.peripherals;
  for (;;) {
    try {
      return await probe(label, { ...world, peripherals: list }, timeoutMs);
    } catch (error) {
      // the message names the block ("(name_9)") or, for a block the mod version lacks, its type
      const screen = (error.screen ?? "").replace(/\s+/g, " ");
      const byName = list.find((p) => screen.includes(`(${p.name})`));
      const byType = list
        .filter((p) =>
          new RegExp(
            `(^|[^\\w:])${p.type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w:]|$)`,
          ).test(screen),
        )
        .sort((a, b) => b.type.length - a.type.length)[0];
      const bad = byName ?? byType;
      if (!bad) throw error;
      console.warn(
        `${label}: ${bad.name} cannot be built here, probed without it`,
      );
      dropped.push(bad);
      list = list.filter((p) => p !== bad);
    }
  }
}
const notOn1182 = [];
take(
  await probeBare("bare blocks", { peripherals: everything }, notOn1182),
  "1.18.2",
  true,
);
// The mods with no 1.18.2 release, one world each on the oldest version they have (and a block its mod's 1.18.2
// version lacks, such as Ducky's sculkophone, on 1.20.1), a few at a time. Each is on its own so one block that
// hangs costs only its own mod's types; it is named and the rest go on.
const jobs = [];
const seen = new Set(Object.keys(peripherals));
for (const a of ADDONS) {
  const mc = probeVersion(a);
  const list = (
    mc === "1.18.2"
      ? notOn1182
      : a.types.map((type) => ({
          name: `${type}_9`,
          type,
          ...BARE_FIXTURES[type],
        }))
  ).filter((p) => a.types.includes(p.type) && !seen.has(p.type));
  list.forEach((p) => seen.add(p.type));
  if (list.length)
    jobs.push({
      label: `${a.id} on ${mc === "1.18.2" ? "1.20.1" : mc}`,
      mc: mc === "1.18.2" ? "1.20.1" : mc,
      list,
    });
}
const failed = [];
const running = new Set();
for (const job of jobs) {
  const run = probeBare(
    job.label,
    { version: job.mc, peripherals: job.list },
    [],
    120_000,
  )
    .then((lines) => take(lines, job.mc, true))
    .catch((error) => {
      failed.push(job.label);
      console.warn(
        `${job.label}: ${error.message.split("\n")[0]}; its types are left out`,
      );
    })
    .finally(() => running.delete(run));
  running.add(run);
  if (running.size >= 4) await Promise.race(running);
}
await Promise.all(running);
if (failed.length) console.warn(`not probed: ${failed.join(", ")}`);
take(
  await probe("1.18.2 globals", { version: "1.18.2", addons: "none" }),
  "1.18.2",
  false,
);
take(
  await probe("1.20.1 globals", { version: "1.20.1", addons: "none" }),
  "1.20.1",
  false,
);

mkdirSync(DATA, { recursive: true });
writeFileSync(
  join(DATA, "emulator-globals.json"),
  JSON.stringify({ globals, modules }, null, 1) + "\n",
);
const lines = Object.keys(peripherals)
  .sort()
  .map(
    (type) =>
      `${JSON.stringify(type)}: ${JSON.stringify({ ...peripherals[type], methods: sortKeys(peripherals[type].methods) })}`,
  );
writeFileSync(
  join(DATA, "emulator-peripherals.json"),
  `{\n${lines.join(",\n")}\n}\n`,
);
rmSync(workspace, { recursive: true, force: true });
console.log(
  `${Object.keys(peripherals).length} peripheral types written to ${DATA}`,
);
