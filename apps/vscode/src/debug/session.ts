// The debug adapter: VS Code's Debug Adapter Protocol on one side, the engine's debugger (engineLink.ts) on the
// other. It keeps the breakpoints and options VS Code sets, gives them to the engine when it connects (before the
// computer runs its first line), and turns the engine's stops into DAP stops, stacks, scopes and variables.
//
// No vscode import: what starts the computer and where messages go is handed in (SessionHost), so the unit tests
// drive it with a stand-in engine and the end-to-end test with a real one.
import { existsSync } from "node:fs";
import type { EngineEvent, EngineReply, Link } from "./engineLink.ts";
import {
  type EngineFrame,
  type EngineVariable,
  baseName,
  childExpression,
  frameName,
  logExpression,
  luaQuote,
  parseHitCondition,
  sortEntries,
  toComputerPath,
  toHostPath,
} from "./paths.ts";

/** A DAP message, either way. */
export interface DapMessage {
  seq: number;
  type: "request" | "response" | "event";
  [key: string]: unknown;
}

/** The `craftos` launch configuration. */
export interface LaunchArguments {
  /** The .lua file to run: absolute, or relative to the workspace folder. */
  readonly program?: string;
  /** Run `program` as a ccunit test file. Default: whether its name ends in .test.lua. */
  readonly test?: boolean;
  /** Stop on the program's first line. */
  readonly stopOnEntry?: boolean;
  /** Let Step Into go into the ROM's code (print, textutils, the shell) instead of over it. */
  readonly stepIntoRom?: boolean;
  readonly noDebug?: boolean;
  readonly [key: string]: unknown;
}

/** Where a launch's program is: the folder the computer gets as its root, and the program's path on the computer. */
export interface Located {
  /** The project folder the emulator copies onto the computer. */
  readonly root: string;
  /** The program on the computer, "/dir/prog.lua". */
  readonly program: string;
}

/** A started computer. */
export interface Launched {
  /** Stop the computer and close what shows it. */
  dispose(): void | Promise<void>;
  /** Called when the computer is gone for another reason (its panel was closed). */
  onDidEnd?(listener: () => void): void;
}

export interface SessionHost {
  /** A message for VS Code. */
  send(message: DapMessage): void;
  /** Open the port the engine connects to. */
  listen(): Promise<Link>;
  /** Work out the project folder and the program's path on the computer. Throws with a message for the user. */
  locate(args: LaunchArguments): Located | Promise<Located>;
  /** Start the computer with the debugger's port and token, running the program. */
  launch(
    args: LaunchArguments,
    located: Located,
    link: { port: number; token: string },
  ): Promise<Launched>;
  /** Default: the file system. */
  exists?(file: string): boolean;
  /** How long the engine has to connect once the computer is started. Default 20 s. */
  connectTimeoutMs?: number;
}

const THREAD_ID = 1;

type Handle =
  | { kind: "locals" | "upvalues" | "globals"; frame: number }
  | { kind: "table"; ref: number; frame: number; expression?: string };

interface Stop {
  readonly reason: string;
  readonly text: string;
  frames?: Promise<EngineFrame[]>;
  readonly handles: Map<number, Handle>;
}

interface DapBreakpoint {
  line: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

interface EngineBreakpoint {
  id: number;
  line: number;
  condition?: string;
  log?: string;
  hitOp?: string;
  hitN?: number;
}

/** Thrown to answer a request with an error the user sees. */
class UserError extends Error {}

export class DebugSession {
  private readonly host: SessionHost;
  private seq = 0;
  private link: Link | undefined;
  private launched: Launched | undefined;
  private located: Located | undefined;
  private args: LaunchArguments = {};
  /** Settles once the launch request has said where the program is (or failed): breakpoints wait for it. */
  private readonly ready: Promise<void>;
  private setReady: () => void = () => undefined;
  private configurationDone = false;
  private running = false;
  private ended = false;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private computer = 0;

  private nextBreakpointId = 1;
  /** By computer path: what the engine holds, and is given again when a new engine connects. */
  private readonly breakpoints = new Map<string, EngineBreakpoint[]>();
  private errorMode: "none" | "uncaught" | "all" = "none";

