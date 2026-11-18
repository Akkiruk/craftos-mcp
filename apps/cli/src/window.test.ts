// `craftos-mcp window` with several computers: how it lays out the network (names, modems, ids, folders), and what it
// refuses before any window opens. The windows themselves: packages/runner/src/window-bridge.integration.test.ts.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { checkConfig, loadConfig } from "@craftos-mcp/runner";
import window, {
  networkComputers,
  screenshotFolder,
  windowEnv,
} from "./commands/window.js";

const scratch = mkdtempSync(join(tmpdir(), "cli-window-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const ready = checkConfig(loadConfig()).length === 0;

describe("a network in windows", () => {
  it("names each computer after its world file, gives it a modem, an id and a seed of its own", () => {
    const list = networkComputers(
      { workspaceDir: scratch },
      [
        { name: "worlds/sender.world.json", world: { seed: 7 } },
        {
          name: "receiver.json",
          world: {
            seed: 7,
            peripherals: [{ name: "left", type: "modem", kind: "ender" }],
          },
        },
      ],
      [],
      { live: true, ownFolders: false },
    );
    expect(list.map((c) => c.name)).toEqual(["sender", "receiver"]);
    expect(list.map((c) => c.world!.computerId)).toEqual([0, 1]);
    expect(list.map((c) => c.world!.seed)).toEqual([7, 8]);
    expect(list.map((c) => c.world!.label)).toEqual(["sender", "receiver"]);
    // a wireless modem on the back only where the world has none
    expect(list[0]!.world!.peripherals).toEqual([
      { name: "back", type: "modem", kind: "wireless" },
    ]);
    expect(list[1]!.world!.peripherals).toEqual([
      { name: "left", type: "modem", kind: "ender" },
    ]);
    // they share the folder, live
    expect(list.map((c) => c.liveDir)).toEqual([scratch, scratch]);
  });

  it("numbers the same world twice as two computers, and gives each its own folder when asked", () => {
    const own = networkComputers(
      { workspaceDir: scratch },
      [{ world: {} }, { world: {} }, { world: {} }],
      [{ name: "top", blocksWide: 1, blocksHigh: 1 }],
      { live: true, ownFolders: true },
    );
    expect(own.map((c) => c.name)).toEqual([
      "computer1",
      "computer2",
      "computer3",
    ]);
    expect(own.map((c) => c.liveDir)).toEqual(
      [0, 1, 2].map((id) => join(scratch, "computer", String(id))),
    );
    expect(existsSync(join(scratch, "computer", "2"))).toBe(true);
    expect(own[0]!.monitors).toEqual([
      { name: "top", blocksWide: 1, blocksHigh: 1 },
    ]);
    // ids a world file gives are kept, and never twice
    const fixed = networkComputers(
      { workspaceDir: scratch },
      [{ world: { computerId: 5 } }, { world: { computerId: 5 } }],
      [],
      { live: false, ownFolders: false },
    );
    expect(fixed.map((c) => c.world!.computerId)).toEqual([5, 6]);
    expect(fixed.every((c) => c.liveDir === undefined)).toBe(true);
  });

  it("uses a computer's own computer/<id> folder when the project has one (CraftOS-PC's layout)", () => {
    const project = join(scratch, "imported");
    mkdirSync(join(project, "computer", "1"), { recursive: true });
    const list = networkComputers(
      { workspaceDir: project },
      [{ world: {} }, { world: {} }],
      [],
      { live: true, ownFolders: false },
    );
    expect(list.map((c) => c.liveDir)).toEqual([
      project,
      join(project, "computer", "1"),
    ]);
    // an imported project's craftos.json picks computer/<id> as its folder: the others are found beside it
    mkdirSync(join(project, "computer", "0"), { recursive: true });
    const imported = networkComputers(
      { workspaceDir: join(project, "computer", "0") },
      [{ world: { computerId: 0 } }, { world: { computerId: 1 } }],
      [],
      { live: true, ownFolders: false },
    );
    expect(imported.map((c) => c.liveDir)).toEqual([
      join(project, "computer", "0"),
      join(project, "computer", "1"),
    ]);
  });

  it("puts the modem it adds on a side nothing else is on", () => {
    const [c] = networkComputers(
      { workspaceDir: scratch },
      [
        {
          world: {
            peripherals: [{ name: "back", type: "minecraft:chest" }],
            monitors: [{ name: "top", blocksWide: 1, blocksHigh: 1 }],
          },
        },
      ],
      [],
      { live: false, ownFolders: false },
    );
    expect(c!.world!.peripherals!.map((p) => `${p.name} ${p.type}`)).toEqual([
      "back minecraft:chest",
      "bottom modem",
    ]);
  });
});

describe.skipIf(!ready)("what the window refuses before it opens", () => {
  const run = async (
    ...args: string[]
  ): Promise<{ code: number; err: string }> => {
    const err: string[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
    try {
      const code = await window.run(["--dir", scratch, ...args]);
      return { code, err: err.join("\n") };
    } finally {
      spy.mockRestore();
    }
  };

  it("a turtle on a network, a bad count, a folder each on a copy", async () => {
    writeFileSync(
      join(scratch, "t.world.json"),
      JSON.stringify({ turtle: { fuel: 10 } }),
    );
    writeFileSync(join(scratch, "c.world.json"), "{}");
    const turtle = await run("t.world.json", "c.world.json");
    expect(turtle.code).toBe(2);
    expect(turtle.err).toMatch(/turtle world opens on its own/);
    const count = await run("--computers", "0");
    expect(count.code).toBe(2);
    expect(count.err).toMatch(/--computers is 1 to 16/);
    const both = await run("--computers", "2", "--copy", "--own-folders");
    expect(both.code).toBe(2);
    expect(both.err).toMatch(/--own-folders/);
  });
});

describe("screenshots from a window", () => {
  it("go to a folder the person keeps, not the window's scratch folder", () => {
    const home = join(scratch, "home");
    mkdirSync(join(home, "Pictures"), { recursive: true });
    expect(screenshotFolder({}, home)).toBe(
      join(home, "Pictures", "craftos-mcp"),
    );
    // no Pictures folder: the home folder
    const bare = join(scratch, "bare");
    mkdirSync(bare, { recursive: true });
    expect(screenshotFolder({}, bare)).toBe(join(bare, "craftos-mcp"));
    expect(screenshotFolder({ CRAFTOS_SCREENSHOTS: "D:/shots" }, home)).toBe(
      "D:/shots",
    );
    // the engine is told (CRAFTOS_SCREENSHOT_DIR), and it is outside the runtime folder the window deletes
    const env = windowEnv({ USERPROFILE: home });
    expect(env["CRAFTOS_SCREENSHOT_DIR"]).toBe(
      join(home, "Pictures", "craftos-mcp"),
    );
    expect(env["CRAFTOS_SCREENSHOT_DIR"]).not.toContain(
      loadConfig().runtimeDir,
    );
  });
});
