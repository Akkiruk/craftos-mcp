import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type KeyName, Keys, renderPng } from "@craftos-agent/rawterm";
import type { EngineHandle } from "./engine.js";
import {
  type SettleOptions,
  type UiRect,
  type UiSnapshot,
  type WaitingState,
  actAndSettle,
  describeAll,
  readWaiting,
  settle,
} from "./ui.js";
import type { SimCommand } from "./world.js";

/*
 * The cheap way to drive and verify any CC program, built on ui.ts:
 *  - compact / delta screen views (a few lines instead of a screenshot or a full dump)
 *  - named elements: learn once that colour #f15c5c is "DOUBLE", then touch("DOUBLE") everywhere
 *  - expectations that return pass/fail and only the evidence that matters
 *  - scripts: many steps in one call, stopping at the first failure with evidence saved to disk
 *  - a trace of what the program was handed and printed, and a diff of the sim state
 */

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface Label {
  /** Hex colour of the element, as reported by craftos_ui (case-insensitive). */
  readonly color: string;
  /** Only elements on this monitor. */
  readonly peripheral?: string;
  /** Only elements whose touch cell lies in this 1-based cell box (inclusive). */
  readonly region?: { x1: number; y1: number; x2: number; y2: number };
}

interface Memory {
  lastView: Map<number, UiSnapshot>;
  labels: Map<string, Label>;
  traceOffset: number;
  traceStderr: number;
  traceVersion: number;
  lastSim: unknown;
  failures: number;
}

const memories = new WeakMap<EngineHandle, Memory>();

function memory(handle: EngineHandle): Memory {
  let m = memories.get(handle);
  if (!m) {
    m = {
      lastView: new Map(),
      labels: new Map(),
      traceOffset: 0,
      traceStderr: 0,
      traceVersion: 0,
      lastSim: undefined,
      failures: 0,
    };
    memories.set(handle, m);
  }
  return m;
}

// ───────────────────────── labels ─────────────────────────

const normColor = (c: string): string => c.trim().toLowerCase();

