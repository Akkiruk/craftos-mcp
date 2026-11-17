// The debug adapter (src/debug/session.ts) against a stand-in engine: what it tells the engine and when, and what
// it makes of the engine's answers for VS Code. The real engine is in test/debug-e2e.mjs.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { DebugSession } from "../../src/debug/session.ts";

const root = join(process.cwd(), "proj");
const tick = () => new Promise((r) => setImmediate(r));

function harness(options = {}) {
  const out = []; // what VS Code is sent
  const sent = []; // what the engine is asked
  const replies = options.replies ?? {};
  const listeners = {};
  let disposed = 0;
  let closed = false;
  const launches = [];
  const link = {
    port: 4711,
    token: "secret",
    connected: false,
    request(cmd, args = {}) {
      if (!link.connected)
        return Promise.reject(new Error("the computer is not connected"));
      sent.push({ cmd, ...args });
      const reply =
        typeof replies[cmd] === "function" ? replies[cmd](args) : replies[cmd];
      if (reply instanceof Error) return Promise.reject(reply);
      return Promise.resolve({ ok: true, ...reply });
    },
    onEvent: (l) => (listeners.event = l),
    onConnect: (l) => (listeners.connect = l),
    onClose: (l) => (listeners.close = l),
    close: () => (closed = true),
  };
  const present = new Set(
    (options.files ?? ["prog.lua", "lib/util.lua"]).map((f) => join(root, f)),
  );
  const session = new DebugSession({
    send: (m) => out.push(m),
    listen: async () => link,
    locate: () => {
      if (options.locateError) throw new Error(options.locateError);
      return { root, program: "/prog.lua" };
    },
    launch: async (args, located, where) => {
      launches.push({ args, located, where });
      if (options.launchError) throw new Error(options.launchError);
      return { dispose: () => void disposed++ };
    },
    exists: (file) => present.has(file),
    connectTimeoutMs: options.connectTimeoutMs ?? 10_000,
  });
  let seq = 0;
  const request = async (command, args = {}) => {
    const mine = ++seq;
    session.handle({ seq: mine, type: "request", command, arguments: args });
    for (let i = 0; i < 200; i++) {
      const response = out.find(
        (m) => m.type === "response" && m.request_seq === mine,
      );
      if (response) return response;
      await tick();
    }
    throw new Error(`no response to ${command}`);
  };
  const events = (name) =>
    out.filter((m) => m.type === "event" && m.event === name);
  return {
    session,
    out,
    sent,
    launches,
    request,
    events,
    get disposed() {
      return disposed;
    },
    get closed() {
      return closed;
    },
    async connect() {
      link.connected = true;
      listeners.connect({ event: "hello", token: "secret", computer: 3 });
      for (let i = 0; i < 20; i++) await tick();
    },
    emit: (event) => listeners.event(event),
    async drop() {
      link.connected = false;
      listeners.close();
      for (let i = 0; i < 20; i++) await tick();
    },
  };
}

/** initialize + launch + configurationDone, with the engine connected: the usual start. */
async function started(options) {
  const h = harness(options);
  await h.request("initialize");
  await h.request("launch", {
    program: "prog.lua",
    ...(options?.launch ?? {}),
  });
  await h.request("setExceptionBreakpoints", { filters: ["uncaught"] });
  await h.request("configurationDone");
  await h.connect();
  return h;
}

const frames = [
  {
    i: 0,
    thread: 0,
    what: "C",
    line: -1,
    name: "error",
    path: "",
    user: false,
    defined: -1,
  },
  {
    i: 1,
    thread: 0,
    what: "Lua",
    line: 3,
    name: "add",
    path: "/lib/util.lua",
    user: true,
    defined: 1,
  },
  {
    i: 2,
    thread: 0,
    what: "main",
    line: 7,
    name: "f",
    path: "/prog.lua",
    user: true,
    defined: 0,
  },
  {
    i: 3,
    thread: 1,
    what: "Lua",
    line: 183,
    name: "executeProgram",
    path: "/rom/programs/shell.lua",
    user: false,
    defined: 108,
  },
  {
    i: 4,
    thread: 1,
    what: "Lua",
    line: 471,
    name: "run",
    path: "bios.lua",
    user: false,
    defined: 453,
  },
];

