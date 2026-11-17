// Reading what `craftos-mcp test` prints (apps/cli/src/commands/test.ts formatTestReport), and finding where in the
// Lua a failure happened. The command has no JSON output, so this reads its report:
//
//   FAIL sub/a.test.lua (3 tests, 587 ms)
//     ok   adds
//     FAIL breaks
//            /sub/a.test.lua:3: expected 3 but got 2
//     the file did not finish before the timeout
//     terminal:
//       | CraftOS 1.8
//
//   1 file, 3 tests: 1 passed, 2 failed
//
// No vscode import: the unit tests load this file in plain Node.

export interface ReportTest {
  name: string;
  passed: boolean;
  error?: string;
}

export interface ReportFile {
  /** Workspace-relative, with forward slashes, as the runner prints it. */
  file: string;
  passed: boolean;
  durationMs: number;
  tests: ReportTest[];
  /** The file as a whole went wrong: it never finished, or it reported nothing (a syntax error, a crash). */
  problem?: "timed_out" | "crashed";
  /** The computer's terminal, printed when the file did not pass. */
  terminal: string[];
}

export interface Report {
  files: ReportFile[];
  summary?: { files: number; tests: number; passed: number; failed: number };
}

const FILE_LINE = /^(PASS|FAIL) (.+) \((\d+) tests?, (\d+) ms\)$/;
const TEST_LINE = /^ {2}(ok {2}|FAIL) (.*)$/;
const ERROR_LINE = /^ {9}(.*)$/;
const TERMINAL_LINE = /^ {4}\| ?(.*)$/;
const SUMMARY_LINE = /^(\d+) files?, (\d+) tests?: (\d+) passed, (\d+) failed$/;

export function parseTestReport(text: string): Report {
  const report: Report = { files: [] };
  let file: ReportFile | undefined;
  let test: ReportTest | undefined;
  let inTerminal = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    let m = FILE_LINE.exec(line);
    if (m) {
      file = {
        file: m[2]!,
        passed: m[1] === "PASS",
        durationMs: Number(m[4]),
        tests: [],
        terminal: [],
      };
      report.files.push(file);
      test = undefined;
      inTerminal = false;
      continue;
    }
    m = SUMMARY_LINE.exec(line);
    if (m) {
      report.summary = {
        files: Number(m[1]),
        tests: Number(m[2]),
        passed: Number(m[3]),
        failed: Number(m[4]),
      };
      file = undefined;
      continue;
    }
    if (!file) continue;
    if (inTerminal) {
      m = TERMINAL_LINE.exec(raw);
      if (m) {
        file.terminal.push(m[1]!.replace(/\s+$/, ""));
        continue;
      }
      inTerminal = false;
    }
    if (line === "  terminal:") {
      inTerminal = true;
      test = undefined;
      continue;
    }
    if (line === "  the file did not finish before the timeout") {
      file.problem = "timed_out";
      test = undefined;
      continue;
    }
    if (line.startsWith("  the file produced no results")) {
      file.problem = "crashed";
      test = undefined;
      continue;
    }
    m = ERROR_LINE.exec(raw);
    if (m && test && !test.passed) {
      test.error = test.error === undefined ? m[1]! : `${test.error}\n${m[1]}`;
      continue;
    }
    m = TEST_LINE.exec(raw);
    if (m) {
      test = { name: m[2]!, passed: m[1] !== "FAIL" };
      file.tests.push(test);
      continue;
    }
  }
  return report;
}

export interface LuaLocation {
  /** As Lua printed it, without the leading slash: workspace-relative. */
  file: string;
  /** 1-based. */
  line: number;
}

/** Every `path.lua:12:` in an error, in order: the first is where it was raised. */
export function errorLocations(error: string): LuaLocation[] {
  const found: LuaLocation[] = [];
  const re = /(?:^|[\s(\[])\/?([^\s:()\[\]"']+?\.lua):(\d+):/g;
  for (let m = re.exec(error); m; m = re.exec(error))
    found.push({ file: m[1]!, line: Number(m[2]) });
  return found;
}

/**
 * The syntax error CraftOS prints when shell.run cannot load a file: the message, then `Line 12`, then the source line.
 * Only the file that crashed without a result has one worth reading.
 */
export function syntaxError(
  terminal: readonly string[],
): { message: string; line: number } | undefined {
  for (let i = 1; i < terminal.length; i++) {
    const m = /^Line (\d+)$/.exec(terminal[i]!.trim());
    if (m) return { message: terminal[i - 1]!.trim(), line: Number(m[1]) };
  }
  // the other form: "file.lua:12: unexpected symbol near '='"
  for (const text of terminal) {
    const [loc] = errorLocations(text);
    if (loc) return { message: text.trim(), line: loc.line };
  }
  return undefined;
}

export interface DeclaredTest {
  name: string;
  /** 0-based line of the ccunit.test call. */
  line: number;
}

/** The `ccunit.test("name", ...)` calls a file makes with a literal name, so they show before the first run. */
export function declaredTests(source: string): DeclaredTest[] {
  const found: DeclaredTest[] = [];
  const re = /ccunit\.test\(\s*(["'])((?:\\.|(?!\1)[^\\\n])*)\1/g;
  const lines = source.split("\n");
  lines.forEach((text, line) => {
    if (/^\s*--/.test(text)) return;
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text))
      found.push({ name: unescapeLua(m[2]!), line });
  });
  return found;
}

function unescapeLua(s: string): string {
  return s.replace(/\\(.)/g, (_, c: string) =>
    c === "n" ? "\n" : c === "t" ? "\t" : c,
  );
}

/** The `--monitor name:WxH@scale` options for a world file's `monitors` list (the window command's format). */
export function monitorOptions(world: unknown): string[] {
  const list = (world as { monitors?: unknown })?.monitors;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const m of list as Record<string, unknown>[]) {
    if (!m || typeof m["name"] !== "string") continue;
    const w = Number(m["blocksWide"] ?? 1) || 1;
    const h = Number(m["blocksHigh"] ?? 1) || 1;
    const scale =
      m["textScale"] !== undefined ? `@${Number(m["textScale"])}` : "";
    out.push("--monitor", `${m["name"]}:${w}x${h}${scale}`);
  }
  return out;
}