export function setLabels(
  handle: EngineHandle,
  labels: Record<string, Label>,
): void {
  const m = memory(handle);
  for (const [name, label] of Object.entries(labels)) {
    if (!/^[\w .:+-]{1,40}$/.test(name))
      throw new Error(`bad label name: ${name}`);
    if (!/^#[0-9a-f]{6}$/i.test(label.color))
      throw new Error(`label ${name}: colour must look like #f15c5c`);
    m.labels.set(name, { ...label, color: normColor(label.color) });
  }
}

export function clearLabels(handle: EngineHandle, names?: string[]): void {
  const m = memory(handle);
  if (!names) m.labels.clear();
  else for (const n of names) m.labels.delete(n);
}

export function getLabels(handle: EngineHandle): Record<string, Label> {
  return Object.fromEntries(memory(handle).labels);
}

function labelsPath(worldsDir: string, file: string): string {
  if (!/^[\w.-]{1,64}$/.test(file) || file.startsWith("."))
    throw new Error(`labels file name must match [\\w.-]{1,64}: ${file}`);
  return join(worldsDir, "labels", `${file}.json`);
}

export function saveLabels(
  handle: EngineHandle,
  worldsDir: string,
  file: string,
): string {
  const path = labelsPath(worldsDir, file);
  mkdirSync(join(worldsDir, "labels"), { recursive: true });
  writeFileSync(path, JSON.stringify(getLabels(handle), null, 2));
  return path;
}

export function loadLabels(
  handle: EngineHandle,
  worldsDir: string,
  file: string,
): string[] {
  const path = labelsPath(worldsDir, file);
  if (!existsSync(path)) throw new Error(`no labels file ${path}`);
  const labels = JSON.parse(readFileSync(path, "utf8")) as Record<
    string,
    Label
  >;
  setLabels(handle, labels);
  return Object.keys(labels);
}

function matchesLabel(label: Label, snap: UiSnapshot, rect: UiRect): boolean {
  if (normColor(rect.color) !== label.color) return false;
  if (label.peripheral !== undefined && label.peripheral !== snap.peripheral)
    return false;
  const r = label.region;
  if (
    r &&
    (rect.cx < r.x1 || rect.cx > r.x2 || rect.cy < r.y1 || rect.cy > r.y2)
  )
    return false;
  return true;
}

function nameOf(
  labels: Map<string, Label>,
  snap: UiSnapshot,
  rect: UiRect,
): string | undefined {
  for (const [name, label] of labels)
    if (matchesLabel(label, snap, rect)) return name;
  return undefined;
}

export interface Found {
  readonly snapshot: UiSnapshot;
  readonly rect: UiRect;
}

/** All elements currently on screen carrying this label, largest first. */
export function findLabelled(
  handle: EngineHandle,
  name: string,
  snapshots: UiSnapshot[] = describeAll(handle),
): Found[] {
  const label = memory(handle).labels.get(name);
  if (!label) throw new Error(`no label "${name}" (see craftos_labels)`);
  const found: Found[] = [];
  for (const snapshot of snapshots)
    for (const rect of snapshot.rects)
      if (matchesLabel(label, snapshot, rect)) found.push({ snapshot, rect });
  return found.sort((a, b) => b.rect.area - a.rect.area);
}

// ───────────────────────── compact views and deltas ─────────────────────────

/** "NAME #rrggbb x,y WxH @cx,cy": one short string per element. */
export function rectString(rect: UiRect, name?: string): string {
  return `${name ? name + " " : ""}${rect.color} ${rect.x},${rect.y} ${rect.w}x${rect.h} @${rect.cx},${rect.cy}`;
}

function textString(t: UiSnapshot["texts"][number]): string {
  return `${t.x},${t.y} ${t.fg}/${t.bg} ${t.text}`;
}

export interface CompactScreen {
  readonly screen: string;
  readonly size: string;
  readonly hash: string;
  readonly bg: string;
  readonly rects: string[];
  readonly texts?: string[];
}

function screenName(s: UiSnapshot): string {
  return s.peripheral ?? "terminal";
}

export function compactScreen(
  handle: EngineHandle,
  snap: UiSnapshot,
): CompactScreen {
  const labels = memory(handle).labels;
  return {
    screen: screenName(snap),
    size: `${snap.width}x${snap.height}${snap.unit === "pixel" ? " px" : ""}`,
    hash: snap.hash,
    bg: snap.background,
    rects: snap.rects.map((r) => rectString(r, nameOf(labels, snap, r))),
    ...(snap.texts.length ? { texts: snap.texts.map(textString) } : {}),
  };
}

export interface DeltaScreen {
  readonly screen: string;
  readonly hash: string;
  readonly unchanged?: true;
  readonly size?: string;
  readonly bg?: string;
  readonly rects?: { added: string[]; removed: string[] };
  readonly texts?: { added: string[]; removed: string[] };
}

const rectKey = (r: UiRect): string => `${r.x},${r.y},${r.w},${r.h},${r.color}`;
const textKey = (t: UiSnapshot["texts"][number]): string =>
  `${t.x},${t.y},${t.fg},${t.bg},${t.text}`;

/**
 * What changed on each screen since the previous craftos_ui / craftos_script view of this session.
 * A screen seen for the first time is reported in full.
 */
export function uiDelta(
  handle: EngineHandle,
  snapshots: UiSnapshot[] = describeAll(handle),
): (CompactScreen | DeltaScreen)[] {
  const m = memory(handle);
  const out: (CompactScreen | DeltaScreen)[] = [];
  for (const snap of snapshots) {
    const prev = m.lastView.get(snap.window);
    m.lastView.set(snap.window, snap);
    if (!prev) {
      out.push(compactScreen(handle, snap));
      continue;
    }
    if (prev.hash === snap.hash) {
      out.push({ screen: screenName(snap), hash: snap.hash, unchanged: true });
      continue;
    }
    const before = new Set(prev.rects.map(rectKey));
    const now = new Set(snap.rects.map(rectKey));
    const beforeT = new Set(prev.texts.map(textKey));
    const nowT = new Set(snap.texts.map(textKey));
    const labels = m.labels;
    const sizeChanged =
      prev.width !== snap.width || prev.height !== snap.height;
    out.push({
      screen: screenName(snap),
      hash: snap.hash,
      ...(sizeChanged ? { size: `${snap.width}x${snap.height}` } : {}),
      ...(prev.background !== snap.background ? { bg: snap.background } : {}),
      rects: {
        added: snap.rects
          .filter((r) => !before.has(rectKey(r)))
          .map((r) => rectString(r, nameOf(labels, snap, r))),
        removed: prev.rects
          .filter((r) => !now.has(rectKey(r)))
          .map((r) => rectString(r, nameOf(labels, prev, r))),
      },
      ...(snap.texts.length || prev.texts.length
        ? {
            texts: {
              added: snap.texts
                .filter((t) => !beforeT.has(textKey(t)))
                .map(textString),
              removed: prev.texts
                .filter((t) => !nowT.has(textKey(t)))
                .map(textString),
            },
          }
        : {}),
    });
  }
  return out;
}

/** Remember the current screens as the baseline for the next delta without returning them. */
export function markUi(
  handle: EngineHandle,
  snapshots: UiSnapshot[] = describeAll(handle),
): void {
  const m = memory(handle);
  for (const snap of snapshots) m.lastView.set(snap.window, snap);
}

// ───────────────────────── sim commands that wait for the sim ─────────────────────────

/** Send a sim command and wait until the program has applied it (it is applied when the program next waits for an event). */
export async function sendAndWait(
  handle: EngineHandle,
  command: SimCommand,
  timeoutMs = 10000,
): Promise<boolean> {
  return (await sendCommandResult(handle, command, timeoutMs)).applied;
}

/**
 * sendAndWait, and whether the command worked: `error` is the sim's reason when it applied the command but the
 * command failed (no such peripheral, unknown player, ...). Tests that expect a refusal read it; tools report it.
 */
export async function sendCommandResult(
  handle: EngineHandle,
  command: SimCommand,
  timeoutMs = 10000,
): Promise<{ applied: boolean; error?: string }> {
  const seq = handle.sendCommand(command);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const waiting = readWaiting(handle);
    if ((waiting?.cmdSeq ?? 0) >= seq) {
      return waiting?.cmdError?.seq === seq
        ? { applied: true, error: waiting.cmdError.error }
        : { applied: true };
    }
    await sleep(15);
  }
  return { applied: false };
}