test("initialize says what the debugger can do and that breakpoints may come", async () => {
  const h = harness();
  const response = await h.request("initialize");
  assert.equal(response.success, true);
  assert.equal(response.body.supportsConditionalBreakpoints, true);
  assert.equal(response.body.supportsHitConditionalBreakpoints, true);
  assert.equal(response.body.supportsLogPoints, true);
  assert.equal(response.body.supportsSetVariable, true);
  assert.deepEqual(
    response.body.exceptionBreakpointFilters.map((f) => [f.filter, f.default]),
    [
      ["uncaught", true],
      ["all", false],
    ],
  );
  assert.equal(h.events("initialized").length, 1);
});

test("the computer is started with the debugger's port and token", async () => {
  const h = harness();
  await h.request("initialize");
  const response = await h.request("launch", {
    program: "prog.lua",
    stopOnEntry: true,
  });
  assert.equal(response.success, true);
  assert.deepEqual(h.launches[0].where, { port: 4711, token: "secret" });
  assert.deepEqual(h.launches[0].located, { root, program: "/prog.lua" });
});

test("breakpoints set before the engine connects reach it before it is told to run", async () => {
  const h = harness();
  await h.request("initialize");
  await h.request("launch", {
    program: "prog.lua",
    stopOnEntry: true,
    stepIntoRom: true,
  });
  const set = await h.request("setBreakpoints", {
    source: { path: join(root, "lib", "util.lua") },
    breakpoints: [{ line: 3 }, { line: 9, condition: "n > 2" }],
  });
  assert.deepEqual(
    set.body.breakpoints.map((b) => [b.verified, b.line]),
    [
      [true, 3],
      [true, 9],
    ],
  );
  await h.request("setExceptionBreakpoints", { filters: ["all", "uncaught"] });
  await h.request("configurationDone");
  assert.deepEqual(
    h.sent,
    [],
    "nothing can be sent before the engine is there",
  );
  await h.connect();
  assert.deepEqual(
    h.sent.map((s) => s.cmd),
    ["configure", "setBreakpoints", "setErrorMode", "run"],
  );
  assert.deepEqual(h.sent[0], {
    cmd: "configure",
    stepIntoRom: true,
    entry: "/prog.lua",
    stopOnEntry: true,
  });
  assert.equal(h.sent[1].path, "/lib/util.lua");
  assert.deepEqual(
    h.sent[1].breakpoints.map((b) => [b.line, b.condition]),
    [
      [3, undefined],
      [9, "n > 2"],
    ],
  );
  assert.equal(h.sent[2].mode, "all");
});

test("the engine is not told to run until VS Code has sent everything", async () => {
  const h = harness();
  await h.request("initialize");
  await h.request("launch", { program: "prog.lua" });
  await h.connect();
  assert.equal(
    h.sent.some((s) => s.cmd === "run"),
    false,
  );
  await h.request("configurationDone");
  assert.equal(h.sent.filter((s) => s.cmd === "run").length, 1);
});

test("a breakpoint set while the program runs goes straight to the engine", async () => {
  const h = await started();
  h.sent.length = 0;
  await h.request("setBreakpoints", {
    source: { path: join(root, "prog.lua") },
    breakpoints: [{ line: 4 }],
  });
  assert.equal(h.sent[0].cmd, "setBreakpoints");
  assert.equal(h.sent[0].path, "/prog.lua");
  // taking them all away again tells the engine so
  await h.request("setBreakpoints", {
    source: { path: join(root, "prog.lua") },
    breakpoints: [],
  });
  assert.deepEqual(h.sent[1].breakpoints, []);
});

test("a breakpoint in a file outside the project is not verified and not sent", async () => {
  const h = await started();
  h.sent.length = 0;
  const set = await h.request("setBreakpoints", {
    source: { path: join(root, "..", "elsewhere.lua") },
    breakpoints: [{ line: 1 }],
  });
  assert.equal(set.body.breakpoints[0].verified, false);
  assert.match(set.body.breakpoints[0].message, /not on the computer/);
  assert.deepEqual(h.sent, []);
});

test("hit counts and log messages are put into the engine's terms; a bad hit count is refused", async () => {
  const h = await started();
  h.sent.length = 0;
  const set = await h.request("setBreakpoints", {
    source: { path: join(root, "prog.lua") },
    breakpoints: [
      { line: 1, hitCondition: "% 3" },
      { line: 2, logMessage: "n is {n}" },
      { line: 3, hitCondition: "sometimes" },
    ],
  });
  assert.deepEqual(
    set.body.breakpoints.map((b) => b.verified),
    [true, true, false],
  );
  const forEngine = h.sent[0].breakpoints;
  assert.equal(forEngine.length, 2);
  assert.deepEqual([forEngine[0].hitOp, forEngine[0].hitN], ["%", 3]);
  assert.equal(forEngine[1].log, '"n is " .. tostring((n))');
});

