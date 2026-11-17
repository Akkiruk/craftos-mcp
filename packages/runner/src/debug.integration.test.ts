// The engine's debugger (engine/src/debug_server.cpp) over its own wire protocol: startEngine with a DebugLink, a
// socket standing in for the debug adapter. The adapter itself (DAP) is tested in apps/vscode.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  type EngineHandle,
  checkConfig,
  loadConfig,
  parseDebugLink,
  resolveVersion,
  romDirFor,
  startEngine,
} from "./index.js";

const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "debug-ws-"));
const config = { ...base, workspaceDir: scratch };
const ready = checkConfig(config).length === 0;

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

writeFileSync(
  join(scratch, "prog.lua"),
  [
    "local function double(n)", // 1
    "  local twice = n * 2", // 2
    "  return twice", // 3
    "end", // 4
    "local sum = 0", // 5
    "for i = 1, 3 do", // 6
    "  sum = sum + double(i)", // 7
    "end", // 8
    'local ok = pcall(error, "caught")', // 9
    'print("sum", sum)', // 10
    'error("uncaught " .. sum)', // 11
    "",
  ].join("\n"),
);

interface Message {
  seq?: number;
  ok?: boolean;
  error?: string;
  event?: string;
  [key: string]: unknown;
}

/** A debug adapter's end of the line: what the engine connects to. */
class Adapter {
  private socket: Socket | undefined;
  private seq = 0;
  private readonly waiting = new Map<number, (m: Message) => void>();
  private readonly events: Message[] = [];
  private wake: (() => void) | undefined;
  closed = false;

  private constructor(
    private readonly server: Server,
    readonly port: number,
  ) {}

  static async listen(): Promise<Adapter> {
    const server = createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const adapter = new Adapter(server, (server.address() as AddressInfo).port);
    server.on("connection", (socket) => {
      adapter.socket = socket;
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("error", () => undefined);
      socket.on("close", () => {
        adapter.closed = true;
        adapter.wake?.();
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        for (
          let nl = buffer.indexOf("\n");
          nl >= 0;
          nl = buffer.indexOf("\n")
        ) {
          const message = JSON.parse(buffer.slice(0, nl)) as Message;
          buffer = buffer.slice(nl + 1);
          if (message.event) {
            adapter.events.push(message);
            adapter.wake?.();
          } else if (message.seq !== undefined) {
            adapter.waiting.get(message.seq)?.(message);
            adapter.waiting.delete(message.seq);
          }
        }
      });
    });
    return adapter;
  }

  request(cmd: string, args: Record<string, unknown> = {}): Promise<Message> {
    const seq = ++this.seq;
    return new Promise((resolve) => {
      this.waiting.set(seq, resolve);
      this.socket!.write(`${JSON.stringify({ seq, cmd, ...args })}\n`);
    });
  }

  /** The next event of that name not taken yet. */
  async event(name: string, timeoutMs = 20000): Promise<Message> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const at = this.events.findIndex((e) => e.event === name);
      if (at >= 0) return this.events.splice(at, 1)[0]!;
      if (this.closed || Date.now() > end)
        throw new Error(
          `no ${name} event (${this.closed ? "the engine hung up" : "timed out"})`,
        );
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 200);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }

  close(): void {
    this.socket?.destroy();
    this.server.close();
  }
}

interface Frame {
  path: string;
  line: number;
  name?: string;
  what: string;
  user: boolean;
}
interface Variable {
  name: string;
  value: string;
  ref?: number;
}

describe("a debug link from untrusted JSON", () => {
  it("takes a port and a token", () => {
    expect(parseDebugLink({ port: 4711, token: "abc_DEF-123" })).toEqual({
      port: 4711,
      token: "abc_DEF-123",
    });
    expect(parseDebugLink(undefined)).toBeUndefined();
  });

  it("refuses what could reach the engine's command line or environment", () => {
    expect(() => parseDebugLink({ port: 0, token: "a" })).toThrow(/port/);
    expect(() => parseDebugLink({ port: "4711", token: "a" })).toThrow(/port/);
    expect(() => parseDebugLink({ port: 70000, token: "a" })).toThrow(/port/);
    expect(() => parseDebugLink({ port: 4711, token: "a b" })).toThrow(/token/);
    expect(() => parseDebugLink({ port: 4711 })).toThrow(/token/);
  });
});

