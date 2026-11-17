import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
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
import {
  type TestFileResult,
  type TestRunResult,
  WorkspaceError,
  checkTestPaths,
  versionChoices,
  runTests,
} from "@craftos-mcp/runner";

const USAGE = [
  "usage: craftos-mcp test [paths...] [--world x.json] [--mc 1.20.1] [--addons a,b] [--timescale n]",
  "                        [--monitor name:WxH] [--timeout seconds] [--dir folder]",
  "                        [--json] [--reporter human|json|junit|github] [--out file]",
  "",
  `--mc picks the Minecraft version: ${versionChoices()}.`,
  "Runs every *.test.lua under the paths (default: the current folder) with the ccunit harness, each file in",
  "its own fresh computer. Exits 0 when everything passes, 1 when a test fails, 2 on a usage error.",
  "",
  "Reports: human (default), json (the whole result; --json is short for it), junit (XML for CI test views) and",
  "github (::error annotations on the failing lines, after the human report; on by itself under GitHub Actions).",
  "--out writes the json or junit report to a file and keeps the human one on the screen.",
].join("\n");

const REPORTERS = ["human", "json", "junit", "github"] as const;
type Reporter = (typeof REPORTERS)[number];

/** The human-readable report: one block per file, the failing tests with their errors, then a summary line. */
export function formatTestReport(result: TestRunResult): string {
  const out: string[] = [];
  for (const file of result.files) {
    const label = file.status === "passed" ? "PASS" : "FAIL";
    out.push(
      `${label} ${file.file} (${file.tests.length} tests, ${file.durationMs} ms)`,
    );
    for (const t of file.tests) {
      out.push(
        `  ${t.skipped ? "skip" : t.passed ? "ok  " : "FAIL"} ${t.name}`,
      );
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
      `${result.passed} passed, ${result.failed} failed` +
      (result.skipped ? `, ${result.skipped} skipped` : ""),
  );
  return out.join("\n");
}

const xml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // XML 1.0 has no place for most control characters
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

/** JUnit XML, one testsuite per file: what CI test views (GitHub, GitLab, Jenkins) read. */
export function formatJunit(result: TestRunResult): string {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>'];
  const total = result.passed + result.failed + (result.skipped ?? 0);
  out.push(
    `<testsuites name="craftos-mcp" tests="${total}" failures="${result.failed}" skipped="${result.skipped ?? 0}">`,
  );
  for (const file of result.files) {
    const broken = file.status === "timed_out" || file.status === "crashed";
    const failures = file.tests.filter((t) => !t.passed).length;
    const cases = file.tests.length + (broken && failures === 0 ? 1 : 0);
    out.push(
      `  <testsuite name="${xml(file.file)}" tests="${cases}" failures="${failures + (broken && failures === 0 ? 1 : 0)}" ` +
        `skipped="${file.tests.filter((t) => t.skipped).length}" time="${(file.durationMs / 1000).toFixed(3)}">`,
    );
    for (const t of file.tests) {
      const head = `    <testcase classname="${xml(file.file)}" name="${xml(t.name)}"`;
      if (t.skipped) out.push(`${head}><skipped/></testcase>`);
      else if (t.passed) out.push(`${head}/>`);
      else {
        const message = (t.error ?? "failed").split("\n")[0]!;
        out.push(
          `${head}><failure message="${xml(message)}">${xml(t.error ?? "")}</failure></testcase>`,
        );
      }
    }
    if (broken && failures === 0)
      out.push(
        `    <testcase classname="${xml(file.file)}" name="(file)"><failure message="${file.status === "timed_out" ? "the file did not finish before the timeout" : "the file produced no results"}">${xml((file.terminal ?? []).join("\n"))}</failure></testcase>`,
      );
    out.push("  </testsuite>");
  }
  out.push("</testsuites>");
  return out.join("\n");
}

/** GitHub Actions workflow commands: an annotation on each failing test's line (file paths from the repo root). */
export function formatGithub(
  result: TestRunResult,
  pathOf: (workspacePath: string) => string = (p) => p,
): string {
  const esc = (s: string): string =>
    s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  const prop = (s: string): string =>
    esc(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
  const out: string[] = [];
  for (const file of result.files) {
    for (const t of file.tests) {
      if (t.passed) continue;
      const where = t.file ?? file.file;
      const line = t.line ? `,line=${t.line}` : "";
      out.push(
        `::error file=${prop(pathOf(where))}${line},title=${prop(t.name)}::${esc(t.error ?? "failed")}`,
      );
    }
    if (
      (file.status === "timed_out" || file.status === "crashed") &&
      !file.tests.some((t) => !t.passed)
    )
      out.push(
        `::error file=${prop(pathOf(file.file))},title=${prop(file.file)}::${esc(file.status === "timed_out" ? "the file did not finish before the timeout" : "the file produced no results (the engine or the file crashed)")}`,
      );
  }
  return out.join("\n");
}

function progressLine(file: TestFileResult): string {
  const failed = file.tests.filter((t) => !t.passed).length;
  return `${file.status === "passed" ? "PASS" : "FAIL"} ${file.file} (${file.tests.length} tests${failed ? `, ${failed} failed` : ""})`;
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
        json: { type: "boolean" },
        reporter: { type: "string" },
        out: { type: "string" },
      });
      if (values.help) {
        console.log(USAGE);
        return 0;
      }
      const v = values as typeof values & {
        json?: boolean;
        reporter?: string;
        out?: string;
      };
      const reporter: Reporter = v.json
        ? "json"
        : ((v.reporter ?? "human") as Reporter);
      if (!REPORTERS.includes(reporter))
        throw new UsageError(
          `--reporter must be one of ${REPORTERS.join(", ")}, got ${JSON.stringify(v.reporter)}`,
        );
      if (v.out && reporter !== "json" && reporter !== "junit")
        throw new UsageError("--out goes with --reporter json or junit");
      const config = configFor(values.dir);
      const timeout = number("timeout", values.timeout);
      const paths = positionals.map((p) => workspacePath(config, p));
      const missing = checkTestPaths(config, paths);
      if (missing.length) throw new WorkspaceError(missing.join("\n"));
      // a machine-readable report keeps stdout to itself; progress goes to stderr when a person watches
      const progress = process.stderr.isTTY && !(reporter === "json" && !v.out);
      const result = await runTests(config, {
        paths,
        monitors: (values.monitor ?? []).map(parseMonitor),
        world: loadWorld(config, values.world, values.addons, values.mc),
        timeScale: number("timescale", values.timescale),
        ...(timeout ? { timeoutMs: timeout * 1000 } : {}),
        ...(progress && {
          onFile: (file: TestFileResult) =>
            process.stderr.write(`${progressLine(file)}\n`),
        }),
      });
      if (result.files.length === 0) {
        throw new WorkspaceError(
          `no *.test.lua files found under ${positionals.join(", ") || config.workspaceDir}`,
        );
      }
      // annotations name files from where the job runs (the repository root)
      const toRepo = (p: string): string =>
        relative(process.cwd(), resolve(config.workspaceDir, p))
          .split("\\")
          .join("/") || p;
      const report =
        reporter === "json"
          ? JSON.stringify(result, null, 2)
          : reporter === "junit"
            ? formatJunit(result)
            : formatTestReport(result);
      if (v.out) {
        mkdirSync(dirname(resolve(v.out)), { recursive: true });
        writeFileSync(resolve(v.out), `${report}\n`);
        console.log(formatTestReport(result));
        console.log(`wrote the ${reporter} report to ${v.out}`);
      } else console.log(report);
      // annotations: asked for, or under GitHub Actions with the human report
      if (
        reporter === "github" ||
        (process.env["GITHUB_ACTIONS"] === "true" && reporter === "human")
      ) {
        const annotations = formatGithub(result, toRepo);
        if (annotations) console.log(annotations);
      }
      return result.failed > 0 ? 1 : 0;
    }),
};
export default test;
