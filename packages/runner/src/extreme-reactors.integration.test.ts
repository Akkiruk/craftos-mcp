import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  type SimCommand,
  type SimState,
  type TestRunResult,
  type WorldConfig,
  checkConfig,
  loadConfig,
  loadNamedWorld,
  runTests,
  sendAndWait,
  SessionManager,
  worldJson,
} from "./index.js";

/**
 * Extreme Reactors 2 (1.18.2-2.0.71, ZeroCore2 1.18.2-2.1.39), checked against behaviour read from those source tags
 * (docs/extreme-reactors.md has the line for every rule). The mod is not in the pack: nothing here was measured in game.
 */
const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "er-ws-"));
const config = { ...base, workspaceDir: scratch };
const ready = checkConfig(config).length === 0;

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function put(name: string, content: string): void {
  const file = join(scratch, name);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
}

const PRELUDE = `
local function err(fn, ...)
  local ok, e = pcall(fn, ...)
  if ok then error("expected an error but the call succeeded", 2) end
  return (tostring(e):gsub("^pcall: ", ""):gsub("^[^:]*:%d+: ", ""))
end
`;

async function lua(
  source: string,
  world: WorldConfig,
  name: string,
): Promise<TestRunResult> {
  put(name, PRELUDE + source);
  return runTests(config, { paths: [name], world, timeoutMs: 60000 }, 1);
}

function expectAllPassed(result: TestRunResult): void {
  const failures = result.files.flatMap((f) =>
    f.tests.filter((t) => !t.passed).map((t) => `${t.name}: ${t.error}`),
  );
  expect(failures).toEqual([]);
  expect(result.files.map((f) => f.status)).toEqual(["passed"]);
}

async function withSession(
  w: WorldConfig,
  run: (step: (c: Dict) => Promise<SimState>) => Promise<void>,
): Promise<void> {
  const manager = new SessionManager(config);
  const s = manager.create([], 1, w);
  try {
    await s.handle.session.waitForText(">", 0, 20000);
    await run(async (c) => {
      // the addon's commands are not in SimCommand's union: the sim takes any { cmd } its handlers know
      expect(await sendAndWait(s.handle, c as unknown as SimCommand)).toBe(
        true,
      );
      return s.handle.readState()!;
    });
  } finally {
    await manager.destroyAll();
  }
}

/** state.json numbers go through Lua's %.14g: equal to the last printed digit. */
function near(actual: unknown, expected: number): void {
  const a = actual as number;
  expect(Math.abs(a - expected)).toBeLessThanOrEqual(
    1e-12 * Math.max(1, Math.abs(expected)),
  );
}

type Dict = Record<string, unknown>;
const machine = (st: SimState, name: string) =>
  (st.peripherals as Record<string, Dict>)[name]!;
const gameTime = (st: SimState) =>
  (st as { addons?: Record<string, Dict> }).addons!["extreme-reactors"]!
    .gameTime as number;

// ───────────── an independent port of the Java, for exact numbers ─────────────

const f = Math.fround;

interface RefReactor {
  ix: number;
  iy: number;
  iz: number;
  /** cells[x][z], 1-based interior: "rod" or a moderator [absorption, efficiency, moderation, conductivity] */
  cells: (string | number[])[][];
  rods: { x: number; z: number; insertion: number }[];
  active: boolean;
  passive: boolean;
  fuel: number;
  waste: number;
  rfu: number;
  fertility: number;
  fuelHeat: number;
  reactorHeat: number;
  energy: number;
  produced: number;
  consumed: number;
  liquid: number;
  gas: number;
  cap: number;
  vaporized: number;
  cursor: number;
  load: number;
  energyCap: number;
  efficiency: number;
}

const AIR = [0.1, 0.25, 1.1, 0.05].map(f);
const GRAPHITE = [0.1, 0.5, 2.0, 2].map(f);
const WATER = [0.33, 0.5, 1.33, 0.1].map(f);

function refReactor(
  layout: string[],
  height: number,
  legend: Record<string, number[]>,
  init: Partial<RefReactor>,
): RefReactor {
  const iz = layout.length;
  const ix = Math.max(...layout.map((r) => r.length));
  const cells: (string | number[])[][] = [];
  const rods: RefReactor["rods"] = [];
  for (let x = 1; x <= ix; x++) cells[x] = [];
  layout.forEach((row, zi) => {
    for (let x = 1; x <= ix; x++) {
      const ch = row[x - 1] ?? ".";
      if (ch === "X") {
        cells[x]![zi + 1] = "rod";
        rods.push({ x, z: zi + 1, insertion: 0 });
      } else cells[x]![zi + 1] = legend[ch] ?? AIR;
    }
  });
  return {
    ix,
    iy: height - 2,
    iz,
    cells,
    rods,
    active: true,
    passive: true,
    fuel: 0,
    waste: 0,
    rfu: 0,
    fertility: 1,
    fuelHeat: 0,
    reactorHeat: 0,
    energy: 0,
    produced: 0,
    consumed: 0,
    liquid: 0,
    gas: 0,
    cap: 0,
    vaporized: 0,
    cursor: 0,
    load: 0,
    energyCap: 1e18,
    efficiency: f(0.8),
    ...init,
  };
}

