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
 * Bigger Reactors 1.18.2-0.6.0-beta.1.4 (Phosphophyllite 1.18.2-0.6.0-beta.1.6), checked against behaviour read from
 * those source tags (docs/bigger-reactors.md has the line for every rule). The mod is not in the pack: nothing here
 * was measured in game.
 */
const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "br-ws-"));
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
local function sorted(t) table.sort(t) return t end
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

type Dict = Record<string, unknown>;

async function withSession(
  w: WorldConfig,
  run: (
    step: (c: Dict) => Promise<SimState>,
    program: (name: string, done: string) => Promise<void>,
  ) => Promise<void>,
): Promise<void> {
  const manager = new SessionManager(config);
  const s = manager.create([], 1, w);
  try {
    const raw = s.handle.session;
    await raw.waitForText(">", 0, 20000);
    await run(
      async (c) => {
        // the addon's commands are not in SimCommand's union: the sim takes any { cmd } its handlers know
        expect(await sendAndWait(s.handle, c as unknown as SimCommand)).toBe(
          true,
        );
        return s.handle.readState()!;
      },
      async (name, done) => {
        raw.typeLine(name);
        try {
          await raw.waitForText(done, 0, 20000);
        } catch (error) {
          const screen = (manager.screens(s.id)[0]?.lines ?? []).join("\n");
          throw new Error(`${(error as Error).message}\n${screen}`);
        }
      },
    );
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

const machine = (st: SimState, name: string) =>
  (st.peripherals as Record<string, Dict>)[name]!;
const gameTime = (st: SimState) =>
  (st as { addons?: Record<string, Dict> }).addons!["bigger-reactors"]!
    .gameTime as number;

// ───────────── an independent port of the Java, for exact numbers ─────────────

/** java.util.Random */
class JavaRandom {
  private seed: bigint;
  private static readonly MASK = (1n << 48n) - 1n;
  constructor(seed: number) {
    this.seed = (BigInt(seed) ^ 0x5deece66dn) & JavaRandom.MASK;
  }
  private next(bits: number): number {
    this.seed = (this.seed * 0x5deece66dn + 0xbn) & JavaRandom.MASK;
    return Number(this.seed >> BigInt(48 - bits));
  }
  nextInt(bound: number): number {
    if ((bound & -bound) === bound)
      return Number((BigInt(bound) * BigInt(this.next(31))) >> 31n);
    let u = this.next(31);
    let r = u % bound;
    while (u - r + (bound - 1) >= 2 ** 31) {
      u = this.next(31);
      r = u % bound;
    }
    return r;
  }
}

/** SimUtil's static block: 64 Fibonacci-sphere rays, each a list of [dx, dy, dz, length] steps. */
function makeRays(): number[][][] {
  const TTL = 4;
  const N = 64;
  const phi = Math.PI * (3.0 - Math.sqrt(5));
  const len2 = (v: number[]) => v[0]! * v[0]! + (v[1]! * v[1]! + v[2]! * v[2]!);
  const out: number[][][] = [];
  for (let i = 0; i < N; i++) {
    const y = 1.0 - (i * 2.0) / (N - 1);
    const radius = Math.sqrt(1.0 - y * y);
    const theta = phi * i;
    let d = [Math.cos(theta) * radius, y, Math.sin(theta) * radius];
    const inv = 1.0 / Math.sqrt(len2(d));
    d = d.map((c) => c * inv);
    const a = d.map(Math.abs);
    const big =
      a[0]! >= a[1]! && a[0]! >= a[2]! ? a[0]! : a[1]! >= a[2]! ? a[1]! : a[2]!;
    let start = d.map((c) => c * (1 / big));
    start = start.map((c) => c * 0.5);
    const scale = TTL + Math.sqrt(len2(start));
    const dir = d.map((c) => c * scale);
    let processed = 0;
    const total = Math.sqrt(len2(dir));
    let cur = [0, 0, 0];
    const planes = dir.map((c) => (Math.abs(c) / c) * 0.5);
    const steps: number[][] = [];
    let first = true;
    for (;;) {
      let best = 0;
      let bestLen = Infinity;
      const hits = [0, 1, 2].map((k) =>
        dir.map((c) => c * (planes[k]! / dir[k]!)),
      );
      for (let k = 0; k < 3; k++) {
        const l = len2(hits[k]!);
        if (l < bestLen) {
          best = k;
          bestLen = l;
        }
      }
      planes[best] = planes[best]! + planes[best]! / Math.abs(planes[best]!);
      const end = hits[best]!;
      const seg = end.map((c, k) => c - cur[k]!);
      const block = end.map(
        (c, k) => Math.floor((c - cur[k]!) * 0.5 + 0.5 + cur[k]!) + 0,
      );
      let segment = Math.sqrt(len2(seg));
      const last = processed + segment >= total;
      segment = Math.min(total - processed, segment);
      if (!first && segment !== 0)
        steps.push([block[0]!, block[1]!, block[2]!, segment]);
      first = false;
      processed += segment;
      if (last) break;
      cur = end;
    }
    out.push(steps);
  }
  return out;
}
const RAYS = makeRays();

interface Mod {
  a: number;
  e: number;
  m: number;
  c: number;
}
const AIR: Mod = { a: 0.1, e: 0.25, m: 1.1, c: 0.05 };
const GRAPHITE: Mod = { a: 0.1, e: 0.5, m: 2, c: 2 };
const WATER: Mod = { a: 0.33, e: 0.5, m: 1.33, c: 0.1 };
const f = Math.fround;
const AMBIENT = 293.15;

interface Heat {
  rfk: number;
  t: number;
}
/** HeatBody.transferWith between two finite bodies */
function transfer(a: Heat, b: Heat, rfkt: number): void {
  let target = (a.rfk * (a.t - b.t)) / (a.rfk + b.rfk);
  target += b.t;
  let d = rfkt * (a.rfk + b.rfk);
  d /= a.rfk * b.rfk;
  d = Math.exp(-d);
  const na = (a.t - target) * d + target;
  const nb = (b.t - target) * d + target;
  a.t = na;
  b.t = nb;
}
const long = (v: number) => (Number.isNaN(v) ? 0 : Math.trunc(v));

class RefReactor {
  x: number;
  y: number;
  z: number;
  passive: boolean;
  cells: (Mod | "rod" | "manifold")[][][] = [];
  rods: { x: number; z: number; insertion: number }[] = [];
  rodXZ: Record<string, { insertion: number }> = {};
  simRods: { x: number; z: number; insertion: number }[];
  currentRod = 0;
  rodOffset = 0;
  fuel: number;
  waste = 0;
  partial = 0;
  burned = 0;
  fertility = 1;
  fuelHeat: Heat;
  stackHeat: Heat;
  fuelToCasing = 0;
  fuelToManifold = 0;
  stackToCoolant: number;
  casingToAmbient: number;
  energy = 0;
  energyCap: number;
  generated = 0;
  liquid = 0;
  vapor = 0;
  coolantCap: number;
  hasWater = false;
  transitioned = 0;
  maxTransitioned = 0;
  load: number;
  coolantSupply: number;
  active = true;

  constructor(
    dims: number[],
    layout: string[],
    legend: Record<string, Mod | "manifold">,
    o: {
      passive: boolean;
      fuel: number;
      load?: number;
      seed?: number;
      coolant?: number;
      coolantSupply?: number;
      level?: number;
    },
  ) {
    [this.x, this.y, this.z] = [dims[0]! - 2, dims[1]! - 2, dims[2]! - 2];
    this.passive = o.passive;
    const { x: X, y: Y, z: Z } = this;
    const col = (i: number, k: number): Mod | "rod" | "manifold" => {
      const c = layout[i]![k]!;
      if (c === "X") return "rod";
      if (c === ".") return AIR;
      if (c === "M" && legend.M === undefined) return "manifold";
      return legend[c]!;
    };
    for (let i = 0; i < X; i++)
      for (let k = 0; k < Z; k++)
        if (col(i, k) === "rod") {
          const rod = { x: i, z: k, insertion: o.level ?? 0 };
          this.rods.push(rod);
          this.rodXZ[`${i},${k}`] = rod;
        }
    let manifolds = 0;
    for (let i = 0; i < X; i++) {
      this.cells[i] = [];
      for (let j = 0; j < Y; j++) {
        this.cells[i]![j] = [];
        for (let k = 0; k < Z; k++) {
          let c = col(i, k);
          if (c === "manifold") {
            if (this.passive) c = AIR;
            else manifolds++;
          }
          this.cells[i]![j]![k] = c;
        }
      }
    }
    const n = this.rods.length;
    this.energyCap = ((X + 2) * (Y + 2) * (Z + 2) - X * Y * Z) * 100000;
    this.coolantCap = n * Y * 10000 + manifolds * 10000;
    for (const rod of this.rods)
      for (let j = 0; j < Y; j++)
        for (const [dx, dz] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nx = rod.x + dx;
          const nz = rod.z + dz;
          if (nx < 0 || nx >= X || nz < 0 || nz >= Z) {
            this.fuelToCasing += 0.6;
            continue;
          }
          const p = this.cells[nx]![j]![nz]!;
          if (p === "manifold") this.fuelToManifold++;
          else if (p !== "rod") this.fuelToCasing += p.c;
        }
    let s = 2 * (X * Y + X * Z + Z * Y);
    for (let i = 0; i < X; i++)
      for (let j = 0; j < Y; j++)
        for (let k = 0; k < Z; k++) {
          if (this.cells[i]![j]![k] !== "manifold") continue;
          for (const [dx, dy, dz] of [
            [1, 0, 0],
            [-1, 0, 0],
            [0, 1, 0],
            [0, -1, 0],
            [0, 0, 1],
            [0, 0, -1],
          ]) {
            const [a, b, c] = [i + dx!, j + dy!, k + dz!];
            if (a < 0 || a >= X || b < 0 || b >= Y || c < 0 || c >= Z) s--;
            else if (this.cells[a]![b]![c] !== "manifold") s++;
          }
        }
    s *= 0.6;
    if (this.passive) s *= f(0.2);
    this.stackToCoolant = s;
    this.casingToAmbient =
      2 * ((X + 2) * (Y + 2) + (X + 2) * (Z + 2) + (Z + 2) * (Y + 2)) * 0.001;
    this.fuelHeat = { rfk: n * Y * 10, t: AMBIENT };
    this.stackHeat = { rfk: X * Y * Z * 10, t: AMBIENT };
    this.fuel = o.fuel;
    this.load = o.load ?? 0;
    this.coolantSupply = o.coolantSupply ?? 0;
    // Collections.shuffle(Arrays.asList(controlRods), random)
    this.simRods = [...this.rods];
    const rnd = new JavaRandom(o.seed ?? 0);
    for (let i = this.simRods.length; i > 1; i--) {
      const j = rnd.nextInt(i);
      [this.simRods[i - 1], this.simRods[j]] = [
        this.simRods[j]!,
        this.simRods[i - 1]!,
      ];
    }
    if (o.coolant) this.fillWater(o.coolant);
  }

  fillWater(amount: number): number {
    const toFill = Math.max(0, Math.min(amount, this.coolantCap - this.liquid));
    this.hasWater = true;
    this.liquid += toFill;
    return toFill;
  }

  manifoldMod(): Mod {
    if (!this.hasWater || this.coolantCap === 0) return AIR;
    const cap = this.coolantCap;
    const l = this.liquid;
    const mix = (d: number, w: number) => (d * (cap - l) + w * l) / cap;
    return {
      a: mix(AIR.a, WATER.a),
      e: mix(AIR.e, WATER.e),
      m: mix(AIR.m, WATER.m),
      c: mix(AIR.c, WATER.c),
    };
  }

  fert(): number {
    return this.fertility <= 1 ? 1 : Math.log10(this.fertility) + 1;
  }

  radiate(): number {
    if (this.fuel <= 0) return 0;
    const { x: X, y: Y, z: Z } = this;
    const n = this.simRods.length;
    this.currentRod++;
    if (this.currentRod >= n) {
      this.currentRod = 0;
      this.rodOffset++;
    }
    const yLevel = this.currentRod % Y;
    const idx = (this.currentRod + this.rodOffset) % n;
    const T = this.fuelHeat.t;
    const penalty = Math.exp(-15 * Math.exp(-0.001 * 2.5 * (T - 273.15)));
    const baseFuel = this.fuel + Math.floor(this.waste / 100);
    const rawRad = baseFuel * f(0.1);
    const scaled = Math.pow(Math.pow(rawRad, f(1.05)) / n, f(1.05)) * n;
    const initialHardness = Math.min(1.0, f(0.2) + 0.8 * penalty);
    const rawIntensity =
      1 +
      -f(0.95) *
        Math.exp(-10 * 1 * Math.exp(-f(0.001) * f(1.2) * (T - 273.15)));
    const fatc =
      1.0 -
      f(0.95) * Math.exp(-10 * 1 * Math.exp(-0.001 * f(2.2) * (T - 273.15)));
    const rod = this.simRods[idx]!;
    const crm = (100 - rod.insertion) / 100;
    const initialIntensity = scaled * crm * rawIntensity;
    const usage = ((f(0.0007) * (rawRad * crm)) / this.fert()) * 1;
    let fuelRF = 10 * initialIntensity;
    let fuelRad = 0;
    let caseRF = 0;
    const manifold = this.manifoldMod();
    for (const steps of RAYS) {
      let h = initialHardness;
      let it = (initialIntensity * 1.0) / RAYS.length;
      for (const [dx, dy, dz, len] of steps) {
        const cx = rod.x + dx!;
        const cy = yLevel + dy!;
        const cz = rod.z + dz!;
        if (cx < 0 || cx >= X || cy < 0 || cy >= Y || cz < 0 || cz >= Z) break;
        const cell = this.cells[cx]![cy]![cz]!;
        if (cell !== "rod") {
          const p = cell === "manifold" ? manifold : cell;
          const absorbed = it * p.a * (1 - h) * len!;
          it = Math.max(0, it - absorbed);
          h = h / ((p.m - 1.0) * len! + 1.0);
          caseRF += p.e * absorbed * 10;
        } else {
          const ins = this.rodXZ[`${cx},${cz}`]!.insertion * 0.001;
          const scaledAbs = fatc * (1 - h * 1) * 0.5 * len!;
          const bonus = (1 - scaledAbs) * ins * 0.5;
          const pen = scaledAbs * ins * 0.5;
          const radAbs = (scaledAbs + bonus) * it;
          const fertAbs = (scaledAbs - pen) * it;
          const fmf = 1.5 + (1.5 * ins + ins);
          it = Math.max(0, it - radAbs);
          h = h / ((fmf - 1.0) * len! + 1.0);
          fuelRF += radAbs * 10;
          fuelRad += fertAbs;
        }
      }
    }
    this.fertility += fuelRad;
    this.fuelHeat.t += fuelRF / this.fuelHeat.rfk;
    this.stackHeat.t += caseRF / this.stackHeat.rfk;
    return usage;
  }

  burn(amount: number): void {
    if (amount === 0) {
      this.burned = 0;
      return;
    }
    const toProcess = Math.min(this.partial + amount, this.fuel);
    this.burned = toProcess - this.partial;
    this.partial = toProcess;
    if (toProcess >= 1) {
      const b = Math.trunc(toProcess);
      this.fuel -= b;
      this.waste += b;
      this.partial -= b;
    }
  }

  /** one server tick, with the fixture's pumps and load around ReactorMultiblockController.tick */
  tick(pushSteam?: (amount: number) => number): void {
    if (!this.passive && this.coolantSupply) this.fillWater(this.coolantSupply);
    const toBurn = this.active ? this.radiate() : (this.burn(0), 0);
    const denom = this.active ? 20 : 20 * 200;
    this.fertility = Math.max(
      0,
      this.fertility - Math.max(f(0.1), this.fertility / denom),
    );
    const cond = this.passive ? AIR.c : this.manifoldMod().c;
    transfer(
      this.fuelHeat,
      this.stackHeat,
      this.fuelToCasing + this.fuelToManifold * cond,
    );
    const body = this.stackHeat;
    if (this.passive) {
      const nt =
        (body.t - AMBIENT) * Math.exp(-this.stackToCoolant / body.rfk) +
        AMBIENT;
      const rf = (nt - body.t) * body.rfk;
      this.generated = long(-rf * 1 * 0.5);
      this.energy = Math.min(this.energyCap, this.energy + this.generated);
      body.t = nt;
    } else if (this.hasWater) {
      let rfkt = this.stackToCoolant * 0.6;
      rfkt *= Math.max(this.liquid / this.coolantCap, 0.01);
      const nt = (body.t - 373.15) * Math.exp(-rfkt / body.rfk) + 373.15;
      const toTransfer = (nt - body.t) * body.rfk;
      if (toTransfer > 0) {
        this.transitioned = this.maxTransitioned = 0;
      } else {
        let t = long(Math.abs(toTransfer) / 4);
        this.maxTransitioned = t;
        t = Math.min(Math.min(this.liquid, this.coolantCap - this.vapor), t);
        this.transitioned = t;
        this.liquid -= t;
        this.vapor += t;
        body.t += -(t * 4) / body.rfk;
      }
    }
    // stack to ambient: the ambient body is infinite
    body.t =
      (body.t - AMBIENT) * Math.exp(-this.casingToAmbient / body.rfk) + AMBIENT;
    if (this.active) this.burn(toBurn);
    if (this.passive && this.load > 0)
      this.energy -= Math.min(this.load, this.energy);
    if (!this.passive && this.vapor > 0 && pushSteam)
      this.vapor -= pushSteam(this.vapor);
  }
}

const COIL_GOLD = { efficiency: 0.66, extractionRate: 0.175, bonus: 1 };

class RefTurbine {
  ix: number;
  iy: number;
  iz: number;
  shafts: number;
  linear = 0;
  bladeCount = 0;
  axialMass: number;
  rotorMass: number;
  capPerRPM: number;
  maxMax: number;
  maxFlow: number;
  coils: number;
  eff: number;
  drag: number;
  bonus: number;
  batteryCap: number;
  tankCap: number;
  steam = 0;
  water = 0;
  energy = 0;
  rotorEnergy = 0;
  generated = 0;
  efficiency = 0;
  flowLast = 0;
  active = true;
  vent: "OVERFLOW" | "CLOSED" | "ALL" = "OVERFLOW";
  load: number;
  hasSteam = false;

  constructor(
    dims: number[],
    rotor: number[][],
    coils: number,
    o: { load?: number; flowRate?: number },
  ) {
    [this.ix, this.iy, this.iz] = [dims[0]! - 2, dims[1]! - 2, dims[2]! - 2];
    this.maxMax = (this.ix * this.iz - 1) * 5000;
    const tri = (u: number) => Math.floor(((1 + u) * u) / 2);
    let mass = 0;
    for (const s of rotor) {
      for (const l of s) {
        this.linear += tri(l);
        mass += l;
      }
    }
    this.bladeCount = mass;
    this.shafts = rotor.length;
    let cap = (this.linear * 20) / 1000;
    this.axialMass = this.shafts * 100 + this.linear * 100;
    cap *= 2 * Math.PI;
    this.capPerRPM = cap;
    this.rotorMass = mass * 100 + this.shafts * 100;
    this.maxFlow = Math.min(this.maxMax, Math.max(0, long(cap * 1800)));
    if (o.flowRate !== undefined)
      this.maxFlow = Math.min(this.maxMax, Math.max(0, o.flowRate));
    this.coils = coils;
    let eff = 0;
    let drag = 0;
    let bonus = 0;
    for (let i = 0; i < coils; i++) {
      eff += COIL_GOLD.efficiency;
      bonus += COIL_GOLD.bonus;
      drag += COIL_GOLD.extractionRate * 1; // distance 1: 2 / (1 + 1)
    }
    drag *= 10;
    this.batteryCap = (coils + 1) * 300000;
    this.eff = coils > 0 ? (eff * 1) / coils : 0;
    this.bonus = coils > 0 ? Math.max(1, bonus / coils) : 0;
    this.drag = coils > 0 ? drag / coils : 0;
    this.tankCap =
      (this.ix * this.iy * this.iz - (this.shafts + coils)) * 10000;
    this.load = o.load ?? 0;
  }

  fillSteam(amount: number): number {
    const toFill = Math.max(0, Math.min(amount, this.tankCap - this.steam));
    this.hasSteam = true;
    this.steam += toFill;
    return toFill;
  }

  rpm(): number {
    return this.rotorEnergy / this.axialMass;
  }

  flow(amount: number, vent: boolean): number {
    let maxT = this.steam;
    if (!vent) maxT = Math.min(maxT, this.tankCap - this.water);
    amount = Math.min(maxT, amount);
    this.flowLast = amount;
    this.steam -= amount;
    this.water += amount;
    if (vent) this.water = Math.min(this.water, this.tankCap);
    return amount;
  }

  tick(pushWater?: (amount: number) => number, steamSupply = 0): void {
    if (steamSupply) this.fillSteam(steamSupply);
    const rpm = this.rpm();
    if (this.active) {
      const flowRate = this.flow(this.maxFlow, this.vent !== "CLOSED");
      let effective = flowRate;
      const rc = this.capPerRPM * Math.max(100, rpm);
      if (flowRate > rc) effective = rc + (flowRate - rc) * (rc / flowRate);
      this.efficiency = flowRate !== 0 ? effective / flowRate : 0;
      if (effective > 0) this.rotorEnergy += 4 * effective * 2.5;
    } else {
      this.flow(0, this.vent !== "CLOSED");
      this.efficiency = 0;
    }
    if (this.vent === "ALL") this.water = 0;
    const torque = rpm * this.drag * this.coils;
    let energy = Math.pow(torque, this.bonus) * this.eff;
    let e = 0.25 * Math.cos(rpm / (45.5 * Math.PI)) + 0.75;
    if (rpm < 450) e = Math.min(0.5, e);
    if (rpm > 2245) e = -rpm / 4490 + 1;
    if (e < 0) e = 0;
    energy *= e;
    this.generated = energy;
    if (energy > 1)
      this.energy += Math.min(long(energy), this.batteryCap - this.energy);
    this.rotorEnergy -= torque;
    this.rotorEnergy -= this.rotorMass * Math.pow(rpm * 0.0001, 2);
    this.rotorEnergy -= this.linear * Math.pow(rpm * 0.0001, 2);
    if (this.rotorEnergy < 0) this.rotorEnergy = 0;
    if (this.load > 0) this.energy -= Math.min(this.load, this.energy);
    if (this.water > 0 && pushWater) this.water -= pushWater(this.water);
  }
}

// ───────────── surface ─────────────

/** The @LuaFunction methods in declaration order (the jar's class files, javap). */
const SOURCE: Record<string, string[]> = {
  BiggerReactors_Reactor: [
    "apiVersion",
    "connected",
    "active",
    "setActive",
    "battery",
    "coolantTank",
    "fuelTank",
    "controlRodCount",
    "getControlRod",
    "setAllControlRodLevels",
    "fuelTemperature",
    "casingTemperature",
    "stackTemperature",
    "ambientTemperature",
  ],
  BiggerReactors_Turbine: [
    "apiVersion",
    "connected",
    "active",
    "setActive",
    "battery",
    "rotor",
    "fluidTank",
    "coilEngaged",
    "setCoilEngaged",
  ],
};

/** java.util.HashMap iteration order after inserting `keys` into a map built with `initialCapacity`. */
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
    fileURLToPath(new URL("./bigger-reactors-surface.json", import.meta.url)),
    "utf8",
  ),
) as Record<string, string[]>;

