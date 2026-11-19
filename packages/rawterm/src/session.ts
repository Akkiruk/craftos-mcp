import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  FeatureBit,
  type EventValue,
  type MouseKind,
  type ServerFrame,
  type TerminalFrame,
} from "./packets.js";
import {
  decodeServerPacket,
  encodeEvent,
  encodeFeatures,
  encodeMouse,
  encodeWindowClose,
} from "./packets.js";
import { FrameParser, encodeFrame } from "./framing.js";
import { type KeyName, Keys, keyCode } from "./keys.js";

export interface SessionOptions {
  readonly executable: string;
  /** Extra CLI flags, e.g. --rom, --directory, --mount-ro, --script. */
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** An engine crash, from the line the engine writes to stderr as it goes (engine/src/crashreport.hpp). */
export interface EngineCrash {
  /** What happened, e.g. "access violation (0xC0000005) at craftos.exe+0x1049d" */
  readonly reason: string;
  /** The crash report (a text file; a .dmp minidump sits beside it on Windows) */
  readonly report: string;
}

const CRASH_LINE = /^engine crashed: (.*); report at (.*)$/m;

/** The engine's crash in its stderr, if it crashed. */
export function parseEngineCrash(stderr: string): EngineCrash | undefined {
  const m = CRASH_LINE.exec(stderr);
  return m ? { reason: m[1]!.trim(), report: m[2]!.trim() } : undefined;
}

/** How a computer in a shared engine (pool.ts) sends its packets: the pool puts them in its envelope. */
export interface SessionTransport {
  /** One packet as a process of its own would get it (window ids the computer's own). */
  write(payload: Uint8Array): void;
  /** Stop the computer now, as killing its process would (stop() after its grace). */
  kill(): void;
}

export interface PooledSessionOptions {
  readonly transport: SessionTransport;
  /** The feature flags the shared engine agreed to. */
  readonly serverFlags: number;
}

export interface WindowState {
  readonly id: number;
  /** Computer id for the main terminal; undefined for monitors. */
  readonly computerId: number | undefined;
  readonly title: string;
  readonly isMonitor: boolean;
  /** Peripheral name (for example "top") when this window is a monitor. */
  readonly peripheral: string | undefined;
  frame: TerminalFrame | undefined;
  /** Incremented every time a terminal frame arrives. */
  version: number;
}

const MONITOR_TITLE = /Monitor (.+)$/;

/** The engine reports no computer id for monitors, but titles them "... Monitor <name>". */
function monitorName(title: string): string | undefined {
  return MONITOR_TITLE.exec(title)?.[1];
}

export interface ScreenText {
  readonly width: number;
  readonly height: number;
  readonly lines: string[];
  readonly cursor: { x: number; y: number };
}

export interface ExitInfo {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** Convert a text-mode frame to plain lines. */
export function frameToText(frame: TerminalFrame): ScreenText {
  const lines: string[] = [];
  for (let y = 0; y < frame.height; y++) {
    const row = frame.text.subarray(y * frame.width, (y + 1) * frame.width);
    lines.push(Buffer.from(row).toString("latin1").replace(/\s+$/, ""));
  }
  return {
    width: frame.width,
    height: frame.height,
    lines,
    cursor: { x: frame.cursorX, y: frame.cursorY },
  };
}

/**
 * One engine process speaking the CraftOS-PC raw protocol. Window 0 is
 * normally the computer's terminal; every monitor gets its own window.
 */
export class RawSession extends EventEmitter<{
  frame: [ServerFrame];
  /** Every packet as the engine sent it, after `frame`: what a raw client (craftos --raw-client) draws. */
  payload: [Uint8Array];
  exit: [ExitInfo];
  stderr: [string];
  /** What the computer's ccsim layer told the host (HostFrame: M lines for other computers, B beacon, T trace). */
  host: [kind: string, text: string];
}> {
  readonly windows = new Map<number, WindowState>();
  /** Windows the engine has closed (kept so final screens survive shutdown). */
  readonly closedWindows: WindowState[] = [];
  readonly messages: { title: string; message: string }[] = [];
  exitInfo: ExitInfo | undefined;
  /** The newest input-wait beacon the computer sent over the host channel (what waiting.json would hold). */
  hostBeacon: string | undefined;

  private readonly child: ChildProcessWithoutNullStreams | undefined;
  /** Set for a computer in a shared engine (pool.ts): packets go through it instead of a process of its own. */
  private readonly transport: SessionTransport | undefined;
  private readonly parser = new FrameParser({ binaryCrc: false });
  private serverFlags = 0;
  private readonly clientFlags = FeatureBit.WindowsOnHandshake;

  constructor(options: SessionOptions | PooledSessionOptions) {
    super();
    if ("transport" in options) {
      // one computer of a shared engine (pool.ts): the pool reads the engine and hands this session its packets
      this.child = undefined;
      this.transport = options.transport;
      this.serverFlags = options.serverFlags;
      return;
    }
    this.transport = undefined;
    const child = spawn(
      options.executable,
      ["--raw", ...(options.args ?? [])],
      {
        cwd: options.cwd,
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    child.stderr.on("data", (chunk: Buffer) =>
      this.emit("stderr", chunk.toString()),
    );
    child.stdin.on("error", () => undefined);
    // the engine could not start (missing, not executable, blocked by antivirus): an exit with the reason on stderr,
    // never an unhandled error that takes the whole process down
    child.on("error", (error: NodeJS.ErrnoException) => {
      this.emit(
        "stderr",
        `could not start the engine ${options.executable}: ${error.code ?? error.message}\n`,
      );
      if (this.exitInfo !== undefined) return;
      this.exitInfo = { code: null, signal: null };
      this.emit("exit", this.exitInfo);
    });
    // "exit" can come before the last of stdout has been read: the frames the engine drew just before it stopped. Say
    // it has exited once the pipe is drained ("close"), so a caller reading the screens then sees them all. A pipe
    // that some other process holds open never closes, so that wait has a generous limit.
    this.child = child;
    child.on("exit", (code, signal) => {
      if (this.exitInfo !== undefined) return;
      const info = { code, signal };
      const done = (): void => {
        clearTimeout(limit);
        if (this.exitInfo !== undefined) return;
        this.exitInfo = info;
        this.emit("exit", info);
      };
      const limit = setTimeout(done, 5000);
      if (child.stdout.readableEnded) done();
      else child.once("close", done);
    });
    this.sendPayload(encodeFeatures(this.clientFlags));
  }

  /** Pool side (pool.ts): one packet the engine sent about this computer, window ids already its own. */
  receivePooled(payload: Uint8Array): void {
    if (this.exitInfo) return;
    const frame = decodeServerPacket(payload);
    this.track(frame, payload);
  }

  /** Pool side: the computer is gone (its exit packet), or its engine is. */
  exitPooled(info: ExitInfo): void {
    if (this.exitInfo !== undefined) return;
    this.exitInfo = info;
    this.emit("exit", info);
  }

  /** Pool side: what the shared engine wrote to stderr, given to the computers it concerns. */
  stderrPooled(text: string): void {
    this.emit("stderr", text);
  }

  get running(): boolean {
    return this.exitInfo === undefined;
  }

  get features(): number {
    return this.serverFlags & this.clientFlags;
  }

  private sendPayload(payload: Uint8Array): void {
    if (!this.running) return;
    if (this.transport) {
      this.transport.write(payload);
      return;
    }
    if (!this.child || this.child.stdin.destroyed) return;
    this.child.stdin.write(encodeFrame(payload, { binaryCrc: false }));
  }

  /**
   * Send a packet as it is, already encoded (a raw client's key, mouse or window packet). Its window byte must be one
   * of this engine's windows.
   */
  sendRaw(payload: Uint8Array): void {
    this.sendPayload(payload);
  }

  /** Each open window's last announcement and last screen, as the engine sent them (replayPayloads). */
  private readonly lastPackets = new Map<
    number,
    { window?: Uint8Array; terminal?: Uint8Array }
  >();

  /**
   * The packets that draw every open window as it is now: its announcement, then its last screen. A raw client that
   * starts watching late gets these first.
   */
  replayPayloads(): Uint8Array[] {
    return [...this.lastPackets.values()].flatMap((p) =>
      p.window ? [p.window, ...(p.terminal ? [p.terminal] : [])] : [],
    );
  }

  private onData(chunk: Buffer): void {
    for (const payload of this.parser.push(chunk)) {
      this.track(decodeServerPacket(payload), payload);
    }
  }

  private track(frame: ServerFrame, payload: Uint8Array): void {
    if (frame.type === "host") {
      // the host's own channel: not a screen, and not for raw clients watching
      if (frame.kind === "B") this.hostBeacon = frame.text;
      this.emit("host", frame.kind, frame.text);
      return;
    }
    {
      this.apply(frame);
      if (frame.type === "window") {
        if (frame.closing === 0)
          this.lastPackets.set(frame.window, {
            ...this.lastPackets.get(frame.window),
            window: payload,
          });
        else this.lastPackets.delete(frame.window);
      } else if (frame.type === "terminal") {
        this.lastPackets.set(frame.window, {
          ...this.lastPackets.get(frame.window),
          terminal: payload,
        });
      }
      this.emit("frame", frame);
      this.emit("payload", payload);
    }
  }

  private apply(frame: ServerFrame): void {
    switch (frame.type) {
      case "window":
        if (frame.closing === 0) {
          const existing = this.windows.get(frame.window);
          this.windows.set(frame.window, {
            id: frame.window,
            computerId: frame.computerId,
            title: frame.title,
            isMonitor: monitorName(frame.title) !== undefined,
            peripheral: monitorName(frame.title),
            frame: existing?.frame,
            version: existing?.version ?? 0,
          });
        } else if (frame.closing === 1) {
          const closing = this.windows.get(frame.window);
          if (closing?.frame) this.closedWindows.push(closing);
          this.windows.delete(frame.window);
        } else {
          // The engine announced quit but keeps its process alive until stdin closes.
          if (this.child) this.child.stdin.end();
        }
        break;
      case "terminal": {
        let state = this.windows.get(frame.window);
        if (!state) {
          // Servers that skip window announcements: infer the window.
          state = {
            id: frame.window,
            computerId: undefined,
            title: "",
            isMonitor: frame.window !== 0,
            peripheral: undefined,
            frame: undefined,
            version: 0,
          };
          this.windows.set(frame.window, state);
        }
        state.frame = frame;
        state.version++;
        break;
      }
      case "message":
        this.messages.push({ title: frame.title, message: frame.message });
        break;
      case "features":
        this.serverFlags = frame.flags;
        break;
      default:
        break;
    }
  }

  /** Open and already-closed windows, in creation order. */
  allWindows(): WindowState[] {
    return [...this.closedWindows, ...this.windows.values()];
  }

  /** Text of the main terminal (window 0) or any monitor window. */
  screen(window = 0): ScreenText | undefined {
    const frame = this.windows.get(window)?.frame;
    return frame && frame.mode === 0 ? frameToText(frame) : undefined;
  }

  /** Resolve once `predicate` is true for some frame-update, or reject on timeout/exit. */
  waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    if (predicate()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        this.off("frame", check);
        this.off("exit", onExit);
      };
      const check = (): void => {
        if (predicate()) {
          cleanup();
          resolve();
        }
      };
      const onExit = (): void => {
        cleanup();
        predicate()
          ? resolve()
          : reject(new Error("engine exited before condition was met"));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.on("frame", check);
      this.on("exit", onExit);
    });
  }

  waitForText(text: string, window = 0, timeoutMs = 5000): Promise<void> {
    return this.waitFor(
      () => this.screen(window)?.lines.some((l) => l.includes(text)) ?? false,
      timeoutMs,
    );
  }

  waitForExit(timeoutMs = 10000): Promise<ExitInfo> {
    if (this.exitInfo) return Promise.resolve(this.exitInfo);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`engine still running after ${timeoutMs}ms`)),
        timeoutMs,
      );
      this.once("exit", (info) => {
        clearTimeout(timer);
        resolve(info);
      });
    });
  }

  /**
   * Press (or release) a key by sending the `key` / `key_up` event directly.
   * The raw protocol's Type 1 key id is a single byte and cannot carry the
   * 1.101.3 GLFW codes, so we inject the Lua events ourselves.
   */
  key(
    key: KeyName | number,
    options: { up?: boolean; held?: boolean } = {},
  ): void {
    if (options.up) this.event("key_up", keyCode(key));
    else this.event("key", keyCode(key), options.held ?? false);
  }

  /** Press and release a key. */
  tap(key: KeyName | number): void {
    this.key(key);
    this.key(key, { up: true });
  }

  /**
   * Type text as `char` events. These go through the same engine queue as
   * `key` events, so their relative order is preserved (Type 1 packets use a
   * separate queue and can overtake them).
   */
  char(text: string): void {
    for (const ch of text) this.event("char", ch);
  }

  /** Type text then press Enter, as a player would. */
  typeLine(text: string): void {
    this.char(text);
    this.tap(Keys.enter);
  }

  mouse(
    window: number,
    kind: MouseKind,
    button: number,
    x: number,
    y: number,
  ): void {
    this.sendPayload(encodeMouse(window, kind, button, x, y));
  }

  event(name: string, ...params: EventValue[]): void {
    this.sendPayload(encodeEvent(name, params));
  }

  /**
   * Simulate a right-click on a monitor cell (1-based CC coordinates). The touch carries a tag saying a player made
   * it, `ccsim_player:<name>` with `player` and `ccsim_engine` without: the ccsim layer reads it and hands the
   * program a plain three-value touch. A touch a program queues itself carries no tag, and ccsim leaves it alone.
   */
  touchMonitor(
    peripheralName: string,
    x: number,
    y: number,
    player?: string,
  ): void {
    this.event(
      "monitor_touch",
      peripheralName,
      x,
      y,
      player === undefined ? "ccsim_engine" : `ccsim_player:${player}`,
    );
  }

  async stop(graceMs = 1000): Promise<ExitInfo> {
    if (this.exitInfo) return this.exitInfo;
    this.sendPayload(encodeWindowClose(0, true));
    try {
      return await this.waitForExit(graceMs);
    } catch {
      // SIGKILL, not the default SIGTERM: once SDL has opened audio it catches SIGTERM and only queues a quit event,
      // which a program stuck in a loop never reads (seen on macOS; Windows always kills outright).
      if (this.transport) this.transport.kill();
      else this.child?.kill("SIGKILL");
      return this.waitForExit(5000);
    }
  }
}