  private stop: Stop | undefined;
  private nextHandle = 1;
  /** Sources that are no file of the project (the ROM): a number VS Code asks for the text by. */
  private readonly sourcePaths = new Map<number, string>();
  private readonly sourceRefs = new Map<string, number>();
  private readonly sourceText = new Map<string, string>();

  constructor(host: SessionHost) {
    this.host = host;
    this.ready = new Promise((resolve) => {
      this.setReady = resolve;
    });
  }

  // ------------------------------------------------------------------------------------------------------------
  // Out

  private event(event: string, body?: Record<string, unknown>): void {
    this.host.send({
      seq: ++this.seq,
      type: "event",
      event,
      ...(body && { body }),
    });
  }

  private respond(request: DapMessage, body?: Record<string, unknown>): void {
    this.host.send({
      seq: ++this.seq,
      type: "response",
      request_seq: request.seq,
      command: request["command"],
      success: true,
      ...(body && { body }),
    });
  }

  private fail(request: DapMessage, message: string): void {
    this.host.send({
      seq: ++this.seq,
      type: "response",
      request_seq: request.seq,
      command: request["command"],
      success: false,
      message,
      body: { error: { id: 1, format: message, showUser: false } },
    });
  }

  private output(text: string, category = "console"): void {
    this.event("output", { category, output: text });
  }

  // ------------------------------------------------------------------------------------------------------------
  // In

  /** A message from VS Code. Never throws: a request that goes wrong is answered with the error. */
  handle(message: DapMessage): void {
    if (message.type !== "request") return;
    void this.dispatch(message).catch((error: unknown) => {
      this.fail(
        message,
        error instanceof Error ? error.message : String(error),
      );
    });
  }

  private async dispatch(request: DapMessage): Promise<void> {
    const args = (request["arguments"] ?? {}) as Record<string, unknown>;
    switch (request["command"]) {
      case "initialize":
        this.respond(request, {
          supportsConfigurationDoneRequest: true,
          supportsConditionalBreakpoints: true,
          supportsHitConditionalBreakpoints: true,
          supportsLogPoints: true,
          supportsEvaluateForHovers: true,
          supportsSetVariable: true,
          supportsExceptionInfoRequest: true,
          supportsTerminateRequest: true,
          supportsDelayedStackTraceLoading: true,
          exceptionBreakpointFilters: [
            {
              filter: "uncaught",
              label: "Uncaught Errors",
              description:
                "Stop where an error is raised that the program does not catch with pcall: the ones the shell prints, or that fail a test.",
              default: true,
            },
            {
              filter: "all",
              label: "All Errors",
              description:
                "Stop where any error is raised, also those a pcall catches (the ROM raises and catches some of its own).",
              default: false,
            },
          ],
        });
        // breakpoints can come at once: they are kept and given to the engine when it connects
        this.event("initialized");
        return;
      case "launch":
        return this.launch(request, args as LaunchArguments);
      case "setBreakpoints":
        return this.setBreakpoints(request, args);
      case "setExceptionBreakpoints": {
        const filters = Array.isArray(args["filters"]) ? args["filters"] : [];
        this.errorMode = filters.includes("all")
          ? "all"
          : filters.includes("uncaught")
            ? "uncaught"
            : "none";
        if (this.link?.connected)
          await this.link.request("setErrorMode", { mode: this.errorMode });
        this.respond(request, {
          breakpoints: filters.map(() => ({ verified: true })),
        });
        return;
      }
      case "configurationDone":
        this.configurationDone = true;
        this.respond(request);
        await this.maybeRun();
        return;
      case "threads":
        this.respond(request, {
          threads: [{ id: THREAD_ID, name: `Computer ${this.computer}` }],
        });
        return;
      case "stackTrace":
        return this.stackTrace(request, args);
      case "scopes":
        return this.scopes(request, args);
      case "variables":
        return this.variables(request, args);
      case "setVariable":
        return this.setVariable(request, args);
      case "evaluate":
        return this.evaluate(request, args);
      case "exceptionInfo":
        this.respond(request, {
          exceptionId: "error",
          description: this.stop?.text ?? "",
          breakMode: this.errorMode === "all" ? "always" : "unhandled",
          details: { message: this.stop?.text ?? "" },
        });
        return;
      case "source":
        return this.source(request, args);
      case "continue":
        await this.resume("continue");
        this.respond(request, { allThreadsContinued: true });
        return;
      case "next":
        await this.resume("next");
        this.respond(request);
        return;
      case "stepIn":
        await this.resume("stepIn");
        this.respond(request);
        return;
      case "stepOut":
        await this.resume("stepOut");
        this.respond(request);
        return;
      case "pause":
        await this.engine().request("pause");
        this.respond(request);
        return;
      case "terminate":
        this.respond(request);
        await this.end(true);
        return;
      case "disconnect":
        this.respond(request);
        // "Disconnect" leaves the computer running without a debugger; Stop ends it
        await this.end(args["terminateDebuggee"] !== false);
        return;
      default:
        this.fail(request, `not supported: ${String(request["command"])}`);
    }
  }

