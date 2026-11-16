export const PacketType = {
  Terminal: 0,
  Key: 1,
  Mouse: 2,
  Event: 3,
  Window: 4,
  Message: 5,
  Features: 6,
  FileRequest: 7,
  FileResponse: 8,
  FileData: 9,
  Speaker: 10,
} as const;

export const FeatureBit = {
  BinaryCrc: 1 << 0,
  Filesystem: 1 << 1,
  WindowsOnHandshake: 1 << 2,
  Speaker: 1 << 3,
} as const;

export interface TerminalFrame {
  readonly type: "terminal";
  readonly window: number;
  readonly mode: 0 | 1 | 2;
  readonly blink: boolean;
  readonly width: number;
  readonly height: number;
  readonly cursorX: number;
  readonly cursorY: number;
  readonly grayscale: boolean;
  /** Mode 0: width*height char codes (empty in graphics modes). */
  readonly text: Uint8Array;
  /** Mode 0 only: per-cell (background << 4) | foreground. */
  readonly colors: Uint8Array;
  /** Graphics modes: width*height*54 palette indexes (empty in text mode). */
  readonly pixels: Uint8Array;
  /** RGB triplets: 16 entries (mode 0/1) or 256 (mode 2). */
  readonly palette: Uint8Array;
}

export interface WindowFrame {
  readonly type: "window";
  readonly window: number;
  readonly closing: 0 | 1 | 2;
  /** Computer id, or undefined for a monitor / unknown. */
  readonly computerId: number | undefined;
  readonly width: number;
  readonly height: number;
  readonly title: string;
}

export interface MessageFrame {
  readonly type: "message";
  readonly flags: number;
  readonly title: string;
  readonly message: string;
}

export interface FeaturesFrame {
  readonly type: "features";
  readonly flags: number;
}

export interface FileResponseFrame {
  readonly type: "file-response";
  readonly requestType: number;
  readonly requestId: number;
  readonly body: Uint8Array;
}

export interface FileDataFrame {
  readonly type: "file-data";
  readonly error: boolean;
  readonly requestId: number;
  readonly data: Uint8Array;
}

export interface SpeakerFrame {
  readonly type: "speaker";
  readonly sound: number;
  readonly speaker: number;
  readonly volume: number;
  readonly speed: number;
  readonly payload: Uint8Array;
}

export interface UnknownFrame {
  readonly type: "unknown";
  readonly packetType: number;
}

export type ServerFrame =
  | TerminalFrame
  | WindowFrame
  | MessageFrame
  | FeaturesFrame
  | FileResponseFrame
  | FileDataFrame
  | SpeakerFrame
  | UnknownFrame;

function decodeRle(
  data: Uint8Array,
  offset: number,
  expected: number,
): { out: Uint8Array; next: number } {
  const out = new Uint8Array(expected);
  let produced = 0;
  let pos = offset;
  while (produced < expected) {
    if (pos + 1 >= data.length) throw new Error("truncated RLE stream");
    const value = data[pos]!;
    const count = data[pos + 1]!;
    pos += 2;
    const run = Math.min(count, expected - produced);
    out.fill(value, produced, produced + run);
    produced += run;
  }
  return { out, next: pos };
}

function readCString(
  data: Uint8Array,
  offset: number,
): { value: string; next: number } {
  let end = offset;
  while (end < data.length && data[end] !== 0) end++;
  return {
    value: Buffer.from(data.subarray(offset, end)).toString("latin1"),
    next: end + 1,
  };
}

