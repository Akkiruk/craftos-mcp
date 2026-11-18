// init, doctor, cache and test --watch, and craftos.json as every command reads it.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  type TestRunResult,
  checkConfig,
  loadConfig,
  runTests,
} from "@craftos-mcp/runner";
import cache from "./commands/cache.js";
import doctor, { formatChecks } from "./commands/doctor.js";
import init, { projectFrom } from "./commands/init.js";
import run from "./commands/run.js";
import test from "./commands/test.js";
import { configFor } from "./shared.js";
import { affectedTests, summaryLine, watchTests } from "./watch.js";

const ready = checkConfig(loadConfig()).length === 0;
const scratch = mkdtempSync(join(tmpdir(), "cli-tools-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A fresh folder under the scratch one, with these files. */
function folder(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(scratch, "p-"));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

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

describe("init", () => {
  it("--yes writes craftos.json from the flags and the defaults, and makes the folder", async () => {
    const dir = folder();
    const r = await call(
      init,
      "--yes",
      "--dir",
      dir,
      "--workspace",
      "lua",
      "--mc",
      "1.20.1",
      "--addons",
      "create,mekanism",
      "--tests",
      "tests/**/*.test.lua",
    );
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const written = JSON.parse(readFileSync(join(dir, "craftos.json"), "utf8"));
    expect(written).toMatchObject({
      workspace: "lua",
      minecraft: "1.20.1",
      addons: ["create", "mekanism"],
      tests: ["tests/**/*.test.lua"],
    });
    expect(written.$schema).toMatch(/craftos\.schema\.json$/);
    expect(existsSync(join(dir, "lua"))).toBe(true);
    // there already: --force replaces it
    const again = await call(init, "--yes", "--dir", dir);
    expect(again.code).toBe(2);
    expect(again.err).toMatch(/--force/);
    expect((await call(init, "--yes", "--force", "--dir", dir)).code).toBe(0);
  });

  it("refuses a bad version or mod before writing anything", async () => {
    const dir = folder();
    const r = await call(init, "--yes", "--dir", dir, "--mc", "1.12.2");
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/minecraft: unknown version/);
    expect(existsSync(join(dir, "craftos.json"))).toBe(false);
  });

  it("leaves blank answers out and picks a lone world file", () => {
    expect(
      projectFrom({ workspace: "", addons: "ALL", tests: " a.test.lua , " }),
    ).toEqual({
      $schema: expect.any(String),
      workspace: ".",
      addons: "all",
      tests: ["a.test.lua"],
    });
    expect(projectFrom({ world: "none" }).world).toBeUndefined();
    // mods by name as well as by id
    expect(
      projectFrom({ addons: "Advanced Peripherals, create" }).addons,
    ).toEqual(["advanced-peripherals", "create"]);
  });

  it("--yes takes no mods and never picks a world file by itself", async () => {
    const dir = folder({ "turtle.world.json": "{}" });
    const r = await call(init, "--yes", "--dir", dir);
    expect(r.code).toBe(0);
    const written = JSON.parse(readFileSync(join(dir, "craftos.json"), "utf8"));
    expect(written.addons).toBe("none");
    expect(written.world).toBeUndefined();
  });
});

describe.skipIf(!ready)("run", () => {
  it("says how to give a program more time when it was stopped at the timeout", async () => {
    const dir = folder({
      "slow.lua": 'print("working") sleep(30) print("done")',
    });
    const r = await call(run, "slow.lua", "--dir", dir, "--timeout", "1");
    expect(r.code).toBe(124);
    expect(r.out).toMatch(/Still running after 1 s/);
    expect(r.out).toMatch(/--timeout 120/);
    expect(r.out).toMatch(/--timescale 5/);
  }, 60000);
});

describe("craftos.json in the commands", () => {
  it("a broken one is a message, not a stack", async () => {
    const dir = folder({ "craftos.json": '{ "minecraft": "1.12.2" }' });
    const r = await call(run, "x.lua", "--dir", dir);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/craftos\.json: minecraft: unknown version/);
  });

  it("gives the workspace and version; a flag and the environment still win", () => {
    const dir = folder({
      "craftos.json": JSON.stringify({ workspace: "src", minecraft: "1.20.1" }),
      "src/a.lua": "",
    });
    const cwd = process.cwd();
    const before = process.env["CRAFTOS_VERSION"];
    delete process.env["CRAFTOS_VERSION"];
    try {
      process.chdir(dir);
      expect(configFor(undefined).workspaceDir).toBe(join(dir, "src"));
      expect(process.env["CRAFTOS_VERSION"]).toBe("1.20.1");
      // --dir wins for the folder
      expect(configFor(dir).workspaceDir).toBe(dir);
      // an environment variable the person set wins over the file
      process.chdir(cwd);
      process.env["CRAFTOS_VERSION"] = "1.18.2";
      process.chdir(dir);
      configFor(undefined);
      expect(process.env["CRAFTOS_VERSION"]).toBe("1.18.2");
    } finally {
      process.chdir(cwd);
      // and leaving the project takes its values back
      delete process.env["CRAFTOS_VERSION"];
      configFor(scratch);
      expect(process.env["CRAFTOS_VERSION"]).toBeUndefined();
      if (before !== undefined) process.env["CRAFTOS_VERSION"] = before;
    }
  });
});