  private engine(): Link {
    if (!this.link?.connected)
      throw new UserError("The computer is not running.");
    return this.link;
  }

  /** The engine's stop the request is about; an error when the program is running. */
  private stopped(): Stop {
    if (!this.stop) throw new UserError("The program is running.");
    return this.stop;
  }

  // ------------------------------------------------------------------------------------------------------------
  // Starting and ending

  private async launch(
    request: DapMessage,
    args: LaunchArguments,
  ): Promise<void> {
    this.args = args;
    try {
      this.located = await this.host.locate(args);
    } catch (error) {
      this.setReady();
      throw error;
    }
    this.setReady();
    const link = await this.host.listen();
    this.link = link;
    link.onConnect((hello) => void this.connected(hello));
    link.onEvent((event) => this.engineEvent(event));
    link.onClose(() => {
      // the computer shut down (a test finished, os.shutdown) or was stopped
      this.stop = undefined;
      this.running = false;
      void this.end(false);
    });
    try {
      this.launched = await this.host.launch(args, this.located, {
        port: link.port,
        token: link.token,
      });
    } catch (error) {
      link.close();
      this.link = undefined;
      throw error;
    }
    if (this.ended) {
      // stopped while it was starting
      await this.launched.dispose();
      return;
    }
    this.launched.onDidEnd?.(() => void this.end(false));
    this.respond(request);
    // Run Without Debugging starts the same computer and gives its engine no debugger to connect to
    if (!link.connected && args.noDebug !== true) {
      this.connectTimer = setTimeout(() => {
        if (this.link?.connected || this.ended) return;
        this.output(
          "The emulator started the computer but its engine never connected to the debugger. " +
            "Debugging needs a craftos-mcp with the debugger in its engine: update craftos-mcp, or point " +
            "craftos-mcp.command at a build that has it. The program is running without the debugger.\n",
          "stderr",
        );
        void this.end(false);
      }, this.host.connectTimeoutMs ?? 20_000);
      // never the reason a process stays alive
      this.connectTimer.unref?.();
    }
  }

  /** The engine connected: give it everything VS Code has set, then let the computer start. */
  private async connected(hello: EngineEvent): Promise<void> {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.computer =
      typeof hello["computer"] === "number" ? hello["computer"] : 0;
    this.running = false;
    const link = this.link;
    if (!link) return;
    try {
      // `entry` is how the engine knows the program: to stop on its first line, and to say when it has ended
      await link.request("configure", {
        stepIntoRom: this.args.stepIntoRom === true,
        entry: this.located?.program ?? "",
        stopOnEntry: this.args.stopOnEntry === true,
      });
      for (const [path, list] of this.breakpoints)
        await link.request("setBreakpoints", { path, breakpoints: list });
      await link.request("setErrorMode", { mode: this.errorMode });
      await this.maybeRun();
    } catch {
      // the engine went away again: onClose ends the session
    }
  }

  /** The computer boots once VS Code has sent all its breakpoints and the engine has them. */
  private async maybeRun(): Promise<void> {
    if (!this.configurationDone || this.running || !this.link?.connected)
      return;
    this.running = true;
    await this.link.request("run");
  }