// ───────────────────────── sim state diff ─────────────────────────

type Json = unknown;

function isObject(v: Json): v is Record<string, Json> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Changes between two sim states: added/changed leaf values by path, appended array items, removed paths. */
export function diffJson(
  before: Json,
  after: Json,
  path = "",
  out: Record<string, unknown> = {},
): Record<string, unknown> {
  if (JSON.stringify(before) === JSON.stringify(after)) return out;
  if (isObject(before) && isObject(after)) {
    for (const key of new Set([
      ...Object.keys(before),
      ...Object.keys(after),
    ])) {
      const p = path ? `${path}.${key}` : key;
      if (!(key in after)) out[p] = { removed: before[key] };
      else if (!(key in before)) out[p] = { added: after[key] };
      else diffJson(before[key], after[key], p, out);
    }
    return out;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const prefix = before.every(
      (v, i) => JSON.stringify(v) === JSON.stringify(after[i]),
    );
    if (prefix && after.length > before.length) {
      out[path] = { appended: after.slice(before.length) };
      return out;
    }
  }
  out[path || "(root)"] = { from: before, to: after };
  return out;
}

/** Sim state, or just what changed since the last call (the first call returns everything). */
export function simState(handle: EngineHandle, delta: boolean): unknown {
  const state = handle.readState() ?? {};
  const m = memory(handle);
  const prev = m.lastSim;
  m.lastSim = state;
  if (!delta || prev === undefined) return state;
  const diff = diffJson(prev, state);
  return Object.keys(diff).length ? { changed: diff } : { changed: {} };
}

function getPath(
  root: unknown,
  path: string,
): { found: boolean; value: unknown } {
  let cur: unknown = root;
  for (const part of path.split(".").filter(Boolean)) {
    if (cur === null || cur === undefined)
      return { found: false, value: undefined };
    if (Array.isArray(cur) && /^\d+$/.test(part)) cur = cur[Number(part)];
    else if (typeof cur === "object" || typeof cur === "string") {
      const next = (cur as Record<string, unknown>)[part];
      if (next === undefined && !(part in Object(cur)))
        return { found: false, value: undefined };
      cur = next;
    } else return { found: false, value: undefined };
  }
  return { found: true, value: cur };
}

// ───────────────────────── expectations ─────────────────────────

export interface Expectation {
  /** Elements on screen. Default: at least one. */
  rect?: {
    color?: string;
    name?: string;
    peripheral?: string;
    min?: number;
    max?: number;
    /** Shorthand for max 0. */
    absent?: boolean;
  };
  /** Text-mode screens only (pixel-font text has no characters). */
  text?: {
    contains?: string;
    regex?: string;
    peripheral?: string;
    absent?: boolean;
  };
  /** What the program is blocked on. */
  waiting?: { blocked?: boolean; filter?: string };
  /** A value in the sim state, by dotted path (e.g. "balances.Alice", "ledger.length"). */
  sim?: {
    path: string;
    equals?: unknown;
    gte?: number;
    lte?: number;
    contains?: unknown;
    exists?: boolean;
  };
  /** True: some screen differs from the last view; false: nothing changed. */
  changed?: boolean;
}

export interface ExpectFailure {
  readonly expect: Expectation;
  readonly reason: string;
  /** The closest things that do exist, so the next move needs no extra look. */
  readonly nearest?: string[];
}

function colorDistance(a: string, b: string): number {
  const n = (s: string, i: number): number =>
    parseInt(s.slice(1 + i * 2, 3 + i * 2), 16);
  return Math.hypot(n(a, 0) - n(b, 0), n(a, 1) - n(b, 1), n(a, 2) - n(b, 2));
}

