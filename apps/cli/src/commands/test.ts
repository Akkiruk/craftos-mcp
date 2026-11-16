import type { Command } from "../command.js";
import {
  UsageError,
  configFor,
  guarded,
  loadWorld,
  number,
  parse,
  parseMonitor,
  workspacePath,
} from "../shared.js";
import { type TestRunResult, runTests } from "@craftos-mcp/runner";

const USAGE = [
  "usage: craftos-mcp test [paths...] [--world x.json] [--mc 1.20.1] [--addons a,b] [--timescale n]",
  "                        [--monitor name:WxH] [--timeout seconds] [--dir folder]",
  "",
  "--mc picks the Minecraft version: 1.18.2 (CC:Tweaked 1.101.3, the default), 1.20.1 or 1.21.1 (CC:Tweaked 1.121.0).",
  "Runs every *.test.lua under the paths (default: the current folder) with the ccunit harness, each file in",
  "its own fresh computer. Exits 0 when everything passes, 1 when a test fails, 2 on a usage error.",
].join("\n");

/** The human-readable report: one block per file, the failing tests with their errors, then a summary line. */
export function formatTestReport(result: TestRunResult): string {
  const out: string[] = [];
  for (const file of result.files) {
    const label = file.status === "passed" ? "PASS" : "FAIL";
    out.push(
      `${label} ${file.file} (${file.tests.length} tests, ${file.durationMs} ms)`,
    );
    for (const t of file.tests) {
      out.push(`  ${t.passed ? "ok  " : "FAIL"} ${t.name}`);
      if (!t.passed && t.error) {
        for (const line of t.error.split("\n")) out.push(`         ${line}`);
      }
    }
    if (file.status === "timed_out")
      out.push("  the file did not finish before the timeout");
    if (file.status === "crashed")
      out.push(
        "  the file produced no results (the engine or the file crashed)",
      );
    if (file.status !== "passed" && file.terminal?.length) {
      out.push("  terminal:");
      for (const line of file.terminal) out.push(`    | ${line}`);
    }
  }
  const total = result.passed + result.failed;
  out.push("");
  out.push(
    `${result.files.length} file${result.files.length === 1 ? "" : "s"}, ${total} test${total === 1 ? "" : "s"}: ` +
      `${result.passed} passed, ${result.failed} failed`,
  );
  return out.join("\n");
}

const test: Command = {
  name: "test",
  summary:
    "run *.test.lua files with the ccunit harness (exits non-zero on failure)",
  usage: USAGE,
  run: (args) =>
    guarded(USAGE, async () => {
      const { values, positionals } = parse(args, {
        timescale: { type: "string" },
        timeout: { type: "string" },
        monitor: { type: "string", multiple: true },
      });
      if (values.help) {
        console.log(USAGE);
        return 0;
      }
      const config = configFor(values.dir);
      const timeout = number("timeout", values.timeout);
      const result = await runTests(config, {
        paths: positionals.map((p) => workspacePath(config, p)),
        monitors: (values.monitor ?? []).map(parseMonitor),
        world: loadWorld(config, values.world, values.addons, values.mc),
        timeScale: number("timescale", values.timescale),
        ...(timeout ? { timeoutMs: timeout * 1000 } : {}),
      });
      if (result.files.length === 0) {
        throw new UsageError(
          `no *.test.lua files found under ${positionals.join(", ") || config.workspaceDir}`,
        );
      }
      console.log(formatTestReport(result));
      return result.failed > 0 ? 1 : 0;
    }),
};
export default test;
