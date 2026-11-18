// End to end: the debug adapter (src/debug/session.ts) speaking DAP on one side and to a real engine on the other,
// on CC:Tweaked 1.101.3 (Minecraft 1.18.2) and 1.121.0 (1.21.1). The computer is started the way the extension
// starts it: `craftos-mcp app` and a POST to its /api/sessions, with the debugger's port and token.
//
//   node --experimental-strip-types test/debug-e2e.mjs
//
// Needs the repo built (npm run build at the root), the engine in engine/build and the ROMs in rom/. CRAFTOS_CLI
// names another craftos-mcp entry point (apps/cli/dist/index.js by default).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EngineLink } from "../src/debug/engineLink.ts";
import { toComputerPath } from "../src/debug/paths.ts";
import { DebugSession } from "../src/debug/session.ts";

const cli =
  process.env.CRAFTOS_CLI ??
  fileURLToPath(new URL("../../cli/dist/index.js", import.meta.url));
if (!existsSync(cli)) {
  console.error(`no ${cli}: run "npm run build" at the repo root first`);
  process.exit(1);
}

const project = mkdtempSync(join(tmpdir(), "craftos-debug-e2e-"));
const put = (name, lines) => {
  mkdirSync(join(project, name, ".."), { recursive: true });
  writeFileSync(join(project, name), `${lines.join("\n")}\n`);
};
put("prog.lua", [
  'local util = require("lib.util")', // 1
  "local total = 0", // 2
  'local names = { first = "a", list = { 10, 20 } }', // 3
  "for i = 1, 3 do", // 4
  "  total = util.add(total, i)", // 5
  "end", // 6
  'print("total", total)', // 7
  'local ok, err = pcall(error, "handled")', // 8
  'local before = os.epoch("utc")', // 9
  'print("waiting")', // 10
  'os.pullEvent("char")', // 11
  'print("woke", os.epoch("utc") - before)', // 12
  'error("boom " .. total)', // 13
]);
put("lib/util.lua", [
  "local M = {}", // 1
  "function M.add(a, b)", // 2
  "  local sum = a + b", // 3
  "  return sum", // 4
  "end", // 5
  "return M", // 6
]);
put("spin.lua", ['print("spinning")', "while true do end"]);
put("math.test.lua", [
  'ccunit.test("adds", function()', // 1
  "  local sum = 1 + 1", // 2
  "  ccunit.eq(sum, 2)", // 3
  "end)", // 4
  'ccunit.test("breaks", function()', // 5
  "  local wrong = 1 + 1", // 6
  "  ccunit.eq(wrong, 3)", // 7
  "end)", // 8
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killTree(child) {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32")
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
    });
  else child.kill("SIGKILL");
}

/** `craftos-mcp app` on the project, as runPanel.ts starts it. */
function startApp() {
  const child = spawn(
    process.execPath,
    [cli, "app", "--port", "0", "--no-open", "--dir", project],
    {
      cwd: project,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let out = "";
  let err = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`the app did not start: ${err}`)),
      120_000,
    );
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const m = /craftos-mcp app: (http:\/\/127\.0\.0\.1:\d+)\//.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve({ child, url: m[1] });
      }
    });
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("exit", (code) =>
      reject(new Error(`the app stopped (code ${code}): ${err}`)),
    );
  });
}