/** ReactorLogic.update, from the Java (yellorium, default config). */
function refReactorTick(m: RefReactor): void {
  const X = m.ix + 2;
  const Y = m.iy + 2;
  const Z = m.iz + 2;
  const vol = m.ix * m.iy * m.iz;
  const fuelRods = m.rods.length * m.iy;
  m.produced = 0;
  m.consumed = 0;
  if (m.active) {
    m.cursor = (m.cursor % fuelRods) + 1;
    const src = m.rods[(m.cursor - 1) % m.rods.length]!;
    if (m.fuel > 0) {
      const fh = m.fuelHeat;
      const penalty = Math.exp(-15 * Math.exp(-0.0025 * fh));
      const baseFuel = m.fuel + Math.trunc(m.waste / 100);
      const react = f(1.05);
      let raw = f(baseFuel * f(0.01));
      let scaled = f(Math.pow(raw, react));
      scaled = f(f(Math.pow(f(scaled / m.rods.length), react)) * m.rods.length);
      const mod = f(f(100 - src.insertion) / 100);
      scaled = f(scaled * mod);
      raw = f(raw * mod);
      let eff = f(
        scaled * f(1 + f(-f(0.95) * Math.exp(-10 * Math.exp(-f(0.0012) * fh)))),
      );
      const hard0 = f(f(0.2) + f(0.8 * penalty));
      const fm = m.fertility <= 1 ? 1 : f(Math.log10(m.fertility) + 1);
      const usage = f(f(f(f(0.0007) * raw) / fm) * f(1));
      let env = 0;
      let fuelE = f(10 * eff);
      let fertAbsTotal = f(0);
      eff = f(eff * f(0.25));
      for (const [dx, dz] of [
        [0, 1],
        [-1, 0],
        [0, -1],
        [1, 0],
      ] as const) {
        let h = hard0;
        let i = eff;
        let ttl = 4;
        let x = src.x;
        let z = src.z;
        while (ttl > 0 && i > f(0.0001)) {
          ttl--;
          x += dx;
          z += dz;
          if (x < 0 || z < 0 || x > X - 1 || z > Z - 1) continue;
          if (x === 0 || z === 0 || x === X - 1 || z === Z - 1) {
            i = 0;
            continue;
          }
          const c = m.cells[x]![z]!;
          if (c === "rod") {
            const rod = m.rods.find((r) => r.x === x && r.z === z)!;
            const ins = Math.min(1, Math.max(0, f(rod.insertion / 100)));
            const ba = f(
              f(1.0 - 0.95 * Math.exp(-10 * Math.exp(-0.0022 * fh))) *
                f(1 - f(h / 1)),
            );
            const sa = Math.min(1, f(ba * f(0.5)));
            const bonus = f(f(f(1 - sa) * ins) * f(0.5));
            const pen = f(f(sa * ins) * f(0.5));
            const ra = f(f(sa + bonus) * i);
            const fa = f(f(sa - pen) * i);
            const fmf = f(f(1.5) + f(f(f(1.5) * ins) + ins));
            i = Math.max(0, f(i - ra));
            h = f(h / fmf);
            fuelE += f(ra * 10);
            fertAbsTotal = f(fertAbsTotal + fa);
          } else {
            const [ab, ef, mo] = c as number[];
            const a = f(f(i * ab!) * f(1 - h));
            i = Math.max(0, f(i - a));
            h = f(h / mo!);
            env += f(f(ef! * a) * 10);
          }
        }
      }
      m.fertility = f(m.fertility + fertAbsTotal);
      m.rfu = f(m.rfu + usage);
      if (m.rfu >= 1) {
        const conv = Math.min(m.fuel, Math.trunc(m.rfu));
        if (conv > 0) {
          m.rfu = Math.max(0, f(m.rfu - conv));
          m.fuel -= conv;
          m.waste += conv;
        }
      }
      const add = (v: number, a: number) => {
        v += a;
        return -0.00001 < v && v < 0.00001 ? 0 : v;
      };
      m.fuelHeat = add(m.fuelHeat, fuelE / (fuelRods * 10));
      m.reactorHeat = add(m.reactorHeat, env / (vol * 10));
      m.consumed = f(m.consumed + usage);
    }
  }
  const den = m.active ? f(20) : f(f(20) * f(200));
  m.fertility = Math.max(
    0,
    f(m.fertility - Math.max(f(0.1), f(m.fertility / den))),
  );
  if (!m.passive) m.liquid = m.cap; // coolant supply "full"
  // fuel rod heat transfer rate
  let rate = 0;
  for (let y = 0; y < m.iy; y++)
    for (const r of m.rods)
      for (const [dx, dz] of [
        [0, 1],
        [-1, 0],
        [0, -1],
        [1, 0],
      ] as const) {
        const x = r.x + dx;
        const z = r.z + dz;
        if (x < 1 || z < 1 || x > m.ix || z > m.iz) rate += f(0.6);
        else {
          const c = m.cells[x]![z]!;
          rate += c === "rod" ? f(0.05) : (c as number[])[3]!;
        }
      }
  const k1 = f(rate);
  let d = m.fuelHeat - m.reactorHeat;
  if (d > 0.01) {
    const e = d * k1;
    const fe = m.fuelHeat * fuelRods * 10 - e;
    const re = m.reactorHeat * vol * 10 + e;
    m.fuelHeat = fe / (fuelRods * 10);
    m.reactorHeat = re / (vol * 10);
  }
  const k2 = f(f(0.6) * (2 * (m.ix * m.iy + m.ix * m.iz + m.iy * m.iz)));
  const coolantT = m.passive
    ? f(20)
    : m.liquid > 0
      ? Math.min(m.reactorHeat, f(100))
      : m.reactorHeat;
  d = m.reactorHeat - coolantT;
  if (d > f(0.01)) {
    let e = d * k2;
    let re = m.reactorHeat * vol * 10;
    if (m.passive) {
      e = e * f(0.2);
      const raw = e * f(0.5) * 1.0 * 1.0 * m.efficiency;
      m.energy = Math.min(
        m.energyCap,
        m.energy + Math.floor(raw) + (Math.round(raw * 10000) % 10000) / 10000,
      );
      m.produced += raw;
    } else {
      let left = e;
      if (e > 0 && m.liquid > 0) {
        let lv = Math.min(m.cap - m.gas, m.liquid);
        let vg = Math.min(lv, Math.trunc(e / f(4)));
        lv = vg;
        vg = Math.trunc(f(vg * f(0.85)));
        if (lv >= 1) {
          m.vaporized = lv;
          m.liquid -= lv;
          m.gas = Math.min(m.cap, m.gas + vg);
          left = Math.max(0, e - lv * f(4));
        }
      }
      e = e - left;
      m.produced = m.vaporized;
    }
    re -= e;
    m.reactorHeat = re / (vol * 10);
  }
  d = m.reactorHeat - f(20);
  if (d > f(0.000001)) {
    const k3 = f(f(0.001) * (2 * (X * Y + X * Z + Y * Z)));
    const lost = Math.max(1, d * k3);
    m.reactorHeat = Math.max(0, m.reactorHeat * vol * 10 - lost) / (vol * 10);
  }
  if (m.reactorHeat < 0) m.reactorHeat = 0;
  if (m.fuelHeat < 0) m.fuelHeat = 0;
  if (m.passive && m.load > 0) m.energy = Math.max(0, m.energy - m.load);
  if (!m.passive) m.gas = 0; // steam drain "all"
}