export function decodeServerPacket(data: Uint8Array): ServerFrame {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const packetType = data[0] ?? -1;
  const window = data[1] ?? 0;
  switch (packetType) {
    case PacketType.Terminal: {
      const mode = data[2] as 0 | 1 | 2;
      if (mode > 2) return { type: "unknown", packetType };
      const width = view.getUint16(4, true);
      const height = view.getUint16(6, true);
      const cells = width * height;
      let text: Uint8Array = new Uint8Array(0);
      let colors: Uint8Array = new Uint8Array(0);
      let pixels: Uint8Array = new Uint8Array(0);
      let next = 0x10;
      if (mode === 0) {
        const t = decodeRle(data, next, cells);
        const c = decodeRle(data, t.next, cells);
        text = t.out;
        colors = c.out;
        next = c.next;
      } else {
        const p = decodeRle(data, next, cells * 54);
        pixels = p.out;
        next = p.next;
      }
      const paletteSize = mode === 2 ? 768 : 48;
      return {
        type: "terminal",
        window,
        mode,
        blink: data[3] !== 0,
        width,
        height,
        cursorX: view.getUint16(8, true),
        cursorY: view.getUint16(10, true),
        grayscale: data[12] === 1,
        text,
        colors,
        pixels,
        palette: data.slice(next, next + paletteSize),
      };
    }
    case PacketType.Window: {
      const computer = data[3] ?? 0;
      return {
        type: "window",
        window,
        closing: (data[2] ?? 0) as 0 | 1 | 2,
        computerId: computer > 0 ? computer - 1 : undefined,
        width: view.getUint16(4, true),
        height: view.getUint16(6, true),
        title: readCString(data, 8).value,
      };
    }
    case PacketType.Message: {
      const title = readCString(data, 6);
      return {
        type: "message",
        flags: view.getUint32(2, true),
        title: title.value,
        message: readCString(data, title.next).value,
      };
    }
    case PacketType.Features:
      return { type: "features", flags: view.getUint16(2, true) };
    case PacketType.FileResponse:
      return {
        type: "file-response",
        requestType: data[2]!,
        requestId: data[3]!,
        body: data.slice(4),
      };
    case PacketType.FileData: {
      const size = view.getUint32(4, true);
      return {
        type: "file-data",
        error: data[2] === 1,
        requestId: data[3]!,
        data: data.slice(8, 8 + size),
      };
    }
    case PacketType.Speaker:
      return {
        type: "speaker",
        sound: data[2]!,
        speaker: data[3]!,
        volume: data[4]!,
        speed: view.getInt8(5),
        payload: data.slice(8, 8 + view.getUint16(6, true)),
      };
    default:
      return { type: "unknown", packetType };
  }
}

/** Value that can be carried by a Type 3 generic event. */
export type EventValue =
  | number
  | boolean
  | string
  | null
  | undefined
  | { [key: string]: EventValue }
  | EventValue[];

function encodeValue(value: EventValue, out: number[]): void {
  if (value === null || value === undefined) {
    out.push(5);
  } else if (typeof value === "boolean") {
    out.push(2, value ? 1 : 0);
  } else if (typeof value === "number") {
    if (Number.isInteger(value) && value >= 0 && value <= 0xffffffff) {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(value);
      out.push(0, ...b);
    } else {
      const b = Buffer.alloc(8);
      b.writeDoubleLE(value);
      out.push(1, ...b);
    }
  } else if (typeof value === "string") {
    out.push(3);
    // Not a spread: a long modem message would not fit in the arguments of one call
    for (const byte of Buffer.from(value, "latin1")) out.push(byte);
    out.push(0);
  } else {
    const entries: [EventValue, EventValue][] = Array.isArray(value)
      ? value.map((v, i) => [i + 1, v] as [EventValue, EventValue])
      : Object.entries(value);
    out.push(4, entries.length);
    for (const [k] of entries) encodeValue(k, out);
    for (const [, v] of entries) encodeValue(v, out);
  }
}

export function encodeEvent(
  name: string,
  params: readonly EventValue[],
): Uint8Array {
  const out: number[] = [
    PacketType.Event,
    0,
    params.length,
    ...Buffer.from(name, "latin1"),
    0,
  ];
  for (const p of params) encodeValue(p, out);
  return Uint8Array.from(out);
}

export function encodeKey(
  window: number,
  key: number,
  flags: { up?: boolean; held?: boolean; ctrl?: boolean; char?: boolean },
): Uint8Array {
  const f =
    (flags.up ? 1 : 0) |
    (flags.held ? 2 : 0) |
    (flags.ctrl ? 4 : 0) |
    (flags.char ? 8 : 0);
  return Uint8Array.from([PacketType.Key, window, key, f]);
}

export type MouseKind = "click" | "up" | "scroll" | "drag";

export function encodeMouse(
  window: number,
  kind: MouseKind,
  button: number,
  x: number,
  y: number,
): Uint8Array {
  const b = Buffer.alloc(12);
  b[0] = PacketType.Mouse;
  b[1] = window;
  b[2] = { click: 0, up: 1, scroll: 2, drag: 3 }[kind];
  b[3] = button;
  b.writeUInt32LE(x, 4);
  b.writeUInt32LE(y, 8);
  return new Uint8Array(b);
}

export function encodeFeatures(flags: number): Uint8Array {
  const b = Buffer.alloc(4);
  b[0] = PacketType.Features;
  b.writeUInt16LE(flags, 2);
  return new Uint8Array(b);
}

export function encodeWindowClose(window: number, quit: boolean): Uint8Array {
  return Uint8Array.from([
    PacketType.Window,
    window,
    quit ? 2 : 1,
    0,
    0,
    0,
    0,
    0,
    0,
  ]);
}
