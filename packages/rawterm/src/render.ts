import { readFileSync } from "node:fs";
import { deflateSync, crc32 } from "node:zlib";
import type { TerminalFrame } from "./packets.js";

export const CELL_WIDTH = 6;
export const CELL_HEIGHT = 9;
/** Border drawn around the terminal, matching the desktop client. */
const MARGIN = 2;

let glyphs: Uint8Array | undefined;

/** 256 glyphs, 9 bytes each; bit 5 is the leftmost pixel of a row. */
function loadGlyphs(): Uint8Array {
  glyphs ??= new Uint8Array(
    readFileSync(new URL("../assets/cc-font.bin", import.meta.url)),
  );
  return glyphs;
}

export interface RenderOptions {
  /** Integer pixel multiplier. Default 2 so small monitors stay readable. */
  readonly scale?: number;
  /** Draw the blinking cursor when the terminal has it enabled. Default true. */
  readonly cursor?: boolean;
}

export interface Image {
  readonly width: number;
  readonly height: number;
  /** RGBA, row-major. */
  readonly rgba: Uint8Array;
}

function rgb(palette: Uint8Array, index: number): [number, number, number] {
  return [
    palette[index * 3] ?? 0,
    palette[index * 3 + 1] ?? 0,
    palette[index * 3 + 2] ?? 0,
  ];
}

/** Rasterize a terminal frame (text or pixel mode) to RGBA. */
export function renderFrame(
  frame: TerminalFrame,
  options: RenderOptions = {},
): Image {
  const scale = Math.max(1, Math.floor(options.scale ?? 2));
  const innerW = frame.width * CELL_WIDTH;
  const innerH = frame.height * CELL_HEIGHT;
  const baseW = innerW + MARGIN * 2;
  const baseH = innerH + MARGIN * 2;
  const base = new Uint8Array(baseW * baseH * 4);

  const put = (x: number, y: number, c: [number, number, number]): void => {
    const o = (y * baseW + x) * 4;
    base[o] = c[0];
    base[o + 1] = c[1];
    base[o + 2] = c[2];
    base[o + 3] = 255;
  };
  const gray = (c: [number, number, number]): [number, number, number] => {
    if (!frame.grayscale) return c;
    const g = Math.round((c[0] + c[1] + c[2]) / 3);
    return [g, g, g];
  };

  if (frame.mode === 0) {
    const font = loadGlyphs();
    // The margin takes the colour of the nearest edge cell, like a real monitor.
    const edgeBg = (cx: number, cy: number): [number, number, number] =>
      gray(
        rgb(
          frame.palette,
          (frame.colors[
            Math.min(frame.height - 1, Math.max(0, cy)) * frame.width +
              Math.min(frame.width - 1, Math.max(0, cx))
          ] ?? 0) >> 4,
        ),
      );
    for (let y = 0; y < baseH; y++) {
      for (let x = 0; x < baseW; x++) {
        const inside =
          x >= MARGIN &&
          y >= MARGIN &&
          x < MARGIN + innerW &&
          y < MARGIN + innerH;
        if (!inside) {
          put(
            x,
            y,
            edgeBg(
              Math.floor((x - MARGIN) / CELL_WIDTH),
              Math.floor((y - MARGIN) / CELL_HEIGHT),
            ),
          );
        }
      }
    }
    for (let cy = 0; cy < frame.height; cy++) {
      for (let cx = 0; cx < frame.width; cx++) {
        const i = cy * frame.width + cx;
        const attr = frame.colors[i] ?? 0xf0;
        const bg = gray(rgb(frame.palette, attr >> 4));
        const fg = gray(rgb(frame.palette, attr & 15));
        const ch = frame.text[i] ?? 32;
        for (let r = 0; r < CELL_HEIGHT; r++) {
          const bits = font[ch * CELL_HEIGHT + r] ?? 0;
          for (let k = 0; k < CELL_WIDTH; k++) {
            put(
              MARGIN + cx * CELL_WIDTH + k,
              MARGIN + cy * CELL_HEIGHT + r,
              bits & (1 << (5 - k)) ? fg : bg,
            );
          }
        }
      }
    }
    if (
      (options.cursor ?? true) &&
      frame.blink &&
      frame.cursorX < frame.width &&
      frame.cursorY < frame.height
    ) {
      const attr =
        frame.colors[frame.cursorY * frame.width + frame.cursorX] ?? 0xf0;
      const color = gray(rgb(frame.palette, attr & 15));
      for (let k = 0; k < CELL_WIDTH; k++) {
        put(
          MARGIN + frame.cursorX * CELL_WIDTH + k,
          MARGIN + frame.cursorY * CELL_HEIGHT + CELL_HEIGHT - 1,
          color,
        );
      }
    }
  } else {
    const black: [number, number, number] = [0, 0, 0];
    for (let y = 0; y < baseH; y++)
      for (let x = 0; x < baseW; x++) put(x, y, black);
    for (let y = 0; y < innerH; y++) {
      for (let x = 0; x < innerW; x++) {
        const index = frame.pixels[y * innerW + x] ?? 0;
        put(MARGIN + x, MARGIN + y, gray(rgb(frame.palette, index)));
      }
    }
  }

  if (scale === 1) return { width: baseW, height: baseH, rgba: base };
  const width = baseW * scale;
  const height = baseH * scale;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.floor(y / scale);
    for (let x = 0; x < width; x++) {
      const so = (sy * baseW + Math.floor(x / scale)) * 4;
      rgba.set(base.subarray(so, so + 4), (y * width + x) * 4);
    }
  }
  return { width, height, rgba };
}

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body) >>> 0, body.length + 4);
  return out;
}

/** Encode RGBA pixels as a PNG (no external dependencies). */
export function encodePng(image: Image): Buffer {
  const { width, height, rgba } = image;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

export function renderPng(
  frame: TerminalFrame,
  options?: RenderOptions,
): Buffer {
  return encodePng(renderFrame(frame, options));
}