describe.skipIf(!ready)("craftos.json against the real engine", () => {
  it("test runs the files its globs pick, and the world it names", async () => {
    const dir = folder({
      "craftos.json": JSON.stringify({
        tests: ["unit/**/*.test.lua"],
        world: "my.world.json",
      }),
      "my.world.json": JSON.stringify({ computerId: 7 }),
      "unit/id.test.lua":
        'ccunit.test("id", function() ccunit.eq(os.getComputerID(), 7) end)',
      "slow/never.test.lua": 'ccunit.test("no", function() error("ran") end)',
    });
    const r = await call(test, "--dir", dir);
    expect(r.out).toContain("PASS unit/id.test.lua");
    expect(r.out).not.toContain("never.test.lua");
    expect(r.code).toBe(0);
    // a path given picks the files instead
    const named = await call(test, "--dir", dir, "slow");
    expect(named.out).toContain("FAIL slow/never.test.lua");
  }, 90000);
});

describe("doctor", () => {
  it("prints each check, with a fix under a failure", () => {
    const text = formatChecks([
      { name: "Node.js", status: "ok", detail: "v22.0.0" },
      {
        name: "engine",
        status: "fail",
        detail: "no engine",
        fix: "run: craftos-mcp setup --force",
      },
    ]);
    expect(text).toMatch(/ok {4}Node\.js/);
    expect(text).toMatch(/FAIL {2}engine/);
    expect(text).toMatch(/fix: run: craftos-mcp setup --force/);
    expect(text).toMatch(/1 check failed\./);
  });

  it("--json, with a broken craftos.json and world file failing", async () => {
    const dir = folder({
      "craftos.json": '{ "workspce": "." }',
      "bad.world.json": '{ "peripheral": [] }',
    });
    const r = await call(doctor, "--dir", dir, "--json", "--skip-boot");
    expect(r.code).toBe(1);
    const report = JSON.parse(r.out) as {
      ok: boolean;
      checks: { name: string; status: string; fix?: string }[];
    };
    expect(report.ok).toBe(false);
    const by = (name: string) => report.checks.find((c) => c.name === name);
    expect(by("Node.js")?.status).toBe("ok");
    expect(by("craftos.json")?.status).toBe("fail");
    expect(by("craftos.json")?.fix).toBeTruthy();
    expect(by("world files")?.status).toBe("fail");
    expect(by("boot")?.status).toBe("skip");
    expect(by("quarantine")?.status).toBe(
      process.platform === "darwin" ? expect.any(String) : "skip",
    );
  });

  it.skipIf(!ready)(
    "passes on a ready setup, a hello world included",
    async () => {
      const dir = folder({ "craftos.json": '{ "workspace": "." }' });
      const r = await call(doctor, "--dir", dir);
      expect(r.out).toMatch(/ok {4}engine runs\s+CraftOS-PC v/);
      expect(r.out).toMatch(/ok {4}boot\s+hello world ran/);
      expect(r.out).toContain("Everything is ready.");
      expect(r.code).toBe(0);
    },
    90000,
  );
});