interface RefTurbine {
  blades: number;
  mass: number;
  coils: number;
  eff: number;
  bonus: number;
  drag: number;
  fric: number;
  bladeDrag: number;
  perBlade: number;
  maxIntake: number;
  cap: number;
  active: boolean;
  inductor: boolean;
  rotor: number;
  gas: number;
  liquid: number;
  energy: number;
  produced: number;
  flow: number;
  bladeEff: number;
}

function refTurbine(
  blades: number,
  shafts: number,
  goldCoils: number,
  cap: number,
): RefTurbine {
  let e = f(0);
  let b = f(0);
  let d = f(0);
  for (let i = 0; i < goldCoils; i++) {
    e = f(e + f(2.0));
    b = f(b + f(1.0));
    d = f(d + f(1.75));
  }
  const mass = blades * 8 + shafts * 8;
  return {
    blades,
    mass,
    coils: goldCoils,
    eff: f(f(e * f(0.33)) / goldCoils),
    bonus: Math.max(1, f(b / goldCoils)),
    drag: f(f(d / goldCoils) * f(f(0.1) * 1)),
    fric: f(f(mass * f(0.01)) * f(1)),
    bladeDrag: f(f(f(0.00025) * blades) * f(1)),
    perBlade: 15,
    maxIntake: 1000,
    cap,
    active: true,
    inductor: true,
    rotor: 0,
    gas: 0,
    liquid: 0,
    energy: 0,
    produced: 0,
    flow: 0,
    bladeEff: 1,
  };
}

/** TurbineLogic.update with steam supply "full" and water drained. */
function refTurbineTick(m: RefTurbine): void {
  m.gas = m.cap;
  m.produced = 0;
  m.flow = 0;
  m.bladeEff = f(1);
  let vapor = 0;
  if (m.active) vapor = Math.min(m.maxIntake, m.gas);
  if (vapor > 0 || m.rotor > 0) {
    const speed = f(m.rotor / (m.blades * m.mass));
    const aero = f(speed * m.bladeDrag);
    let lift = f(0);
    if (vapor > 0) {
      let steam = Math.min(m.blades * m.perBlade, vapor);
      lift = f(steam * f(10));
      if (steam < vapor) {
        steam = vapor - steam;
        const needed = Math.trunc(vapor / m.perBlade);
        const missing = needed - m.blades;
        const be = f(1 - f(f(missing) / f(needed)));
        lift = f(lift + f(f(steam * f(10)) * be));
        m.bladeEff = f(lift / f(vapor * f(10)));
      }
    }
    const ind = m.inductor ? f(f(speed * m.drag) * m.coils) : f(0);
    const en = f(f(Math.pow(ind, m.bonus)) * m.eff);
    if (en > 0) {
      let eff = f(f(0.25 * Math.cos(speed / (45.5 * Math.PI))) + f(0.75));
      if (speed < 500) eff = Math.min(f(0.5), eff);
      const raw = f(en * eff);
      m.energy += Math.floor(raw) + (Math.round(raw * 10000) % 10000) / 10000;
      m.produced += raw;
    }
    const delta = f(f(f(lift + f(-1 * ind)) + f(-1 * aero)) + f(-1 * m.fric));
    m.rotor = Math.max(0, f(m.rotor + delta));
    if (vapor > 0) {
      m.gas -= vapor;
      m.liquid = Math.min(m.cap, m.liquid + vapor);
      m.flow = vapor;
    }
  }
  m.liquid = 0;
}

// ───────────── surface ─────────────

const SOURCE = {
  "BigReactors-Reactor": [
    "getVariant",
    "getEnergyStored",
    "getEnergyStoredAsText",
    "getNumberOfControlRods",
    "getActive",
    "getFuelTemperature",
    "getCasingTemperature",
    "getFuelAmount",
    "getWasteAmount",
    "getFuelAmountMax",
    "getControlRodName",
    "getControlRodLevel",
    "getEnergyProducedLastTick",
    "getHotFluidProducedLastTick",
    "isActivelyCooled",
    "getCoolantAmount",
    "getCoolantAmountMax",
    "getCoolantType",
    "getHotFluidAmount",
    "getHotFluidAmountMax",
    "getHotFluidType",
    "getFuelReactivity",
    "getFuelConsumedLastTick",
    "getControlRodLocation",
    "getEnergyCapacity",
    "getControlRodsLevels",
    "setControlRodsLevels",
    "getEnergyStats",
    "getFuelStats",
    "getHotFluidStats",
    "getCoolantFluidStats",
    "setActive",
    "setControlRodLevel",
    "setAllControlRodLevels",
    "setControlRodName",
    "doEjectWaste",
    "doEjectFuel",
  ],
  "BigReactors-Turbine": [
    "getVariant",
    "getActive",
    "getEnergyProducedLastTick",
    "getEnergyStored",
    "getEnergyStoredAsText",
    "getFluidAmountMax",
    "getFluidFlowRate",
    "getFluidFlowRateMax",
    "getFluidFlowRateMaxMax",
    "getInputAmount",
    "getInputType",
    "getOutputAmount",
    "getOutputType",
    "getRotorSpeed",
    "getNumberOfBlades",
    "getBladeEfficiency",
    "getRotorMass",
    "getInductorEngaged",
    "getEnergyCapacity",
    "getEnergyStats",
    "setActive",
    "setFluidFlowRateMax",
    "setVentNone",
    "setVentOverflow",
    "setVentAll",
    "setInductorEngaged",
  ],
} as const;
const COMMON = [
  "help",
  "isMethodAvailable",
  "mbIsConnected",
  "mbIsAssembled",
  "mbIsDisassembled",
  "mbIsPaused",
  "mbGetMultiblockControllerTypeName",
  "mbGetMinimumCoordinate",
  "mbGetMaximumCoordinate",
];

/** CC's PeripheralAPI.getMethods: a HashMap sized to the method count, filled in ZeroCore's sorted order. */
function javaHashMapOrder(keys: string[], initialCapacity: number): string[] {
  const hash = (s: string) => {
    let h = 0;
    for (const c of s) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0;
    return h ^ (h >>> 16);
  };
  let cap = 1;
  while (cap < initialCapacity) cap *= 2;
  let threshold = Math.floor(cap * 0.75);
  for (let size = 1; size <= keys.length; size++) {
    if (size > threshold) {
      cap *= 2;
      threshold = Math.floor(cap * 0.75);
    }
  }
  return keys
    .map((k, i) => ({ k, i, b: hash(k) & (cap - 1) }))
    .sort((a, b) => a.b - b.b || a.i - b.i)
    .map((x) => x.k);
}

