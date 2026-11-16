import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { checkConfig, loadConfig } from "@craftos-mcp/runner";
import { parseMonitor } from "./shared.js";
import info from "./commands/info.js";
import run, { formatScreens } from "./commands/run.js";
import test, { formatTestReport } from "./commands/test.js";

const scratch = mkdtempSync(join(tmpdir(), "cli-ws-"));
const ready = checkConfig(loadConfig()).length === 0;
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function put(name: string, content: string): void {
  const file = join(scratch, name);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
}

/** Run a command and return what it printed and its exit code. */
async function call(
  command: { run(args: string[]): Promise<number> },
  ...args: string[]
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = vi
    .spyOn(console, "log")
    .mockImplementation((...a) => void out.push(a.join(" ")));
  const error = vi
    .spyOn(console, "error")
    .mockImplementation((...a) => void err.push(a.join(" ")));
  try {
    const code = await command.run(args);
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

describe("monitor option", () => {
  it("parses name:WxH and a text scale", () => {
    expect(parseMonitor("top:2x3")).toEqual({
      name: "top",
      blocksWide: 2,
      blocksHigh: 3,
    });
    expect(parseMonitor("m_0:4x1@0.5")).toEqual({
      name: "m_0",
      blocksWide: 4,
      blocksHigh: 1,
      textScale: 0.5,
    });
    expect(parseMonitor("left")).toEqual({
      name: "left",
      blocksWide: 1,
      blocksHigh: 1,
    });
    expect(() => parseMonitor("top:wide")).toThrow(/--monitor/);
  });
});

describe("reports", () => {
  it("lists failing tests with their errors and a summary", () => {
    const text = formatTestReport({
      passed: 1,
      failed: 1,
      files: [
        {
          file: "a.test.lua",
          status: "failed",
          durationMs: 5,
          tests: [
            { name: "good", passed: true },
            { name: "bad", passed: false, error: "expected 1, got 2" },
          ],
          terminal: ["boom"],
        },
      ],
    });
    expect(text).toContain("FAIL a.test.lua");
    expect(text).toContain("ok   good");
    expect(text).toContain("expected 1, got 2");
    expect(text).toContain("| boom");
    expect(text).toContain("1 file, 2 tests: 1 passed, 1 failed");
  });

  it("prints screens without trailing blank lines", () => {
    const text = formatScreens([
      {
        window: 0,
        peripheral: undefined,
        open: true,
        width: 3,
        height: 3,
        lines: ["hi", "", ""],
        cursor: { x: 1, y: 1 },
      },
      {
        window: 1,
        peripheral: "top",
        open: true,
        width: 2,
        height: 1,
        lines: ["ok"],
        cursor: { x: 1, y: 1 },
      },
    ]);
    expect(text).toBe(
      "--- terminal (3x3) ---\nhi\n--- monitor top (2x1) ---\nok",
    );
  });
});

describe("usage errors", () => {
  it("exits 2 with a message", async () => {
    const a = await call(run);
    expect(a.code).toBe(2);
    expect(a.err).toContain("give a program to run");
    const b = await call(test, "--nope");
    expect(b.code).toBe(2);
    expect(b.err).toContain("usage: craftos-mcp test");
    const c = await call(
      run,
      "x.lua",
      "--monitor",
      "bad:thing",
      "--dir",
      scratch,
    );
    expect(c.code).toBe(2);
  });

  it("--mc refuses an unknown Minecraft version", async () => {
    const r = await call(test, "--dir", scratch, "--mc", "1.12.2");
    expect(r.code).toBe(2);
    expect(r.err).toContain('--mc: unknown Minecraft version "1.12.2"');
  });

  it("help prints usage and exits 0", async () => {
    const r = await call(test, "--help");
    expect(r.code).toBe(0);
    expect(r.out).toContain("usage: craftos-mcp test");
  });
});

describe.skipIf(!ready)("against the real engine", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = process.cwd();
  });
  afterEach(() => process.chdir(cwd));

  it("info reports the setup", async () => {
    const r = await call(info, "--dir", scratch);
    expect(r.code).toBe(0);
    expect(r.out).toContain("engine");
    expect(r.out).toContain("advanced-peripherals");
    expect(r.out).toContain("Ready.");
  });

  it("info --mc shows that version's mods", async () => {
    const r = await call(info, "--dir", scratch, "--mc", "1.21.1");
    expect(r.out).toContain("CC:Tweaked 1.121.0 (Minecraft 1.21.1, neoforge)");
    expect(r.out).toMatch(
      /bigger-reactors\s+Bigger Reactors \(no release for 1\.21\.1\)/,
    );
  });

  it("test --mc runs the computer on that version", async () => {
    // its own folder: the other tests here run every file in theirs
    const dir = mkdtempSync(join(tmpdir(), "cli-mc-"));
    writeFileSync(
      join(dir, "host.test.lua"),
      'ccunit.test("host", function() ccunit.truthy(_HOST:find("1.121.0", 1, true), _HOST) end)',
    );
    const r = await call(test, "--dir", dir, "--mc", "1.20.1", "host.test.lua");
    rmSync(dir, { recursive: true, force: true });
    // without the 1.121.0 ROM (build-rom.mjs --download 1.20.1) the run says how to build it
    if (r.code === 2)
      expect(r.err).toContain("build-rom.mjs --download 1.20.1");
    else {
      expect(r.out).toContain("PASS host.test.lua");
      expect(r.code).toBe(0);
    }
  }, 60000);

  it("test passes, then fails with a non-zero exit code", async () => {
    put(
      "ok.test.lua",
      'ccunit.test("adds", function() ccunit.eq(1 + 1, 2) end)',
    );
    const pass = await call(test, "--dir", scratch, "ok.test.lua");
    expect(pass.out).toContain("PASS ok.test.lua");
    expect(pass.code).toBe(0);

    put(
      "sub/bad.test.lua",
      'ccunit.test("breaks", function() ccunit.eq(1, 2) end)',
    );
    const fail = await call(test, "--dir", scratch);
    expect(fail.code).toBe(1);
    expect(fail.out).toContain("PASS ok.test.lua");
    expect(fail.out).toContain("FAIL sub/bad.test.lua");
    expect(fail.out).toContain("1 passed, 1 failed");
  }, 90000);

  it("test takes paths relative to the current folder", async () => {
    put(
      "rel/in.test.lua",
      'ccunit.test("here", function() ccunit.truthy(true) end)',
    );
    process.chdir(join(scratch, "rel"));
    const r = await call(test, "--dir", scratch, "in.test.lua");
    expect(r.code).toBe(0);
    expect(r.out).toContain("PASS rel/in.test.lua");
  }, 60000);

  it("test says so when there are no test files", async () => {
    const empty = mkdtempSync(join(tmpdir(), "cli-empty-"));
    try {
      const r = await call(test, "--dir", empty);
      expect(r.code).toBe(2);
      expect(r.err).toContain("no *.test.lua files");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("run prints the terminal and a monitor, and saves PNGs", async () => {
    put(
      "show.lua",
      'print("hello", ...)\nlocal m = peripheral.wrap("top")\nm.setCursorPos(1,1)\nm.write("on monitor")',
    );
    const png = join(scratch, "shots", "out.png");
    const r = await call(
      run,
      "--dir",
      scratch,
      "show.lua",
      "--monitor",
      "top:2x1",
      "--screenshot",
      png,
      "--",
      "a",
      "-b",
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("show.lua: completed");
    expect(r.out).toContain("hello\ta\t-b");
    expect(r.out).toContain("--- monitor top (");
    expect(r.out).toContain("on monitor");
    expect(existsSync(png)).toBe(true);
    expect(existsSync(join(scratch, "shots", "out-top.png"))).toBe(true);
    expect(readFileSync(png).subarray(1, 4).toString()).toBe("PNG");
  }, 60000);

  it("run exits 1 when the program errors and 124 on a timeout", async () => {
    put("bad.lua", 'error("kaboom", 0)');
    const bad = await call(run, "--dir", scratch, "bad.lua");
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("kaboom");

    put("forever.lua", "while true do sleep(1) end");
    const slow = await call(
      run,
      "--dir",
      scratch,
      "forever.lua",
      "--timeout",
      "1",
    );
    expect(slow.code).toBe(124);
    expect(slow.out).toContain("timed_out");
  }, 60000);

  it("run loads a world file and --addons switches mods", async () => {
    put(
      "w.json",
      JSON.stringify({
        peripherals: [{ name: "chest_0", type: "minecraft:chest" }],
      }),
    );
    put("list.lua", 'print(peripheral.getType("chest_0"))');
    const r = await call(
      run,
      "--dir",
      scratch,
      "list.lua",
      "--world",
      join(scratch, "w.json"),
      "--addons",
      "none",
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("inventory");
  }, 60000);
});
