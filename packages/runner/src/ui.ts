import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type TerminalFrame, type WindowState } from "@craftos-agent/rawterm";
import type { EngineHandle } from "./engine.js";

/*
 * Screenshot-free introspection of any CC program:
 *  - describeFrame(): solid rectangles (buttons, cards, panels) and text runs as data
 *  - readWaiting():   what event the program is blocked on and which events it was handed
 *  - actAndSettle():  send input, wait until the program consumed it and the screen stopped changing
 */

const CELL_W = 6;
const CELL_H = 9;

export interface UiRect {
  /** Bounding box in grid units (0-based). `unit` says what a grid unit is. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly color: string;
  /** Cells covered by the rectangle's colour (text inside a button does not count). */
  readonly area: number;
  /** 1-based terminal cell at the centre: pass straight to a monitor_touch. */
  readonly cx: number;
  readonly cy: number;
}

export interface UiTextRun {
  /** 1-based cell of the first character. */
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly fg: string;
  readonly bg: string;
}

export interface UiSnapshot {
  readonly window: number;
  readonly peripheral: string | undefined;
  readonly mode: 0 | 1 | 2;
  /** Terminal size in characters. */
  readonly width: number;
  readonly height: number;
  /** "cell" when every character cell is one flat colour (typical for pixel UIs drawn per cell). */
  readonly unit: "cell" | "pixel";
  readonly background: string;
  readonly rects: UiRect[];
  /** Mode 0 only: text with its colours. Pixel-drawn text has no characters to read. */
  readonly texts: UiTextRun[];
  /** Changes whenever anything on screen changes. */
  readonly hash: string;
}

export interface DescribeOptions {
  /** Smallest rectangle (in grid cells of colour) worth reporting. Default 40. */
  readonly minArea?: number;
  /** Smallest side of a rectangle. Default 3. */
  readonly minSide?: number;
  /** Cap on reported rectangles, largest first. Default 200. */
  readonly maxRects?: number;
}

function hex(palette: Uint8Array, index: number): string {
  const c = (n: number): string =>
    (palette[index * 3 + n] ?? 0).toString(16).padStart(2, "0");
  return `#${c(0)}${c(1)}${c(2)}`;
}

interface Grid {
  readonly gw: number;
  readonly gh: number;
  readonly unit: "cell" | "pixel";
  readonly idx: Uint8Array;
}

function buildGrid(frame: TerminalFrame): Grid {
  const { width, height } = frame;
  if (frame.mode === 0) {
    const idx = new Uint8Array(width * height);
    for (let i = 0; i < idx.length; i++)
      idx[i] = (frame.colors[i] ?? 0xf0) >> 4;
    return { gw: width, gh: height, unit: "cell", idx };
  }
  const pw = width * CELL_W;
  const ph = height * CELL_H;
  const cells = new Uint8Array(width * height);
  let flat = 0;
  for (let cy = 0; cy < height; cy++) {
    for (let cx = 0; cx < width; cx++) {
      const first = frame.pixels[cy * CELL_H * pw + cx * CELL_W] ?? 0;
      let uniform = true;
      for (let y = 0; y < CELL_H && uniform; y++)
        for (let x = 0; x < CELL_W; x++)
          if (
            frame.pixels[(cy * CELL_H + y) * pw + cx * CELL_W + x] !== first
          ) {
            uniform = false;
            break;
          }
      cells[cy * width + cx] = first;
      if (uniform) flat++;
    }
  }
  if (flat >= cells.length * 0.995) {
    return { gw: width, gh: height, unit: "cell", idx: cells };
  }
  const idx = new Uint8Array(pw * ph);
  for (let i = 0; i < idx.length; i++) idx[i] = frame.pixels[i] ?? 0;
  return { gw: pw, gh: ph, unit: "pixel", idx };
}