const surface = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./extreme-reactors-surface.json", import.meta.url)),
    "utf8",
  ),
) as Record<string, string[]>;

describe("Extreme Reactors method surface (no engine)", () => {
  it("extreme-reactors-surface.json is the source's methods in CC's order", () => {
    expect(Object.keys(surface).sort()).toEqual(Object.keys(SOURCE).sort());
    for (const [type, own] of Object.entries(SOURCE)) {
      // ComputerPeripheral.MethodCollection sorts by name; ConnectorComputerCraft hands CC that array
      const sorted = [...COMMON, ...own].sort();
      expect(surface[type]).toEqual(javaHashMapOrder(sorted, sorted.length));
    }
  });

  it("a world using them fails cleanly when the addon is off", () => {
    expect(() =>
      worldJson({
        addons: "none",
        peripherals: [{ name: "r", type: "BigReactors-Reactor" }],
      }),
    ).toThrow(
      /peripheral "r" is a BigReactors-Reactor from Extreme Reactors \(addon "extreme-reactors"\)/,
    );
    expect(() =>
      worldJson({
        addons: ["mekanism"],
        extremeReactors: { gameTime: 5 },
      } as WorldConfig),
    ).toThrow(/world.extremeReactors configures Extreme Reactors/);
    expect(() =>
      worldJson({
        addons: ["extreme-reactors"],
        peripherals: [{ name: "t", type: "BigReactors-Turbine" }],
      }),
    ).not.toThrow();
  });
});

// ───────────── the computer ports ─────────────

const world: WorldConfig = {
  peripherals: [
    {
      name: "r",
      type: "BigReactors-Reactor",
      variant: "reinforced",
      layout: ["X.X", ".G.", "X.X"],
      dimensions: [5, 6, 5],
      fuel: 10000,
      waste: 500,
      position: [100, 60, -20],
      controlRods: [{ name: "north", level: 10 }, { level: 20 }],
    },
    {
      name: "hot",
      type: "BigReactors-Reactor",
      variant: "reinforced",
      cooling: "active",
      coolant: 5000,
    },
    { name: "off", type: "BigReactors-Reactor", connected: false },
    {
      name: "broken",
      type: "BigReactors-Reactor",
      assembled: false,
      fuel: 1000,
    },
    {
      name: "t",
      type: "BigReactors-Turbine",
      dimensions: [5, 8, 5],
      blades: 12,
      shafts: 6,
      coils: { "minecraft:gold_block": 8, iron: 4 },
      steamSupply: 0,
    },
    {
      name: "boil",
      type: "BigReactors-Reactor",
      variant: "reinforced",
      cooling: "active",
      casingHeat: 500,
      coolant: 1000,
      coolantSupply: 0,
      steamDrain: 0,
    },
    {
      name: "ports",
      type: "BigReactors-Reactor",
      fuel: 3000,
      waste: 2500,
      dimensions: [5, 4, 5],
      wasteEjection: "manual",
      wasteOutlet: true,
      fuelInlet: true,
    },
    { name: "e1", type: "BigReactors-Reactor", energy: 123456.7 },
    { name: "e2", type: "BigReactors-Reactor", energy: 999.999 },
    { name: "e3", type: "BigReactors-Reactor", energy: 0.5 },
    {
      name: "tw",
      type: "BigReactors-Turbine",
      steam: 5000,
      water: 100,
      steamSupply: 0,
      waterDrain: 0,
    },
    {
      name: "tv",
      type: "BigReactors-Turbine",
      active: true,
      vent: "all",
      waterDrain: 0,
    },
  ],
};

