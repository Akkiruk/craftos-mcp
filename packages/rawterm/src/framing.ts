import { crc32 } from "node:zlib";

export interface FramingOptions {
  /** Feature bit 0: CRC covers decoded bytes instead of the Base64 text. */
  readonly binaryCrc: boolean;
}

export class FramingError extends Error {}

const MAGIC_SMALL = "!CPC";
const MAGIC_LARGE = "!CPD";

function crcHex(value: number): string {
  return (value >>> 0).toString(16).padStart(8, "0");
}

/** Wrap a decoded payload in a `!CPC` (or `!CPD` when large) frame. */
export function encodeFrame(
  payload: Uint8Array,
  options: FramingOptions,
): string {
  const base64 = Buffer.from(payload).toString("base64");
  const sum = crc32(options.binaryCrc ? payload : base64);
  if (base64.length > 0xffff) {
    return `${MAGIC_LARGE}${base64.length.toString(16).toUpperCase().padStart(12, "0")}${base64}${crcHex(sum)}\n`;
  }
  return `${MAGIC_SMALL}${base64.length.toString(16).toUpperCase().padStart(4, "0")}${base64}${crcHex(sum)}\n`;
}

/**
 * Incremental frame parser. Feed it raw stdout chunks; it yields decoded
 * payloads and skips any non-frame text (for example startup banners).
 */
export class FrameParser {
  private buffer = "";

  constructor(private options: FramingOptions = { binaryCrc: false }) {}

  setOptions(options: FramingOptions): void {
    this.options = options;
  }

  push(chunk: Buffer | string): Uint8Array[] {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("latin1");
    const payloads: Uint8Array[] = [];
    for (;;) {
      const start = this.findMagic();
      if (start < 0) {
        // keep a possible partial magic at the tail
        this.buffer = this.buffer.slice(Math.max(0, this.buffer.length - 3));
        return payloads;
      }
      if (start > 0) this.buffer = this.buffer.slice(start);
      const large = this.buffer.startsWith(MAGIC_LARGE);
      const sizeLength = large ? 12 : 4;
      const header = 4 + sizeLength;
      if (this.buffer.length < header) return payloads;
      const size = Number.parseInt(this.buffer.slice(4, header), 16);
      if (!Number.isFinite(size)) {
        this.buffer = this.buffer.slice(4);
        continue;
      }
      const total = header + size + 8;
      if (this.buffer.length < total) return payloads;
      const base64 = this.buffer.slice(header, header + size);
      const expected = Number.parseInt(
        this.buffer.slice(header + size, total),
        16,
      );
      this.buffer = this.buffer.slice(total).replace(/^\r?\n/, "");
      const decoded = Buffer.from(base64, "base64");
      const actual = crc32(this.options.binaryCrc ? decoded : base64) >>> 0;
      if (actual !== expected) {
        throw new FramingError(
          `CRC mismatch: expected ${crcHex(expected)}, got ${crcHex(actual)}`,
        );
      }
      payloads.push(new Uint8Array(decoded));
    }
  }

  private findMagic(): number {
    const a = this.buffer.indexOf(MAGIC_SMALL);
    const b = this.buffer.indexOf(MAGIC_LARGE);
    if (a < 0) return b;
    if (b < 0) return a;
    return Math.min(a, b);
  }
}
