// The test-report parser against a real `craftos-mcp test` report (0.2.0, Windows), and the launcher's command lines.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  declaredTests,
  errorLocations,
  monitorOptions,
  parseTestReport,
  syntaxError,
} from "../../src/testOutput.ts";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  directBase,
  launchFor,
  needsCmd,
  npmCacheDir,
} from "../../src/launcher.ts";

const REPORT = [
  "PASS a.test.lua (1 tests, 641 ms)",
  "  ok   t",
  "FAIL bad.test.lua (0 tests, 628 ms)",
  "  the file produced no results (the engine or the file crashed)",
  "  terminal:",
  "    | CraftOS 1.8",
  '    | With the "gps" program you can get the position of',
  "    | a computer.",
  "    | Unexpected =. Expected an expression.",
  "    | Line 1",
  "    | local x = = 1",
  "    |           ",
  "FAIL hang.test.lua (0 tests, 5024 ms)",
  "  the file did not finish before the timeout",
  "  terminal:",
  "    | CraftOS 1.8",
  "FAIL sub/a.test.lua (3 tests, 587 ms)",
  "  ok   adds",
  "  FAIL breaks",
  "         /sub/a.test.lua:3: expected 3 but got 2",
  "  FAIL throws",
  "         /sub/a.test.lua:5: kaboom",
  "         second line of the error",
  "  terminal:",
  "    | CraftOS 1.8",
  "",
  "4 files, 6 tests: 2 passed, 4 failed",
].join("\r\n");

test("reads every file, test, error and terminal", () => {
  const report = parseTestReport(REPORT);
  assert.deepEqual(report.summary, {
    files: 4,
    tests: 6,
    passed: 2,
    failed: 4,
  });
  assert.deepEqual(
    report.files.map((f) => [f.file, f.passed, f.problem, f.tests.length]),
    [
      ["a.test.lua", true, undefined, 1],
      ["bad.test.lua", false, "crashed", 0],
      ["hang.test.lua", false, "timed_out", 0],
      ["sub/a.test.lua", false, undefined, 3],
    ],
  );
  const sub = report.files[3];
  assert.equal(sub.durationMs, 587);
  assert.deepEqual(sub.tests, [
    { name: "adds", passed: true },
    {
      name: "breaks",
      passed: false,
      error: "/sub/a.test.lua:3: expected 3 but got 2",
    },
    {
      name: "throws",
      passed: false,
      error: "/sub/a.test.lua:5: kaboom\nsecond line of the error",
    },
  ]);
  assert.deepEqual(sub.terminal, ["CraftOS 1.8"]);
  assert.equal(report.files[1].terminal.length, 7);
});

test("a test name that looks like report text stays a name", () => {
  const report = parseTestReport(
    "FAIL x.test.lua (2 tests, 1 ms)\n  FAIL the file did not finish\n         x.test.lua:1: no\n  ok   terminal:\n",
  );
  assert.deepEqual(
    report.files[0].tests.map((t) => t.name),
    ["the file did not finish", "terminal:"],
  );
});

test("finds where an error was raised", () => {
  assert.deepEqual(errorLocations("/sub/a.test.lua:3: expected 3 but got 2"), [
    { file: "sub/a.test.lua", line: 3 },
  ]);
  assert.deepEqual(
    errorLocations(
      "examples/power/power_monitor.lua:20: attempt to index nil (from /lib/x.lua:4:)",
    ),
    [
      { file: "examples/power/power_monitor.lua", line: 20 },
      { file: "lib/x.lua", line: 4 },
    ],
  );
  assert.deepEqual(errorLocations("kaboom"), []);
});

test("reads CraftOS's syntax error out of the terminal", () => {
  const report = parseTestReport(REPORT);
  assert.deepEqual(syntaxError(report.files[1].terminal), {
    message: "Unexpected =. Expected an expression.",
    line: 1,
  });
  assert.deepEqual(
    syntaxError(["bios.lua", "x.test.lua:7: unexpected symbol near '='"]),
    { message: "x.test.lua:7: unexpected symbol near '='", line: 7 },
  );
  assert.equal(syntaxError(["CraftOS 1.8"]), undefined);
});