describe.skipIf(!ready)("Extreme Reactors computer ports", () => {
  it("every method, its values and its errors", async () => {
    const result = await lua(
      `
local expected = { ${Object.entries(surface)
        .map(
          ([k, v]) =>
            `[${JSON.stringify(k)}] = { ${v.map((m) => JSON.stringify(m)).join(", ")} }`,
        )
        .join(", ")} }
ccunit.test("types and getMethods order", function()
  ccunit.eq(peripheral.getType("r"), "BigReactors-Reactor")
  ccunit.eq(peripheral.getType("t"), "BigReactors-Turbine")
  ccunit.eq(peripheral.getMethods("r"), expected["BigReactors-Reactor"])
  ccunit.eq(peripheral.getMethods("t"), expected["BigReactors-Turbine"])
end)

ccunit.test("reactor getters", function()
  local r = peripheral.wrap("r")
  ccunit.eq(r.getVariant(), "reinforced")
  ccunit.eq(r.getActive(), false)
  ccunit.eq(r.getNumberOfControlRods(), 4)
  ccunit.eq(r.getFuelAmount(), 10000)
  ccunit.eq(r.getWasteAmount(), 500)
  ccunit.eq(r.getFuelAmountMax(), 4 * 4 * 4000)
  ccunit.eq(r.getFuelTemperature(), 0)
  ccunit.eq(r.getCasingTemperature(), 0)
  ccunit.eq(r.getControlRodName(0), "north")
  ccunit.eq(r.getControlRodName(2), "")
  ccunit.eq(r.getControlRodLevel(0), 10)
  ccunit.eq(r.getControlRodLevel(1.4), 20) -- Math.round
  ccunit.eq(r.getControlRodLevel(-1), nil)
  ccunit.eq(select("#", r.getControlRodLevel(-1)), 0)
  ccunit.eq(r.getControlRodsLevels(), { [0] = 10, [1] = 20, [2] = 0, [3] = 0 })
  ccunit.eq(r.getControlRodLocation(0), nil) -- a BlockPos: CC cannot convert it
  ccunit.eq(select("#", r.getControlRodLocation(0)), 1) -- one nil, as MethodResult.of(null) gives
  ccunit.eq(r.isActivelyCooled(), false)
  ccunit.eq(r.getCoolantAmount(), 0)
  ccunit.eq(r.getCoolantAmountMax(), 0)
  ccunit.eq(r.getCoolantType(), "")
  ccunit.eq(r.getHotFluidType(), "")
  ccunit.eq(r.getEnergyStored(), 0)
  ccunit.eq(r.getEnergyStoredAsText(), "0.00 FE")
  ccunit.eq(r.getEnergyCapacity(), 30000 * (5 * 6 * 5 - 3 * 4 * 3 + 16))
  ccunit.eq(r.getEnergyProducedLastTick(), 0)
  ccunit.eq(r.getHotFluidProducedLastTick(), 0)
  -- fertility starts at 1 (100%) and loses at least 0.1 a tick while the reactor is off
  local fr = r.getFuelReactivity()
  ccunit.eq(fr == 100 or fr <= 90.00000357627869, true)
  ccunit.eq(r.getFuelConsumedLastTick(), 0)
  ccunit.eq(r.getEnergyStats(), { energyStored = 0, energyCapacity = 30000 * 130, energyProducedLastTick = 0, energySystem = "FE" })
  local stats = r.getFuelStats()
  ccunit.eq(type(stats.fuelReactivity), "number")
  stats.fuelReactivity = nil
  ccunit.eq(stats, { fuelAmount = 10000, fuelCapacity = 64000, fuelTemperature = 0, fuelConsumedLastTick = 0, wasteAmount = 500 })
  ccunit.eq(r.getHotFluidStats(), { fluidAmount = 0, fluidCapacity = 0, fluidProducedLastTick = 0 })
  ccunit.eq(r.getCoolantFluidStats(), { fluidAmount = 0, fluidCapacity = 0 })
  ccunit.eq(r.mbIsConnected(), true)
  ccunit.eq(r.mbIsAssembled(), true)
  ccunit.eq(r.mbIsDisassembled(), false)
  ccunit.eq(r.mbIsPaused(), false)
  ccunit.eq(r.mbGetMultiblockControllerTypeName(), "it.zerono.mods.extremereactors.gamecontent.multiblock.reactor.MultiblockReactor")
  ccunit.eq(r.mbGetMinimumCoordinate(), { 100, 60, -20 })
  ccunit.eq(r.mbGetMaximumCoordinate(), { 104, 65, -16 })
  ccunit.eq(r.help(), "The help() method is not implemented yet")
  ccunit.eq(r.isMethodAvailable("getFuelAmount"), true)
  ccunit.eq(r.isMethodAvailable("getRotorSpeed"), false)
  ccunit.eq(r.isMethodAvailable("help"), true)
end)

ccunit.test("actively cooled reactor", function()
  local h = peripheral.wrap("hot")
  ccunit.eq(h.isActivelyCooled(), true)
  ccunit.eq(h.getVariant(), "reinforced")
  ccunit.eq(h.getCoolantAmountMax(), (125 - 27) * 1000)
  ccunit.eq(h.getHotFluidAmountMax(), 98000)
  ccunit.eq(h.getCoolantType(), "minecraft:water")
  ccunit.eq(h.getNumberOfControlRods(), 1)
  ccunit.eq(h.getFuelAmountMax(), 3 * 4000)
end)

ccunit.test("errors", function()
  local r = peripheral.wrap("r")
  ccunit.eq(err(r.getControlRodName), "Insufficient number of arguments, expected 1")
  ccunit.eq(err(r.getControlRodName, "1"), "Invalid argument 0, expected Number")
  ccunit.eq(err(r.getControlRodName, nil), "Invalid argument 0, expected Number")
  ccunit.eq(err(r.getControlRodName, 4), "Index: 4, Size: 4") -- getControlRodByIndex checks index > count, not >=
  ccunit.eq(err(r.getControlRodLocation, 4), "Index: 4, Size: 4")
  ccunit.eq(r.getControlRodName(5), nil)
  ccunit.eq(err(r.isMethodAvailable), "Index 0 out of bounds for length 0")
  ccunit.eq(err(r.isMethodAvailable, 3), "Invalid argument 0, expected String")
  ccunit.eq(err(r.setActive), "Insufficient number of arguments, expected 1")
  ccunit.eq(err(r.setControlRodLevel, 1), "Insufficient number of arguments, expected 2")
  ccunit.eq(err(r.setControlRodName, 1), "Insufficient number of arguments, expected 2")
  ccunit.eq(err(r.setAllControlRodLevels), "Insufficient number of arguments, expected 1")
  ccunit.eq(err(r.setControlRodsLevels), "Insufficient number of arguments, expected 1")
  local t = peripheral.wrap("t")
  ccunit.eq(err(t.setFluidFlowRateMax), "Insufficient number of arguments, expected 1")
  ccunit.eq(err(t.setInductorEngaged), "Insufficient number of arguments, expected 1")
  ccunit.eq(err(t.setActive), "Insufficient number of arguments, expected 1")
end)

ccunit.test("setters run on the next server tick and swallow their errors", function()
  local r = peripheral.wrap("r")
  ccunit.eq(select("#", r.setControlRodLevel(0, 55)), 0)
  ccunit.eq(r.getControlRodLevel(0), 10) -- not yet
  sleep(0.1)
  ccunit.eq(r.getControlRodLevel(0), 55)
  -- bad arguments are only logged on the server
  r.setControlRodLevel(0, 150)
  r.setControlRodLevel(4, 50)
  r.setActive("yes")
  r.setControlRodName(1, "")
  r.setControlRodName(1, 7)
  r.setControlRodsLevels({ 1, 2, 3, 4 }) -- 1-based keys: no key 0, nothing changes
  r.setControlRodsLevels({ [0] = 1, [1] = 2 }) -- wrong count
  sleep(0.1)
  ccunit.eq(r.getControlRodsLevels(), { [0] = 55, [1] = 20, [2] = 0, [3] = 0 })
  ccunit.eq(r.getActive(), false)
  ccunit.eq(r.getControlRodName(1), "")
  r.setControlRodsLevels({ [0] = 1, [1] = 2.5, [2] = 99.4, [3] = 100 })
  r.setControlRodName(1, "east")
  sleep(0.1)
  ccunit.eq(r.getControlRodsLevels(), { [0] = 1, [1] = 3, [2] = 99, [3] = 100 })
  ccunit.eq(r.getControlRodName(1), "east")
  r.setAllControlRodLevels(42.5)
  sleep(0.1)
  ccunit.eq(r.getControlRodsLevels(), { [0] = 43, [1] = 43, [2] = 43, [3] = 43 })
  r.setActive(true)
  ccunit.eq(r.getActive(), false)
  sleep(0.1)
  ccunit.eq(r.getActive(), true)
  r.setActive(false)
  sleep(0.1)
end)

ccunit.test("no method waits for the server: events are kept", function()
  local r, t = peripheral.wrap("r"), peripheral.wrap("t")
  os.queueEvent("mark")
  r.getFuelAmount(); r.getFuelStats(); r.setActive(false); t.getRotorSpeed(); t.setVentAll(); r.mbGetMinimumCoordinate()
  ccunit.eq(os.pullEvent(), "mark")
end)

ccunit.test("not connected, not assembled", function()
  local o = peripheral.wrap("off")
  ccunit.eq(o.mbIsConnected(), false)
  ccunit.eq(o.mbIsAssembled(), false)
  ccunit.eq(o.mbIsDisassembled(), false)
  ccunit.eq(o.mbGetMultiblockControllerTypeName(), "it.zerono.mods.extremereactors.gamecontent.multiblock.reactor.MultiblockReactor")
  ccunit.eq(o.getFuelAmount(), {}) -- evalOnController's default, an empty Object[]
  ccunit.eq(o.mbGetMinimumCoordinate(), {})
  ccunit.eq(o.getControlRodName(0), {})
  ccunit.eq(select("#", o.setActive(true)), 0)
  local b = peripheral.wrap("broken")
  ccunit.eq(b.mbIsAssembled(), false)
  ccunit.eq(b.mbIsDisassembled(), true)
  ccunit.eq(b.getFuelAmount(), 1000)
  b.setActive(true)
  sleep(0.2)
  ccunit.eq(b.getActive(), true)
  ccunit.eq(b.getFuelAmount(), 1000) -- a machine that is not assembled does not tick
  ccunit.eq(b.getFuelTemperature(), 0)
end)

ccunit.test("fluids, names, waste ejection, energy text", function()
  local b = peripheral.wrap("boil")
  sleep(0.1) -- 500 C against 100 C water boils it on the first tick
  ccunit.eq(b.getHotFluidType(), "bigreactors:steam")
  ccunit.eq(b.getHotFluidAmount() > 0, true)
  ccunit.eq(b.getCoolantAmount() < 1000, true)
  ccunit.eq(b.getHotFluidProducedLastTick() >= 0, true)
  ccunit.eq(b.getEnergyProducedLastTick(), 0)
  local hs = b.getHotFluidStats()
  ccunit.eq(hs.fluidType, nil) -- an Optional: CC leaves the key out
  ccunit.eq(hs.fluidCapacity, 98000)
  local p = peripheral.wrap("ports")
  ccunit.eq(p.getFuelAmountMax(), 2 * 4000)
  p.doEjectWaste()
  p.doEjectFuel()
  ccunit.eq(p.getWasteAmount(), 2500)
  sleep(0.1)
  ccunit.eq(p.getWasteAmount(), 500) -- whole ingots only
  ccunit.eq(p.getFuelAmount(), 0)
  ccunit.eq(peripheral.wrap("e1").getEnergyStoredAsText(), "123.46 kFE")
  ccunit.eq(peripheral.wrap("e2").getEnergyStoredAsText(), "1000.00 FE") -- %.2f rounds half up, after the > 1000 test
  ccunit.eq(peripheral.wrap("e2").getEnergyStored(), 999.999)
  ccunit.eq(peripheral.wrap("e3").getEnergyStoredAsText(), "500.00 mFE")
  local tw = peripheral.wrap("tw")
  ccunit.eq(tw.getInputType(), "Steam")
  ccunit.eq(tw.getOutputType(), "Water")
  ccunit.eq(tw.getInputAmount(), 5000)
  ccunit.eq(tw.getOutputAmount(), 100)
  local tv = peripheral.wrap("tv")
  sleep(0.2)
  ccunit.eq(tv.getFluidFlowRate(), 1000)
  ccunit.eq(tv.getOutputAmount(), 0) -- vent all: the condensed water is dumped
  ccunit.eq(tv.getRotorSpeed() > 0, true)
end)

ccunit.test("turbine getters and setters", function()
  local t = peripheral.wrap("t")
  ccunit.eq(t.getVariant(), "basic")
  ccunit.eq(t.getActive(), false)
  ccunit.eq(t.getNumberOfBlades(), 12)
  ccunit.eq(t.getRotorMass(), 12 * 8 + 6 * 8)
  ccunit.eq(t.getRotorSpeed(), 0)
  ccunit.eq(t.getInductorEngaged(), false)
  ccunit.eq(t.getFluidFlowRateMax(), 1000)
  ccunit.eq(t.getFluidFlowRateMaxMax(), 1000)
  ccunit.eq(t.getFluidAmountMax(), 10000) -- (5*8*5 - 3*6*3) * 250, capped at 10000
  ccunit.eq(t.getInputAmount(), 0)
  ccunit.eq(t.getInputType(), "")
  ccunit.eq(t.getOutputType(), "")
  ccunit.eq(t.getBladeEfficiency(), 100)
  ccunit.eq(t.getEnergyCapacity(), 10000 * (200 - 54 + 18))
  ccunit.eq(t.getEnergyStats(), { energyStored = 0, energyCapacity = 1640000, energyProducedLastTick = 0, energySystem = "FE" })
  ccunit.eq(t.mbGetMultiblockControllerTypeName(), "it.zerono.mods.extremereactors.gamecontent.multiblock.turbine.MultiblockTurbine")
  ccunit.eq(t.mbGetMaximumCoordinate(), { 4, 7, 4 })
  t.setFluidFlowRateMax(250.5)
  t.setInductorEngaged(true)
  t.setVentNone()
  ccunit.eq(t.getFluidFlowRateMax(), 1000)
  sleep(0.1)
  ccunit.eq(t.getFluidFlowRateMax(), 251)
  ccunit.eq(t.getInductorEngaged(), true)
  t.setFluidFlowRateMax(5000)
  t.setFluidFlowRateMax(-3)
  sleep(0.1)
  ccunit.eq(t.getFluidFlowRateMax(), 0)
  t.setFluidFlowRateMax(5000)
  t.setInductorEngaged("no") -- logged, ignored
  sleep(0.1)
  ccunit.eq(t.getFluidFlowRateMax(), 1000)
  ccunit.eq(t.getInductorEngaged(), true)
end)
`,
      world,
      "methods.lua",
    );
    expectAllPassed(result);
  }, 120000);
});

