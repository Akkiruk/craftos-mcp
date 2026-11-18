// The steps that take a running computer from one world to another, as the game would make them (world-live.ts).
import { describe, expect, it } from "vitest";
import { planLive, worldForPanel } from "./world-live.js";
import type { WorldConfig } from "./world.js";

const w = (x: Record<string, unknown>): WorldConfig => x as WorldConfig;
const cmds = (
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  departed?: Set<string>,
) => planLive(w(before), w(after), departed).steps.map((s) => s.command);

describe("planLive", () => {
  it("places, breaks and moves blocks: breaking comes first, so a side can change hands", () => {
    const before = { peripherals: [{ name: "left", type: "minecraft:chest" }] };
    const after = {
      peripherals: [
        { name: "right", type: "minecraft:chest" },
        { name: "left", type: "speaker" },
      ],
    };
    expect(cmds(before, after)).toEqual([
      { cmd: "detachPeripheral", name: "left" },
      {
        cmd: "attachPeripheral",
        peripheral: { name: "right", type: "minecraft:chest" },
      },
      {
        cmd: "attachPeripheral",
        peripheral: { name: "left", type: "speaker" },
      },
    ]);
  });

  it("nothing changed: no steps", () => {
    const world = {
      peripherals: [{ name: "left", type: "minecraft:chest" }],
      players: [{ name: "Alice" }],
    };
    expect(planLive(w(world), w(structuredClone(world)))).toEqual({
      steps: [],
      later: [],
    });
  });

  it("a chest's contents change in place, slot by slot, with placing it again to fall back on", () => {
    const before = {
      peripherals: [
        {
          name: "left",
          type: "minecraft:chest",
          items: { "1": { name: "minecraft:dirt", count: 2 } },
        },
      ],
    };
    const after = {
      peripherals: [
        {
          name: "left",
          type: "minecraft:chest",
          items: { "3": { name: "minecraft:diamond", count: 5 } },
        },
      ],
    };
    const plan = planLive(w(before), w(after));
    expect(plan.steps.map((s) => s.command)).toEqual([
      { cmd: "setItem", peripheral: "left", slot: 1, item: null },
      {
        cmd: "setItem",
        peripheral: "left",
        slot: 3,
        item: { name: "minecraft:diamond", count: 5 },
      },
    ]);
    expect(plan.steps[0]!.fallback?.map((s) => s.command.cmd)).toEqual([
      "detachPeripheral",
      "attachPeripheral",
    ]);
    expect(plan.steps[1]!.what).toBe(
      "Put 5 minecraft:diamond in slot 3 of left",
    );
  });

  it("energy and fluid levels change in place", () => {
    const before = {
      peripherals: [
        { name: "back", type: "energy_storage", energy: 10 },
        {
          name: "top",
          type: "fluid_storage",
          fluid: { name: "minecraft:water", amount: 1000 },
        },
        {
          name: "tank_0",
          type: "fluid_storage",
          tanks: [{ name: "minecraft:lava", amount: 5 }, {}],
        },
      ],
    };
    const after = {
      peripherals: [
        { name: "back", type: "energy_storage", energy: 500 },
        { name: "top", type: "fluid_storage" },
        {
          name: "tank_0",
          type: "fluid_storage",
          tanks: [
            { name: "minecraft:lava", amount: 5 },
            { name: "minecraft:water", amount: 9 },
          ],
        },
      ],
    };
    expect(cmds(before, after)).toEqual([
      { cmd: "setEnergy", peripheral: "back", energy: 500 },
      { cmd: "setFluid", peripheral: "top", tank: 1, fluid: null },
      {
        cmd: "setFluid",
        peripheral: "tank_0",
        tank: 2,
        fluid: { name: "minecraft:water", amount: 9 },
      },
    ]);
  });

  it("any other setting: the block is broken and placed again", () => {
    const before = {
      peripherals: [{ name: "left", type: "minecraft:chest", size: 27 }],
    };
    const after = {
      peripherals: [
        {
          name: "left",
          type: "minecraft:chest",
          size: 9,
          items: { "1": { name: "a:b", count: 1 } },
        },
      ],
    };
    expect(cmds(before, after)).toEqual([
      { cmd: "detachPeripheral", name: "left" },
      { cmd: "attachPeripheral", peripheral: after.peripherals[0] },
    ]);
  });

  it("monitors: placed with their size and kind, grown, swapped for a normal one", () => {
    expect(
      cmds(
        {},
        {
          monitors: [
            { name: "top", blocksWide: 3, blocksHigh: 2, advanced: false },
          ],
        },
      ),
    ).toEqual([
      {
        cmd: "attachPeripheral",
        peripheral: {
          name: "top",
          type: "monitor",
          blocksWide: 3,
          blocksHigh: 2,
          advanced: false,
        },
      },
    ]);
    expect(
      cmds(
        { monitors: [{ name: "top" }] },
        { monitors: [{ name: "top", blocksWide: 4, blocksHigh: 3 }] },
      ),
    ).toEqual([
      { cmd: "resizeMonitor", monitor: "top", blocksWide: 4, blocksHigh: 3 },
    ]);
    expect(
      cmds(
        { monitors: [{ name: "top" }] },
        { monitors: [{ name: "top", advanced: false }] },
      ),
    ).toEqual([
      { cmd: "detachPeripheral", name: "top" },
      {
        cmd: "attachPeripheral",
        peripheral: { name: "top", type: "monitor", advanced: false },
      },
    ]);
    const scale = planLive(
      w({ monitors: [{ name: "top" }] }),
      w({ monitors: [{ name: "top", textScale: 2 }] }),
    );
    expect(scale.steps).toEqual([]);
    expect(scale.later[0]).toMatch(/text scale/);
  });

  it("players join, leave, come back and move", () => {
    expect(cmds({}, { players: [{ name: "Alice", x: 1 }] })).toEqual([
      { cmd: "addPlayer", name: "Alice", x: 1 },
    ]);
    expect(cmds({ players: [{ name: "Alice" }] }, {})).toEqual([
      { cmd: "leave", player: "Alice" },
    ]);
    expect(
      cmds(
        {},
        { players: [{ name: "Alice", x: 4, z: 2 }] },
        new Set(["alice"]),
      ),
    ).toEqual([
      { cmd: "join", player: "Alice" },
      { cmd: "setPlayerPos", player: "Alice", x: 4, z: 2 },
    ]);
    expect(
      cmds(
        { players: [{ name: "Alice", x: 0 }] },
        { players: [{ name: "Alice", x: 9, online: false }] },
      ),
    ).toEqual([
      { cmd: "leave", player: "Alice" },
      { cmd: "setPlayerPos", player: "Alice", x: 9 },
    ]);
    const health = planLive(
      w({ players: [{ name: "Alice" }] }),
      w({ players: [{ name: "Alice", health: 3 }] }),
    );
    expect(health.steps).toEqual([]);
    expect(health.later[0]).toMatch(/Alice's health/);
  });

  it("the computer moves, the weather changes, an entity appears; the rest waits for the next start", () => {
    const plan = planLive(
      w({ environment: { raining: false } }),
      w({
        position: { x: 5, y: 70, z: -3 },
        environment: { raining: true, time: 6000 },
        entities: [{ type: "minecraft:cow" }],
        version: "1.20.1",
      }),
    );
    expect(plan.steps.map((s) => s.command)).toEqual([
      { cmd: "setEnvironment", values: { raining: true, time: 6000 } },
      { cmd: "setComputerPos", x: 5, y: 70, z: -3 },
      { cmd: "addEntity", entity: { type: "minecraft:cow" } },
    ]);
    expect(plan.later).toEqual([
      "The Minecraft version: a new computer from this world uses it.",
    ]);
  });

  it("worldForPanel puts the monitors back in the world and leaves the app's own keys out", () => {
    expect(
      worldForPanel(w({ simProgram: true, label: "x" }), [
        { name: "top", blocksWide: 2 },
      ]),
    ).toEqual({
      label: "x",
      monitors: [{ name: "top", blocksWide: 2 }],
    });
  });
});