describe("Bigger Reactors method surface (no engine)", () => {
  it("bigger-reactors-surface.json is the jar's methods in CC's order", () => {
    expect(Object.keys(surface).sort()).toEqual(Object.keys(SOURCE).sort());
    for (const [type, own] of Object.entries(SOURCE)) {
      expect([...surface[type]!].sort()).toEqual([...own].sort());
      expect(surface[type]).toEqual(javaHashMapOrder(own, own.length));
    }
  });

  it("a world using them fails cleanly when the addon is off", () => {
    expect(() =>
      worldJson({
        addons: "none",
        peripherals: [{ name: "r", type: "BiggerReactors_Reactor" }],
      }),
    ).toThrow(
      /peripheral "r" is a BiggerReactors_Reactor from Bigger Reactors \(addon "bigger-reactors"\)/,
    );
    expect(() =>
      worldJson({
        addons: ["extreme-reactors"],
        biggerReactors: { seed: 1 },
      } as WorldConfig),
    ).toThrow(/world.biggerReactors configures Bigger Reactors/);
    expect(() =>
      worldJson({
        addons: ["bigger-reactors"],
        peripherals: [{ name: "t", type: "BiggerReactors_Turbine" }],
      }),
    ).not.toThrow();
  });

  it("the reference rays look like the source's", () => {
    expect(RAYS.length).toBe(64);
    // straight up: the first step leaves the rod's own block, then one block per unit up to 4.5 blocks
    expect(RAYS[0]!.map((s) => s.slice(0, 3))).toEqual([
      [0, 1, 0],
      [0, 2, 0],
      [0, 3, 0],
      [0, 4, 0],
    ]);
    for (const ray of RAYS) {
      const total = ray.reduce((a, s) => a + s[3]!, 0);
      expect(total).toBeGreaterThan(3.9);
      expect(total).toBeLessThan(4.9);
    }
  });
});