  private async end(stopComputer: boolean): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.setReady();
    if (this.connectTimer) clearTimeout(this.connectTimer);
    const link = this.link;
    if (link?.connected && !stopComputer)
      await link.request("detach").catch(() => undefined);
    link?.close();
    this.link = undefined;
    this.stop = undefined;
    if (stopComputer)
      await Promise.resolve(this.launched?.dispose()).catch(() => undefined);
    this.event("terminated");
  }

  /** VS Code closed the session without saying so (the window went away). */
  dispose(): void {
    void this.end(true);
  }

  // ------------------------------------------------------------------------------------------------------------
  // Breakpoints

  private async setBreakpoints(
    request: DapMessage,
    args: Record<string, unknown>,
  ): Promise<void> {
    await this.ready;
    const source = (args["source"] ?? {}) as {
      path?: string;
      sourceReference?: number;
    };
    const wanted = (
      Array.isArray(args["breakpoints"]) ? args["breakpoints"] : []
    ) as DapBreakpoint[];
    let path: string | undefined;
    if (source.sourceReference)
      path = this.sourcePaths.get(source.sourceReference);
    else if (source.path && this.located)
      path = toComputerPath(source.path, this.located.root);
    if (!path) {
      const message = this.located
        ? `This file is not on the computer: it is outside ${this.located.root}.`
        : "No program is being debugged.";
      this.respond(request, {
        breakpoints: wanted.map(() => ({ verified: false, message })),
      });
      return;
    }
    const forEngine: EngineBreakpoint[] = [];
    const answers = wanted.map((b) => {
      const id = this.nextBreakpointId++;
      const out: EngineBreakpoint = { id, line: b.line };
      if (b.condition?.trim()) out.condition = b.condition;
      if (b.hitCondition?.trim()) {
        const hit = parseHitCondition(b.hitCondition);
        if (!hit)
          return {
            id,
            verified: false,
            line: b.line,
            message:
              'A hit count is a number, optionally after >=, >, == or %: "5", "> 5", "% 2".',
          };
        out.hitOp = hit.hitOp;
        out.hitN = hit.hitN;
      }
      if (b.logMessage) out.log = logExpression(b.logMessage);
      forEngine.push(out);
      return { id, verified: true, line: b.line };
    });
    if (forEngine.length) this.breakpoints.set(path, forEngine);
    else this.breakpoints.delete(path);
    if (this.link?.connected)
      await this.link.request("setBreakpoints", {
        path,
        breakpoints: forEngine,
      });
    this.respond(request, { breakpoints: answers });
  }

  // ------------------------------------------------------------------------------------------------------------
  // The engine's side

  private engineEvent(event: EngineEvent): void {
    switch (event.event) {
      case "stopped": {
        const reason =
          typeof event["reason"] === "string" ? event["reason"] : "pause";
        const text = typeof event["text"] === "string" ? event["text"] : "";
        this.stop = { reason, text, handles: new Map() };
        this.nextHandle = 1;
        const ids = Array.isArray(event["breakpoints"])
          ? event["breakpoints"]
          : [];
        this.event("stopped", {
          reason,
          threadId: THREAD_ID,
          allThreadsStopped: true,
          ...(reason === "exception" && {
            description: "Paused on error",
            text,
          }),
          ...(ids.length > 0 && { hitBreakpointIds: ids }),
        });
        return;
      }
      case "continued":
        this.stop = undefined;
        return;
      case "started":
        // the computer (re)booted: nothing of the old Lua state is left
        this.stop = undefined;
        return;
      case "ended":
        // The program returned or failed and the shell has its prompt back: the session is over. The computer stays
        // as it is, with what the program left on its screen, for as long as its panel is open.
        void this.end(false);
        return;
      case "output": {
        const path = typeof event["path"] === "string" ? event["path"] : "";
        const source = path ? this.sourceFor(path, true) : undefined;
        this.event("output", {
          category: event["category"] === "stderr" ? "stderr" : "console",
          output: String(event["text"] ?? ""),
          ...(source && { source, line: Number(event["line"]) || 1 }),
        });
        return;
      }
      default:
        return;
    }
  }

  private async resume(
    cmd: "continue" | "next" | "stepIn" | "stepOut",
  ): Promise<void> {
    this.stopped();
    this.stop = undefined;
    await this.engine().request(cmd);
  }