test("finds the literal ccunit.test names with their lines", () => {
  const source = [
    'ccunit.test("addition", function() ccunit.eq(1 + 1, 2) end)',
    "-- ccunit.test('commented out', function() end)",
    "local function helper() end",
    "ccunit.test('it says \\'hi\\'', function()",
    "end)",
    "ccunit.test(name, function() end)",
  ].join("\n");
  assert.deepEqual(declaredTests(source), [
    { name: "addition", line: 0 },
    { name: "it says 'hi'", line: 3 },
  ]);
});

test("a world's monitors become --monitor options", () => {
  assert.deepEqual(
    monitorOptions({
      monitors: [
        { name: "top", blocksWide: 4, blocksHigh: 3 },
        { name: "left", blocksWide: 2, blocksHigh: 2, textScale: 0.5 },
        { blocksWide: 1 },
      ],
    }),
    ["--monitor", "top:4x3", "--monitor", "left:2x2@0.5"],
  );
  assert.deepEqual(monitorOptions({ peripherals: [] }), []);
});

test("Windows starts npx through cmd, everything else directly", () => {
  const base = ["npx", "-y", "craftos-mcp@0.2.0"];
  assert.deepEqual(
    launchFor(base, ["serve"], "win32", "C:\\Windows\\cmd.exe"),
    {
      command: "C:\\Windows\\cmd.exe",
      args: ["/d", "/c", "npx", "-y", "craftos-mcp@0.2.0", "serve"],
    },
  );
  assert.deepEqual(launchFor(base, ["serve"], "linux"), {
    command: "npx",
    args: ["-y", "craftos-mcp@0.2.0", "serve"],
  });
  assert.deepEqual(launchFor(["node", "C:/x y/index.js"], ["serve"], "win32"), {
    command: "node",
    args: ["C:/x y/index.js", "serve"],
  });
  assert.equal(needsCmd("C:\\tools\\craftos-mcp.cmd", "win32"), true);
  assert.equal(needsCmd("C:\\Program Files\\nodejs\\node.exe", "win32"), false);
});

test("the pinned npx command runs the cached package directly once npx has it", () => {
  const cache = mkdtempSync(join(tmpdir(), "craftos-npx-"));
  const spec = "craftos-mcp@9.8.7";
  const env = { npm_config_cache: cache };
  const base = ["npx", "-y", spec];
  try {
    assert.equal(npmCacheDir(env, "win32"), cache);
    assert.equal(
      npmCacheDir({ LOCALAPPDATA: "C:\Users\a\AppData\Local" }, "win32"),
      join("C:\Users\a\AppData\Local", "npm-cache"),
    );
    // nothing cached: npx as before
    assert.deepEqual(directBase(base, env), base);
    const hash = createHash("sha512").update(spec).digest("hex").slice(0, 16);
    const modules = join(cache, "_npx", hash, "node_modules");
    const pkg = join(modules, "craftos-mcp");
    mkdirSync(join(pkg, "scripts", "npm"), { recursive: true });
    writeFileSync(join(pkg, "scripts", "npm", "craftos-mcp.mjs"), "");
    const manifest = (version) =>
      writeFileSync(
        join(pkg, "package.json"),
        JSON.stringify({
          version,
          bin: { "craftos-mcp": "scripts/npm/craftos-mcp.mjs" },
          dependencies: { zod: "4" },
        }),
      );
    manifest("9.8.7");
    // a dependency missing (an install cut short): still npx
    assert.deepEqual(directBase(base, env), base);
    mkdirSync(join(modules, "zod"), { recursive: true });
    writeFileSync(join(modules, "zod", "package.json"), "{}");
    assert.deepEqual(directBase(base, env), [
      "node",
      join(pkg, "scripts", "npm", "craftos-mcp.mjs"),
    ]);
    // another version in that folder, an unpinned spec, a custom command: left alone
    manifest("9.8.6");
    assert.deepEqual(directBase(base, env), base);
    manifest("9.8.7");
    assert.deepEqual(directBase(["npx", "-y", "craftos-mcp"], env), [
      "npx",
      "-y",
      "craftos-mcp",
    ]);
    assert.deepEqual(directBase(["craftos-mcp"], env), ["craftos-mcp"]);
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});
