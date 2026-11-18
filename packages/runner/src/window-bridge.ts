import type { Readable, Writable } from "node:stream";
import {
  FrameParser,
  type KeyName,
  type RawSession,
  encodeFrame,
} from "@craftos-mcp/rawterm";
import { TERMINATE_HOLD_MS, powerCycle } from "./drive.js";
import type { EngineHandle } from "./engine.js";

/*
 * Desktop windows for computers the runner drives (`craftos-mcp window` with a turtle or several computers). The
 * computers run headless, as every session does, so the network relay and the block world work as they do anywhere
 * else; one `craftos --raw-client` process draws them. CraftOS-PC's raw client opens a window for each window id it is
 * told about, so every computer's terminal and monitors get their own window there: the bridge gives each window of
 * each engine its own id, and passes what the client sends back to the engine that window belongs to.
 */

/** A computer the bridge shows: what its windows are titled after, and its engine (which `restart` may replace). */
export interface BridgedComputer {
  readonly name: string;
  readonly handle: EngineHandle;
}

/** The two pipes of a `craftos --raw-client` process (or a stand-in that speaks the raw protocol, in tests). */
export interface RawClientPipes {
  readonly stdin: Writable;
  readonly stdout: Readable;
}

export interface WindowBridgeOptions {
  /** Every window is closed (the person closed them, or every computer shut down). */
  readonly onEmpty?: () => void;
  /** Put the computer's name in each window's title. Default: when there is more than one computer. */
  readonly names?: boolean;
  /** How often the list of computers is looked at again (a turtle places one, a computer turns another on). */
  readonly pollMs?: number;
}

/** The raw client's key bytes (CraftOS-PC's keymap: the old LWJGL key numbers) as CC:Tweaked's key names. */
const LWJGL_KEYS: Record<number, KeyName> = {
  1: "escape",
  2: "one",
  3: "two",
  4: "three",
  5: "four",
  6: "five",
  7: "six",
  8: "seven",
  9: "eight",
  10: "nine",
  11: "zero",
  12: "minus",
  13: "equals",
  14: "backspace",
  15: "tab",
  16: "q",
  17: "w",
  18: "e",
  19: "r",
  20: "t",
  21: "y",
  22: "u",
  23: "i",
  24: "o",
  25: "p",
  26: "leftBracket",
  27: "rightBracket",
  28: "enter",
  29: "leftCtrl",
  30: "a",
  31: "s",
  32: "d",
  33: "f",
  34: "g",
  35: "h",
  36: "j",
  37: "k",
  38: "l",
  39: "semicolon",
  40: "apostrophe",
  41: "grave",
  42: "leftShift",
  43: "backslash",
  44: "z",
  45: "x",
  46: "c",
  47: "v",
  48: "b",
  49: "n",
  50: "m",
  51: "comma",
  52: "period",
  53: "slash",
  54: "rightShift",
  55: "numPadMultiply",
  56: "leftAlt",
  57: "space",
  58: "capsLock",
  59: "f1",
  60: "f2",
  61: "f3",
  62: "f4",
  63: "f5",
  64: "f6",
  65: "f7",
  66: "f8",
  67: "f9",
  68: "f10",
  69: "numLock",
  70: "scrollLock",
  71: "numPad7",
  72: "numPad8",
  73: "numPad9",
  74: "numPadSubtract",
  75: "numPad4",
  76: "numPad5",
  77: "numPad6",
  78: "numPadAdd",
  79: "numPad1",
  80: "numPad2",
  81: "numPad3",
  82: "numPad0",
  83: "numPadDecimal",
  87: "f11",
  88: "f12",
  156: "numPadEnter",
  157: "rightCtrl",
  181: "numPadDivide",
  184: "rightAlt",
  197: "pause",
  199: "home",
  200: "up",
  201: "pageUp",
  203: "left",
  205: "right",
  207: "end",
  208: "down",
  209: "pageDown",
  210: "insert",
  211: "delete",
};

/** The raw protocol's packet types the bridge reads (packets.ts PacketType). */
const TERMINAL = 0;
const KEY = 1;
const MOUSE = 2;
const EVENT = 3;
const WINDOW = 4;
const MESSAGE = 5;

/** Ctrl held with these, for TERMINATE_HOLD_MS: what CC's terminal does (TerminalWidget). */
const HOLD_ACTIONS: Partial<
  Record<KeyName, "terminate" | "reboot" | "shutdown">
