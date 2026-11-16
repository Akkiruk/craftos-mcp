import { describe, expect, it } from "vitest";
import {
  FrameParser,
  FramingError,
  decodeServerPacket,
  encodeEvent,
  encodeFrame,
  encodeKey,
} from "./index.js";

describe("framing", () => {
  it("round-trips payloads in both CRC modes", () => {
    for (const binaryCrc of [false, true]) {
      const parser = new FrameParser({ binaryCrc });
      const frame = encodeFrame(Uint8Array.from([4, 0, 0, 1, 51, 0, 19, 0]), {
        binaryCrc,
      });
      expect(parser.push(frame)).toEqual([
        Uint8Array.from([4, 0, 0, 1, 51, 0, 19, 0]),
      ]);
    }
  });

  it("handles split chunks and leading noise", () => {
    const parser = new FrameParser();
    const frame = encodeFrame(Uint8Array.from([6, 0, 0, 0]), {
      binaryCrc: false,
    });
    expect(parser.push("banner\n" + frame.slice(0, 7))).toEqual([]);
    expect(parser.push(frame.slice(7))).toHaveLength(1);
  });

  it("rejects a corrupt CRC", () => {
    const parser = new FrameParser();
    const frame = encodeFrame(Uint8Array.from([6, 0, 0, 0]), {
      binaryCrc: false,
    });
    const bad = frame.slice(0, -2) + (frame.endsWith("0\n") ? "1\n" : "0\n");
    expect(() => parser.push(bad)).toThrow(FramingError);
  });
});

describe("packets", () => {
  it("decodes a text terminal frame", () => {
    const header = new Uint8Array(0x10);
    header.set([0, 2, 0, 1, 2, 0, 1, 0, 1, 0, 0, 0, 0]);
    const rle = [72, 1, 105, 1, 0x1f, 2];
    const palette = new Uint8Array(48).fill(7);
    const data = Uint8Array.from([...header, ...rle, ...palette]);
    const frame = decodeServerPacket(data);
    expect(frame).toMatchObject({
      type: "terminal",
      window: 2,
      width: 2,
      height: 1,
      cursorX: 1,
    });
    if (frame.type !== "terminal") throw new Error("unreachable");
    expect(Buffer.from(frame.text).toString("latin1")).toBe("Hi");
    expect([...frame.colors]).toEqual([0x1f, 0x1f]);
    expect(frame.palette).toHaveLength(48);
  });

  it("encodes events with typed parameters", () => {
    const bytes = encodeEvent("monitor_touch", ["top", 3, 2]);
    expect(Buffer.from(bytes).toString("latin1")).toContain("monitor_touch\0");
    expect(bytes[2]).toBe(3);
  });

  it("encodes key flags", () => {
    expect([...encodeKey(0, 30, { up: true, char: false })]).toEqual([
      1, 0, 30, 1,
    ]);
  });
});