function inPeripheral(
  snap: UiSnapshot,
  peripheral: string | undefined,
): boolean {
  return peripheral === undefined || snap.peripheral === peripheral;
}

function evalOne(
  handle: EngineHandle,
  e: Expectation,
  snaps: UiSnapshot[],
  waiting: WaitingState | undefined,
): ExpectFailure | undefined {
  const m = memory(handle);
  if (e.rect) {
    const spec = e.rect;
    let color = spec.color ? normColor(spec.color) : undefined;
    let label: Label | undefined;
    if (spec.name) {
      label = m.labels.get(spec.name);
      if (!label)
        return {
          expect: e,
          reason: `no label "${spec.name}" (see craftos_labels)`,
        };
      color = label.color;
    }
    const hits: Found[] = [];
    for (const snap of snaps) {
      if (!inPeripheral(snap, spec.peripheral)) continue;
      for (const rect of snap.rects) {
        if (
          label
            ? !matchesLabel(label, snap, rect)
            : color && normColor(rect.color) !== color
        )
          continue;
        hits.push({ snapshot: snap, rect });
      }
    }
    const min = spec.absent ? 0 : (spec.min ?? 1);
    const max = spec.absent ? 0 : spec.max;
    if (hits.length >= min && (max === undefined || hits.length <= max))
      return undefined;
    const what = spec.name ?? spec.color ?? "element";
    const reason =
      hits.length < min
        ? `expected at least ${min} ${what}, found ${hits.length}`
        : `expected at most ${max} ${what}, found ${hits.length}`;
    let nearest: string[];
    if (hits.length > (max ?? Infinity)) {
      nearest = hits.slice(0, 5).map((h) => rectString(h.rect, spec.name));
    } else {
      const all = snaps
        .filter((s) => inPeripheral(s, spec.peripheral))
        .flatMap((s) => s.rects.map((rect) => ({ s, rect })));
      all.sort(
        (a, b) =>
          (color
            ? colorDistance(a.rect.color, color) -
              colorDistance(b.rect.color, color)
            : 0) || b.rect.area - a.rect.area,
      );
      nearest = all
        .slice(0, 5)
        .map((h) => rectString(h.rect, nameOf(m.labels, h.s, h.rect)));
    }
    return { expect: e, reason, nearest };
  }
  if (e.text) {
    const spec = e.text;
    const pool = snaps.filter((s) => inPeripheral(s, spec.peripheral));
    const runs = pool.flatMap((s) => s.texts.map((t) => t.text));
    const joined = runs.join("\n");
    let re: RegExp | undefined;
    if (spec.regex !== undefined) {
      try {
        re = new RegExp(spec.regex);
      } catch {
        return { expect: e, reason: `bad regex: ${spec.regex}` };
      }
    }
    const present =
      (spec.contains === undefined || joined.includes(spec.contains)) &&
      (re === undefined || re.test(joined));
    if (spec.absent ? !present : present) return undefined;
    const needle = spec.contains ?? spec.regex ?? "";
    const near = runs
      .filter(
        (t) =>
          needle && t.toLowerCase().includes(needle.toLowerCase().slice(0, 3)),
      )
      .slice(0, 5);
    return {
      expect: e,
      reason: spec.absent
        ? `text unexpectedly present: ${needle}`
        : `text not found: ${needle}${pool.every((s) => s.mode !== 0) ? " (no text-mode screen; pixel-font text cannot be read)" : ""}`,
      nearest: near.length ? near : runs.slice(0, 8),
    };
  }
  if (e.waiting) {
    const w = e.waiting;
    if (!waiting)
      return {
        expect: e,
        reason: "no beacon (program has not started waiting for input yet)",
      };
    if (w.blocked !== undefined && waiting.blocked !== w.blocked)
      return {
        expect: e,
        reason: `blocked is ${waiting.blocked}, expected ${w.blocked}`,
      };
    if (w.filter !== undefined && waiting.filter !== w.filter)
      return {
        expect: e,
        reason: `waiting for "${waiting.filter}", expected "${w.filter}"`,
      };
    return undefined;
  }
  if (e.sim) {
    const s = e.sim;
    const { found, value } = getPath(handle.readState() ?? {}, s.path);
    if (s.exists !== undefined && found !== s.exists)
      return {
        expect: e,
        reason: `${s.path} ${found ? "exists" : "does not exist"}`,
      };
    const fail = (reason: string): ExpectFailure => ({
      expect: e,
      reason,
      nearest: [`${s.path} = ${JSON.stringify(value) ?? "undefined"}`],
    });
    if (
      s.equals !== undefined &&
      JSON.stringify(value) !== JSON.stringify(s.equals)
    )
      return fail(
        `${s.path} is ${JSON.stringify(value)}, expected ${JSON.stringify(s.equals)}`,
      );
    if (s.gte !== undefined && !(typeof value === "number" && value >= s.gte))
      return fail(
        `${s.path} is ${JSON.stringify(value)}, expected >= ${s.gte}`,
      );
    if (s.lte !== undefined && !(typeof value === "number" && value <= s.lte))
      return fail(
        `${s.path} is ${JSON.stringify(value)}, expected <= ${s.lte}`,
      );
    if (s.contains !== undefined) {
      const has = Array.isArray(value)
        ? value.some(
            (v) =>
              JSON.stringify(v) === JSON.stringify(s.contains) ||
              (isObject(v) &&
                isObject(s.contains) &&
                Object.entries(s.contains).every(
                  ([k, x]) => JSON.stringify(v[k]) === JSON.stringify(x),
                )),
          )
        : typeof value === "string" && typeof s.contains === "string"
          ? value.includes(s.contains)
          : false;
      if (!has)
        return fail(`${s.path} does not contain ${JSON.stringify(s.contains)}`);
    }
    return undefined;
  }
  if (e.changed !== undefined) {
    const differs = snaps.some(
      (s) => m.lastView.get(s.window)?.hash !== s.hash,
    );
    if (differs !== e.changed)
      return {
        expect: e,
        reason: e.changed ? "nothing changed on screen" : "the screen changed",
      };
    return undefined;
  }
  return {
    expect: e,
    reason: "empty expectation (give rect, text, waiting, sim or changed)",
  };
}

