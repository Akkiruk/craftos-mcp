// Keeps `craftos-mcp serve` alive behind one stdio connection. VS Code talks to this process; it starts the real
// server as a child and passes every line through. When the child dies, VS Code never sees the server go away, so
// the chat keeps its tools: the child starts again, gets the client's initialize replayed, and the calls that were in
// flight get an error saying to try again. No vscode import, so the tests run it in plain Node.
import type { ChildProcess } from "node:child_process";
import {
  type SpawnOptions,
  fallbackFor,
  killTree,
  missingVersion,
  spawnCommand,
} from "./launcher.ts";

export type SupervisorEvent =
  | { type: "started"; pid: number | undefined; command: string[] }
  | {
      type: "crashed";
      code: number | null;
      signal: string | null;
      restarts: number;
    }
  | { type: "fallback"; command: string[] }
  | { type: "gave-up"; restarts: number; stderr: string }
  | { type: "stopped" }
  /** What the server wrote to stderr (sent by supervisor.ts, not Supervisor itself). */
  | { type: "log"; text: string };

export interface SuperviseOptions {
  /** craftos-mcp as a command and its arguments, and the subcommand (["serve"]). */
  base: string[];
  sub: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Where the client's lines go. */
  write: (line: string) => void;
  log?: (text: string) => void;
  events?: (event: SupervisorEvent) => void;
  /** Restarts allowed inside windowMs before giving up (default 3 in 2 minutes). */
  maxRestarts?: number;
  windowMs?: number;
  /** Wait before a restart, so a crash loop does not spin (default 500 ms). */
  delayMs?: number;
  spawn?: (
    base: readonly string[],
    sub: readonly string[],
    options: SpawnOptions,
  ) => ChildProcess;
}

interface Message {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

const INTERNAL_ERROR = -32603;

export class Supervisor {
  private child: ChildProcess | undefined;
  private base: string[];
  /** The client's initialize request, replayed to every new child. */
  private initialize: Message | undefined;
  private clientInitialized = false;
  /** The id of a replayed initialize the new child has not answered yet: client lines wait in `queue` until then. */
  private replaying: string | undefined;
  private replays = 0;
  private readonly queue: string[] = [];
  /** Client requests the current child has not answered, by JSON id. */
  private readonly pending = new Map<string, Message>();
  private crashes: number[] = [];
  private stopping = false;
  private restartAsked = false;
  private gaveUp = false;
  private stderrTail = "";
  private sawStdout = false;
  private restartTimer: NodeJS.Timeout | undefined;

  private readonly options: SuperviseOptions;

  constructor(options: SuperviseOptions) {
    this.options = options;
    this.base = [...options.base];
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get givenUp(): boolean {
    return this.gaveUp;
  }

  start(): void {
    if (this.stopping) return;
    this.restartTimer = undefined;
    this.sawStdout = false;
    this.stderrTail = "";
    const spawn = this.options.spawn ?? spawnCommand;
    const child = spawn(this.base, this.options.sub, {
      cwd: this.options.cwd,
      env: this.options.env,
    });
    this.child = child;
    child.stdin?.on("error", () => {
      // the child died mid-write: its exit handler restarts it
    });
    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      if (child !== this.child) return;
      this.sawStdout = true;
      buffer += chunk.toString();
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (line.trim()) this.fromChild(line);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      this.options.log?.(text);
      this.stderrTail = (this.stderrTail + text).slice(-4000);
    });
    child.on("error", (error) => {
      this.stderrTail += `\n${error.message}`;
    });
    child.on("exit", (code, signal) => this.exited(child, code, signal));
    this.options.events?.({
      type: "started",
      pid: child.pid,
      command: [...this.base, ...this.options.sub],
    });
    if (
      this.initialize &&
      !this.pending.has(JSON.stringify(this.initialize.id))
    ) {
      // a new child after a crash: initialize it the way the client did, then let the client's lines through
      this.replaying = `craftos-supervisor-${++this.replays}`;
      this.toChild(JSON.stringify({ ...this.initialize, id: this.replaying }));
    } else this.flush();
  }

