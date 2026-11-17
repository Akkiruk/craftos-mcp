/**
 * What the smaller addons' integration tests share: a scratch workspace, Lua test files run with a world, a live
 * session driven by sim commands. Each test file makes its own kit, so files can run in parallel.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, vi } from "vitest";
import {
  type SimCommand,
  type SimState,
  type TestRunResult,
  type WorldConfig,
  checkConfig,
  loadConfig,
  runTests,
  sendCommandResult,
  SessionManager,
} from "./index.js";

export type Dict = Record<string, unknown>;

/** err(fn, ...): the message of the error fn raises, without its position. */
export const PRELUDE = `
local function err(fn, ...)
  local ok, e = pcall(fn, ...)
  if ok then error("expected an error but the call succeeded", 2) end
  return (tostring(e):gsub("^pcall: ", ""):gsub("^[^:]*:%d+: ", ""))
end
`;

export function addonTestKit(prefix: string) {
  // engines boot and run real-time Lua: far past vitest's 5 s default
  vi.setConfig({ testTimeout: 120000 });
  const base = loadConfig();
  const scratch = mkdtempSync(join(tmpdir(), `${prefix}-ws-`));
  const config = { ...base, workspaceDir: scratch };
  const ready = checkConfig(config).length === 0;
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  function put(name: string, content: string): void {
    const file = join(scratch, name);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, content);
  }

  /** Run Lua (ccunit tests, PRELUDE first) as its own test file with `world`. */
  async function lua(
    source: string,
    world: WorldConfig,
    name: string,
    timeoutMs = 60000,
  ): Promise<TestRunResult> {
    put(name, PRELUDE + source);
    return runTests(config, { paths: [name], world, timeoutMs }, 1);
  }

  function expectAllPassed(result: TestRunResult): void {
    const failures = result.files.flatMap((f) =>
      f.tests.filter((t) => !t.passed).map((t) => `${t.name}: ${t.error}`),
    );
    expect(failures).toEqual([]);
    expect(result.files.map((f) => f.status)).toEqual(["passed"]);
  }

  /** A live computer at the shell; step() sends one sim command (it must succeed) and returns the sim state. */
  async function withSession(
    w: WorldConfig,
    run: (
      step: (c: Dict) => Promise<SimState>,
      session: {
        send: (
          c: Dict,
          timeoutMs?: number,
        ) => Promise<{ applied: boolean; error?: string }>;
        state: () => SimState;
        typeLine: (text: string) => void;
        tap: (key: string) => void;
        screen: () => string;
        resultsDir: string;
        waitForText: (text: string, timeoutMs?: number) => Promise<void>;
      },
    ) => Promise<void>,
  ): Promise<void> {
    const manager = new SessionManager(config);
    const s = manager.create([], 1, w);
    try {
      await s.handle.session.waitForText(">", 0, 20000);
      const send = (c: Dict, timeoutMs?: number) =>
        sendCommandResult(s.handle, c as unknown as SimCommand, timeoutMs);
      await run(
        async (c) => {
          // an addon's commands are not in SimCommand's union: the sim takes any { cmd } its handlers know
          expect(await send(c)).toEqual({ applied: true });
          return s.handle.readState()!;
        },
        {
          send,
          state: () => s.handle.readState()!,
          typeLine: (text) => s.handle.session.typeLine(text),
          tap: (key) =>
            s.handle.session.tap(
              key as Parameters<typeof s.handle.session.tap>[0],
            ),
          resultsDir: s.handle.resultsDir,
          screen: () => (s.handle.session.screen(0)?.lines ?? []).join("\n"),
          waitForText: async (text, timeoutMs = 20000) => {
            await s.handle.session.waitForText(text, 0, timeoutMs);
          },
        },
      );
    } finally {
      await manager.destroyAll();
    }
  }

  return { config, ready, scratch, put, lua, expectAllPassed, withSession };
}

export const peripheralState = (st: SimState, name: string): Dict =>
  (st.peripherals as Record<string, Dict>)[name]!;