describe.skipIf(!ready)("worlds/extreme-reactors-demo.json", () => {
  it("boots and every machine answers", async () => {
    const demo = loadNamedWorld(config.worldsDir, "extreme-reactors-demo");
    const result = await lua(
      `
ccunit.test("demo", function()
  local r = peripheral.wrap("BigReactors-Reactor_0")
  ccunit.eq(r.getNumberOfControlRods(), 9)
  ccunit.eq(r.isActivelyCooled(), true)
  ccunit.eq(r.getCoolantAmountMax(), 200000)
  ccunit.eq(r.getControlRodName(0), "corner")
  ccunit.eq(r.getControlRodLevel(1), 20)
  ccunit.eq(r.mbGetMinimumCoordinate(), { 100, 60, 100 })
  local t = peripheral.wrap("BigReactors-Turbine_0")
  ccunit.eq(t.getNumberOfBlades(), 80)
  ccunit.eq(t.getVariant(), "reinforced")
  ccunit.eq(t.getFluidFlowRateMax(), 2000)
  local p = peripheral.wrap("BigReactors-Reactor_1")
  ccunit.eq(p.getActive(), true)
  ccunit.eq(#peripheral.getNames(), 3)
end)
`,
      demo,
      "demo.lua",
    );
    expectAllPassed(result);
  }, 60000);
});