  /** A line from the client (VS Code). */
  fromClient(line: string): void {
    let msg: Message | undefined;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        msg = parsed as Message;
    } catch {
      // not JSON: the server answers it with a parse error
    }
    const isRequest = msg?.method !== undefined && msg.id !== undefined;
    if (this.gaveUp) {
      if (isRequest) this.answerError(msg!, this.gaveUpMessage());
      return;
    }
    if (msg?.method === "initialize" && isRequest) this.initialize = msg;
    if (msg?.method === "notifications/initialized")
      this.clientInitialized = true;
    if (isRequest) this.pending.set(JSON.stringify(msg!.id), msg!);
    if (!this.child || this.replaying) this.queue.push(line);
    else this.toChild(line);
  }

  /** Stop for good (the client closed stdin): kill the child and everything it started. */
  stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.child) killTree(this.child);
    this.options.events?.({ type: "stopped" });
  }

  /** Start over after giving up, or kill and start a stuck child: the restart count starts from zero. */
  restart(): void {
    if (this.stopping) return;
    this.crashes = [];
    this.gaveUp = false;
    if (
      this.child &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    ) {
      this.restartAsked = true;
      killTree(this.child);
      return;
    }
    if (!this.restartTimer) this.start();
  }

  private fromChild(line: string): void {
    let msg: Message | undefined;
    try {
      msg = JSON.parse(line) as Message;
    } catch {
      // not JSON: pass it on as it is
    }
    const isResponse =
      msg &&
      typeof msg === "object" &&
      msg.method === undefined &&
      msg.id !== undefined;
    if (
      isResponse &&
      this.replaying !== undefined &&
      msg!.id === this.replaying
    ) {
      this.replaying = undefined;
      if (this.clientInitialized)
        this.toChild(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/initialized",
          }),
        );
      this.flush();
      return;
    }
    if (isResponse) this.pending.delete(JSON.stringify(msg!.id));
    this.options.write(line);
  }

  private flush(): void {
    while (this.queue.length && this.child && !this.replaying)
      this.toChild(this.queue.shift()!);
  }

  private toChild(line: string): void {
    this.child?.stdin?.write(`${line}\n`);
  }

  private answerError(msg: Message, message: string): void {
    this.pending.delete(JSON.stringify(msg.id));
    this.options.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: INTERNAL_ERROR, message },
      }),
    );
  }

  private gaveUpMessage(): string {
    const last = this.stderrTail.trim().split(/\r?\n/).slice(-3).join(" | ");
    return (
      `craftos-mcp stopped ${this.crashes.length + 1} times in ${Math.round(this.windowMs() / 60000)} minutes, so it is not ` +
      `being restarted${last ? ` (last output: ${last})` : ""}. Click Restart on the craftos-mcp notification in VS Code, ` +
      `or run MCP: List Servers > craftos-mcp > Restart.`
    );
  }

  private windowMs(): number {
    return this.options.windowMs ?? 2 * 60 * 1000;
  }

  private exited(
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (child !== this.child) return;
    this.child = undefined;
    this.replaying = undefined;
    if (this.stopping) return;

    // the pinned version is not on npm yet: use the one before it, without counting a crash
    const fallback = fallbackFor(this.base);
    if (!this.sawStdout && fallback && missingVersion(this.stderrTail)) {
      this.base = fallback;
      this.options.log?.(
        `craftos-mcp: that version is not on npm, starting ${fallback.join(" ")} instead\n`,
      );
      this.options.events?.({ type: "fallback", command: fallback });
      // npx never got as far as the server: everything it was sent goes to the next one, in order
      const sent = [...this.pending.values()]
        .filter((msg) => !this.queue.some((l) => sameRequest(l, msg)))
        .map((msg) => JSON.stringify(msg));
      this.queue.unshift(...sent);
      this.start();
      return;
    }

    const why = this.restartAsked
      ? "craftos-mcp was restarted while answering this. Try the call again."
      : `craftos-mcp stopped while answering this (exit code ${code ?? signal}). It is starting again: try the call once more.`;
    // calls the dead child had taken get their error now; calls still queued go to the next child
    // (an unanswered initialize is sent to the next child as it is, so the client never sees it fail)
    for (const msg of [...this.pending.values()]) {
      if (this.queue.some((l) => sameRequest(l, msg))) continue;
      if (msg === this.initialize) this.queue.unshift(JSON.stringify(msg));
      else this.answerError(msg, why);
    }
    if (this.restartAsked) {
      this.restartAsked = false;
      this.start();
      return;
    }

    const now = Date.now();
    this.crashes = this.crashes.filter((t) => now - t < this.windowMs());
    const max = this.options.maxRestarts ?? 3;
    if (this.crashes.length >= max) {
      this.gaveUp = true;
      for (const line of this.queue.splice(0)) {
        const msg = parse(line);
        if (msg?.method !== undefined && msg.id !== undefined)
          this.answerError(msg, this.gaveUpMessage());
      }
      this.options.events?.({
        type: "gave-up",
        restarts: this.crashes.length,
        stderr: this.stderrTail,
      });
      return;
    }
    this.crashes.push(now);
    this.options.events?.({
      type: "crashed",
      code,
      signal,
      restarts: this.crashes.length,
    });
    this.restartTimer = setTimeout(
      () => this.start(),
      this.options.delayMs ?? 500,
    );
  }
}

function parse(line: string): Message | undefined {
  try {
    return JSON.parse(line) as Message;
  } catch {
    return undefined;
  }
}

function sameRequest(line: string, msg: Message): boolean {
  const m = parse(line);
  return (
    m?.method !== undefined && JSON.stringify(m.id) === JSON.stringify(msg.id)
  );
}
