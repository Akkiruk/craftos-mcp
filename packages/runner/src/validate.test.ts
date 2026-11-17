import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ADDONS } from "./addons.js";
import { loadConfig } from "./config.js";
import { parseLuaError } from "./run.js";
import {
  WORLD_KEYS,
  checkProgram,
  checkTestPaths,
  checkWorld,
  didYouMean,
} from "./validate.js";

const scratch = mkdtempSync(join(tmpdir(), "validate-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const config = loadConfig({
  ...process.env,
  CRAFTOS_WORKSPACE: scratch,
  CRAFTOS_RUNTIME_ROOT: join(scratch, ".rt"),
});
function put(name: string, content = "print(1)"): void {
  const file = join(scratch, name);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
}

describe("world checks", () => {
  it("knows every WorldConfig key", () => {
    // the interface in world.ts is the truth: every top-level field of it, and nothing else; an addon's own keys
    // come from its worldKeys in addons.ts
    const source = readFileSync(join(import.meta.dirname, "world.ts"), "utf8");
    const body = source.slice(source.indexOf("export interface WorldConfig {"));
    const fields = new Set<string>();
    let depth = 0;
    for (const line of body.split("\n").slice(1)) {
      if (/^\s*(\/\/|\/?\*)/.test(line)) continue; // comments say anything
      if (depth === 0) {
        const m = /^ {2}(\w+)\??:/.exec(line);
        if (m) fields.add(m[1]!);
        if (/^\}/.test(line)) break;
      }
      depth += (line.match(/\{/g) ?? []).length;
      depth -= (line.match(/\}/g) ?? []).length;
    }
    expect(fields.size).toBeGreaterThan(30);
    const known = new Set([
      ...WORLD_KEYS,
      ...ADDONS.flatMap((a) => a.worldKeys ?? []),
    ]);
    expect([...fields].sort()).toEqual([...known].sort());
  });

  it("refuses a misspelt key and an unknown type, with suggestions, before boot", () => {
    const r = checkWorld({
      peripheralz: [],
      peripherals: [
        { name: "c", type: "minecraft:chets" },
        { name: "s", type: "speakr" },
        { name: "x", type: "mekanism:fake_block" },
      ],
    });
    expect(r.errors).toHaveLength(4);
    expect(r.errors[0]).toMatch(
      /world\.peripheralz .*Did you mean "peripherals"/,
    );
    expect(r.errors[1]).toMatch(
      /peripherals\[0\]\.type "minecraft:chets".*Did you mean "minecraft:chest"/,
    );
    expect(r.errors[2]).toMatch(/Did you mean "speaker"/);
    expect(r.errors[3]).toMatch(
      /fake_block" is not a peripheral the sim can build/,
    );
  });

  it("names the addon a near-miss type comes from", () => {
    const r = checkWorld({
      peripherals: [{ name: "p", type: "playerDetecter" }],
    });
    expect(r.errors[0]).toMatch(
      /Did you mean "playerDetector" \(Advanced Peripherals/,
    );
  });

  it("only warns about a key that is nothing like a real one, and allows notes", () => {
    const r = checkWorld({
      description: "a demo",
      $schema: "x",
      _comment: "y",
      somethingElse: 1,
    });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([expect.stringMatching(/world\.somethingElse/)]);
  });

  it("takes generic storage blocks of any name, and warns on a near miss", () => {
    expect(
      checkWorld({
        peripherals: [{ name: "f", type: "thermal:machine_furnace", size: 3 }],
      }),
    ).toEqual({ errors: [], warnings: [] });
    const near = checkWorld({
      peripherals: [{ name: "c", type: "minecraft:chets", size: 27 }],
    });
    expect(near.errors).toEqual([]);
    expect(near.warnings[0]).toMatch(/Did you mean "minecraft:chest"/);
  });

  it("points monitors at the monitors parameter, and catches missing and twice-used names", () => {
    const r = checkWorld({
      peripherals: [
        { name: "top", type: "monitor" },
        { type: "modem" },
        { name: "a", type: "modem" },
        { name: "a", type: "modem" },
      ],
    });
    expect(r.errors[0]).toMatch(/pass them in "monitors"/);
    expect(r.errors[1]).toMatch(/peripherals\[1\]\.name is missing/);
    expect(r.errors[2]).toMatch(/"a" is used twice/);
  });

  it("takes CC 1.114's redstone_relay on 1.21.1", () => {
    const relay = { peripherals: [{ name: "r", type: "redstone_relay" }] };
    expect(checkWorld({ ...relay, version: "1.21.1" }).errors).toEqual([]);
  });

  it("reports an addon that is off, and an unknown version", () => {
    expect(
      checkWorld({
        addons: "none",
        peripherals: [{ name: "p", type: "playerDetector" }],
      }).errors[0],
    ).toMatch(/Advanced Peripherals.*switched off/);
    expect(checkWorld({ version: "1.99" }).errors[0]).toMatch(/1\.99/);
  });

  it("didYouMean ignores case and a mod prefix, and gives up on far words", () => {
    expect(didYouMean("CHEST", ["minecraft:chest", "modem"])).toBe(
      "minecraft:chest",
    );
    expect(didYouMean("banana", ["modem", "speaker"])).toBeUndefined();
  });
});

describe("program checks", () => {
  put("hello.lua");
  put("src/door.lua");
  put("main.lua");
  it("accepts a workspace program, with or without .lua, and ROM programs", () => {
    expect(checkProgram(config, "hello.lua")).toBeUndefined();
    expect(checkProgram(config, "hello")).toBeUndefined();
    expect(checkProgram(config, "hello.lua extra args")).toBeUndefined();
    expect(checkProgram(config, "edit")).toBeUndefined();
  });

  it("refuses a missing one and suggests the nearest", () => {
    expect(checkProgram(config, "helo.lua")).toMatch(
      /no program "helo.lua" in the workspace.*Did you mean "hello.lua"/,
    );
    // the same file name in another folder
    expect(checkProgram(config, "door.lua")).toMatch(
      /Did you mean "src\/door.lua"/,
    );
  });

  it("follows the deploy list", () => {
    const world = { deploy: [{ from: "src" }] };
    expect(checkProgram(config, "door.lua", world)).toBeUndefined();
    expect(checkProgram(config, "main.lua", world)).toMatch(/deploy list/);
    expect(
      checkProgram(config, "app/door.lua", {
        deploy: [{ from: "src", to: "app" }],
      }),
    ).toBeUndefined();
  });

  it("checks test paths", () => {
    put("a.test.lua");
    expect(checkTestPaths(config, ["a.test.lua", "src"])).toEqual([]);
    expect(checkTestPaths(config, ["b.test.lua"])[0]).toMatch(
      /no file "b.test.lua".*Did you mean "a.test.lua"/,
    );
  });
});

describe("Lua errors", () => {
  it("splits file, line and message", () => {
    expect(parseLuaError("/src/rt.lua:12: boom")).toEqual({
      kind: "runtime",
      file: "src/rt.lua",
      line: 12,
      message: "boom",
    });
    expect(parseLuaError("plain message", "syntax")).toEqual({
      kind: "syntax",
      message: "plain message",
    });
  });
});
