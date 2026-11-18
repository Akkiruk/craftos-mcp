// `craftos-mcp test --watch`: run the tests, then again for every change to a .lua file, only the test files the
// change touches. Changes are gathered for a moment (debounced) so a save that writes several files runs once.
import { type FSWatcher, readFileSync, watch } from "node:fs";
import { basename, join } from "node:path";
import type { TestRunResult } from "@craftos-mcp/runner";

/** Folders whose changes never matter: what is never copied onto a computer. */
const IGNORED = /(^|\/)(\.git|node_modules|\.runtime|\.vscode-test)(\/|$)/;

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The test files a change touches: a changed test file itself, and the test files that name a changed module
 * (require("util"), require("lib.util"), dofile("lib/util.lua"), ccunit.run("util.lua")). A changed .lua file no test
 * names reruns them all: it may be loaded some other way. Paths are workspace paths with /.
 */
export function affectedTests(
  changed: readonly string[],
  tests: readonly string[],
  read: (path: string) => string,
): string[] {
  const picked = new Set<string>();
  let all = false;
  const texts = new Map<string, string>();
  const textOf = (t: string): string => {
    if (!texts.has(t)) {
      let text = "";
      try {
        text = read(t);
      } catch {
        // gone meanwhile
      }
      texts.set(t, text);
    }
    return texts.get(t)!;
  };
  for (const path of changed) {
    if (!path.endsWith(".lua")) continue;
    if (tests.includes(path)) {
      picked.add(path);
      continue;
    }
    const stem = basename(path, ".lua");
    const dotted = path.slice(0, -4).replace(/\//g, ".");
    const names = new RegExp(
      `["'/.](${escape(stem)}|${escape(dotted)})(\\.lua)?["']|["']${escape(path)}["']`,
    );
    const users = tests.filter((t) => names.test(textOf(t)));
    if (users.length) for (const t of users) picked.add(t);
    else all = true;
  }
  return all ? [...tests] : tests.filter((t) => picked.has(t));
}

/** The line under each run: when, how it went, and what ran. */
export function summaryLine(
  result: TestRunResult,
  ran: number,
  total: number,
  changed: readonly string[],
  now = new Date(),
): string {
  const time = now.toTimeString().slice(0, 8);
  const tests = result.passed + result.failed + (result.skipped ?? 0);
  const why = changed.length
    ? `${ran} of ${total} file${total === 1 ? "" : "s"} for ${changed.slice(0, 3).join(", ")}${changed.length > 3 ? ` and ${changed.length - 3} more` : ""}`
    : `${ran} file${ran === 1 ? "" : "s"}`;
  return (
    `[${time}] ${result.failed ? "FAIL" : "PASS"} ${tests} test${tests === 1 ? "" : "s"}: ${result.passed} passed, ` +
    `${result.failed} failed${result.skipped ? `, ${result.skipped} skipped` : ""} (${why}). Watching for changes; Ctrl+C stops.`
  );
}

export interface WatchOptions {
  readonly workspaceDir: string;
  /** The test files in scope right now (the paths or craftos.json's globs): asked again before each run. */
  readonly listTests: () => string[];
  /** Run these test files and print the report. */
  readonly run: (files: string[], changed: string[]) => Promise<void>;
  /** Stops watching. */
  readonly signal: AbortSignal;
  readonly debounceMs?: number;
}

/** Run once, then on every change. Resolves when the signal stops it. */
export async function watchTests(options: WatchOptions): Promise<void> {
  const { workspaceDir, listTests, run, signal } = options;
  const debounce = options.debounceMs ?? 200;
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  const flush = async (): Promise<void> => {
    if (running || signal.aborted) return;
    const changed = [...pending].sort();
    pending.clear();
    const tests = listTests();
    const files = changed.length
      ? affectedTests(changed, tests, (p) =>
          readFileSync(join(workspaceDir, p), "utf8"),
        )
      : tests;
    if (!files.length) return;
    running = run(files, changed).catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
    });
    await running;
    running = undefined;
    // changes while it ran: their turn now
    if (pending.size && !signal.aborted) void flush();
  };
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(workspaceDir, { recursive: true }, (_event, name) => {
      if (!name) return;
      const path = name.toString().replace(/\\/g, "/");
      if (!path.endsWith(".lua") || IGNORED.test(path)) return;
      pending.add(path);
      clearTimeout(timer);
      timer = setTimeout(() => void flush(), debounce);
    });
  } catch (error) {
    throw new Error(
      `cannot watch ${workspaceDir}: ${(error as Error).message}`,
    );
  }
  await flush();
  await new Promise<void>((done) => {
    if (signal.aborted) done();
    signal.addEventListener("abort", () => done(), { once: true });
  });
  clearTimeout(timer);
  watcher.close();
  await running;
}