describe.skipIf(!ready)("the engine's debugger", () => {
  const handles: EngineHandle[] = [];
  const adapters: Adapter[] = [];
  afterAll(async () => {
    for (const a of adapters) a.close();
    for (const h of handles) {
      await h.session.stop().catch(() => undefined);
      h.dispose();
    }
  });

  for (const mc of ["1.18.2", "1.21.1"]) {
    const rom = existsSync(
      join(romDirFor(config, resolveVersion(mc, {})), "bios.lua"),
    );
    it.skipIf(!rom)(
      `${mc}: breakpoint, locals, step, continue, break on an uncaught error`,
      async () => {
        const adapter = await Adapter.listen();
        adapters.push(adapter);
        const handle = startEngine(config, 'shell.run("prog.lua")', {
          world: { version: mc },
          debug: { port: adapter.port, token: "token-for-test" },
        });
        handles.push(handle);

        // the engine says hello with the token and waits: nothing has run yet
        const hello = await adapter.event("hello");
        expect(hello["token"]).toBe("token-for-test");
        expect(handle.session.screen(0)?.lines.join("")).toBeFalsy();
        await adapter.request("setBreakpoints", {
          path: "/prog.lua",
          breakpoints: [{ id: 7, line: 2, condition: "n == 2" }],
        });
        await adapter.request("setErrorMode", { mode: "uncaught" });
        await adapter.request("configure", { entry: "/prog.lua" });
        expect((await adapter.request("stack")).ok).toBe(false); // not stopped
        await adapter.request("run");

        // the conditional breakpoint: the second call of double
        let stopped = await adapter.event("stopped");
        expect(stopped["reason"]).toBe("breakpoint");
        expect(stopped["breakpoints"]).toEqual([7]);
        let frames = (await adapter.request("stack"))["frames"] as Frame[];
        expect(frames[0]).toMatchObject({
          path: "/prog.lua",
          line: 2,
          name: "double",
          user: true,
        });
        expect(frames[1]).toMatchObject({
          path: "/prog.lua",
          line: 7,
          what: "main",
        });
        expect(frames.some((f) => f.path.startsWith("/rom/") && !f.user)).toBe(
          true,
        );

        const locals = async (frame: number): Promise<Record<string, string>> =>
          Object.fromEntries(
            (
              (await adapter.request("locals", { frame }))[
                "variables"
              ] as Variable[]
            ).map((v) => [v.name, v.value]),
          );
        expect(await locals(0)).toEqual({ n: "2" });
        expect(await locals(1)).toMatchObject({ sum: "2", i: "2" });
        expect(
          (await adapter.request("eval", { frame: 0, expr: "n * 10" }))[
            "value"
          ],
        ).toBe("20");
        expect(
          (await adapter.request("eval", { frame: 1, expr: "sum" }))["value"],
        ).toBe("2");

        // step over the line: twice is set
        await adapter.request("next");
        stopped = await adapter.event("stopped");
        expect(stopped["reason"]).toBe("step");
        frames = (await adapter.request("stack"))["frames"] as Frame[];
        expect(frames[0]).toMatchObject({ path: "/prog.lua", line: 3 });
        expect(await locals(0)).toEqual({ n: "2", twice: "4" });

        // continue: the error pcall catches is passed, the uncaught one stops where it is raised
        await adapter.request("setBreakpoints", {
          path: "/prog.lua",
          breakpoints: [],
        });
        await adapter.request("continue");
        stopped = await adapter.event("stopped");
        expect(stopped["reason"]).toBe("exception");
        expect(stopped["text"]).toBe("/prog.lua:11: uncaught 12");
        frames = (await adapter.request("stack"))["frames"] as Frame[];
        expect(frames.find((f) => f.what !== "C")).toMatchObject({
          path: "/prog.lua",
          line: 11,
        });
        // the screen is still drawn while the program is stopped: what it printed before the error is there
        await handle.session.waitForText("sum", 0, 5000);
        expect(handle.session.screen(0)?.lines.join("\n")).toMatch(/sum\s+12/);

        // let it go: the shell prints the error as it always does, and the engine says the program has ended
        await adapter.request("continue");
        await adapter.event("ended");
        await handle.session.waitForText("uncaught 12", 0, 10000);
      },
      60000,
    );
  }

  it("with nothing listening the computer runs as if no debugger had been asked for", async () => {
    const closed = await Adapter.listen();
    const port = closed.port;
    closed.close();
    const handle = startEngine(config, 'shell.run("prog.lua")', {
      debug: { port, token: "nobody" },
    });
    handles.push(handle);
    await handle.session.waitForText("uncaught 12", 0, 30000);
    expect(handle.stderr.join("")).toMatch(/debugger: could not connect/);
  }, 60000);

  it("an adapter that hangs up leaves the program running", async () => {
    const adapter = await Adapter.listen();
    adapters.push(adapter);
    const handle = startEngine(config, 'shell.run("prog.lua")', {
      debug: { port: adapter.port, token: "t" },
    });
    handles.push(handle);
    await adapter.event("hello");
    await adapter.request("setBreakpoints", {
      path: "/prog.lua",
      breakpoints: [{ id: 1, line: 5 }],
    });
    await adapter.request("run");
    await adapter.event("stopped");
    adapter.close();
    await handle.session.waitForText("uncaught 12", 0, 15000);
  }, 60000);

  /** Start `boot` with an adapter that has said its piece: errors the program does not catch stop it. */
  async function started(
    boot: string,
    mc?: string,
  ): Promise<{
    adapter: Adapter;
    handle: EngineHandle;
  }> {
    const adapter = await Adapter.listen();
    adapters.push(adapter);
    const handle = startEngine(config, boot, {
      ...(mc && { world: { version: mc } }),
      debug: { port: adapter.port, token: "t" },
    });
    handles.push(handle);
    await adapter.event("hello");
    await adapter.request("setErrorMode", { mode: "uncaught" });
    return { adapter, handle };
  }

  // 1.21.1 too: its parallel raises the error again as a {message, thread} table
  for (const mc of ["1.18.2", "1.21.1"])
    it(`${mc}: an error caught one coroutine up is caught: pcall around parallel, coroutine.resume, a wrapped coroutine`, async () => {
      writeFileSync(
        join(scratch, "catch.lua"),
        [
          'local ok = pcall(parallel.waitForAny, function() error("inner one") end)', // 1
          'print("first", ok)', // 2
          'local co = coroutine.create(function() error("inner two") end)', // 3
          'print("second", (coroutine.resume(co)))', // 4
          'local wrapped = coroutine.wrap(function() error("inner three") end)', // 5
          'print("third", (pcall(wrapped)))', // 6
          'parallel.waitForAny(function() error("outer") end)', // 7
          "",
        ].join("\n"),
      );
      const { adapter, handle } = await started('shell.run("catch.lua")', mc);
      await adapter.request("configure", { entry: "/catch.lua" });
      await adapter.request("run");
      // the only stop is the one nothing in the program catches, where it is raised
      const stopped = await adapter.event("stopped");
      expect(stopped["reason"]).toBe("exception");
      expect(stopped["text"]).toBe("/catch.lua:7: outer");
      await handle.session.waitForText("third", 0, 5000);
      const lines = handle.session.screen(0)?.lines.join("\n") ?? "";
      expect(lines).toMatch(/first\s+false/);
      expect(lines).toMatch(/second\s+false/);
      expect(lines).toMatch(/third\s+false/);
      // parallel raises it again in the program's own coroutine: that is the same error, not a second stop
      await adapter.request("continue");
      await adapter.event("ended");
    }, 60000);

  it("the same words raised again later are a new error", async () => {
    writeFileSync(join(scratch, "fail.lua"), 'error("same words", 0)\n');
    const { adapter, handle } = await started(
      'shell.run("fail.lua") sleep(0.1) shell.run("fail.lua") print("both done")',
    );
    await adapter.request("run");
    for (const _ of [1, 2]) {
      const stopped = await adapter.event("stopped");
      expect(stopped["text"]).toBe("same words");
      await adapter.request("continue");
    }
    await handle.session.waitForText("both done", 0, 10000);
  }, 60000);

  it("a coroutine made by an evaluated expression is the program's: its breakpoints stop it", async () => {
    writeFileSync(
      join(scratch, "made.lua"),
      [
        "function probe(n)", // 1
        "  return n + 1", // 2
        "end", // 3
        'print("ready")', // 4
        "local got = made and made()", // 5
        'print("got", got)', // 6
        "",
      ].join("\n"),
    );
    const { adapter, handle } = await started('shell.run("made.lua")');
    await adapter.request("setBreakpoints", {
      path: "/made.lua",
      breakpoints: [
        { id: 1, line: 4 },
        { id: 2, line: 2 },
      ],
    });
    await adapter.request("run");
    expect((await adapter.event("stopped"))["breakpoints"]).toEqual([1]);
    // a long enough loop that the evaluation's own guard looks at it at least once after the evaluation is over
    const made = await adapter.request("eval", {
      frame: 0,
      expr: "made = coroutine.wrap(function() local n = 0 for i = 1, 300000 do n = n + 1 end return probe(n) end)",
    });
    expect(made.ok).toBe(true);
    await adapter.request("continue");
    const stopped = await adapter.event("stopped");
    expect(stopped["breakpoints"]).toEqual([2]);
    const locals = (await adapter.request("locals", { frame: 0 }))[
      "variables"
    ] as Variable[];
    expect(locals).toMatchObject([{ name: "n", value: "300000" }]);
    await adapter.request("continue");
    await handle.session.waitForText("got", 0, 10000);
    expect(handle.session.screen(0)?.lines.join("\n")).toMatch(/got\s+300001/);
  }, 60000);
});