/** One debug session over DAP, with the helpers the steps below read well with. */
async function debug(app, version, launchArgs) {
  const messages = [];
  let waiters = [];
  let sessionId;
  const session = new DebugSession({
    send: (m) => {
      messages.push(m);
      for (const w of waiters) w();
    },
    listen: () => EngineLink.listen(),
    locate: (args) => ({
      root: project,
      program: toComputerPath(args.program, project),
    }),
    launch: async (args, located, link) => {
      const res = await fetch(`${app.url}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "debugged",
          program: located.program.slice(1),
          world: { version },
          debug: link,
          ...(args.test && { test: true }),
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      sessionId = (await res.json()).ids[0];
      return {
        dispose: () =>
          fetch(`${app.url}/api/sessions/${sessionId}`, { method: "DELETE" }),
      };
    },
  });
  let seq = 0;
  let read = 0; // events before this index have been taken
  const until = async (find, what, ms = 30_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const hit = find();
      if (hit !== undefined) return hit;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 250);
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      waiters = [];
    }
  };
  const request = async (command, args = {}) => {
    const mine = ++seq;
    session.handle({ seq: mine, type: "request", command, arguments: args });
    const response = await until(
      () =>
        messages.find((m) => m.type === "response" && m.request_seq === mine),
      `the answer to ${command}`,
    );
    return response;
  };
  const ok = async (command, args) => {
    const response = await request(command, args);
    assert.equal(
      response.success,
      true,
      `${command} failed: ${response.message}`,
    );
    return response.body ?? {};
  };
  /** The next event of a kind that has not been taken yet. */
  const event = (name, ms) =>
    until(
      () => {
        for (let i = read; i < messages.length; i++) {
          const m = messages[i];
          if (m.type === "event" && m.event === name) {
            read = i + 1;
            return m.body ?? {};
          }
        }
        return undefined;
      },
      `a ${name} event`,
      ms,
    );
  /** The terminal's text. */
  const screen = async () => {
    const screens = await (
      await fetch(`${app.url}/api/sessions/${sessionId}/screens`)
    ).json();
    return (Array.isArray(screens) ? screens : (screens.screens ?? []))
      .flatMap((s) => s.lines ?? [])
      .join("\n");
  };
  const untilScreen = async (pattern, ms = 30_000) => {
    const end = Date.now() + ms;
    let text = "";
    while (Date.now() < end) {
      text = await screen();
      if (pattern.test(text)) return text;
      await sleep(250);
    }
    throw new Error(`the screen never showed ${pattern}: ${text}`);
  };
  /** The stack, with each frame's source as a path relative to the project (or its name on the computer). */
  const stack = async () => {
    const { stackFrames } = await ok("stackTrace", { threadId: 1 });
    return stackFrames.map((f) => ({
      ...f,
      file: f.source?.path
        ? toComputerPath(f.source.path, project)
        : f.source?.name,
    }));
  };
  const locals = async (frameId) => {
    const { scopes } = await ok("scopes", { frameId });
    const { variables } = await ok("variables", {
      variablesReference: scopes[0].variablesReference,
    });
    return {
      variables,
      byName: Object.fromEntries(variables.map((v) => [v.name, v])),
    };
  };

  const capabilities = await ok("initialize", { adapterID: "craftos" });
  assert.equal(capabilities.supportsConditionalBreakpoints, true);
  await event("initialized");
  await ok("launch", {
    program: join(project, launchArgs.program),
    ...launchArgs.extra,
  });
  return {
    ok,
    request,
    event,
    stack,
    locals,
    screen,
    untilScreen,
    messages,
    sessionId: () => sessionId,
    input: (events) =>
      fetch(`${app.url}/api/sessions/${sessionId}/input`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events }),
      }),
    outputs: () =>
      messages
        .filter((m) => m.type === "event" && m.event === "output")
        .map((m) => m.body.output)
        .join(""),
    breakpoints: (file, breakpoints) =>
      ok("setBreakpoints", {
        source: { path: join(project, file) },
        breakpoints,
      }),
  };
}

let failed = 0;
async function step(name, body) {
  const started = Date.now();
  try {
    await body();
    console.log(`  ok   ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}: ${error.stack ?? error}`);
    throw error;
  }
}

async function program(app, version, long) {
  const d = await debug(app, version, { program: "prog.lua" });
  let top;
  let seenWaiting = 0;

  await step(
    "a conditional breakpoint stops on the pass that meets it; a logpoint prints and does not stop",
    async () => {
      const set = await d.breakpoints("prog.lua", [
        { line: 5, condition: "i == 2" },
      ]);
      assert.equal(set.breakpoints[0].verified, true);
      await d.breakpoints("lib/util.lua", [
        { line: 4, logMessage: "sum is {sum}" },
      ]);
      await d.ok("setExceptionBreakpoints", { filters: ["uncaught"] });
      await d.ok("configurationDone");
      const stopped = await d.event("stopped");
      assert.equal(stopped.reason, "breakpoint");
      assert.deepEqual(stopped.hitBreakpointIds, [set.breakpoints[0].id]);
      [top] = await d.stack();
      assert.deepEqual(
        [top.file, top.line, top.name],
        ["/prog.lua", 5, "main chunk"],
      );
      assert.match(d.outputs(), /sum is 1\n/);
    },
  );

  await step("locals show with their values, and a table opens", async () => {
    const { byName } = await d.locals(top.id);
    assert.equal(byName.total.value, "1");
    assert.equal(byName.i.value, "2");
    assert.equal(byName.util.type, "table");
    assert.match(byName.names.value, /first = "a"/);
    const inside = await d.ok("variables", {
      variablesReference: byName.names.variablesReference,
    });
    const entries = Object.fromEntries(
      inside.variables.map((v) => [v.name, v]),
    );
    assert.equal(entries.first.value, '"a"');
    assert.equal(entries.first.evaluateName, "names.first");
    const list = await d.ok("variables", {
      variablesReference: entries.list.variablesReference,
    });
    assert.deepEqual(
      list.variables.map((v) => [v.name, v.value]),
      [
        ["[1]", "10"],
        ["[2]", "20"],
      ],
    );
  });

  await step("upvalues and globals are there too", async () => {
    const { scopes } = await d.ok("scopes", { frameId: top.id });
    const globals = await d.ok("variables", {
      variablesReference: scopes[2].variablesReference,
    });
    const names = globals.variables.map((v) => v.name);
    assert.ok(names.includes("require"), `no require among ${names}`);
    assert.ok(names.includes("shell"), `no shell among ${names}`);
  });

  await step(
    "watch, hover and the debug console evaluate in the frame; a variable can be set",
    async () => {
      assert.equal(
        (
          await d.ok("evaluate", {
            expression: "total + 100",
            frameId: top.id,
            context: "watch",
          })
        ).result,
        "101",
      );
      assert.equal(
        (
          await d.ok("evaluate", {
            expression: "names.list[2]",
            frameId: top.id,
            context: "hover",
          })
        ).result,
        "20",
      );
      assert.equal(
        (
          await d.ok("evaluate", {
            expression: "#names.list, os.getComputerID()",
            frameId: top.id,
            context: "repl",
          })
        ).result,
        "2, 0",
      );
      const bad = await d.request("evaluate", {
        expression: "sleep(1)",
        frameId: top.id,
        context: "repl",
      });
      assert.equal(bad.success, false);
      assert.match(bad.message, /yield/);
      const { scopes } = await d.ok("scopes", { frameId: top.id });
      const set = await d.ok("setVariable", {
        variablesReference: scopes[0].variablesReference,
        name: "total",
        value: "2 + 3",
      });
      assert.equal(set.value, "5");
      assert.equal((await d.locals(top.id)).byName.total.value, "5");
    },
  );

  if (long)
    await step(
      "eight seconds at a breakpoint do not count towards 'too long without yielding'",
      async () => {
        await sleep(8500);
        assert.equal(
          (
            await d.ok("evaluate", {
              expression: "total",
              frameId: top.id,
              context: "watch",
            })
          ).result,
          "5",
        );
      },
    );

  await step(
    "step into the library, step over a line, step out again",
    async () => {
      await d.ok("stepIn", { threadId: 1 });
      assert.equal((await d.event("stopped")).reason, "step");
      let frames = await d.stack();
      assert.deepEqual(
        [frames[0].file, frames[0].line, frames[0].name],
        ["/lib/util.lua", 3, "add"],
      );
      assert.deepEqual([frames[1].file, frames[1].line], ["/prog.lua", 5]);
      let { byName } = await d.locals(frames[0].id);
      assert.deepEqual([byName.a.value, byName.b.value], ["5", "2"]);
      assert.equal(byName.sum, undefined, "sum is not set yet on its own line");

      await d.ok("next", { threadId: 1 });
      await d.event("stopped");
      frames = await d.stack();
      assert.deepEqual([frames[0].file, frames[0].line], ["/lib/util.lua", 4]);
      ({ byName } = await d.locals(frames[0].id));
      assert.equal(byName.sum.value, "7");

      await d.ok("stepOut", { threadId: 1 });
      await d.event("stopped");
      frames = await d.stack();
      assert.equal(frames[0].file, "/prog.lua");
      assert.equal(frames[0].name, "main chunk");
      assert.equal((await d.locals(frames[0].id)).byName.total.value, "7");
    },
  );

  await step(
    "the stack goes on through the ROM's code, which is marked as not the program's",
    async () => {
      const frames = await d.stack();
      const shell = frames.find((f) => f.file === "/rom/programs/shell.lua");
      assert.ok(shell, `no shell frame in ${frames.map((f) => f.file)}`);
      assert.equal(shell.presentationHint, "subtle");
      assert.equal(shell.source.presentationHint, "deemphasize");
      const text = await d.ok("source", {
        source: shell.source,
        sourceReference: shell.source.sourceReference,
      });
      assert.match(text.content, /shell\.run|function shell\./);
    },
  );

  await step(
    "continue runs to the event wait: an error a pcall catches does not stop",
    async () => {
      await d.breakpoints("prog.lua", []);
      await d.ok("continue", { threadId: 1 });
      await d.untilScreen(/waiting/);
      seenWaiting = Date.now();
      // total: 7 after the second pass, then + 3
      assert.match(await d.screen(), /total\s+10/);
    },
  );

  await step(
    "pause stops a program that is waiting for an event, on the line that waits",
    async () => {
      await sleep(300);
      await d.ok("pause", { threadId: 1 });
      const stopped = await d.event("stopped");
      assert.equal(stopped.reason, "pause");
      const frames = await d.stack();
      const mine = frames.find((f) => f.file === "/prog.lua");
      assert.ok(
        mine,
        `the program is not on the stack: ${frames.map((f) => `${f.name} ${f.file}`)}`,
      );
      assert.equal(mine.line, 11);
      assert.equal(frames[0].name, "[C] yield");
      assert.equal((await d.locals(mine.id)).byName.total.value, "10");
      top = mine;
    },
  );

  await step("the computer's clock stands still while stopped", async () => {
    const epoch = () =>
      d.ok("evaluate", {
        expression: 'os.epoch("utc")',
        frameId: top.id,
        context: "watch",
      });
    const first = (await epoch()).result;
    await sleep(1500);
    assert.equal((await epoch()).result, first);
  });

  await step(
    "an uncaught error stops where it is raised, with its message",
    async () => {
      await d.ok("continue", { threadId: 1 });
      const woken = Date.now();
      await d.input([{ type: "char", text: "g" }]);
      const stopped = await d.event("stopped");
      assert.equal(stopped.reason, "exception");
      assert.equal(stopped.text, "/prog.lua:13: boom 10");
      const frames = await d.stack();
      assert.deepEqual([frames[0].file, frames[0].line], ["/prog.lua", 13]);
      const info = await d.ok("exceptionInfo", { threadId: 1 });
      assert.equal(info.description, "/prog.lua:13: boom 10");
      // the 1.5 s and more spent stopped are not in the wait the program measured with os.epoch
      const woke = /woke\s+(\d+)/.exec(await d.untilScreen(/woke\s+\d+/, 5000));
      assert.ok(woke, "the program did not print how long it waited");
      assert.ok(
        Number(woke[1]) < woken - seenWaiting - 700,
        `the program measured ${woke[1]} ms of a wait that took ${woken - seenWaiting} ms with 1.5 s of it stopped`,
      );
    },
  );

  const computerThere = async () => {
    const { sessions } = await (await fetch(`${app.url}/api/sessions`)).json();
    return sessions.some((s) => s.id === d.sessionId());
  };
  if (long)
    await step("Stop ends the computer", async () => {
      await d.ok("disconnect", { terminateDebuggee: true });
      await d.event("terminated");
      assert.equal(await computerThere(), false, "the computer is still there");
    });
  else
    await step(
      "the program ending ends the session; the computer stays, with the shell's prompt back",
      async () => {
        await d.ok("continue", { threadId: 1 });
        await d.event("terminated");
        assert.equal(
          await computerThere(),
          true,
          "the computer went with the session",
        );
        // the shell printed the error and is ready for the next command
        await d.untilScreen(/boom 10[\s\S]*^>\s*$/m, 10_000);
        await fetch(`${app.url}/api/sessions/${d.sessionId()}`, {
          method: "DELETE",
        });
      },
    );
}

async function testFile(app, version) {
  const d = await debug(app, version, {
    program: "math.test.lua",
    extra: { test: true },
  });
  await step(
    "a breakpoint in a test stops it; the failing assertion stops as an uncaught error",
    async () => {
      await d.breakpoints("math.test.lua", [{ line: 3 }]);
      await d.ok("setExceptionBreakpoints", { filters: ["uncaught"] });
      await d.ok("configurationDone");
      assert.equal((await d.event("stopped")).reason, "breakpoint");
      let frames = await d.stack();
      assert.deepEqual([frames[0].file, frames[0].line], ["/math.test.lua", 3]);
      assert.equal((await d.locals(frames[0].id)).byName.sum.value, "2");

      await d.ok("continue", { threadId: 1 });
      const stopped = await d.event("stopped");
      assert.equal(stopped.reason, "exception");
      assert.match(stopped.text, /expected 3 but got 2/);
      frames = await d.stack();
      // ccunit.eq raised it: the test's own line is the first frame that is the program's
      const mine = frames.find((f) => f.presentationHint !== "subtle");
      assert.deepEqual([mine.file, mine.line], ["/math.test.lua", 7]);
      assert.equal((await d.locals(mine.id)).byName.wrong.value, "2");
    },
  );
  await step(
    "the session ends when the test file has run; its results stay on the screen",
    async () => {
      await d.ok("continue", { threadId: 1 });
      await d.event("terminated");
      // the computer shuts down after printing them; its last screen stays up (the panel, in the editor)
      const text = await d.untilScreen(/1 passed, 1 failed/, 10_000);
      assert.match(text, /pass {2}adds/);
      assert.match(text, /FAIL {2}breaks/);
      assert.match(text, /expected 3 but got 2/);
    },
  );
}

async function watchdog(app, version) {
  const d = await debug(app, version, { program: "spin.lua" });
  await step(
    "with the debugger attached a busy loop still gets 'too long without yielding'",
    async () => {
      await d.ok("setExceptionBreakpoints", { filters: [] });
      await d.ok("configurationDone");
      await d.untilScreen(/spinning/);
      await d.untilScreen(/Too long without yielding/i, 30_000);
      await d.ok("disconnect", { terminateDebuggee: true });
    },
  );
}

let app;
try {
  app = await startApp();
  for (const version of ["1.21.1", "1.18.2"]) {
    console.log(`Minecraft ${version}`);
    await program(app, version, version === "1.21.1");
    await testFile(app, version);
  }
  console.log("the yield limit");
  await watchdog(app, "1.21.1");
} catch (error) {
  if (!failed) {
    failed++;
    console.error(error.stack ?? error);
  }
} finally {
  if (app) killTree(app.child);
  // an engine the kill has not let go of yet can still hold the folder: say so, and still give the result
  try {
    rmSync(project, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 300,
    });
  } catch (error) {
    console.error(`could not remove ${project}: ${error.code ?? error}`);
  }
}
console.log(failed ? "debug e2e: FAILED" : "debug e2e: ok");
process.exit(failed ? 1 : 0);
