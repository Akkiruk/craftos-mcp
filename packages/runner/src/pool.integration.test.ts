// Computers sharing one engine (CRAFTOS_POOL, rawterm pool.ts) read their files as if each had an engine of its own.
// Two engine bugs only showed with many computers on the threads of one process: get_comp looked its table up without
// the lock while other computers were added (a lookup could return another computer), and a file stream on CC 1.109+
// fclosed its FILE twice, so the FILE another computer had just opened was closed under it and read as empty (a
// module of rom/ccsim came back with nothing in it, and the sim failed to start).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { checkConfig, loadConfig, runProgram } from "./index.js";

const scratch = mkdtempSync(join(tmpdir(), "pool-ws-"));
const config = { ...loadConfig(), workspaceDir: scratch };
const ready = checkConfig(config).length === 0;

afterEach(() => {
  delete process.env["CRAFTOS_POOL"];
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe.skipIf(!ready)("computers in a shared engine", () => {
  for (const version of ["1.18.2", "1.21.1"]) {
    it(`twelve at once read the same ROM file 200 times each, never short (${version})`, async () => {
      writeFileSync(
        join(scratch, "reads.lua"),
        `local function len()
  local h = fs.open("/rom/apis/textutils.lua", "r")
  if not h then return -1 end
  local t = h.readAll() h.close() return t and #t or -2
end
local want, bad = len(), 0
for i = 1, 200 do if len() ~= want then bad = bad + 1 end end
print("bad " .. bad .. " of " .. want)`,
      );
      process.env["CRAFTOS_POOL"] = "16";
      const results = await Promise.all(
        Array.from({ length: 12 }, () =>
          runProgram(config, {
            program: "reads.lua",
            world: { version },
            timeoutMs: 90000,
          }),
        ),
      );
      for (const r of results) {
        expect(r.status).toBe("completed");
        expect(r.screens[0]?.lines.join("\n")).toMatch(/bad 0 of \d+/);
      }
    }, 120000);
  }

  it("twelve turtles at once all boot as turtles", async () => {
    writeFileSync(join(scratch, "probe.lua"), "print(type(turtle))");
    process.env["CRAFTOS_POOL"] = "16";
    const world = {
      version: "1.21.1",
      turtle: { x: 0, y: 64, z: 0, facing: "north" as const, fuel: 100 },
      ground: { y: 63, name: "minecraft:stone" },
    };
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        runProgram(config, { program: "probe.lua", world, timeoutMs: 90000 }),
      ),
    );
    for (const r of results)
      expect(r.screens[0]?.lines.filter(Boolean)).toContain("table");
  }, 120000);
});
