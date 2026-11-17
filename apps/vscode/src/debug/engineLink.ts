// The debugger's line to the engine. The adapter listens on 127.0.0.1 and hands the port and a token to whatever
// starts the computer; the engine connects (--debug-connect), says hello with the token, and from then on both
// sides speak JSON, one object a line: requests {"seq","cmd",...} answered by {"seq","ok",...}, and events
// {"event":...} from the engine (engine/src/debug_server.hpp). No vscode import: the tests use it in plain Node.
import { randomBytes } from "node:crypto";
import { type Server, type Socket, createServer } from "node:net";

/** What the engine says on its own: hello, started, stopped, continued, output, exited. */
export interface EngineEvent {
  readonly event: string;
  readonly [key: string]: unknown;
}

/** An engine's answer: `ok` false comes with `error`. */
export interface EngineReply {
  readonly ok: boolean;
  readonly error?: string;
  readonly [key: string]: unknown;
}

/** The part of the link the debug session uses, so a test can stand in for the engine. */
export interface Link {
  readonly port: number;
  readonly token: string;
  readonly connected: boolean;
  /** Ask the engine something. Rejects when it says no, or when it is not (or no longer) connected. */
  request(cmd: string, args?: Record<string, unknown>): Promise<EngineReply>;
  onEvent(listener: (event: EngineEvent) => void): void;
  /** The engine connected and said hello with the right token. */
  onConnect(listener: (hello: EngineEvent) => void): void;
  /** The engine's connection ended (the computer shut down, or its process was stopped). */
  onClose(listener: () => void): void;
  close(): void;
}

export class EngineLink implements Link {
  readonly token = randomBytes(24).toString("base64url");
  private socket: Socket | undefined;
  private seq = 0;
  private readonly waiting = new Map<
    number,
    { resolve: (r: EngineReply) => void; reject: (e: Error) => void }
  >();
  private readonly eventListeners: ((e: EngineEvent) => void)[] = [];
  private readonly connectListeners: ((e: EngineEvent) => void)[] = [];
  private readonly closeListeners: (() => void)[] = [];

  private readonly server: Server;
  readonly port: number;

  // no parameter properties: the unit tests load this file with Node's type stripping
  private constructor(server: Server, port: number) {
    this.server = server;
    this.port = port;
  }

  /** Listen on a free port of 127.0.0.1. */
  static listen(): Promise<EngineLink> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close();
          return reject(new Error("could not open a port for the debugger"));
        }
        const link = new EngineLink(server, address.port);
        server.on("connection", (socket) => link.accept(socket));
        resolve(link);
      });
    });
  }

  get connected(): boolean {
    return this.socket !== undefined;
  }

  /** One engine at a time. Whoever connects must say hello with the token first, or the line is cut. */
  private accept(socket: Socket): void {
    let buffer = "";
    let greeted = false;
    socket.setNoDelay(true);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let at: number;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (!line.trim()) continue;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (!greeted) {
          if (
            message["event"] !== "hello" ||
            message["token"] !== this.token ||
            this.socket
          ) {
            socket.destroy();
            return;
          }
          greeted = true;
          this.socket = socket;
          for (const l of this.connectListeners) l(message as EngineEvent);
          continue;
        }
        if (typeof message["event"] === "string") {
          for (const l of this.eventListeners) l(message as EngineEvent);
        } else if (typeof message["seq"] === "number") {
          const waiter = this.waiting.get(message["seq"]);
          this.waiting.delete(message["seq"]);
          if (!waiter) continue;
          if (message["ok"] === true) waiter.resolve(message as EngineReply);
          else
            waiter.reject(
              new Error(
                typeof message["error"] === "string"
                  ? message["error"]
                  : "the engine refused",
              ),
            );
        }
      }
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      for (const waiter of this.waiting.values())
        waiter.reject(new Error("the computer stopped"));
      this.waiting.clear();
      for (const l of this.closeListeners) l();
    });
  }

  request(
    cmd: string,
    args: Record<string, unknown> = {},
  ): Promise<EngineReply> {
    const socket = this.socket;
    if (!socket)
      return Promise.reject(new Error("the computer is not connected"));
    const seq = ++this.seq;
    return new Promise((resolve, reject) => {
      this.waiting.set(seq, { resolve, reject });
      socket.write(`${JSON.stringify({ ...args, seq, cmd })}\n`);
    });
  }

  onEvent(listener: (event: EngineEvent) => void): void {
    this.eventListeners.push(listener);
  }

  onConnect(listener: (hello: EngineEvent) => void): void {
    this.connectListeners.push(listener);
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  close(): void {
    this.server.close();
    this.socket?.destroy();
  }
}