export interface ExpectResult {
  readonly pass: boolean;
  readonly checked: number;
  readonly failures: ExpectFailure[];
  /** Files saved when something failed: PNGs per screen and a JSON dump. Read these only if needed. */
  readonly evidence?: string[];
}

export function evaluate(
  handle: EngineHandle,
  expectations: Expectation[],
  options: { evidence?: boolean } = {},
): ExpectResult {
  const snaps = describeAll(handle);
  const waiting = readWaiting(handle);
  const failures: ExpectFailure[] = [];
  for (const e of expectations) {
    const f = evalOne(handle, e, snaps, waiting);
    if (f) failures.push(f);
  }
  if (failures.length === 0)
    return { pass: true, checked: expectations.length, failures };
  const evidence =
    options.evidence === false
      ? undefined
      : saveEvidence(handle, snaps, waiting);
  return {
    pass: false,
    checked: expectations.length,
    failures,
    ...(evidence ? { evidence } : {}),
  };
}

/**
 * Wait for the program to settle, then evaluate. Games animate with timers, so a screen can sit still
 * between frames: with `waitMs` the check is retried until it passes or that long has passed (the last
 * result is returned), instead of failing on a transition.
 */
export async function expectSettled(
  handle: EngineHandle,
  expectations: Expectation[],
  options: SettleOptions & {
    evidence?: boolean;
    settle?: boolean;
    waitMs?: number;
  } = {},
): Promise<ExpectResult> {
  const deadline = Date.now() + (options.waitMs ?? 0);
  for (;;) {
    if (options.settle !== false) await settle(handle, options);
    const quiet = Date.now() >= deadline;
    const result = evaluate(handle, expectations, {
      evidence: quiet ? options.evidence : false,
    });
    if (result.pass || quiet) return result;
    await sleep(100);
  }
}

/** PNG per screen plus a JSON dump of what the harness saw, saved in the session folder. */
export function saveEvidence(
  handle: EngineHandle,
  snaps: UiSnapshot[] = describeAll(handle),
  waiting: WaitingState | undefined = readWaiting(handle),
): string[] {
  const m = memory(handle);
  m.failures += 1;
  const dir = join(handle.dir, "failures");
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  const stem = `fail-${m.failures}`;
  for (const w of handle.session.allWindows()) {
    if (!w.frame) continue;
    const file = join(dir, `${stem}-${w.peripheral ?? "terminal"}.png`);
    writeFileSync(file, renderPng(w.frame, { scale: 3 }));
    files.push(file);
  }
  const dump = join(dir, `${stem}.json`);
  writeFileSync(
    dump,
    JSON.stringify(
      {
        waiting,
        screens: snaps.map((s) => compactScreen(handle, s)),
        sim: handle.readState(),
        trace: readTraceFile(handle, 0).lines.slice(-40),
      },
      null,
      2,
    ),
  );
  files.push(dump);
  return files;
}

// ───────────────────────── trace ─────────────────────────

export interface TraceResult {
  /** Events handed to the program since the last call: "key 65", "monitor_touch right 5 3". */
  readonly events: string[];
  /** Everything it printed. */
  readonly output: string[];
  /** printError output and uncaught errors. */
  readonly errors: string[];
  /** Number of screen updates since the last call. */
  readonly screenUpdates: number;
  /** Lines the engine process wrote to stderr (crashes, Lua panics). */
  readonly stderr: string[];
  readonly running: boolean;
  readonly exitCode?: number | null | undefined;
  /** Older lines dropped to keep the result small. */
  readonly dropped: number;
}