test("a stop becomes a DAP stop with the breakpoints that were hit", async () => {
  const h = await started();
  h.emit({
    event: "stopped",
    reason: "breakpoint",
    text: "",
    breakpoints: [2],
  });
  const stopped = h.events("stopped")[0];
  assert.equal(stopped.body.reason, "breakpoint");
  assert.equal(stopped.body.threadId, 1);
  assert.deepEqual(stopped.body.hitBreakpointIds, [2]);
  const threads = await h.request("threads");
  assert.deepEqual(threads.body.threads, [{ id: 1, name: "Computer 3" }]);
});

test("the stack: project files open as themselves, the ROM by reference, the BIOS by name only", async () => {
  const h = await started({ replies: { stack: { frames: frames.slice(1) } } });
  h.emit({ event: "stopped", reason: "breakpoint", text: "", breakpoints: [] });
  const stack = await h.request("stackTrace", { threadId: 1 });
  const got = stack.body.stackFrames;
  assert.equal(stack.body.totalFrames, 4);
  assert.deepEqual(
    got.map((f) => [f.id, f.name, f.line]),
    [
      [2, "add", 3],
      [3, "main chunk", 7],
      [4, "executeProgram", 183],
      [5, "run (bios.lua:471)", 0],
    ],
  );
  assert.equal(got[0].source.path, join(root, "lib", "util.lua"));
  assert.equal(got[0].presentationHint, undefined);
  assert.equal(got[2].source.sourceReference, 1);
  assert.equal(got[2].source.presentationHint, "deemphasize");
  assert.equal(got[2].presentationHint, "subtle");
  assert.equal(got[3].source, undefined);
  // asked for once: the second request is answered from what is known
  await h.request("stackTrace", { threadId: 1, startFrame: 1, levels: 1 });
  assert.equal(h.sent.filter((s) => s.cmd === "stack").length, 1);
});

test("a stop on an error starts at the code that raised it, not at error()", async () => {
  const h = await started({ replies: { stack: { frames } } });
  h.emit({
    event: "stopped",
    reason: "exception",
    text: "/lib/util.lua:3: boom",
    breakpoints: [],
  });
  const stopped = h.events("stopped")[0];
  assert.equal(stopped.body.text, "/lib/util.lua:3: boom");
  const stack = await h.request("stackTrace", { threadId: 1 });
  assert.equal(stack.body.stackFrames[0].name, "add");
  const info = await h.request("exceptionInfo", { threadId: 1 });
  assert.equal(info.body.description, "/lib/util.lua:3: boom");
  assert.equal(info.body.breakMode, "unhandled");
  // with no frame named, an expression is evaluated where the error was raised
  await h.request("evaluate", { expression: "a", context: "repl" });
  assert.equal(h.sent.find((s) => s.cmd === "eval").frame, 1);
});

test("scopes and variables: locals in order, a table opens, names can be evaluated", async () => {
  const h = await started({
    replies: {
      stack: { frames: frames.slice(1) },
      locals: {
        variables: [
          { name: "b", value: "2", type: "number", ek: true },
          { name: "a", value: "{x = 1}", type: "table", ref: 7, ek: true },
          { name: "(...)[1]", value: "9", type: "number" },
        ],
      },
      children: {
        variables: [
          { name: "x", value: "1", type: "number", ek: true },
          { name: "[2]", value: '"two"', type: "string", ek: true },
          { name: "[1]", value: "{}", type: "table", ref: 8, ek: true },
          { name: "(metatable)", value: "{...}", type: "table", ref: 9 },
        ],
      },
    },
  });
  h.emit({ event: "stopped", reason: "step", text: "", breakpoints: [] });
  const scopes = await h.request("scopes", { frameId: 2 });
  assert.deepEqual(
    scopes.body.scopes.map((s) => s.name),
    ["Locals", "Upvalues", "Globals"],
  );
  const locals = await h.request("variables", {
    variablesReference: scopes.body.scopes[0].variablesReference,
  });
  assert.equal(h.sent.at(-1).cmd, "locals");
  assert.equal(h.sent.at(-1).frame, 1);
  assert.deepEqual(
    locals.body.variables.map((v) => [
      v.name,
      v.value,
      v.evaluateName,
      v.variablesReference > 0,
    ]),
    [
      ["b", "2", "b", false],
      ["a", "{x = 1}", "a", true],
      ["(...)[1]", "9", undefined, false],
    ],
  );
  const inside = await h.request("variables", {
    variablesReference: locals.body.variables[1].variablesReference,
  });
  assert.equal(h.sent.at(-1).ref, 7);
  assert.deepEqual(
    inside.body.variables.map((v) => [v.name, v.evaluateName]),
    [
      ["[1]", "a[1]"],
      ["[2]", "a[2]"],
      ["x", "a.x"],
      ["(metatable)", undefined],
    ],
  );
});