// ───────────── the computer ports ─────────────

const world: WorldConfig = {
  peripherals: [
    {
      name: "r",
      type: "BiggerReactors_Reactor",
      dimensions: [5, 6, 5],
      layout: ["X.X", ".G.", "X.X"],
      legend: { G: "graphite" },
      fuel: 10000,
      waste: 500,
      energy: 1234,
      controlRods: [{ name: "north", level: 10 }, { level: 20 }],
    },
    {
      name: "hot",
      type: "BiggerReactors_Reactor",
      cooling: "active",
      layout: ["XMX", "MXM", "XMX"],
      coolant: 5000,
      steam: 70,
    },
    {
      name: "broken",
      type: "BiggerReactors_Reactor",
      assembled: false,
      fuel: 100,
    },
    {
      name: "ports",
      type: "BiggerReactors_Reactor",
      fuel: 1000,
      waste: 2500,
      wasteOutlet: true,
    },
    {
      name: "t",
      type: "BiggerReactors_Turbine",
      dimensions: [7, 10, 7],
      shafts: 8,
      bladeLength: 2,
      coils: { "minecraft:gold_block": 8, iron: 8 },
    },
    {
      name: "wet",
      type: "BiggerReactors_Turbine",
      steam: 5000,
      water: 300,
      flowRate: 999999,
    },
    { name: "tb", type: "BiggerReactors_Turbine", assembled: false },
  ],
};