function readTraceFile(
  handle: EngineHandle,
  from: number,
): { lines: string[]; end: number } {
  const file = join(handle.resultsDir, "trace.log");
  try {
    const size = statSync(file).size;
    if (size <= from) return { lines: [], end: from };
    const buf = readFileSync(file);
    const slice = buf.subarray(from);
    // only complete lines
    const cut = slice.lastIndexOf(10);
    if (cut < 0) return { lines: [], end: from };
    const text = slice.subarray(0, cut).toString("utf8");
    return { lines: text.split("\n").filter(Boolean), end: from + cut + 1 };
  } catch {
    return { lines: [], end: from };
  }
}

/** What the program was handed and printed since the last call, without screenshots or log reading. */
export function readTrace(
  handle: EngineHandle,
  options: { maxLines?: number; reset?: boolean } = {},
): TraceResult {
  const m = memory(handle);
  const maxLines = options.maxLines ?? 60;
  const { lines, end } = readTraceFile(handle, m.traceOffset);
  m.traceOffset = end;
  let version = 0;
  for (const w of handle.session.allWindows()) version += w.version;
  const screenUpdates = Math.max(0, version - m.traceVersion);
  m.traceVersion = version;
  const stderr = handle.stderr
    .slice(m.traceStderr)
    .join("")
    .split("\n")
    .filter(Boolean);
  m.traceStderr = handle.stderr.length;
  if (options.reset)
    return {
      events: [],
      output: [],
      errors: [],
      screenUpdates: 0,
      stderr: [],
      running: handle.session.running,
      dropped: lines.length,
    };
  const dropped = Math.max(0, lines.length - maxLines);
  const keep = lines.slice(-maxLines);
  const stamp = (kind: string): string[] =>
    keep
      .filter((l) => l.split(" ", 2)[1] === kind)
      .map((l) => {
        const first = l.indexOf(" ");
        const second = l.indexOf(" ", first + 1);
        return `${(Number(l.slice(0, first)) / 1000).toFixed(1)}s ${l.slice(second + 1)}`;
      });
  return {
    events: stamp("E"),
    output: stamp("O"),
    errors: stamp("X"),
    screenUpdates,
    stderr: stderr.slice(-20),
    running: handle.session.running,
    exitCode: handle.session.exitInfo?.code,
    dropped,
  };
}

// ───────────────────────── held keys and named touches ─────────────────────────

/** How long ctrl+t must be held before CC queues `terminate` (TerminalWidget's terminate timer). */
export const TERMINATE_HOLD_MS = 1000;
/** Key repeat while a key is held: one `key` event with held=true per client tick. */
const KEY_REPEAT_MS = 50;

/**
 * Hold a key down for `ms`, as a player does. A plain key sends `key`, then `key` with held=true every tick, then
 * `key_up`. With ctrl, t does what CC's TerminalWidget does: no `key` for the t itself, and once it has been held for
 * TERMINATE_HOLD_MS the computer gets `terminate`. A shorter hold, like a tap, sends nothing but ctrl's own events.
 */
export async function holdKey(
  handle: EngineHandle,
  key: string,
  options: { ms: number; ctrl?: boolean; shift?: boolean },
): Promise<void> {
  if (!(key in Keys)) throw new Error(`unknown key "${key}"`);
  const raw = handle.session;
  const terminating = options.ctrl === true && key === "t";
  if (options.ctrl) raw.key("leftCtrl");
  if (options.shift) raw.key("leftShift");
  const start = Date.now();
  let terminated = false;
  if (!terminating) raw.key(key as KeyName);
  for (;;) {
    const held = Date.now() - start;
    if (terminating && !terminated && held >= TERMINATE_HOLD_MS) {
      raw.event("terminate");
      terminated = true;
    }
    if (held >= options.ms) break;
    await sleep(Math.min(KEY_REPEAT_MS, options.ms - held));
    if (!terminating && Date.now() - start < options.ms)
      raw.key(key as KeyName, { held: true });
  }
  if (!terminating) raw.key(key as KeyName, { up: true });
  if (options.shift) raw.key("leftShift", { up: true });
  if (options.ctrl) raw.key("leftCtrl", { up: true });
}

/**
 * Touch a monitor cell, optionally as a named player: each touch carries its own player, so two players' touches
 * close together keep their own names. A name the world does not hold is an error, not a touch by someone else.
 */
