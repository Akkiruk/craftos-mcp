import { describe, expect, it } from "vitest";
import type { TerminalFrame } from "@craftos-agent/rawterm";
import { describeFrame } from "./ui.js";

const palette = new Uint8Array(16 * 3);
palette.set([0, 80, 0], 5 * 3); // green table
palette.set([240, 240, 240], 0 * 3);
palette.set([20, 20, 20], 15 * 3);
palette.set([120, 200, 25], 13 * 3); // lime button
palette.set([240, 90, 90], 14 * 3); // red button

const CW = 6;
const CH = 9;

/** A pixel-mode frame drawn one flat colour per character cell, like a pixel-mode surface UI. */
function pixelFrame(
  width: number,
  height: number,
  draw: (cells: number[][]) => void,
): TerminalFrame {
  const cells = Array.from({ length: height }, () => Array(width).fill(5));
  draw(cells);
  const pixels = new Uint8Array(width * CW * height * CH);
  for (let cy = 0; cy < height; cy++)
    for (let cx = 0; cx < width; cx++)
      for (let y = 0; y < CH; y++)
        for (let x = 0; x < CW; x++)
          pixels[(cy * CH + y) * width * CW + cx * CW + x] = cells[cy]![cx]!;
  return {
    type: "terminal",
    window: 1,
    mode: 1,
    blink: false,
    width,
    height,
    cursorX: 0,
    cursorY: 0,
    grayscale: false,
    text: new Uint8Array(0),
    colors: new Uint8Array(0),
    pixels,
    palette,
  };
}

function fill(
  cells: number[][],
  x: number,
  y: number,
  w: number,
  h: number,
  color: number,
): void {
  for (let j = y; j < y + h; j++)
    for (let i = x; i < x + w; i++) cells[j]![i] = color;
}

describe("describeFrame", () => {
  it("finds labelled buttons as rectangles with a touchable centre", () => {
    const frame = pixelFrame(40, 30, (cells) => {
      fill(cells, 10, 5, 20, 7, 13); // PLAY
      fill(cells, 13, 7, 4, 3, 15); // label strokes inside the button
      fill(cells, 5, 15, 30, 7, 14); // QUIT
    });
    const ui = describeFrame({ id: 1, peripheral: "right" }, frame);
    expect(ui.unit).toBe("cell");
    expect(ui.background).toBe("#005000");
    const rects = ui.rects.map((r) => [
      r.color,
      r.x,
      r.y,
      r.w,
      r.h,
      r.cx,
      r.cy,
    ]);
    expect(rects).toContainEqual(["#78c819", 10, 5, 20, 7, 20, 9]);
    expect(rects).toContainEqual(["#f05a5a", 5, 15, 30, 7, 20, 19]);
  });

  it("ignores thin strokes that are not rectangles", () => {
    const frame = pixelFrame(40, 30, (cells) => {
      for (let i = 0; i < 12; i++) cells[5 + i]![5 + i] = 15; // diagonal
      fill(cells, 20, 5, 1, 12, 15); // 1-wide line
    });
    expect(
      describeFrame({ id: 1, peripheral: undefined }, frame).rects,
    ).toEqual([]);
  });

  it("changes its hash when the screen changes", () => {
    const a = describeFrame(
      { id: 1, peripheral: undefined },
      pixelFrame(10, 10, () => undefined),
    );
    const b = describeFrame(
      { id: 1, peripheral: undefined },
      pixelFrame(10, 10, (cells) => fill(cells, 1, 1, 3, 3, 13)),
    );
    expect(a.hash).not.toBe(b.hash);
  });

  it("reads text runs with colours from text-mode frames", () => {
    const width = 20;
    const text = new Uint8Array(width * 2).fill(32);
    const colors = new Uint8Array(width * 2).fill(0xf0);
    "OK".split("").forEach((c, i) => {
      text[width + 3 + i] = c.charCodeAt(0);
      colors[width + 3 + i] = (13 << 4) | 15;
    });
    const frame: TerminalFrame = {
      type: "terminal",
      window: 1,
      mode: 0,
      blink: false,
      width,
      height: 2,
      cursorX: 0,
      cursorY: 0,
      grayscale: false,
      text,
      colors,
      pixels: new Uint8Array(0),
      palette,
    };
    const ui = describeFrame({ id: 1, peripheral: "top" }, frame);
    expect(ui.texts).toEqual([
      { x: 4, y: 2, text: "OK", fg: "#141414", bg: "#78c819" },
    ]);
  });
});