describe("cache", () => {
  it("lists the versions and prunes all but the newest two", async () => {
    const home = folder();
    for (const v of ["0.1.0", "0.2.0", "0.3.0"]) {
      mkdirSync(join(home, v, "engine"), { recursive: true });
      writeFileSync(join(home, v, "engine", "x"), "12345");
    }
    const before = process.env["CRAFTOS_HOME"];
    process.env["CRAFTOS_HOME"] = home;
    try {
      const list = await call(cache, "list");
      expect(list.code).toBe(0);
      expect(list.out).toMatch(/0\.1\.0 .*prune removes it/);
      expect(list.out).not.toMatch(/0\.3\.0 .*prune removes it/);
      const dry = await call(cache, "prune", "--dry-run");
      expect(dry.out).toMatch(/would remove 0\.1\.0/);
      expect(existsSync(join(home, "0.1.0"))).toBe(true);
      const pruned = await call(cache, "prune");
      expect(pruned.out).toMatch(/removed 0\.1\.0 .*kept 0\.2\.0, 0\.3\.0/);
      expect(existsSync(join(home, "0.1.0"))).toBe(false);
      expect((await call(cache, "prune")).out).toMatch(/nothing to prune/);
      expect((await call(cache, "tidy")).code).toBe(2);
    } finally {
      if (before === undefined) delete process.env["CRAFTOS_HOME"];
      else process.env["CRAFTOS_HOME"] = before;
    }
  });
});

describe("test --watch", () => {
  const tests = ["a.test.lua", "b.test.lua", "sub/c.test.lua"];
  const texts: Record<string, string> = {
    "a.test.lua": 'local util = require("util")',
    "b.test.lua": 'local m = require("lib.menu") dofile("/draw.lua")',
    "sub/c.test.lua": 'ccunit.run("app.lua", { seconds = 1 })',
  };
  const read = (p: string) => texts[p] ?? "";

  it("reruns the changed test files and the ones that load a changed module", () => {
    expect(affectedTests(["sub/c.test.lua"], tests, read)).toEqual([
      "sub/c.test.lua",
    ]);
    expect(affectedTests(["util.lua"], tests, read)).toEqual(["a.test.lua"]);
    expect(affectedTests(["lib/menu.lua", "app.lua"], tests, read)).toEqual([
      "b.test.lua",
      "sub/c.test.lua",
    ]);
    expect(affectedTests(["draw.lua"], tests, read)).toEqual(["b.test.lua"]);
    // a module no test names: every test, it may be loaded some other way
    expect(affectedTests(["other.lua"], tests, read)).toEqual(tests);
    expect(affectedTests(["notes.txt"], tests, read)).toEqual([]);
  });

  it("says when and what ran in one line", () => {
    const result: TestRunResult = { passed: 3, failed: 1, files: [] };
    const line = summaryLine(
      result,
      1,
      3,
      ["util.lua"],
      new Date(2026, 0, 1, 9, 5, 7),
    );
    expect(line).toBe(
      "[09:05:07] FAIL 4 tests: 3 passed, 1 failed (1 of 3 files for util.lua). Watching for changes; Ctrl+C stops.",
    );
  });

  it("counts skipped tests in the watch summary too", () => {
    const line = summaryLine(
      { passed: 1, failed: 2, skipped: 1, files: [] },
      1,
      1,
      [],
      new Date(2026, 0, 1, 9, 5, 7),
    );
    expect(line).toBe(
      "[09:05:07] FAIL 4 tests: 1 passed, 2 failed, 1 skipped (1 file). Watching for changes; Ctrl+C stops.",
    );
  });

  it("refuses machine-readable reports", async () => {
    const r = await call(test, "--watch", "--json", "--dir", scratch);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/--watch prints the human report/);
  });

  it.skipIf(!ready)(
    "runs everything, then only what a change touches",
    async () => {
      const dir = folder({
        "util.lua": "return { n = 1 }",
        "a.test.lua":
          'local u = require("util") ccunit.test("n", function() ccunit.eq(u.n, 1) end)',
        "b.test.lua": 'ccunit.test("b", function() ccunit.truthy(true) end)',
      });
      const config = loadConfig({ ...process.env, CRAFTOS_WORKSPACE: dir });
      const runs: { files: string[]; changed: string[]; failed: number }[] = [];
      const stop = new AbortController();
      let next: () => void = () => undefined;
      const ran = () => new Promise<void>((done) => (next = done));
      const first = ran();
      const watching = watchTests({
        workspaceDir: dir,
        listTests: () => ["a.test.lua", "b.test.lua"],
        signal: stop.signal,
        debounceMs: 100,
        run: async (files, changed) => {
          const result = await runTests(config, { paths: files });
          runs.push({ files, changed, failed: result.failed });
          next();
        },
      });
      await first;
      expect(runs[0]).toEqual({
        files: ["a.test.lua", "b.test.lua"],
        changed: [],
        failed: 0,
      });
      const second = ran();
      writeFileSync(join(dir, "util.lua"), "return { n = 2 }");
      await second;
      stop.abort();
      await watching;
      expect(runs[1]).toEqual({
        files: ["a.test.lua"],
        changed: ["util.lua"],
        failed: 1,
      });
    },
    90000,
  );
});
