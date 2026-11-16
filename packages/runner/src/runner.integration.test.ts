import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkConfig, loadConfig, runProgram, runTests } from "./index.js";

const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "runner-ws-"));
const config = { ...base, workspaceDir: scratch };
const ready = checkConfig(config).length === 0;

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function put(name: string, content: string): void {
  const file = join(scratch, name);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
}

describe.skipIf(!ready)("runner against the real engine", () => {
  it("runs a program and captures terminal output", async () => {
    put("hello.lua", 'print("Hello from CC:Tweaked")');
    const result = await runProgram(config, { program: "hello.lua" });
    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.screens[0]?.lines.join("\n")).toContain(
      "Hello from CC:Tweaked",
    );
  }, 40000);

  it("reports a failing program", async () => {
    put("bad.lua", 'error("kaboom", 0)');
    const result = await runProgram(config, { program: "bad.lua" });
    expect(result.status).toBe("program_failed");
    expect(result.screens[0]?.lines.join("\n")).toContain("kaboom");
  }, 40000);

  it("renders a block-sized monitor and screenshots it", async () => {
    put(
      "mon.lua",
      'local m = peripheral.wrap("top") m.setBackgroundColor(colors.blue) m.clear() m.setCursorPos(1,1) m.write("hi") local w,h = m.getSize() print(w.."x"..h)',
    );
    const result = await runProgram(config, {
      program: "mon.lua",
      monitors: [{ name: "top", blocksWide: 2, blocksHigh: 2 }],
      screenshots: true,
    });
    const monitor = result.screens.find((s) => s.peripheral === "top");
    expect(monitor).toBeDefined();
    expect([monitor!.width, monitor!.height]).toEqual([18, 12]);
    expect(monitor!.lines[0]).toBe("hi");
    expect(Buffer.from(monitor!.png!, "base64").subarray(1, 4).toString()).toBe(
      "PNG",
    );
    expect(result.screens[0]?.lines.join("\n")).toContain("18x12");
  }, 40000);

  it("times out a runaway program", async () => {
    put("loop.lua", "while true do end");
    const result = await runProgram(config, {
      program: "loop.lua",
      timeoutMs: 1500,
    });
    expect(result.status).toBe("timed_out");
  }, 40000);

  it("runs ccunit tests", async () => {
    put(
      "a.test.lua",
      'ccunit.test("ok", function() ccunit.eq(2, 2) end) ccunit.test("bad", function() ccunit.eq(1, 2) end)',
    );
    put(
      "b.test.lua",
      'ccunit.test("fine", function() ccunit.truthy(true) end)',
    );
    const result = await runTests(config);
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(1);
    const a = result.files.find((f) => f.file === "a.test.lua")!;
    expect(a.status).toBe("failed");
    expect(a.tests.find((t) => t.name === "bad")?.error).toContain(
      "expected 2",
    );
  }, 60000);

  it("runs a virtual clock faster than real time", async () => {
    put(
      "slow.lua",
      'local c = os.clock() sleep(20) print(string.format("elapsed=%.0f", os.clock() - c))',
    );
    const result = await runProgram(config, {
      program: "slow.lua",
      timeScale: 20,
    });
    expect(result.status).toBe("completed");
    expect(result.screens[0]?.lines.join("\n")).toContain("elapsed=20");
    expect(result.durationMs).toBeLessThan(8000);
  }, 40000);

  it("aborts code that never yields, like CC:Tweaked", async () => {
    put("spin.lua", "while true do end");
    const result = await runProgram(config, {
      program: "spin.lua",
      timeoutMs: 20000,
    });
    expect(result.status).toBe("program_failed");
    expect(result.screens[0]?.lines.join("\n")).toContain(
      "Too long without yielding",
    );
  }, 40000);

  it("has a pinned engine and ROM on disk", () => {
    expect(existsSync(config.engineExe)).toBe(true);
  });
});
