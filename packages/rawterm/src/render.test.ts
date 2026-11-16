import { describe, expect, it } from "vitest";
import type { TerminalFrame } from "./packets.js";
import { CELL_HEIGHT, CELL_WIDTH, encodePng, renderFrame } from "./render.js";

function frame(overrides: Partial<TerminalFrame> = {}): TerminalFrame {
  const palette = new Uint8Array(48);
  palette.set([240, 240, 240], 0); // white
  palette.set([0, 0, 255], 3 * 11); // index 11 is blue
  palette.set([0, 0, 0], 3 * 15); // black
  return {
    type: "terminal",
    window: 1,
    mode: 0,
    blink: false,
    width: 2,
    height: 1,
    cursorX: 0,
    cursorY: 0,
    grayscale: false,
    text: Uint8Array.from([65, 32]),
    colors: Uint8Array.from([0xb0, 0xb0]), // blue background, white foreground
    pixels: new Uint8Array(0),
    palette,
    ...overrides,
  };
}

describe("renderFrame", () => {
  it("sizes the image from cells, margin and scale", () => {
    const image = renderFrame(frame(), { scale: 3 });
    expect(image.width).toBe((2 * CELL_WIDTH + 4) * 3);
    expect(image.height).toBe((CELL_HEIGHT + 4) * 3);
  });

  it("paints glyph pixels in the foreground and the rest in the background", () => {
    const image = renderFrame(frame(), { scale: 1 });
    const at = (x: number, y: number): number[] => {
      const o = (y * image.width + x) * 4;
      return [...image.rgba.subarray(o, o + 3)];
    };
    // 'A' top row is ".###.." so x=1 inside the cell is lit, x=0 is not.
    expect(at(2 + 1, 2)).toEqual([240, 240, 240]);
    expect(at(2 + 0, 2)).toEqual([0, 0, 255]);
    // second cell is a space: all background
    expect(at(2 + CELL_WIDTH + 1, 2)).toEqual([0, 0, 255]);
  });
});

describe("encodePng", () => {
  it("produces a PNG with the right signature and IHDR", () => {
    const png = encodePng(renderFrame(frame(), { scale: 1 }));
    expect([...png.subarray(0, 8)]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    expect(png.subarray(12, 16).toString("latin1")).toBe("IHDR");
    expect(png.readUInt32BE(16)).toBe(2 * CELL_WIDTH + 4);
    expect(
      png.subarray(png.length - 8, png.length - 4).toString("latin1"),
    ).toBe("IEND");
  });
});