> = {
  t: "terminate",
  r: "reboot",
  s: "shutdown",
};

interface Attached {
  readonly computer: BridgedComputer;
  readonly session: RawSession;
  /** This engine's open windows: engine window id -> client window id. */
  readonly windows: Map<number, number>;
  /** Keys held down now, so a repeat says held. */
  readonly down: Set<KeyName>;
  /** A Ctrl+T / R / S being held: what happens when the hold is long enough. */
  hold?: { key: KeyName; timer: NodeJS.Timeout };
  readonly detach: () => void;
}

export class WindowBridge {
  private readonly attached = new Map<string, Attached>();
  /** Client window id -> the engine and its own window id, for what the client sends back. */
  private readonly byClientId = new Map<
    number,
    { name: string; window: number; monitor: boolean }
  >();
  /** The client id a computer's engine window keeps, so a computer that restarts gets its own windows back. */
  private readonly ids = new Map<string, number>();
  private nextId = 0;
  private readonly open = new Set<number>();
  private everOpen = false;
  private closed = false;
  private readonly parser = new FrameParser({ binaryCrc: false });
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly computers: () => readonly BridgedComputer[],
    private readonly client: RawClientPipes,
    private readonly options: WindowBridgeOptions = {},
  ) {
    client.stdout.on("data", (chunk: Buffer) => {
      for (const payload of this.parser.push(chunk)) this.fromClient(payload);
    });
    client.stdin.on("error", () => undefined);
    this.timer = setInterval(() => this.poll(), options.pollMs ?? 100);
    this.poll();
  }

  /** The windows open in the client now (client ids). */
  get openWindows(): number {
    return this.open.size;
  }

  /** Stop drawing: the client is told to quit. The computers are the caller's to stop. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    for (const a of this.attached.values()) {
      if (a.hold) clearTimeout(a.hold.timer);
      a.detach();
    }
    this.attached.clear();
    this.send(Uint8Array.from([WINDOW, 0, 2, 0, 0, 0, 0, 0]));
  }

  private send(payload: Uint8Array): void {
    if (this.client.stdin.destroyed || this.client.stdin.writableEnded) return;
    this.client.stdin.write(encodeFrame(payload, { binaryCrc: false }));
  }

  /** Attach to computers that are new, or whose engine `restart` replaced. */
  private poll(): void {
    if (this.closed) return;
    const list = this.computers();
    const names = this.options.names ?? list.length > 1;
    for (const computer of list) {
      const before = this.attached.get(computer.name);
      const session = computer.handle.session;
      if (before?.session === session) continue;
      if (before) this.forget(before);
      if (!session.running) continue;
      this.attach(computer, session, names);
    }
    for (const a of [...this.attached.values()])
      if (!list.some((c) => c.name === a.computer.name)) this.forget(a);
    // nothing on screen and nothing that could put something there: the end
    if (
      this.open.size === 0 &&
      (this.everOpen || list.every((c) => !c.handle.session.running))
    )
      this.empty();
  }

  private attach(
    computer: BridgedComputer,
    session: RawSession,
    names: boolean,
  ): void {
    const onPayload = (payload: Uint8Array): void =>
      this.toClient(entry, payload, names);
    const onExit = (): void => {
      // an engine that stops sends no goodbye for its windows: close them here
      for (const id of entry.windows.values()) this.closeClientWindow(id);
      entry.windows.clear();
    };
    const entry: Attached = {
      computer,
      session,
      windows: new Map(),
      down: new Set(),
      detach: () => {
        session.off("payload", onPayload);
        session.off("exit", onExit);
      },
    };
    this.attached.set(computer.name, entry);
    for (const payload of session.replayPayloads())
      this.toClient(entry, payload, names);
    session.on("payload", onPayload);
    session.once("exit", onExit);
  }

  private forget(entry: Attached): void {
    entry.detach();
    if (entry.hold) clearTimeout(entry.hold.timer);
    for (const id of entry.windows.values()) this.closeClientWindow(id);
    this.attached.delete(entry.computer.name);
  }

  private clientId(name: string, window: number): number {
    const key = `${name}\u0000${window}`;
    let id = this.ids.get(key);
    if (id === undefined) {
      // the protocol's window id is one byte; past 255 windows, the oldest ids are used again
      id = this.nextId++ % 256;
      this.ids.set(key, id);
    }
    return id;
  }

  private closeClientWindow(id: number): void {
    if (!this.open.delete(id)) return;
    this.byClientId.delete(id);
    this.send(Uint8Array.from([WINDOW, id, 1, 0, 0, 0, 0, 0]));
  }

  private emptied = false;

  private empty(): void {
    if (this.closed || this.emptied) return;
    this.emptied = true;
    this.options.onEmpty?.();
  }

  /** A packet from an engine, on its way to the client with the window's client id. */
  private toClient(entry: Attached, payload: Uint8Array, names: boolean): void {
    const type = payload[0];
    if (type !== TERMINAL && type !== WINDOW && type !== MESSAGE) return;
    const window = payload[1]!;
    const name = entry.computer.name;
    if (type === WINDOW) {
      const closing = payload[2];
      const id = this.clientId(name, window);
      if (closing !== 0) {
        entry.windows.delete(window);
        this.closeClientWindow(id);
        return;
      }
      const engineTitle = Buffer.from(payload.subarray(8))
        .toString("latin1")
        .replace(/\0[\s\S]*$/, "");
      const monitor = / Monitor .+$/.test(engineTitle);
      const shown = engineTitle.replace(/^CraftOS Terminal: /, "");
      // a computer's own window says its name; a monitor says whose it is
      const title = !names
        ? engineTitle
        : monitor
          ? `${name}: ${shown}`
          : shown === name
            ? name
            : `${name} (${shown})`;
      const out = Buffer.concat([
        Buffer.from(payload.subarray(0, 8)),
        Buffer.from(title, "latin1"),
        Buffer.from([0]),
      ]);
      out[1] = id;
      entry.windows.set(window, id);
      this.byClientId.set(id, { name, window, monitor });
      this.open.add(id);
      this.everOpen = true;
      this.send(out);
      return;
    }
    const id = entry.windows.get(window);
    if (id === undefined) return; // a window the client has not been told about (closed already)
    const out = Buffer.from(payload);
    out[1] = id;
    this.send(out);
  }

  /** A packet from the client: a key, a click, or a window closed, for the engine that owns the window. */
  private fromClient(payload: Uint8Array): void {
    const type = payload[0];
    const target = this.byClientId.get(payload[1]!);
    if (type === WINDOW && payload[2] === 2) {
      // the client is quitting (its last window closed): everything goes
      this.empty();
      return;
    }
    if (!target) return;
    const entry = this.attached.get(target.name);
    if (!entry || !entry.session.running) return;
    if (type === KEY) this.key(entry, payload[2]!, payload[3]!);
    else if (type === MOUSE || type === EVENT) {
      const out = Buffer.from(payload);
      out[1] = target.window;
      entry.session.sendRaw(out);
    } else if (type === WINDOW && payload[2] === 1 && !target.monitor) {
      // its terminal window closed: the computer is turned off, as closing a CraftOS-PC window does
      void entry.session.stop();
    }
  }

  /**
   * A key from the client. Its key byte is an old LWJGL number, which the engine would pass on unchanged; CC:Tweaked
   * since 1.13 numbers keys as GLFW does, so the key goes to the computer as a `key` / `key_up` event of its own.
   */
  private key(entry: Attached, code: number, flags: number): void {
    const session = entry.session;
    if (flags & 8) {
      // typed text: the client sends the first byte of the character; CC's characters are single bytes below 256
      if (code >= 32 && code < 127) session.char(String.fromCharCode(code));
      return;
    }
    const name = LWJGL_KEYS[code];
    if (!name) return;
    const up = (flags & 1) !== 0;
    const ctrl = (flags & 4) !== 0;
    if (up) {
      // letting go of the letter or of Ctrl ends a hold
      if (
        entry.hold &&
        (entry.hold.key === name || name === "leftCtrl" || name === "rightCtrl")
      ) {
        clearTimeout(entry.hold.timer);
        entry.hold = undefined;
      }
      if (entry.down.delete(name)) session.key(name, { up: true });
      return;
    }
    const action = ctrl ? HOLD_ACTIONS[name] : undefined;
    if (action) {
      // as CC's terminal: the letter itself is not typed, and holding it long enough does the action, once a hold
      if (!entry.hold) {
        const timer = setTimeout(() => {
          if (action === "terminate") session.event("terminate");
          else void powerCycle(entry.computer.handle, action);
        }, TERMINATE_HOLD_MS);
        timer.unref();
        entry.hold = { key: name, timer };
      }
      return;
    }
    const held = entry.down.has(name);
    entry.down.add(name);
    session.key(name, { held });
  }
}