test("setting a variable assigns in the frame and reports the new value", async () => {
  const h = await started({
    replies: {
      stack: { frames: frames.slice(1) },
      locals: {
        variables: [
          { name: "a", value: "{x = 1}", type: "table", ref: 7, ek: true },
        ],
      },
      children: {
        variables: [{ name: "x", value: "1", type: "number", ek: true }],
      },
      eval: (args) =>
        args.expr === "a.x"
          ? { value: "5", type: "number" }
          : { value: "nil", type: "nil", none: true },
    },
  });
  h.emit({ event: "stopped", reason: "step", text: "", breakpoints: [] });
  const scopes = await h.request("scopes", { frameId: 2 });
  const locals = await h.request("variables", {
    variablesReference: scopes.body.scopes[0].variablesReference,
  });
  const tableRef = locals.body.variables[0].variablesReference;
  await h.request("variables", { variablesReference: tableRef });
  const set = await h.request("setVariable", {
    variablesReference: tableRef,
    name: "x",
    value: "2 + 3",
  });
  assert.equal(set.success, true);
  assert.equal(set.body.value, "5");
  const evals = h.sent.filter((s) => s.cmd === "eval").map((s) => s.expr);
  assert.deepEqual(evals, ["a.x = 2 + 3", "a.x"]);
});

test("evaluate: a value, a table that opens, a statement that gives nothing, an error", async () => {
  const h = await started({
    replies: {
      stack: { frames: frames.slice(1) },
      eval: (args) => {
        if (args.expr === "t")
          return { value: "{1, 2}", type: "table", ref: 4 };
        if (args.expr === "x = 1")
          return { value: "nil", type: "nil", none: true };
        if (args.expr === "nope(")
          return new Error("unexpected symbol near <eof>");
        return { value: "42", type: "number" };
      },
    },
  });
  h.emit({ event: "stopped", reason: "breakpoint", text: "", breakpoints: [] });
  const value = await h.request("evaluate", {
    expression: "6 * 7",
    frameId: 3,
    context: "watch",
  });
  assert.equal(value.body.result, "42");
  assert.equal(h.sent.at(-1).frame, 2);
  const table = await h.request("evaluate", {
    expression: "t",
    frameId: 2,
    context: "hover",
  });
  assert.ok(table.body.variablesReference > 0);
  const statement = await h.request("evaluate", {
    expression: "x = 1",
    frameId: 2,
    context: "repl",
  });
  assert.equal(statement.body.result, "");
  const bad = await h.request("evaluate", {
    expression: "nope(",
    frameId: 2,
    context: "repl",
  });
  assert.equal(bad.success, false);
  assert.match(bad.message, /unexpected symbol/);
});

test("nothing can be looked at while the program runs", async () => {
  const h = await started();
  const evaluate = await h.request("evaluate", {
    expression: "1",
    context: "repl",
  });
  assert.equal(evaluate.success, false);
  assert.match(evaluate.message, /running/);
  const stack = await h.request("stackTrace", { threadId: 1 });
  assert.equal(stack.success, false);
});

test("continue and the steps go to the engine, and what was shown is forgotten", async () => {
  const h = await started({ replies: { stack: { frames: frames.slice(1) } } });
  for (const [command, cmd] of [
    ["continue", "continue"],
    ["next", "next"],
    ["stepIn", "stepIn"],
    ["stepOut", "stepOut"],
  ]) {
    h.emit({ event: "stopped", reason: "step", text: "", breakpoints: [] });
    const response = await h.request(command, { threadId: 1 });
    assert.equal(response.success, true);
    assert.equal(h.sent.at(-1).cmd, cmd);
    assert.equal((await h.request("scopes", { frameId: 2 })).success, false);
  }
  await h.request("pause", { threadId: 1 });
  assert.equal(h.sent.at(-1).cmd, "pause");
});