function fnv(data: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h ^= data[i]!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Connected same-colour regions whose outline is a complete rectangle. */
function findRects(
  grid: Grid,
  bgIndex: number,
  palette: Uint8Array,
  frame: TerminalFrame,
  opts: Required<DescribeOptions>,
): UiRect[] {
  const { gw, gh, idx } = grid;
  const seen = new Uint8Array(gw * gh);
  const out: UiRect[] = [];
  const stack: number[] = [];
  // grid units per terminal cell
  const divX = grid.unit === "cell" ? 1 : CELL_W;
  const divY = grid.unit === "cell" ? 1 : CELL_H;
  for (let start = 0; start < idx.length; start++) {
    if (seen[start] || idx[start] === bgIndex) continue;
    const color = idx[start]!;
    let minX = gw,
      minY = gh,
      maxX = -1,
      maxY = -1,
      area = 0;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % gw;
      const y = (p - x) / gw;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && !seen[p - 1] && idx[p - 1] === color) {
        seen[p - 1] = 1;
        stack.push(p - 1);
      }
      if (x < gw - 1 && !seen[p + 1] && idx[p + 1] === color) {
        seen[p + 1] = 1;
        stack.push(p + 1);
      }
      if (y > 0 && !seen[p - gw] && idx[p - gw] === color) {
        seen[p - gw] = 1;
        stack.push(p - gw);
      }
      if (y < gh - 1 && !seen[p + gw] && idx[p + gw] === color) {
        seen[p + gw] = 1;
        stack.push(p + gw);
      }
    }
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    if (area < opts.minArea || w < opts.minSide || h < opts.minSide) continue;
    // A button with a label has holes, but its outline is complete; glyph strokes and diagonals are not.
    let ring = 0;
    for (let x = minX; x <= maxX; x++) {
      if (idx[minY * gw + x] === color) ring++;
      if (idx[maxY * gw + x] === color) ring++;
    }
    for (let y = minY + 1; y < maxY; y++) {
      if (idx[y * gw + minX] === color) ring++;
      if (idx[y * gw + maxX] === color) ring++;
    }
    const perimeter = h === 1 ? w : w === 1 ? h : 2 * (w + h) - 4;
    if (ring < perimeter * 0.95) continue;
    const cxCell = Math.floor((minX + (w - 1) / 2) / divX) + 1;
    const cyCell = Math.floor((minY + (h - 1) / 2) / divY) + 1;
    out.push({
      x: minX,
      y: minY,
      w,
      h,
      color: hex(palette, color),
      area,
      cx: Math.min(frame.width, cxCell),
      cy: Math.min(frame.height, cyCell),
    });
  }
  out.sort((a, b) => b.area - a.area);
  return out.slice(0, opts.maxRects);
}

function textRuns(frame: TerminalFrame): UiTextRun[] {
  const runs: UiTextRun[] = [];
  for (let y = 0; y < frame.height; y++) {
    let x = 0;
    while (x < frame.width) {
      const i = y * frame.width + x;
      const ch = frame.text[i] ?? 32;
      if (ch === 32 || ch === 0) {
        x++;
        continue;
      }
      const attr = frame.colors[i] ?? 0xf0;
      let end = x;
      let gap = 0;
      let last = x;
      while (end < frame.width) {
        const j = y * frame.width + end;
        if ((frame.colors[j] ?? 0xf0) !== attr) break;
        const c = frame.text[j] ?? 32;
        if (c === 32 || c === 0) {
          if (++gap >= 2) break;
        } else {
          gap = 0;
          last = end;
        }
        end++;
      }
      let text = "";
      for (let k = x; k <= last; k++) {
        const c = frame.text[y * frame.width + k] ?? 32;
        text += String.fromCharCode(c === 0 ? 32 : c);
      }
      runs.push({
        x: x + 1,
        y: y + 1,
        text,
        fg: hex(frame.palette, attr & 15),
        bg: hex(frame.palette, attr >> 4),
      });
      x = last + 1;
    }
  }
  return runs;
}

/** Describe one window's frame as data: rectangles, text runs and a change hash. */
export function describeFrame(
  window: Pick<WindowState, "id" | "peripheral">,
  frame: TerminalFrame,
  options: DescribeOptions = {},
): UiSnapshot {
  const opts: Required<DescribeOptions> = {
    minArea: options.minArea ?? 40,
    minSide: options.minSide ?? 3,
    maxRects: options.maxRects ?? 200,
  };
  const grid = buildGrid(frame);
  const counts = new Map<number, number>();
  for (let i = 0; i < grid.idx.length; i++)
    counts.set(grid.idx[i]!, (counts.get(grid.idx[i]!) ?? 0) + 1);
  let bg = 0;
  let best = -1;
  for (const [k, n] of counts) if (n > best) ((best = n), (bg = k));
  const hashInput =
    frame.mode === 0
      ? Uint8Array.from([...frame.text, ...frame.colors])
      : frame.pixels;
  return {
    window: window.id,
    peripheral: window.peripheral,
    mode: frame.mode,
    width: frame.width,
    height: frame.height,
    unit: grid.unit,
    background: hex(frame.palette, bg),
    rects: findRects(grid, bg, frame.palette, frame, opts),
    texts: frame.mode === 0 ? textRuns(frame) : [],
    hash: fnv(hashInput),
  };
}

