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
  exit: [ExitInfo];
  stderr: [string];
}> {
  readonly windows = new Map<number, WindowState>();
  /** Windows the engine has closed (kept so final screens survive shutdown). */
  readonly closedWindows: WindowState[] = [];
  readonly messages: { title: string; message: string }[] = [];
  exitInfo: ExitInfo | undefined;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly parser = new FrameParser({ binaryCrc: false });
  private serverFlags = 0;
  private readonly clientFlags = FeatureBit.WindowsOnHandshake;

  constructor(options: SessionOptions) {
    super();
    this.child = spawn(options.executable, ["--raw", ...(options.args ?? [])], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    this.child.stderr.on("data", (chunk: Buffer) =>
      this.emit("stderr", chunk.toString()),
    );
    this.child.stdin.on("error", () => undefined);
    this.child.on("exit", (code, signal) => {
      this.exitInfo = { code, signal };
      this.emit("exit", this.exitInfo);
    });
    this.sendPayload(encodeFeatures(this.clientFlags));
  }

  get running(): boolean {
    return this.exitInfo === undefined;
  }

  get features(): number {
    return this.serverFlags & this.clientFlags;
  }

  private sendPayload(payload: Uint8Array): void {
    if (!this.running || this.child.stdin.destroyed) return;
    this.child.stdin.write(encodeFrame(payload, { binaryCrc: false }));
  }

  private onData(chunk: Buffer): void {
    for (const payload of this.parser.push(chunk)) {
      const frame = decodeServerPacket(payload);
      this.apply(frame);
      this.emit("frame", frame);
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
          this.child.stdin.end();
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
   * Simulate a right-click on a monitor cell (1-based CC coordinates). With `player`, the touch carries the player
   * who made it (the ccsim layer reads it and hands the program a plain three-value touch).
   */
  touchMonitor(
    peripheralName: string,
    x: number,
    y: number,
    player?: string,
  ): void {
    if (player === undefined) this.event("monitor_touch", peripheralName, x, y);
    else
      this.event(
        "monitor_touch",
        peripheralName,
        x,
        y,
        `ccsim_player:${player}`,
      );
  }

  async stop(graceMs = 1000): Promise<ExitInfo> {
    if (this.exitInfo) return this.exitInfo;
    this.sendPayload(encodeWindowClose(0, true));
    try {
      return await this.waitForExit(graceMs);
    } catch {
      this.child.kill();
      return this.waitForExit(5000);
    }
  }
}