test("a logpoint's line shows in the debug console with its place", async () => {
  const h = await started();
  h.emit({
    event: "output",
    category: "console",
    text: "n is 3\n",
    path: "/prog.lua",
    line: 4,
  });
  const output = h.events("output").at(-1);
  assert.equal(output.body.output, "n is 3\n");
  assert.equal(output.body.source.path, join(root, "prog.lua"));
  assert.equal(output.body.line, 4);
});

test("a ROM file's text is read from the computer once", async () => {
  let reads = 0;
  const h = await started({
    replies: {
      stack: { frames: frames.slice(1) },
      eval: (args) => {
        assert.equal(args.raw, true);
        assert.match(
          args.expr,
          /fs\.open\("\/rom\/programs\/shell\.lua", "r"\)/,
        );
        reads++;
        return { text: "-- the shell\n" };
      },
    },
  });
  h.emit({ event: "stopped", reason: "breakpoint", text: "", breakpoints: [] });
  const stack = await h.request("stackTrace", { threadId: 1 });
  const ref = stack.body.stackFrames[2].source.sourceReference;
  const first = await h.request("source", { sourceReference: ref });
  assert.equal(first.body.content, "-- the shell\n");
  await h.request("source", { source: { sourceReference: ref } });
  assert.equal(reads, 1);
});

test("the computer shutting down ends the session and leaves its panel alone", async () => {
  const h = await started();
  await h.drop();
  assert.equal(h.events("terminated").length, 1);
  assert.equal(h.disposed, 0);
});

test("the program ending ends the session and leaves the computer and its panel as they are", async () => {
  const h = await started();
  h.emit({ event: "ended" });
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(h.events("terminated").length, 1);
  assert.equal(h.sent.at(-1).cmd, "detach");
  assert.equal(h.disposed, 0);
  assert.equal(h.closed, true);
});

test("Stop ends the computer; Disconnect leaves it running without the debugger", async () => {
  const stop = await started();
  await stop.request("disconnect", { terminateDebuggee: true });
  for (let i = 0; i < 20; i++) await tick(); // the answer comes first, the ending after it
  assert.equal(stop.disposed, 1);
  assert.equal(stop.closed, true);
  assert.equal(stop.events("terminated").length, 1);

  const leave = await started();
  await leave.request("disconnect", { terminateDebuggee: false });
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(leave.sent.at(-1).cmd, "detach");
  assert.equal(leave.disposed, 0);
  assert.equal(leave.events("terminated").length, 1);
});

test("an engine that never connects is reported, with what to do about it", async () => {
  const h = harness({ connectTimeoutMs: 20 });
  await h.request("initialize");
  await h.request("launch", { program: "prog.lua" });
  await h.request("configurationDone");
  await new Promise((r) => setTimeout(r, 80));
  const said = h
    .events("output")
    .map((e) => e.body.output)
    .join("");
  assert.match(said, /never connected to the debugger/);
  assert.match(said, /update craftos-mcp/);
  assert.equal(h.events("terminated").length, 1);
  assert.equal(h.disposed, 0, "the program goes on running in its panel");
});

test("Run Without Debugging starts the computer and waits for no engine", async () => {
  const h = harness({ connectTimeoutMs: 20 });
  await h.request("initialize");
  await h.request("launch", { program: "prog.lua", noDebug: true });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(h.events("terminated").length, 0);
});

test("a computer that will not start fails the launch with the reason", async () => {
  const h = harness({ launchError: "The computer did not start." });
  await h.request("initialize");
  const response = await h.request("launch", { program: "prog.lua" });
  assert.equal(response.success, false);
  assert.match(response.message, /did not start/);
  assert.equal(h.closed, true);

  const lost = harness({ locateError: "There is no prog.lua." });
  await lost.request("initialize");
  const nowhere = await lost.request("launch", { program: "prog.lua" });
  assert.match(nowhere.message, /There is no prog\.lua/);
  // breakpoints sent after a failed launch are still answered
  const set = await lost.request("setBreakpoints", {
    source: { path: join(root, "prog.lua") },
    breakpoints: [{ line: 1 }],
  });
  assert.equal(set.body.breakpoints[0].verified, false);
});
