import { isBlockWorld, startInBlockWorld } from "./blockworld.js";
import type { RunnerConfig } from "./config.js";
import { captureScreens, startEngine } from "./engine.js";
import {
  type MonitorSpec,
  REDRAW_TERMINAL_LUA,
  luaString,
  monitorSetupLua,
} from "./lua.js";
import { DEFAULT_TIMEOUT_MS, readResultFile } from "./run.js";
import type { WorldConfig } from "./world.js";
import { listWorkspace } from "./workspace.js";

export interface TestCase {
  readonly name: string;
  readonly passed: boolean;
  readonly error?: string | undefined;
}

export interface TestFileResult {
  readonly file: string;
  readonly status: "passed" | "failed" | "timed_out" | "crashed";
  readonly tests: TestCase[];
  /** Final terminal text, included when a file did not pass. */
  readonly terminal?: string[] | undefined;
  readonly durationMs: number;
}

export interface TestRunResult {
  readonly passed: number;
  readonly failed: number;
  readonly files: TestFileResult[];
}

export interface TestRequest {
  /** Workspace-relative files or directories. Default: every *.test.lua. */
  readonly paths?: readonly string[];
  readonly monitors?: readonly MonitorSpec[];
  /** Simulated world (players, virtual peripherals). */
  readonly world?: WorldConfig;
  readonly timeoutMs?: number;
  /** Run the virtual clock this many times faster than real time (default 1). */
  readonly timeScale?: number;
}

export function discoverTests(
  workspaceDir: string,
  paths?: readonly string[],
): string[] {
  const roots = paths && paths.length > 0 ? paths : ["."];
  const found = new Set<string>();
  for (const root of roots) {
    if (root.endsWith(".lua")) {
      found.add(root.replace(/\\/g, "/"));
      continue;
    }
    for (const entry of listWorkspace(workspaceDir, root)) {
      if (entry.kind === "file" && entry.path.endsWith(".test.lua"))
        found.add(entry.path);
    }
  }
  return [...found].sort();
}

export function testBoot(
  file: string,
  monitors: readonly MonitorSpec[],
): string {
  return [
    monitorSetupLua(monitors),
    `_G.ccunit = dofile("/ccunit/ccunit.lua")`,
    `local ok, err = pcall(shell.run, ${luaString(file)})`,
    `if not ok then ccunit.test("load " .. ${luaString(file)}, function() error(err, 0) end) end`,
    REDRAW_TERMINAL_LUA,
    `ccunit.finish()`,
  ].join("\n");
}

async function runTestFile(
  config: RunnerConfig,
  file: string,
  request: TestRequest,
): Promise<TestFileResult> {
  const started = Date.now();
  const boot = testBoot(file, request.monitors ?? []);
  // a turtle's world: the host that shares its blocks and starts the computers it places
  const blocks =
    request.world && isBlockWorld(request.world)
      ? startInBlockWorld(config, boot, {
          label: "test",
          timeScale: request.timeScale,
          world: request.world,
        })
      : undefined;
  const handle =
    blocks?.handle ??
    startEngine(config, boot, {
      label: "test",
      timeScale: request.timeScale,
      world: request.world,
    });
  let timedOut = false;
  try {
    await handle.session
      .waitForExit(request.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      .catch(async () => {
        timedOut = true;
        await handle.session.stop(0);
      });
    const parsed = readResultFile<{ tests: TestCase[]; failed: number }>(
      handle.resultsDir,
      "results.json",
    );
    const tests = Array.isArray(parsed?.tests) ? parsed.tests : [];
    const status: TestFileResult["status"] = timedOut
      ? "timed_out"
      : !parsed || tests.length === 0
        ? "crashed"
        : parsed.failed > 0
          ? "failed"
          : "passed";
    const terminal =
      status === "passed"
        ? undefined
        : captureScreens(handle.session).flatMap((s) =>
            s.lines.filter((l) => l.length > 0),
          );
    return { file, status, tests, terminal, durationMs: Date.now() - started };
  } finally {
    if (blocks) {
      blocks.network.close();
      await blocks.host.dispose();
    }
    handle.dispose();
  }
}

export async function runTests(
  config: RunnerConfig,
  request: TestRequest = {},
  concurrency = 4,
): Promise<TestRunResult> {
  const files = discoverTests(config.workspaceDir, request.paths);
  const results: TestFileResult[] = new Array(files.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= files.length) return;
      results[index] = await runTestFile(config, files[index]!, request);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, files.length) }, worker),
  );
  let passed = 0;
  let failed = 0;
  for (const file of results) {
    for (const t of file.tests) t.passed ? passed++ : failed++;
    if (file.status === "timed_out" || file.status === "crashed") failed++;
  }
  return { passed, failed, files: results };
}
