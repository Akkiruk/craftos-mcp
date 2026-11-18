// Row 150 of docs/conformance/emulator-vs-real-deviations.md: a program's own debug.sethook under the VS Code
// debugger. The debugger's hook is the engine's own (debug_server.cpp); a program that hooks itself (the cide addon's
// agent) used to get "Cannot set hooks while debugger is attached". On a server debug.sethook always works, so now the
// program's hook runs on top of the debugger's: both are called, debug.gethook reports the program's own, and
// breakpoints still stop. A small adapter here stands in for the extension's (the protocol is in debug_server.hpp).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  type AddressInfo,
  type Server,
  type Socket,
  createServer,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  checkConfig,
  loadConfig,
  readResultFile,
  startEngine,
  testBoot,
} from "./index.js";

const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "debug-hook-ws-"));
const config = { ...base, workspaceDir: scratch };
const ready = checkConfig(config).length === 0;

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const TOKEN = "debug-hook-test";
const FILE = "hook.test.lua";

// The breakpoint is on the line marked BREAK, inside the stretch the program's own line hook watches.
const LUA = `
ccunit.test("debug.sethook works with the debugger attached, and gethook reports the program's", function()
  ccunit.eq({ debug.gethook() }, { nil, "", 0 })
  local lines = {}
  local function hook(event, line) if event == "line" then lines[#lines + 1] = line end end
  debug.sethook(hook, "l")
  local x = 1
  x = x + 1 -- BREAK
  x = x + 1
  local fn, mask, count = debug.gethook()
  debug.sethook()
  ccunit.eq({ fn == hook, mask, count }, { true, "l", 0 })
  -- every new line, the breakpoint's included (a hook that returned used to take the next line's event with it)
  ccunit.eq(lines, { 7, 8, 9, 10, 11 })
  ccunit.eq({ debug.gethook() }, { nil, "", 0 })
end)
ccunit.test("a count hook of the program's own", function()
  local calls = 0
  debug.sethook(function() calls = calls + 1 end, "", 1000)
  local y = 0
  for i = 1, 100000 do y = y + i end
  local _, mask, count = debug.gethook()
  debug.sethook()
  ccunit.truthy(calls > 20, "called " .. calls .. " times")
  ccunit.eq({ mask, count }, { "", 1000 })
end)
`;

describe.skipIf(!ready)(
  "row 150: debug.sethook under the VS Code debugger",
  () => {
    it("runs the program's hook and the debugger's, and still stops at a breakpoint", async () => {
      writeFileSync(join(scratch, FILE), LUA);
      const breakLine =
        LUA.split("\n").findIndex((l) => l.includes("-- BREAK")) + 1;
      const events: string[] = [];
      let socket: Socket | undefined;
      const server: Server = createServer((s) => {
        socket = s;
        let buf = "";
        let seq = 0;
        const send = (msg: Record<string, unknown>): void => {
          s.write(`${JSON.stringify({ seq: ++seq, ...msg })}\n`);
        };
        s.on("data", (chunk) => {
          buf += chunk.toString("utf8");
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            const msg = JSON.parse(line) as Record<string, unknown>;
            if (typeof msg["event"] !== "string") continue;
            events.push(
              msg["event"] === "stopped"
                ? `stopped ${String(msg["reason"])}`
                : String(msg["event"]),
            );
            if (msg["event"] === "hello") {
              send({
                cmd: "setBreakpoints",
                path: `/${FILE}`,
                breakpoints: [{ id: 1, line: breakLine }],
              });
              send({ cmd: "run" });
            } else if (msg["event"] === "stopped") send({ cmd: "continue" });
          }
        });
        s.on("error", () => undefined);
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const port = (server.address() as AddressInfo).port;
      const handle = startEngine(config, testBoot(FILE, []), {
        label: "test",
        debug: { port, token: TOKEN },
      });
      try {
        await handle.session.waitForExit(60000);
        const parsed = readResultFile<{
          tests: { name: string; passed: boolean; error?: string }[];
        }>(handle.resultsDir, "results.json");
        const failed = (parsed?.tests ?? [])
          .filter((t) => !t.passed)
          .map((t) => `${t.name}: ${t.error}`);
        expect(parsed?.tests.length).toBe(2);
        expect(failed).toEqual([]);
        // the debugger's hook went on running under the program's: its breakpoint stopped the program once
        expect(events).toContain("stopped breakpoint");
      } finally {
        socket?.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        handle.dispose();
      }
    }, 90000);
  },
);