describe.skipIf(!ready)("Bigger Reactors computer ports", () => {
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
  ccunit.eq(peripheral.getType("r"), "BiggerReactors_Reactor")
  ccunit.eq(peripheral.getType("t"), "BiggerReactors_Turbine")
  ccunit.eq(peripheral.getMethods("r"), expected["BiggerReactors_Reactor"])
  ccunit.eq(peripheral.getMethods("t"), expected["BiggerReactors_Turbine"])
end)

ccunit.test("reactor getters", function()
  local r = peripheral.wrap("r")
  ccunit.eq(r.apiVersion(), "0.6.0-beta.1.4")
  ccunit.eq(r.connected(), true)
  ccunit.eq(r.active(), false)
  ccunit.eq(r.controlRodCount(), 4)
  ccunit.eq(r.fuelTemperature(), 293.15)
  ccunit.eq(r.stackTemperature(), 293.15)
  ccunit.eq(r.casingTemperature(), 293.15)
  ccunit.eq(r.ambientTemperature(), 293.15)
  ccunit.eq(r.coolantTank(), nil)
  local b = r.battery()
  ccunit.eq(sorted((function() local k = {} for n in pairs(b) do k[#k + 1] = n end return k end)()),
    { "capacity", "producedLastTick", "stored" })
  ccunit.eq(b.stored(), 1234)
  ccunit.eq(b:stored(), 1234) -- the table passed as an extra argument is ignored
  ccunit.eq(b.capacity(), (5 * 6 * 5 - 3 * 4 * 3) * 100000)
  ccunit.eq(b.producedLastTick(), 0)
  ccunit.eq(r.battery() == r.battery(), false) -- a fresh table every call
  local f = r.fuelTank()
  ccunit.eq(f.capacity(), 4000 * 4 * 4)
  ccunit.eq(f.fuel(), 10000)
  ccunit.eq(f.waste(), 500)
  ccunit.eq(f.totalReactant(), 10500)
  ccunit.eq(f.fuelReactivity(), 1)
  ccunit.eq(f.burnedLastTick(), 0)
  f.ejectWaste() -- no access port with an inventory: nothing goes
  ccunit.eq(f.waste(), 500)
end)

ccunit.test("control rods", function()
  local r = peripheral.wrap("r")
  local rod = r.getControlRod(0)
  ccunit.eq(rod.valid(), true)
  ccunit.eq(rod.index(), 0)
  ccunit.eq(rod.name(), "north")
  ccunit.eq(rod.level(), 10)
  ccunit.eq(r.getControlRod(1).level(), 20)
  ccunit.eq(r.getControlRod(1.9).index(), 1) -- getInt truncates
  ccunit.eq(r.getControlRod(2).name(), "")
  rod.setLevel(55.5)
  ccunit.eq(rod.level(), 55.5)
  rod.setLevel(150)
  ccunit.eq(rod.level(), 100)
  rod.setLevel(-3)
  ccunit.eq(rod.level(), 0)
  rod.setLevel(0 / 0) -- NaN is ignored
  ccunit.eq(rod.level(), 0)
  rod.setName("core")
  ccunit.eq(r.getControlRod(0).name(), "core")
  r.setAllControlRodLevels(42)
  for i = 0, 3 do ccunit.eq(r.getControlRod(i).level(), 42) end
  r.setAllControlRodLevels(1 / 0)
  ccunit.eq(rod.level(), 100)
  ccunit.eq(err(rod.setLevel), "bad argument #1 (number expected, got nil)")
  ccunit.eq(err(rod.setLevel, "5"), "bad argument #1 (number expected, got string)")
  ccunit.eq(err(function() rod:setLevel(5) end), "bad argument #1 (number expected, got table)")
  ccunit.eq(err(rod.setName, 5), "bad argument #1 (string expected, got number)")
  ccunit.eq(err(r.getControlRod, 4), "Java Exception Thrown: java.lang.IndexOutOfBoundsException: Index 4 out of bounds for length 4")
  ccunit.eq(err(r.getControlRod, -1), "Java Exception Thrown: java.lang.IndexOutOfBoundsException: Index -1 out of bounds for length 4")
  ccunit.eq(err(r.getControlRod), "bad argument #1 (number expected, got nil)")
  ccunit.eq(err(r.getControlRod, 0 / 0), "bad argument #1 (number expected, got nan)")
  ccunit.eq(err(r.getControlRod, 1 / 0), "bad argument #1 (number expected, got inf)")
  ccunit.eq(err(r.setAllControlRodLevels, true), "bad argument #1 (number expected, got boolean)")
  ccunit.eq(err(r.setActive, 1), "bad argument #1 (boolean expected, got number)")
  r.setActive(true)
  ccunit.eq(r.active(), true)
  r.setActive(false)
end)

ccunit.test("an actively cooled reactor", function()
  local r = peripheral.wrap("hot")
  ccunit.eq(r.battery(), nil)
  local c = r.coolantTank()
  ccunit.eq(c.capacity(), 5 * 3 * 10000 + 4 * 3 * 10000)
  ccunit.eq(c.coldFluidAmount(), 5000)
  ccunit.eq(c.hotFluidAmount(), 70)
  ccunit.eq(c.transitionedLastTick(), 0)
  ccunit.eq(c.maxTransitionedLastTick(), 0)
  c.dump()
  ccunit.eq(c.coldFluidAmount(), 0)
  ccunit.eq(c.hotFluidAmount(), 0)
  ccunit.eq(r.fuelTank().fuel(), 0)
end)

ccunit.test("waste goes out whole ingots at a time", function()
  local f = peripheral.wrap("ports").fuelTank()
  f.ejectWaste() -- (autoEjectWaste does the same every tick) 2 ingots leave, 500 mB stay
  ccunit.eq(f.waste(), 500)
  sleep(0.2)
  ccunit.eq(f.waste(), 500)
  ccunit.eq(f.fuel(), 1000)
end)

ccunit.test("a reactor that is not assembled", function()
  local r = peripheral.wrap("broken")
  ccunit.eq(r.connected(), false)
  ccunit.eq(r.apiVersion(), "0.6.0-beta.1.4")
  ccunit.eq(err(r.active), "Invalid multiblock controller")
  ccunit.eq(err(r.setActive, true), "Invalid multiblock controller")
  ccunit.eq(err(r.battery), "Invalid multiblock controller")
  ccunit.eq(err(r.coolantTank), "Invalid multiblock controller")
  ccunit.eq(err(r.fuelTemperature), "Invalid multiblock controller")
  ccunit.eq(err(r.setAllControlRodLevels, 5), "Invalid multiblock controller")
  ccunit.eq(err(r.setAllControlRodLevels, "x"), "bad argument #1 (number expected, got string)")
  local f = r.fuelTank() -- the handle itself comes back
  ccunit.eq(err(f.fuel), "Invalid multiblock controller")
  ccunit.eq(r.controlRodCount(), 5)
  local rod = r.getControlRod(0)
  ccunit.eq(rod.valid(), true)
  ccunit.eq(err(rod.level), "Invalid multiblock controller")
end)

ccunit.test("turbine", function()
  local t = peripheral.wrap("t")
  ccunit.eq(t.apiVersion(), "0.6.0-beta.1.4")
  ccunit.eq(t.connected(), true)
  ccunit.eq(t.active(), false)
  ccunit.eq(t.coilEngaged(), true)
  t.setCoilEngaged(false)
  ccunit.eq(t.coilEngaged(), false)
  t.setCoilEngaged(true)
  ccunit.eq(err(t.setCoilEngaged), "bad argument #1 (boolean expected, got nil)")
  local b = t.battery()
  ccunit.eq(b.capacity(), 17 * 300000)
  ccunit.eq(b.stored(), 0)
  ccunit.eq(b.producedLastTick(), 0)
  local rotor = t.rotor()
  ccunit.eq(rotor.RPM(), 0)
  ccunit.eq(rotor.efficiencyLastTick(), 0)
  local tank = t.fluidTank()
  -- interior 5 x 8 x 5, 8 shafts, 16 coils
  ccunit.eq(tank.input().maxAmount(), (5 * 8 * 5 - (8 + 16)) * 10000)
  ccunit.eq(tank.input().name(), "minecraft:empty")
  ccunit.eq(tank.output().name(), "minecraft:empty")
  ccunit.eq(tank.input().amount(), 0)
  ccunit.eq(tank.flowRateLimit(), (5 * 5 - 1) * 5000)
  -- 6 bladed shafts of 4 arms of 2 blades: (1 + 2) * 4 * 6 = 72 linear metres; 72 * 20 / 1000 * 2 pi * 1800
  ccunit.eq(tank.nominalFlowRate(), math.floor(72 * 20 / 1000 * (2 * math.pi) * 1800))
  ccunit.eq(tank.flowLastTick(), 0)
  tank.setNominalFlowRate(1234.9)
  ccunit.eq(tank.nominalFlowRate(), 1234)
  tank.setNominalFlowRate(-5)
  ccunit.eq(tank.nominalFlowRate(), 0)
  tank.setNominalFlowRate(1e9)
  ccunit.eq(tank.nominalFlowRate(), 120000)
  ccunit.eq(err(tank.setNominalFlowRate, 0 / 0), "bad argument #1 (number expected, got nan)")
  ccunit.eq(err(tank.setNominalFlowRate, "1"), "bad argument #1 (number expected, got string)")
  local w = peripheral.wrap("wet").fluidTank()
  ccunit.eq(w.input().name(), "biggerreactors:steam")
  ccunit.eq(w.output().name(), "minecraft:water")
  ccunit.eq(w.input().amount(), 5000)
  ccunit.eq(w.output().amount(), 300)
  ccunit.eq(w.nominalFlowRate(), (3 * 3 - 1) * 5000)
end)

ccunit.test("a turbine that is not assembled", function()
  local t = peripheral.wrap("tb")
  ccunit.eq(t.connected(), false)
  ccunit.eq(err(t.active), "Invalid multiblock controller")
  ccunit.eq(err(t.coilEngaged), "Invalid multiblock controller")
  local b = t.battery()
  ccunit.eq(err(b.stored), "Invalid multiblock controller")
  ccunit.eq(err(t.rotor().RPM), "Invalid multiblock controller")
  ccunit.eq(err(t.fluidTank().input().name), "Invalid multiblock controller")
end)

ccunit.test("every method runs at once on the computer thread", function()
  local r = peripheral.wrap("r")
  local t = peripheral.wrap("t")
  os.queueEvent("mark")
  r.active(); r.fuelTank().fuel(); r.getControlRod(0).level(); t.rotor().RPM(); t.fluidTank().nominalFlowRate()
  r.setAllControlRodLevels(10); t.setActive(false)
  local ev = os.pullEvent()
  ccunit.eq(ev, "mark") -- nothing waited for a tick, so the event was not lost
end)
`,
      world,
      "ports.lua",
    );
    expectAllPassed(result);
  }, 90000);
});

describe.skipIf(!ready)("worlds/bigger-reactors-demo.json", () => {
  it("boots and every machine answers", async () => {
    const demo = loadNamedWorld(config.worldsDir, "bigger-reactors-demo");
    const result = await lua(
      `
ccunit.test("demo", function()
  local r = peripheral.wrap("BiggerReactors_Reactor_0")
  ccunit.eq(r.connected(), true)
  ccunit.eq(r.controlRodCount(), 5)
  ccunit.eq(r.battery(), nil)
  ccunit.eq(r.coolantTank().capacity() > 0, true)
  ccunit.eq(r.getControlRod(0).name(), "centre")
  local t = peripheral.wrap("BiggerReactors_Turbine_0")
  ccunit.eq(t.connected(), true)
  ccunit.eq(t.fluidTank().nominalFlowRate(), 2000)
  local p = peripheral.wrap("BiggerReactors_Reactor_1")
  ccunit.eq(p.battery().capacity() > 0, true)
  ccunit.eq(p.active(), true)
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

describe.skipIf(!ready)("Bigger Reactors simulation", () => {
  it("a passively cooled reactor, tick for tick against the Java", async () => {
    const layout = ["X.X", ".G.", "X.X"];
    await withSession(
      {
        biggerReactors: { seed: 7 },
        peripherals: [
          {
            name: "r",
            type: "BiggerReactors_Reactor",
            dimensions: [5, 6, 5],
            layout,
            legend: { G: "graphite" },
            fuel: 12000,
            active: true,
            load: 40,
            rodLevel: 25,
          },
        ],
      } as WorldConfig,
      async (step) => {
        const ref = new RefReactor(
          [5, 6, 5],
          layout,
          { G: GRAPHITE },
          {
            passive: true,
            fuel: 12000,
            load: 40,
            seed: 7,
            level: 25,
          },
        );
        let done = 0;
        for (const seconds of [0.05, 0.5, 3, 20, 40]) {
          const st = await step({ cmd: "advance", seconds });
          const n = gameTime(st);
          while (done < n) {
            ref.tick();
            done++;
          }
          const s = machine(st, "r");
          expect(s.fuel).toBe(ref.fuel);
          expect(s.waste).toBe(ref.waste);
          near(s.partialUsed, ref.partial);
          near(s.burnedLastTick, ref.burned);
          near(s.fertility, ref.fertility);
          near(s.fuelHeat, ref.fuelHeat.t);
          near(s.stackHeat, ref.stackHeat.t);
          expect(s.producedLastTick).toBe(ref.generated);
          expect(s.energy).toBe(ref.energy);
        }
        // the numbers a control program reads have moved the right way
        const s = machine(await step({ cmd: "advance", seconds: 0.05 }), "r");
        expect(s.fuelHeat as number).toBeGreaterThan(400);
        expect(s.energy as number).toBeGreaterThan(0);
        expect(s.producedLastTick as number).toBeGreaterThan(0);
        expect(s.fuel as number).toBeLessThan(12000);
        expect(s.fuelReactivity as number).toBeGreaterThan(1);
      },
    );
  }, 180000);

  it("an actively cooled reactor boils water into a turbine, tick for tick", async () => {
    const layout = ["XMX", "MXM", "XMX"];
    await withSession(
      {
        peripherals: [
          {
            name: "r",
            type: "BiggerReactors_Reactor",
            cooling: "active",
            dimensions: [5, 7, 5],
            layout,
            fuel: 20000,
            coolant: 40000,
            coolantSupply: 300,
            active: true,
            steamTo: "t",
          },
          {
            name: "t",
            type: "BiggerReactors_Turbine",
            dimensions: [7, 10, 7],
            rotor: [
              [2, 2, 2, 2],
              [2, 2, 2, 2],
              [2, 2, 2, 2],
              [2, 2, 2, 2],
              [2, 2, 2, 2],
              [2, 2, 2, 2],
              [0, 0, 0, 0],
              [0, 0, 0, 0],
            ],
            coils: { gold: 16 },
            active: true,
            load: 500,
          },
        ],
      } as WorldConfig,
      async (step) => {
        const r = new RefReactor(
          [5, 7, 5],
          layout,
          {},
          {
            passive: false,
            fuel: 20000,
            coolant: 40000,
            coolantSupply: 300,
          },
        );
        // "M" is a coolant manifold in an active reactor
        const t = new RefTurbine(
          [7, 10, 7],
          [...Array(6).fill([2, 2, 2, 2]), [0, 0, 0, 0], [0, 0, 0, 0]],
          16,
          { load: 500 },
        );
        let done = 0;
        for (const seconds of [0.05, 1, 10, 30]) {
          const st = await step({ cmd: "advance", seconds });
          const n = gameTime(st);
          while (done < n) {
            r.tick((v) => t.fillSteam(v));
            t.tick((w) => r.fillWater(w));
            done++;
          }
          const sr = machine(st, "r");
          const stt = machine(st, "t");
          expect(sr.fuel).toBe(r.fuel);
          near(sr.fuelHeat, r.fuelHeat.t);
          near(sr.stackHeat, r.stackHeat.t);
          expect(sr.coolant).toBe(r.liquid);
          expect(sr.steam).toBe(r.vapor);
          expect(sr.transitionedLastTick).toBe(r.transitioned);
          expect(sr.maxTransitionedLastTick).toBe(r.maxTransitioned);
          expect(stt.steam).toBe(t.steam);
          expect(stt.water).toBe(t.water);
          expect(stt.flowLastTick).toBe(t.flowLast);
          near(stt.rpm, t.rpm());
          near(stt.efficiencyLastTick, t.efficiency);
          expect(stt.energy).toBe(t.energy);
          expect(stt.producedLastTick).toBe(long(t.generated));
        }
        const st = await step({ cmd: "advance", seconds: 0.05 });
        expect(machine(st, "r").transitionedLastTick as number).toBeGreaterThan(
          0,
        );
        expect(machine(st, "t").rpm as number).toBeGreaterThan(10);
      },
    );
  }, 240000);

  it("a turbine on its own: spin-up, flow, vents and the inductor", async () => {
    await withSession(
      {
        peripherals: [
          {
            name: "t",
            type: "BiggerReactors_Turbine",
            dimensions: [7, 12, 7],
            shafts: 10,
            bladeLength: 2,
            bladedShafts: 8,
            coils: { gold: 16 },
            active: true,
            steamSupply: "full",
            waterDrain: "full",
            load: 2000,
          },
        ],
      },
      async (step) => {
        const ref = new RefTurbine(
          [7, 12, 7],
          [...Array(8).fill([2, 2, 2, 2]), [0, 0, 0, 0], [0, 0, 0, 0]],
          16,
          { load: 2000 },
        );
        let done = 0;
        for (const seconds of [0.05, 2, 20, 60]) {
          const st = await step({ cmd: "advance", seconds });
          const n = gameTime(st);
          while (done < n) {
            ref.tick((w) => w, ref.tankCap);
            done++;
          }
          const s = machine(st, "t");
          near(s.rpm, ref.rpm());
          near(s.efficiencyLastTick, ref.efficiency);
          expect(s.flowLastTick).toBe(ref.flowLast);
          expect(s.energy).toBe(ref.energy);
          expect(s.producedLastTick).toBe(long(ref.generated));
        }
        let s = machine(await step({ cmd: "advance", seconds: 0.05 }), "t");
        expect(s.rpm as number).toBeGreaterThan(100);
        expect(s.energy as number).toBeGreaterThan(0);
        // disengage the inductor: no power, the rotor speeds up
        const rpm = s.rpm as number;
        await step({ cmd: "brSetLoad", peripheral: "t", rate: 0 });
        const result = await step({ cmd: "advance", seconds: 0.05 });
        expect(machine(result, "t").load).toBe(0);
        s = machine(result, "t");
        expect(s.rpm as number).toBeGreaterThan(rpm * 0.9);
      },
    );
  }, 240000);

  it("sim commands, and rod handles that go stale when the reactor is rebuilt", async () => {
    put(
      "grab.lua",
      `
_G.oldRod = peripheral.wrap("r").getControlRod(0)
print("grabbed " .. tostring(_G.oldRod.valid()))
`,
    );
    put(
      "check.lua",
      `
local function err(fn, ...)
  local ok, e = pcall(fn, ...)
  return ok and "no error" or tostring(e)
end
local rod = _G.oldRod
local fresh = peripheral.wrap("r").getControlRod(0)
local got = table.concat({ tostring(rod.valid()), rod.index(), err(rod.level), err(rod.setLevel, 5),
  err(rod.setLevel, "x"), tostring(fresh.valid()), fresh.name() }, "|")
local want = "false|0|Invalid control rod object|Invalid control rod object|" ..
  "bad argument #1 (number expected, got string)|true|a"
print(got == want and "stale ok" or got)
`,
    );
    put(
      "coiloff.lua",
      `
peripheral.wrap("t").setCoilEngaged(false)
print("coil off")
`,
    );
    await withSession(
      {
        peripherals: [
          {
            name: "r",
            type: "BiggerReactors_Reactor",
            fuel: 0,
            controlRods: [{ name: "a" }],
          },
          { name: "t", type: "BiggerReactors_Turbine", coils: { gold: 8 } },
        ],
      },
      async (step, program) => {
        await program("grab", "grabbed true");
        let st = await step({
          cmd: "brAddFuel",
          peripheral: "r",
          amount: 5000,
        });
        expect(machine(st, "r").fuel).toBe(5000);
        st = await step({ cmd: "brAddFuel", peripheral: "r", amount: 99999 });
        expect(machine(st, "r").fuel).toBe(60000); // the default 5 x 5 x 5: 5 rods of 3 blocks, 4000 each
        st = await step({ cmd: "brAddWaste", peripheral: "r", amount: 10 });
        expect(machine(st, "r").waste).toBe(0); // already full
        st = await step({ cmd: "brSetActive", peripheral: "r", active: true });
        expect(machine(st, "r").active).toBe(true);
        st = await step({ cmd: "advance", seconds: 30 });
        let r = machine(st, "r");
        expect(r.energy as number).toBeGreaterThan(0);
        expect(r.fuel as number).toBeLessThan(60000);
        st = await step({
          cmd: "brDrainEnergy",
          peripheral: "r",
          amount: 1e12,
        });
        // drained to nothing; the ticks since then have only refilled a little
        expect(machine(st, "r").energy as number).toBeLessThan(
          r.energy as number,
        );
        st = await step({ cmd: "brSetLoad", peripheral: "r", rate: 1e9 });
        st = await step({ cmd: "advance", seconds: 1 });
        expect(machine(st, "r").energy).toBe(0);
        st = await step({
          cmd: "brSetAssembled",
          peripheral: "r",
          assembled: false,
        });
        r = machine(st, "r");
        expect(r.assembled).toBe(false);
        expect(r.active).toBe(false);
        st = await step({
          cmd: "brSetAssembled",
          peripheral: "r",
          assembled: true,
        });
        expect(machine(st, "r").assembled).toBe(true);
        await program("check", "stale ok");
        st = await step({ cmd: "brAddSteam", peripheral: "t", amount: 4000 });
        expect(machine(st, "t").steam).toBe(4000);
        st = await step({
          cmd: "brSetSteamSupply",
          peripheral: "t",
          rate: 100,
        });
        st = await step({ cmd: "brSetActive", peripheral: "t", active: true });
        st = await step({ cmd: "advance", seconds: 5 });
        expect(machine(st, "t").rpm as number).toBeGreaterThan(0);
        expect(machine(st, "t").water as number).toBeGreaterThan(0);
        // the turbine sends no water anywhere: the vent is on overflow, so the tank stays at most full
        expect(machine(st, "t").water as number).toBeLessThanOrEqual(
          machine(st, "t").tankCapacity as number,
        );
        st = await step({ cmd: "brSetSteamSupply", peripheral: "t", rate: 0 });
        // the spinning rotor would keep making energy between the drain and the read: disengage the coil
        await program("coiloff", "coil off");
        st = await step({
          cmd: "brDrainEnergy",
          peripheral: "t",
          amount: 1e12,
        });
        expect(machine(st, "t").energy).toBe(0);
      },
    );
  }, 240000);
});