// ───────────── the simulation on the virtual clock ─────────────

describe.skipIf(!ready)("Extreme Reactors simulation", () => {
  it("a passively cooled reactor, tick for tick against the Java", async () => {
    await withSession(
      {
        peripherals: [
          {
            name: "r",
            type: "BigReactors-Reactor",
            layout: ["X.X", ".G.", "X.X"],
            dimensions: [5, 6, 5],
            fuel: 12000,
            active: true,
            load: 40,
          },
        ],
      },
      async (step) => {
        const ref = refReactor(
          ["X.X", ".G.", "X.X"],
          6,
          { G: GRAPHITE },
          {
            fuel: 12000,
            load: 40,
            energyCap: 10000 * (150 - 36 + 16),
          },
        );
        let done = 0;
        for (const seconds of [0.05, 0.5, 3, 20, 60]) {
          const st = await step({ cmd: "advance", seconds });
          const n = gameTime(st);
          while (done < n) {
            refReactorTick(ref);
            done++;
          }
          const s = machine(st, "r");
          expect(s.fuel).toBe(ref.fuel);
          expect(s.waste).toBe(ref.waste);
          near(s.fertility, ref.fertility);
          near(s.fuelHeat, ref.fuelHeat);
          near(s.casingHeat, ref.reactorHeat);
          near(s.fuelConsumedLastTick, ref.consumed);
          near(s.producedLastTick, ref.produced);
          expect(s.energy).toBeCloseTo(ref.energy, 3);
        }
        const s = machine(await step({ cmd: "advance", seconds: 0 }), "r");
        // the reactor warms up, burns fuel into waste and fills its buffer faster than the 40 FE/t load drains it
        expect(s.fuelHeat as number).toBeGreaterThan(200);
        expect(s.waste as number).toBeGreaterThan(0);
        expect(s.fertility as number).toBeGreaterThan(1); // radiation reaches the other fuel rods
        expect(s.energy as number).toBeGreaterThan(1000);
      },
    );
  }, 180000);

  it("an actively cooled reactor boils water into steam", async () => {
    await withSession(
      {
        peripherals: [
          {
            name: "r",
            type: "BigReactors-Reactor",
            variant: "reinforced",
            cooling: "active",
            layout: ["X.X", ".W.", "X.X"],
            dimensions: [5, 6, 5],
            fuel: 16000,
            active: true,
          },
        ],
      },
      async (step) => {
        const ref = refReactor(
          ["X.X", ".W.", "X.X"],
          6,
          { W: WATER },
          {
            fuel: 16000,
            passive: false,
            cap: (150 - 36) * 1000,
          },
        );
        let done = 0;
        for (const seconds of [1, 30, 60]) {
          const st = await step({ cmd: "advance", seconds });
          const n = gameTime(st);
          while (done < n) {
            refReactorTick(ref);
            done++;
          }
          const s = machine(st, "r");
          near(s.fuelHeat, ref.fuelHeat);
          near(s.casingHeat, ref.reactorHeat);
          near(s.producedLastTick, ref.produced);
          expect(s.fuel).toBe(ref.fuel);
        }
        const s = machine(await step({ cmd: "advance", seconds: 0 }), "r");
        expect(s.producedLastTick as number).toBeGreaterThan(0); // mB of water boiled last tick
        expect(s.casingHeat as number).toBeLessThan(200);
        expect(s.energy).toBe(0); // active cooling makes no power
      },
    );
  }, 180000);

  it("a turbine spins up, tick for tick against the Java", async () => {
    await withSession(
      {
        peripherals: [
          {
            name: "t",
            type: "BigReactors-Turbine",
            dimensions: [5, 8, 5],
            blades: 40,
            shafts: 6,
            coils: { gold: 8 },
            active: true,
            inductor: true,
          },
        ],
      },
      async (step) => {
        const ref = refTurbine(40, 6, 8, 10000);
        let done = 0;
        for (const seconds of [0.5, 10, 60, 120]) {
          const st = await step({ cmd: "advance", seconds });
          const n = gameTime(st);
          while (done < n) {
            refTurbineTick(ref);
            done++;
          }
          const s = machine(st, "t");
          near(s.rotorEnergy, ref.rotor);
          near(s.producedLastTick, ref.produced);
          expect(s.flowLastTick).toBe(ref.flow);
          near(s.bladeEfficiency, f(ref.bladeEff * 100));
          expect(s.energy).toBeCloseTo(Math.min(ref.energy, 10000 * 192), 2);
        }
        const s = machine(await step({ cmd: "advance", seconds: 0 }), "t");
        expect(s.rotorSpeed as number).toBeGreaterThan(300);
        expect(s.producedLastTick as number).toBeGreaterThan(0);
        expect(s.water).toBe(0); // drained
      },
    );
  }, 180000);

  it("too few blades cost efficiency; a closed vent stops the flow; world.extremeReactors.gameTime", async () => {
    await withSession(
      {
        extremeReactors: { gameTime: 1000 },
        peripherals: [
          {
            name: "t",
            type: "BigReactors-Turbine",
            blades: 4,
            shafts: 5,
            coils: { gold: 8 },
            active: true,
            vent: "none",
            waterDrain: 0,
          },
        ],
      } as WorldConfig,
      async (step) => {
        const first = await step({ cmd: "advance", seconds: 0.25 });
        expect(gameTime(first)).toBeGreaterThanOrEqual(1005);
        let s = machine(first, "t");
        // 1000 mB/t needs 66 blades of 15 mB; 4 blades: lift drops to 4/66 + the rest at (1 - 62/66)
        expect(s.bladeEfficiency as number).toBeLessThan(20);
        expect(s.inductor).toBe(false);
        const free = s.rotorSpeed as number;
        // water is not drained and the vent is closed: the turbine stops taking steam once the water tank is full
        s = machine(await step({ cmd: "advance", seconds: 5 }), "t");
        expect(s.water).toBe(10000);
        expect(s.flowLastTick).toBe(0);
        expect(free).toBeGreaterThan(0);
      },
    );
  }, 120000);

  it("a reactor feeding a turbine, and the sim commands", async () => {
    await withSession(
      {
        peripherals: [
          {
            name: "r",
            type: "BigReactors-Reactor",
            variant: "reinforced",
            cooling: "active",
            layout: ["XWX", "WXW", "XWX"],
            dimensions: [5, 7, 5],
            fuel: 20000,
            coolant: 50000,
            coolantSupply: 400, // mB/t from a pump, on top of the water the turbine sends back
            active: true,
            steamTo: "t",
          },
          {
            name: "t",
            type: "BigReactors-Turbine",
            variant: "reinforced",
            dimensions: [7, 10, 7],
            blades: 80,
            shafts: 8,
            coils: { gold: 24 },
            active: true,
            inductor: true,
            load: 1000,
          },
          {
            name: "p",
            type: "BigReactors-Reactor",
            fuel: 0,
            active: true,
          },
        ],
      },
      async (step) => {
        let st = await step({ cmd: "advance", seconds: 60 });
        let r = machine(st, "r");
        let t = machine(st, "t");
        expect(r.steam as number).toBeLessThan(r.fluidCapacity as number);
        expect(t.flowLastTick as number).toBeGreaterThan(0); // steam the reactor made
        expect(t.rotorSpeed as number).toBeGreaterThan(0);
        expect((r.coolant as number) + (t.water as number)).toBeGreaterThan(0); // water comes back
        const before = r.fuel as number;

        // a reactor with no fuel stays cold; add fuel and it starts burning
        st = await step({ cmd: "erAddFuel", peripheral: "p", amount: 5000 });
        expect(machine(st, "p").fuel).toBe(5000);
        st = await step({ cmd: "erAddFuel", peripheral: "p", amount: 99999 });
        expect(machine(st, "p").fuel).toBe(12000); // capacity: 3 fuel rods * 4000
        st = await step({ cmd: "advance", seconds: 20 });
        const p = machine(st, "p");
        expect(p.fuel as number).toBeLessThan(12000);
        expect(p.energy as number).toBeGreaterThan(0);
        expect(p.energy as number).toBeGreaterThan(50000);
        // The reactor keeps producing while the clock runs, and an unknown number of ticks pass between the reads and
        // the drain. Measure the production per tick over a second of ticks, and have the state after the drain say
        // how many ticks it has seen: the energy the drain took is what is missing.
        const a = await step({ cmd: "advance", seconds: 1 });
        const b = await step({ cmd: "advance", seconds: 1 });
        const rate =
          ((machine(b, "p").energy as number) -
            (machine(a, "p").energy as number)) /
          (gameTime(b) - gameTime(a));
        expect(rate).toBeGreaterThan(0);
        st = await step({ cmd: "erDrainEnergy", peripheral: "p", amount: 1e9 });
        const taken =
          (machine(b, "p").energy as number) +
          rate * (gameTime(st) - gameTime(b)) -
          (machine(st, "p").energy as number);
        // no more than the basic reactor's 50000 FE max extract in one go
        expect(taken).toBeGreaterThan(49000);
        expect(taken).toBeLessThan(51000);
        st = await step({ cmd: "erSetLoad", peripheral: "p", rate: 1e6 });
        st = await step({ cmd: "advance", seconds: 1 });
        expect(machine(st, "p").energy).toBe(0);
        expect(machine(st, "p").load).toBe(1e6);

        const waste = machine(st, "r").waste as number;
        st = await step({ cmd: "erAddWaste", peripheral: "r", amount: 1000 });
        expect(machine(st, "r").waste as number).toBeGreaterThanOrEqual(
          waste + 1000,
        );

        st = await step({ cmd: "erAddSteam", peripheral: "t", amount: 100 });
        st = await step({
          cmd: "erSetAssembled",
          peripheral: "t",
          assembled: false,
        });
        t = machine(st, "t");
        expect(t.assembled).toBe(false);
        expect(t.active).toBe(false);
        expect(t.rotorSpeed).toBe(0);
        st = await step({
          cmd: "erSetAssembled",
          peripheral: "t",
          assembled: true,
        });
        st = await step({ cmd: "erSetActive", peripheral: "t", active: true });
        expect(machine(st, "t").active).toBe(true);
        st = await step({
          cmd: "erSetConnected",
          peripheral: "p",
          connected: false,
        });
        expect(machine(st, "p").connected).toBe(false);
        st = await step({
          cmd: "erSetCoolantSupply",
          peripheral: "r",
          rate: "full",
        });
        st = await step({ cmd: "erSetSteamSupply", peripheral: "t", rate: 0 });
        st = await step({ cmd: "advance", seconds: 5 });
        r = machine(st, "r");
        expect(r.fuel as number).toBeLessThan(before);
        // topped up every tick now, before the tick boils some of it
        expect(r.coolant as number).toBeGreaterThan(
          (r.fluidCapacity as number) * 0.9,
        );
      },
    );
  }, 240000);
});