export interface WaitingState {
  /** Monotonic write counter. */
  readonly seq: number;
  /** True while the program sits in os.pullEvent waiting for input. */
  readonly blocked: boolean;
  /** The event name it filters for, or "*" for any. */
  readonly filter: string;
  /** Newest host command the sim has applied (see EngineHandle.sendCommand's return value). */
  readonly cmdSeq?: number;
  /** The newest host command that failed with a reason, if any. */
  readonly cmdError?: { readonly seq: number; readonly error: string };
  /** Events handed to the program so far, by name. */
  readonly delivered: Record<string, number>;
  /** The last non-timer events delivered, newest last. */
  readonly last: (string | number | boolean)[][];
}

export function readWaiting(
  handle: Pick<EngineHandle, "resultsDir">,
): WaitingState | undefined {
  try {
    const raw = JSON.parse(
      readFileSync(join(handle.resultsDir, "waiting.json"), "utf8"),
    ) as Record<string, unknown>;
    // CC's JSON encoder writes an empty table as {}.
    const last = Array.isArray(raw["last"]) ? raw["last"] : [];
    return { ...(raw as object), last } as WaitingState;
  } catch {
    return undefined;
  }
}

function frameVersion(handle: EngineHandle): number {
  let v = 0;
  for (const w of handle.session.allWindows()) v += w.version;
  return v;
}

export interface SettleOptions {
  /** Screen and program must be quiet for this long (real ms). Default 250. */
  readonly quietMs?: number;
  /** Give up after this long (real ms). Default 15000. */
  readonly timeoutMs?: number;
}

export interface SettleResult {
  readonly settled: boolean;
  readonly waiting: WaitingState | undefined;
  readonly elapsedMs: number;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait until the program is blocked waiting for input and the screen has stopped changing.
 * Programs that never block (busy loops) settle on the screen alone once the timeout passes.
 */
export async function settle(
  handle: EngineHandle,
  options: SettleOptions = {},
): Promise<SettleResult> {
  const quietMs = options.quietMs ?? 250;
  const timeoutMs = options.timeoutMs ?? 15000;
  const start = Date.now();
  let lastVersion = frameVersion(handle);
  let quietSince = Date.now();
  for (;;) {
    await sleep(30);
    const now = Date.now();
    const version = frameVersion(handle);
    if (version !== lastVersion) {
      lastVersion = version;
      quietSince = now;
    }
    const waiting = readWaiting(handle);
    const ready = waiting === undefined || waiting.blocked;
    if (ready && now - quietSince >= quietMs) {
      return { settled: true, waiting, elapsedMs: now - start };
    }
    if (now - start >= timeoutMs) {
      return { settled: false, waiting, elapsedMs: now - start };
    }
  }
}

export interface ActOptions extends SettleOptions {
  /** Event the input should produce, e.g. "monitor_touch" or "key". Waits until the program consumed it. */
  readonly expect?: string;
}

export interface ActResult extends SettleResult {
  /** False when the program never consumed the expected event (it was not listening). */
  readonly consumed: boolean;
}

/** Send input, wait until the program consumed it, then wait for the screen to settle. */
export async function actAndSettle(
  handle: EngineHandle,
  act: () => void,
  options: ActOptions = {},
): Promise<ActResult> {
  const before = readWaiting(handle)?.delivered ?? {};
  act();
  let consumed = options.expect === undefined;
  if (options.expect !== undefined) {
    const start = Date.now();
    const timeoutMs = options.timeoutMs ?? 15000;
    while (Date.now() - start < timeoutMs) {
      const now = readWaiting(handle)?.delivered ?? {};
      if ((now[options.expect] ?? 0) > (before[options.expect] ?? 0)) {
        consumed = true;
        break;
      }
      await sleep(30);
    }
  }
  const result = await settle(handle, options);
  return { ...result, consumed };
}

/** Describe every open window of a session. */
export function describeAll(
  handle: EngineHandle,
  options: DescribeOptions = {},
): UiSnapshot[] {
  return handle.session
    .allWindows()
    .filter((w) => w.frame !== undefined)
    .map((w) => describeFrame(w, w.frame!, options));
}