export function touchMonitorAs(
  handle: EngineHandle,
  monitor: string,
  x: number,
  y: number,
  player?: string,
): void {
  if (player !== undefined) {
    const balances = handle.readState()?.balances;
    const known =
      balances &&
      Object.keys(balances).some(
        (n) => n.toLowerCase() === player.toLowerCase(),
      );
    if (!known)
      throw new Error(
        `unknown player "${player}": add them first (world players or the addPlayer sim command)`,
      );
  }
  handle.session.touchMonitor(monitor, x, y, player);
}

// ───────────────────────── scripts ─────────────────────────

export interface TouchTarget {
  readonly monitor?: string;
  readonly x?: number;
  readonly y?: number;
  /** The player who touches. Default: the interacting player. A name the world does not hold is an error. */
  readonly player?: string;
  /** A label name (see craftos_labels); the largest matching element is touched. */
  readonly name?: string;
  /** Which match to touch when several elements carry the label (0 = largest). */
  readonly index?: number;
}

export interface Step {
  touch?: TouchTarget;
  key?: string;
  ctrl?: boolean;
  shift?: boolean;
  /** With key: hold it down this many ms instead of tapping it. Holding ctrl+t for a second terminates. */
  hold?: number;
  text?: string;
  /** With text: press Enter afterwards (default false in scripts). */
  enter?: boolean;
  expect?: Expectation[];
  /** With expect: keep re-checking for this long before failing (default 2000 ms). */
  waitMs?: number;
  /** Jump the virtual clock forward and fire the timers that fall due. */
  advance?: number;
  /** A sim command (setBalance, chat, interact, ...). */
  sim?: SimCommand;
  /** Pin math.random to this seed. */
  seed?: number;
  /** Wait for the program to be idle without doing anything. */
  settle?: boolean;
  /** Touch/key/text steps fail when the program never consumed the input; set true to allow that. */
  lenient?: boolean;
  /** Free text echoed in the result next to a failing step. */
  note?: string;
}

export interface ScriptOptions extends SettleOptions {
  /** Stop at the first failing step (default true). */
  stopOnFail?: boolean;
  /** What to return for the screens at the end. */
  ui?: "none" | "delta" | "full";
  evidence?: boolean;
}

export interface StepFailure {
  readonly step: number;
  readonly action: string;
  readonly reason: string;
  readonly failures?: ExpectFailure[];
  readonly note?: string;
}

export interface ScriptResult {
  readonly ok: boolean;
  readonly steps: number;
  readonly ran: number;
  readonly failures: StepFailure[];
  readonly evidence?: string[];
  readonly ui?: (CompactScreen | DeltaScreen)[];
  readonly waiting: { blocked: boolean; filter: string } | null;
  readonly elapsedMs: number;
}

function describeStep(step: Step): string {
  if (step.touch)
    return `touch ${step.touch.name ?? `${step.touch.monitor}@${step.touch.x},${step.touch.y}`}`;
  if (step.key !== undefined)
    return step.hold !== undefined
      ? `hold ${step.ctrl ? "ctrl+" : ""}${step.key} ${step.hold}ms`
      : `key ${step.key}`;
  if (step.text !== undefined) return `text ${JSON.stringify(step.text)}`;
  if (step.expect) return `expect ×${step.expect.length}`;
  if (step.advance !== undefined) return `advance ${step.advance}s`;
  if (step.sim) return `sim ${step.sim.cmd}`;
  if (step.seed !== undefined) return `seed ${step.seed}`;
  return "settle";
}

function resolveTouch(
  handle: EngineHandle,
  t: TouchTarget,
): { monitor: string; x: number; y: number } {
  if (t.name !== undefined) {
    const found = findLabelled(handle, t.name);
    const pick = found[t.index ?? 0];
    if (!pick) {
      const label = memory(handle).labels.get(t.name)!;
      const near = describeAll(handle)
        .flatMap((s) => s.rects.map((rect) => ({ s, rect })))
        .sort(
          (a, b) =>
            colorDistance(a.rect.color, label.color) -
            colorDistance(b.rect.color, label.color),
        )
        .slice(0, 3)
        .map((h) => rectString(h.rect, undefined));
      throw new Error(
        `label "${t.name}" (${label.color}) is not on screen; closest: ${near.join(" | ") || "nothing"}`,
      );
    }
    if (pick.snapshot.peripheral === undefined)
      throw new Error(
        `"${t.name}" is on the terminal, which cannot be touched; use key or text`,
      );
    return {
      monitor: pick.snapshot.peripheral,
      x: pick.rect.cx,
      y: pick.rect.cy,
    };
  }
  if (t.monitor === undefined || t.x === undefined || t.y === undefined)
    throw new Error("touch needs a name, or monitor with x and y");
  return { monitor: t.monitor, x: t.x, y: t.y };
}

