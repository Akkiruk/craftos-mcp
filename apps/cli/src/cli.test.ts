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

  it("refuses a wall bigger than the game allows, as a message, not a crash", () => {
    expect(parseMonitor("top:8x6").blocksWide).toBe(8);
    expect(() => parseMonitor("top:9x9")).toThrow(
      /--monitor top:9x9: monitor "top" is 9x9 blocks; a monitor wall is at most 8x6/,
    );
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

  it("counts skipped tests in the total, so the numbers add up", () => {
    const text = formatTestReport({
      passed: 1,
      failed: 2,
      skipped: 1,
      files: [
        {
          file: "a.test.lua",
          status: "failed",
          durationMs: 5,
          tests: [
            { name: "one", passed: false, error: "x" },
            { name: "two", passed: false, error: "y" },
            { name: "later", passed: true, skipped: true },
            { name: "good", passed: true },
          ],
        },
        {
          file: "b.test.lua",
          status: "passed",
          durationMs: 5,
          tests: [{ name: "only", passed: true }],
        },
      ],
    });
    expect(text).toContain("FAIL a.test.lua (4 tests, 5 ms)");
    expect(text).toContain("PASS b.test.lua (1 test, 5 ms)");
    expect(text).toContain("2 files, 4 tests: 1 passed, 2 failed, 1 skipped");
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

  it("run from a clone's root uses its workspace folder and finishes", async () => {
    // it used to copy the whole repo, .runtime with every old run in it, before the timeout even started
    // the clone's own default, not the CRAFTOS_WORKSPACE the other tests here leave set
    const { CRAFTOS_WORKSPACE: _, ...env } = process.env;
    const clone = loadConfig(env);
    const name = `tmp/cli-root-${process.pid}.lua`;
    const file = join(clone.workspaceDir, name);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, 'print("from the root")');
    process.chdir(join(clone.workspaceDir, ".."));
    const saved = process.env["CRAFTOS_WORKSPACE"];
    try {
      const started = Date.now();
      const r = await call(run, `workspace/${name}`, "--timeout", "20");
      expect(r.out).toContain("from the root");
      expect(r.code).toBe(0);
      expect(Date.now() - started).toBeLessThan(20000);
    } finally {
      if (saved === undefined) delete process.env["CRAFTOS_WORKSPACE"];
      else process.env["CRAFTOS_WORKSPACE"] = saved;
      rmSync(file, { force: true });
    }
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

  it("run attaches the monitors a world file lists, and --monitor replaces one of the same name", async () => {
    put(
      "wall.lua",
      'local m = peripheral.wrap("top")\nm.setCursorPos(1,1)\nm.write("on the wall")',
    );
    put(
      "wall.world.json",
      JSON.stringify({
        monitors: [{ name: "top", blocksWide: 2, blocksHigh: 1 }],
      }),
    );
    const world = join(scratch, "wall.world.json");
    const r = await call(run, "--dir", scratch, "wall.lua", "--world", world);
    expect(r.code).toBe(0);
    expect(r.out).toContain("--- monitor top (18x5)");
    expect(r.out).toContain("on the wall");
    const bigger = await call(
      run,
      "--dir",
      scratch,
      "wall.lua",
      "--world",
      world,
      "--monitor",
      "top:3x1",
    );
    expect(bigger.out).toContain("--- monitor top (29x5)");
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

describe.skipIf(!ready)("checks and reports", () => {
  it("run refuses a missing program and a bad world before booting", async () => {
    put("real.lua", 'print("ok")');
    const missing = await call(run, "--dir", scratch, "rael.lua");
    expect(missing.code).toBe(2);
    expect(missing.err).toMatch(
      /no program "rael.lua".*Did you mean "real.lua"/,
    );
    put("typo.json", JSON.stringify({ peripheralz: [] }));
    const world = await call(
      run,
      "--dir",
      scratch,
      "real.lua",
      "--world",
      join(scratch, "typo.json"),
    );
    expect(world.code).toBe(2);
    expect(world.err).toMatch(/Did you mean "peripherals"/);
  });

  it("run says a bad --addons id came from --addons and suggests the id meant", async () => {
    put("real.lua", 'print("ok")');
    const r = await call(
      run,
      "--dir",
      scratch,
      "real.lua",
      "--addons",
      "mekansim",
    );
    expect(r.code).toBe(2);
    expect(r.err).toMatch(
      /unknown addon "mekansim" in --addons\. Did you mean "mekanism"\?/,
    );
    expect(r.err).not.toMatch(/world\.addons/);
  });

  it("run says a world file is not there, and lists the saved worlds for a wrong name", async () => {
    put("real.lua", 'print("ok")');
    const file = await call(
      run,
      "--dir",
      scratch,
      "real.lua",
      "--world",
      "typo.world.jsn",
    );
    expect(file.code).toBe(2);
    expect(file.err).toContain("no world file typo.world.jsn (looked in ");
    const name = await call(
      run,
      "--dir",
      scratch,
      "real.lua",
      "--world",
      "no-such-world",
    );
    expect(name.code).toBe(2);
    expect(name.err).toMatch(
      /^no world named "no-such-world" in .*it has: .*generic-storage-demo/,
    );
  });

  it("run prints the error with its file and line", async () => {
    put("oops.lua", "local t = nil\nprint(t.x)\n");
    const r = await call(run, "--dir", scratch, "oops.lua");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/error \(runtime\): oops\.lua:2: attempt to index/);
  }, 60000);

  const suite = (): void => {
    mkdirSync(join(scratch, "rep"), { recursive: true });
    put(
      "rep/mixed.test.lua",
      [
        'ccunit.test("good", function() ccunit.eq(1, 1) end)',
        'ccunit.test("bad <one>", function() ccunit.eq(1, 2) end)',
        'ccunit.skip("later")',
      ].join("\n"),
    );
  };

  it("test --json prints the whole result", async () => {
    suite();
    const r = await call(test, "--dir", scratch, "rep", "--json");
    expect(r.code).toBe(1);
    const result = JSON.parse(r.out) as {
      passed: number;
      failed: number;
      skipped: number;
      files: { tests: { name: string; line?: number }[] }[];
    };
    expect([result.passed, result.failed, result.skipped]).toEqual([1, 1, 1]);
    expect(result.files[0]!.tests[1]).toMatchObject({
      name: "bad <one>",
      line: 2,
    });
  }, 60000);

  it("test --reporter junit writes XML, and github annotates the line", async () => {
    suite();
    const out = join(scratch, "reports", "junit.xml");
    const j = await call(
      test,
      "--dir",
      scratch,
      "rep",
      "--reporter",
      "junit",
      "--out",
      out,
    );
    expect(j.code).toBe(1);
    expect(j.out).toContain("1 passed, 1 failed, 1 skipped");
    const xml = readFileSync(out, "utf8");
    expect(xml).toMatch(
      /<testsuite name="rep\/mixed.test.lua" tests="3" failures="1" skipped="1"/,
    );
    expect(xml).toContain('name="bad &lt;one&gt;"><failure message=');
    expect(xml).toContain("<skipped/>");
    const cwd = process.cwd();
    process.chdir(scratch);
    try {
      const g = await call(test, "rep", "--reporter", "github");
      expect(g.code).toBe(1);
      expect(g.out).toMatch(
        /^::error file=rep\/mixed\.test\.lua,line=2,title=bad <one>::.*expected 2 but got 1/m,
      );
    } finally {
      process.chdir(cwd);
    }
  }, 60000);

  it("test refuses a test file that is not there", async () => {
    const r = await call(test, "--dir", scratch, "rep/mixd.test.lua");
    expect(r.code).toBe(2);
    expect(r.err).toMatch(
      /no file "rep\/mixd.test.lua".*Did you mean "rep\/mixed.test.lua"/,
    );
  });
});
