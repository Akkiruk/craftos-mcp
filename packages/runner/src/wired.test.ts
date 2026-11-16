import { describe, expect, it } from "vitest";
import { linkedWorlds } from "./network.js";
import { remoteOrder, resolveWired } from "./wired.js";
import type { BlockPos, ModemSpec, WorldConfig } from "./world.js";

const wired = (name: string, extra: Partial<ModemSpec> = {}): ModemSpec => ({
  name,
  type: "modem",
  kind: "wired",
  ...extra,
});

const computer = (
  computerId: number,
  x: number,
  modem: ModemSpec,
): { world: WorldConfig } => ({
  world: {
    computerId,
    position: { x, y: 70, z: 0 },
    peripherals: [modem],
  },
});

const at = (x: number): BlockPos => ({ x, y: 70, z: 0 });

describe("wired network resolution", () => {
  it("orders names like the real ConcurrentHashMap", () => {
    // Measured: getNamesRemote gave these orders on a real network
    expect(
      remoteOrder([{ name: "computer_12" }, { name: "speaker_2" }]).map(
        (r) => r.name,
      ),
    ).toEqual(["speaker_2", "computer_12"]);
    expect(
      remoteOrder([{ name: "computer_11" }, { name: "speaker_2" }]).map(
        (r) => r.name,
      ),
    ).toEqual(["speaker_2", "computer_11"]);
  });

  it("joins modems by id and numbers computers by the counter, not their id", () => {
    const [a, b, c] = resolveWired([
      computer(40, 0, wired("right", { network: "floor" })),
      computer(41, 5, wired("left", { network: "floor" })),
      computer(42, 9, wired("left", { network: "other" })),
    ]);
    expect(a!["right"]!.localName).toBe("computer_0");
    expect(b!["left"]!.localName).toBe("computer_1");
    expect(a!["right"]!.net).toBe(b!["left"]!.net);
    expect(c!["left"]!.net).not.toBe(a!["right"]!.net);
    expect(a!["right"]!.remotes.map((r) => r.name)).toEqual(["computer_1"]);
    expect(c!["left"]!.remotes).toEqual([]);
  });

  it("joins blocks that touch and measures the route along them", () => {
    const route: BlockPos[] = [2, 3, 4].map(at);
    route.push(
      { x: 4, y: 70, z: 1 },
      { x: 5, y: 70, z: 1 },
      { x: 6, y: 70, z: 1 },
    );
    route.push(at(6));
    const [a, b] = resolveWired(
      [
        computer(1, 0, wired("right", { block: at(1) })),
        computer(2, 7, wired("left", { block: at(6) })),
      ],
      [{ cables: route, peripherals: [{ type: "speaker" }] }],
    );
    // One step to the first block, seven along the bend, one step off the last block
    expect(b!["left"]!.peers["1/right"]).toEqual([8, 1]);
    expect(a!["right"]!.peers["2/left"]).toEqual([8, 1]);
    expect(a!["right"]!.remotes.map((r) => r.name).sort()).toEqual([
      "computer_1",
      "speaker_0",
    ]);
  });

  it("does not list a computer whose modem is off, and keeps the modem connected", () => {
    const [a, b] = resolveWired([
      computer(1, 0, wired("right", { network: "n" })),
      computer(2, 5, wired("left", { network: "n", on: false })),
    ]);
    expect(a!["right"]!.remotes).toEqual([]);
    expect(b!["left"]!.remotes.map((r) => r.name)).toEqual(["computer_0"]);
    expect(b!["left"]!.net).toBe(a!["right"]!.net);
  });

  it("gives the measured routes of the rc-wired rig", () => {
    const pos = (x: number, z: number): BlockPos => ({ x, y: 70, z });
    const on = (
      id: number,
      name: string,
      x: number,
      z: number,
      block: BlockPos,
      power = true,
    ) => ({
      world: {
        computerId: id,
        position: pos(x, z),
        peripherals: [wired(name, { block, on: power })],
      },
    });
    const [live, off, bent, sided] = resolveWired(
      [
        on(960, "right", 0, 0, pos(1, 0)),
        on(961, "left", 4, 0, pos(3, 0), false),
        on(962, "left", 5, -2, pos(4, -2)),
        on(963, "back", 2, 3, pos(2, 2)),
      ],
      [{ cables: [pos(2, 0), pos(2, -1), pos(2, -2), pos(3, -2), pos(2, 1)] }],
    );
    const reported = (route: [number, number] | undefined): number =>
      route![0] + route![1];
    expect(reported(live!["right"]!.peers["961/left"])).toBe(4);
    expect(reported(live!["right"]!.peers["962/left"])).toBe(7);
    expect(reported(live!["right"]!.peers["963/back"])).toBe(5);
    expect(reported(off!["left"]!.peers["962/left"])).toBe(7);
    expect(reported(bent!["left"]!.peers["963/back"])).toBe(8);
    expect(reported(sided!["back"]!.peers["962/left"])).toBe(8);
  });

  it("refuses computers that would talk over each other", () => {
    expect(() =>
      linkedWorlds([
        { world: { computerId: 3 } },
        { world: { computerId: 3 } },
      ]),
    ).toThrow(/id 3/);
    expect(() =>
      linkedWorlds([
        { world: { computerId: 3, seed: 7 } },
        { world: { computerId: 4, seed: 7 } },
      ]),
    ).toThrow(/seed/);
  });
});