/** Run many steps in one call. Returns only what failed, plus an optional compact view of the end state. */
export async function runScript(
  handle: EngineHandle,
  steps: Step[],
  options: ScriptOptions = {},
): Promise<ScriptResult> {
  const start = Date.now();
  const stopOnFail = options.stopOnFail ?? true;
  const failures: StepFailure[] = [];
  const evidence: string[] = [];
  const raw = handle.session;
  let ran = 0;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const action = describeStep(step);
    const fail = (reason: string, extra: Partial<StepFailure> = {}): void => {
      failures.push({
        step: i,
        action,
        reason,
        ...(step.note ? { note: step.note } : {}),
        ...extra,
      });
    };
    ran++;
    try {
      const settleOpts = {
        quietMs: options.quietMs,
        timeoutMs: options.timeoutMs,
      };
      const input = async (
        send: () => void,
        expectEvent: string,
      ): Promise<void> => {
        const r = await actAndSettle(handle, send, {
          ...settleOpts,
          expect: expectEvent,
        });
        if (!r.consumed && !step.lenient)
          fail(
            `the program never consumed the ${expectEvent} (it was not waiting for it)`,
          );
        else if (!r.settled)
          fail(
            "the program did not settle (still busy or the screen keeps changing)",
          );
      };
      if (step.touch) {
        const { monitor, x, y } = resolveTouch(handle, step.touch);
        const player = step.touch.player;
        await input(
          () => touchMonitorAs(handle, monitor, x, y, player),
          "monitor_touch",
        );
      } else if (step.key !== undefined && step.hold !== undefined) {
        const key = step.key;
        if (!(key in Keys)) throw new Error(`unknown key "${key}"`);
        const hold = step.hold;
        let holding: Promise<void> = Promise.resolve();
        await input(
          () => {
            holding = holdKey(handle, key, {
              ms: hold,
              ctrl: step.ctrl,
              shift: step.shift,
            });
          },
          step.ctrl && key === "t" && step.hold >= TERMINATE_HOLD_MS
            ? "terminate"
            : "key",
        );
        await holding;
      } else if (step.key !== undefined) {
        const key = step.key;
        if (!(key in Keys)) throw new Error(`unknown key "${key}"`);
        await input(() => {
          if (step.ctrl) raw.key("leftCtrl");
          if (step.shift) raw.key("leftShift");
          raw.tap(key as KeyName);
          if (step.shift) raw.key("leftShift", { up: true });
          if (step.ctrl) raw.key("leftCtrl", { up: true });
        }, "key");
      } else if (step.text !== undefined) {
        const typed = step.text;
        await input(() => {
          raw.char(typed);
          if (step.enter) raw.tap(Keys.enter);
        }, "char");
      } else if (step.expect) {
        const r = await expectSettled(handle, step.expect, {
          ...settleOpts,
          evidence: false,
          waitMs: step.waitMs ?? 2000,
        });
        if (!r.pass)
          fail(`${r.failures.length} of ${r.checked} expectations failed`, {
            failures: r.failures,
          });
      } else if (step.advance !== undefined) {
        if (
          !(await sendAndWait(handle, {
            cmd: "advance",
            seconds: step.advance,
          }))
        )
          fail(
            "the program did not apply the clock jump (it never waited for an event)",
          );
        await settle(handle, settleOpts);
      } else if (step.sim) {
        const result = await sendCommandResult(handle, step.sim);
        if (!result.applied)
          fail(
            "the program did not apply the sim command (it never waited for an event)",
          );
        if (result.error !== undefined)
          fail(`the sim command failed: ${result.error}`);
        await settle(handle, settleOpts);
      } else if (step.seed !== undefined) {
        if (!(await sendAndWait(handle, { cmd: "seed", value: step.seed })))
          fail("the program did not apply the seed");
      } else {
        const r = await settle(handle, settleOpts);
        if (!r.settled) fail("the program did not settle");
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    if (
      failures.length > 0 &&
      failures[failures.length - 1]!.step === i &&
      stopOnFail
    )
      break;
  }
  if (failures.length > 0 && options.evidence !== false)
    evidence.push(...saveEvidence(handle));
  const waiting = readWaiting(handle);
  const mode = options.ui ?? "delta";
  return {
    ok: failures.length === 0,
    steps: steps.length,
    ran,
    failures,
    ...(evidence.length ? { evidence } : {}),
    ...(mode === "none"
      ? {}
      : {
          ui:
            mode === "full"
              ? (() => {
                  const snaps = describeAll(handle);
                  markUi(handle, snaps);
                  return snaps.map((s) => compactScreen(handle, s));
                })()
              : uiDelta(handle),
        }),
    waiting: waiting
      ? { blocked: waiting.blocked, filter: waiting.filter }
      : null,
    elapsedMs: Date.now() - start,
  };
}