  // ------------------------------------------------------------------------------------------------------------
  // Stack

  /** How VS Code should show where a frame's code is. Project files open as themselves; the ROM by reference. */
  private sourceFor(
    path: string,
    user: boolean,
  ): Record<string, unknown> | undefined {
    if (!path.startsWith("/")) return undefined; // the BIOS and the boot script are no files of the computer
    const file = this.located ? toHostPath(path, this.located.root) : undefined;
    if (file && user && (this.host.exists ?? existsSync)(file))
      return { name: baseName(path), path: file };
    let ref = this.sourceRefs.get(path);
    if (!ref) {
      ref = this.sourceRefs.size + 1;
      this.sourceRefs.set(path, ref);
      this.sourcePaths.set(ref, path);
    }
    return {
      name: path,
      sourceReference: ref,
      origin: "on the computer",
      presentationHint: user ? "normal" : "deemphasize",
    };
  }

  /** The whole stack of this stop, asked for once. An error's stop leaves out the `error` call on top. */
  private frames(stop: Stop): Promise<EngineFrame[]> {
    stop.frames ??= this.engine()
      .request("stack")
      .then((reply) => {
        let frames = (reply["frames"] ?? []) as EngineFrame[];
        if (stop.reason === "exception") {
          const firstLua = frames.findIndex((f) => f.what !== "C");
          if (firstLua > 0) frames = frames.slice(firstLua);
        }
        return frames;
      });
    return stop.frames;
  }

  private async stackTrace(
    request: DapMessage,
    args: Record<string, unknown>,
  ): Promise<void> {
    const frames = await this.frames(this.stopped());
    const start = Number(args["startFrame"]) || 0;
    const levels = Number(args["levels"]) || frames.length;
    this.respond(request, {
      totalFrames: frames.length,
      stackFrames: frames.slice(start, start + levels).map((f) => {
        const source = this.sourceFor(f.path, f.user);
        const where = !source && f.path ? ` (${f.path}:${f.line})` : "";
        return {
          id: f.i + 1,
          name: frameName(f) + where,
          line: source && f.line > 0 ? f.line : 0,
          column: source ? 1 : 0,
          ...(source && { source }),
          ...(!f.user && { presentationHint: "subtle" }),
        };
      }),
    });
  }

  /** The engine's frame number for a DAP frame id; with none, the frame on top. */
  private async frameOf(id: unknown): Promise<number> {
    if (typeof id === "number" && id > 0) return id - 1;
    const frames = await this.frames(this.stopped());
    return frames[0]?.i ?? 0;
  }

  // ------------------------------------------------------------------------------------------------------------
  // Variables

  private handleFor(handle: Handle): number {
    const id = this.nextHandle++;
    this.stopped().handles.set(id, handle);
    return id;
  }

  private async scopes(
    request: DapMessage,
    args: Record<string, unknown>,
  ): Promise<void> {
    this.stopped();
    const frame = await this.frameOf(args["frameId"]);
    this.respond(request, {
      scopes: [
        {
          name: "Locals",
          presentationHint: "locals",
          variablesReference: this.handleFor({ kind: "locals", frame }),
          expensive: false,
        },
        {
          name: "Upvalues",
          variablesReference: this.handleFor({ kind: "upvalues", frame }),
          expensive: false,
        },
        {
          name: "Globals",
          variablesReference: this.handleFor({ kind: "globals", frame }),
          expensive: true,
        },
      ],
    });
  }

  private toDap(
    v: EngineVariable,
    frame: number,
    expression: string | undefined,
  ): Record<string, unknown> {
    return {
      name: v.name,
      value: v.value,
      type: v.type,
      variablesReference: v.ref
        ? this.handleFor({
            kind: "table",
            ref: v.ref,
            frame,
            ...(expression && { expression }),
          })
        : 0,
      ...(expression && { evaluateName: expression }),
    };
  }

  /** The expression that reads a variable of a scope or an entry of a table, when there is one. */
  private expressionIn(handle: Handle, v: EngineVariable): string | undefined {
    if (!v.ek) return undefined;
    if (handle.kind === "table")
      return handle.expression
        ? childExpression(handle.expression, v.name)
        : undefined;
    // _ENV in an evaluated expression is the frame's environment, so a global with an odd name is _ENV["odd name"]
    return v.name.startsWith("[") ? `_ENV${v.name}` : v.name;
  }

  private async variables(
    request: DapMessage,
    args: Record<string, unknown>,
  ): Promise<void> {
    const stop = this.stopped();
    const handle = stop.handles.get(Number(args["variablesReference"]));
    if (!handle) {
      this.respond(request, { variables: [] });
      return;
    }
    const reply: EngineReply =
      handle.kind === "table"
        ? await this.engine().request("children", { ref: handle.ref })
        : await this.engine().request(handle.kind, { frame: handle.frame });
    let list = (reply["variables"] ?? []) as EngineVariable[];
    if (handle.kind !== "locals" && handle.kind !== "upvalues")
      list = sortEntries(list);
    const variables = list.map((v) =>
      this.toDap(v, handle.frame, this.expressionIn(handle, v)),
    );
    if (reply["more"] === true)
      variables.push({
        name: "...",
        value: "more entries than are shown",
        type: "",
        variablesReference: 0,
      });
    this.respond(request, { variables });
  }

  private async setVariable(
    request: DapMessage,
    args: Record<string, unknown>,
  ): Promise<void> {
    const stop = this.stopped();
    const handle = stop.handles.get(Number(args["variablesReference"]));
    const name = String(args["name"] ?? "");
    const target =
      handle &&
      this.expressionIn(handle, { name, value: "", type: "", ek: true });
    if (!handle || !target || name.startsWith("("))
      throw new UserError("This one cannot be changed from here.");
    await this.engine().request("eval", {
      frame: handle.frame,
      expr: `${target} = ${String(args["value"] ?? "nil")}`,
    });
    const now = await this.engine().request("eval", {
      frame: handle.frame,
      expr: target,
    });
    this.respond(request, {
      value: String(now["value"] ?? "nil"),
      type: String(now["type"] ?? ""),
      variablesReference:
        typeof now["ref"] === "number"
          ? this.handleFor({
              kind: "table",
              ref: now["ref"],
              frame: handle.frame,
              expression: target,
            })
          : 0,
    });
  }

  private async evaluate(
    request: DapMessage,
    args: Record<string, unknown>,
  ): Promise<void> {
    const expression = String(args["expression"] ?? "");
    if (!this.stop) {
      throw new UserError(
        args["context"] === "repl"
          ? "The program is running: pause it or stop at a breakpoint to evaluate."
          : "not available while the program runs",
      );
    }
    const frame = await this.frameOf(args["frameId"]);
    const reply = await this.engine().request("eval", {
      frame,
      expr: expression,
    });
    this.respond(request, {
      // a statement (x = 5) gives nothing back
      result: reply["none"] === true ? "" : String(reply["value"] ?? "nil"),
      type: String(reply["type"] ?? ""),
      variablesReference:
        typeof reply["ref"] === "number"
          ? this.handleFor({
              kind: "table",
              ref: reply["ref"],
              frame,
              expression: `(${expression})`,
            })
          : 0,
    });
  }

  /** The text of a file that is on the computer but not in the project (the ROM), read through the computer's fs. */
  private async source(
    request: DapMessage,
    args: Record<string, unknown>,
  ): Promise<void> {
    const source = (args["source"] ?? {}) as { sourceReference?: number };
    const ref = Number(args["sourceReference"]) || source.sourceReference || 0;
    const path = this.sourcePaths.get(ref);
    if (!path) throw new UserError("No such source.");
    let text = this.sourceText.get(path);
    if (text === undefined) {
      this.stopped();
      const reply = await this.engine().request("eval", {
        frame: await this.frameOf(undefined),
        raw: true,
        expr: `(function() local h = fs.open(${luaQuote(path)}, "r") if not h then return nil end local s = h.readAll() h.close() return s end)()`,
      });
      if (typeof reply["text"] !== "string")
        throw new UserError(`${path} could not be read from the computer.`);
      text = reply["text"];
      this.sourceText.set(path, text);
    }
    this.respond(request, { content: text, mimeType: "text/x-lua" });
  }
}
