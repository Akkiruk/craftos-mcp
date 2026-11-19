import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { encodeFrame, FrameParser } from "./framing.js";
import { encodeFeatures, FeatureBit } from "./packets.js";
import { type ExitInfo, RawSession } from "./session.js";

/*
 * Many computers in one engine process (craftos --raw --pool). A computer started here is a RawSession like any other
 * (windows, screens, events, stop, exit), but it shares its process with up to `capacity` others: one process and its
 * fixed cost (about 8 MB of private memory, 9 threads, 270 handles on Windows) for all of them, and per computer
 * only what the computer itself needs (its Lua state, about 2 MB, and one thread).
 *
 * Each computer keeps what a process of its own gave it: its own folders, mounts, boot script, clock (speed, pause,
 * jumps: simclock domains in the engine) and window numbering (its terminal is window 0). What it does not keep is a
 * process to itself: a crash of the engine takes every computer in it down, and the engine's stderr cannot be told
 * apart by computer (each computer gets it only if the engine dies). The wire format is in the engine's
 * RawTerminal.cpp (CCPC_RAW_POOL_ENVELOPE).
 */

const ENVELOPE = 0x40;
const SPAWN = 0x41;
const EXITED = 0x42;
const KILL = 0x43;

/** One computer, as its own engine's command line would have said it. */
export interface PoolComputerSpec {
  /** --id */
  readonly id: number;
  /** --directory: config/<id>.json is read and written here */
  readonly base: string;
  /** the computers folder: the computer's files are <computers>/<id>, floppy disks <computers>/disk/<n> */
  readonly computers?: string;
  /** --script */
  readonly script?: string;
  /** CRAFTOS_CLOCK_FILE */
  readonly clockFile?: string;
  /** --time-scale */
  readonly timeScale?: number;
  /** --mount-ro (mode 0), --mount-rw (1), --mount (-1: the engine's -o mount_mode) */
  readonly mounts?: readonly (readonly [
    name: string,
    path: string,
    mode: 0 | 1 | -1,
  ])[];
}

export interface EnginePoolOptions {
  readonly executable: string;
  /** Flags every computer of the engine shares (--rom, --cc-version, --directory for global.json, -o, ...). */
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Computers per process (default 32). */
  readonly capacity?: number;
  /** How long an engine with no computers left waits for the next before it closes (ms, default 2000). */
  readonly idleMs?: number;
}

/** stderr kept per engine, for the computers in it if it dies */
const STDERR_KEEP = 16384;

class PoolProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly sessions = new Map<number, RawSession>();
  /** no new computers: one would not stop (it may still be running in there), or the engine is closing */
  retired = false;
  exited = false;
  private nextSlot = 0;
  private stderrTail = "";
  private idleTimer: NodeJS.Timeout | undefined;
  private readonly parser = new FrameParser({ binaryCrc: false });

  constructor(
    private readonly owner: EnginePool,
    private readonly options: EnginePoolOptions,
  ) {
    this.child = spawn(
      options.executable,
      ["--raw", "--pool", ...(options.args ?? [])],
      {
        cwd: options.cwd,
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    this.child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      // CRAFTOS_POOL_STDERR=1: the shared engine's stderr as it comes, for looking into one
      if (
        options.env?.["CRAFTOS_POOL_STDERR"] ??
        process.env["CRAFTOS_POOL_STDERR"]
      )
        process.stderr.write(chunk);
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(
        -STDERR_KEEP,
      );
    });
    this.child.stdin.on("error", () => undefined);
    this.child.on("error", (error: NodeJS.ErrnoException) => {
      this.stderrTail += `could not start the engine ${options.executable}: ${error.code ?? error.message}\n`;
      this.onExit(null, null);
    });
    this.child.on("exit", (code, signal) => {
      // the last packets may still be in the pipe: hand them out first
      if (this.child.stdout.readableEnded) this.onExit(code, signal);
      else {
        const limit = setTimeout(() => this.onExit(code, signal), 5000);
        this.child.once("close", () => {
          clearTimeout(limit);
          this.onExit(code, signal);
        });
      }
    });
    this.write(encodeFeatures(FeatureBit.WindowsOnHandshake));
  }

  get live(): number {
    return this.sessions.size;
  }

  private write(payload: Uint8Array): void {
    if (this.exited || this.child.stdin.destroyed) return;
    this.child.stdin.write(encodeFrame(payload, { binaryCrc: false }));
  }

  private envelope(slot: number, payload: Uint8Array): Uint8Array {
    const out = new Uint8Array(payload.length + 3);
    out[0] = ENVELOPE;
    out[1] = slot & 0xff;
    out[2] = (slot >> 8) & 0xff;
    out.set(payload, 3);
    return out;
  }

  private freeSlot(): number {
    for (let i = 0; i < 0x10000; i++) {
      const slot = (this.nextSlot + i) & 0xffff;
      if (!this.sessions.has(slot)) {
        this.nextSlot = slot + 1;
        return slot;
      }
    }
    throw new Error("no free pool slot");
  }

  start(spec: PoolComputerSpec): RawSession {
    this.busy();
    const slot = this.freeSlot();
    let killTimer: NodeJS.Timeout | undefined;
    const session: RawSession = new RawSession({
      serverFlags: FeatureBit.WindowsOnHandshake,
      transport: {
        write: (payload) => this.write(this.envelope(slot, payload)),
        kill: () => {
          this.write(this.envelope(slot, Uint8Array.from([KILL, 0])));
          // a computer stuck inside the engine (not in Lua) cannot be stopped from outside: say it is gone, and
          // start no more computers in this engine, which closes once the others are done
          killTimer ??= setTimeout(() => {
            if (!this.sessions.has(slot)) return;
            this.retired = true;
            this.finish(slot, { code: null, signal: "SIGKILL" });
          }, 3000);
          killTimer.unref();
        },
      },
    });
    session.once("exit", () => clearTimeout(killTimer));
    this.sessions.set(slot, session);
    const json = Buffer.from(
      JSON.stringify({
        id: spec.id,
        base: spec.base,
        ...(spec.computers !== undefined && { computers: spec.computers }),
        ...(spec.script !== undefined && { script: spec.script }),
        ...(spec.clockFile !== undefined && { clockFile: spec.clockFile }),
        timeScale: spec.timeScale ?? 1,
        mounts: spec.mounts ?? [],
      }),
      "utf8",
    );
    const packet = new Uint8Array(4 + json.length);
    packet[0] = SPAWN;
    packet[1] = 0;
    packet[2] = slot & 0xff;
    packet[3] = (slot >> 8) & 0xff;
    packet.set(json, 4);
    this.write(packet);
    return session;
  }

  private finish(slot: number, info: ExitInfo): void {
    const session = this.sessions.get(slot);
    if (!session) return;
    this.sessions.delete(slot);
    session.exitPooled(info);
    if (this.sessions.size === 0) this.idle();
  }

  private onData(chunk: Buffer): void {
    for (const payload of this.parser.push(chunk)) {
      if (payload[0] !== ENVELOPE || payload.length < 5) continue; // the engine's own (features, its quit)
      const slot = payload[1]! | (payload[2]! << 8);
      const inner = payload.subarray(3);
      if (inner[0] === EXITED) {
        const code = Buffer.from(inner).readInt32LE(2);
        this.finish(
          slot,
          code < 0 ? { code: null, signal: null } : { code, signal: null },
        );
        continue;
      }
      this.sessions.get(slot)?.receivePooled(inner);
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.retired = true;
    clearTimeout(this.idleTimer);
    this.owner.forget(this);
    // the engine went down with computers in it: each gets what it said, and the engine's own exit
    for (const [slot, session] of [...this.sessions]) {
      if (this.stderrTail) session.stderrPooled(this.stderrTail);
      this.sessions.delete(slot);
      session.exitPooled({ code, signal });
    }
  }

  /** Computers running: the engine keeps Node's event loop alive, as an engine of its own does. */
  private busy(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.child.ref();
    (this.child.stdout as unknown as { ref?: () => void }).ref?.();
    (this.child.stderr as unknown as { ref?: () => void }).ref?.();
  }

  /** None left: close after a while unless another comes; meanwhile the engine never holds Node open. */
  private idle(): void {
    this.child.unref();
    (this.child.stdout as unknown as { unref?: () => void }).unref?.();
    (this.child.stderr as unknown as { unref?: () => void }).unref?.();
    const idleMs = this.options.idleMs ?? 2000;
    if (this.retired || idleMs <= 0) {
      this.close();
      return;
    }
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), idleMs);
    this.idleTimer.unref();
  }

  close(): void {
    this.retired = true;
    this.owner.forget(this);
    if (!this.child.stdin.destroyed) this.child.stdin.end();
  }
}

/** Engines shared by many computers: one starts when the others are full, and closes when it has none for a while. */
export class EnginePool {
  private readonly processes = new Set<PoolProcess>();
  readonly capacity: number;

  constructor(private readonly options: EnginePoolOptions) {
    this.capacity = Math.max(1, options.capacity ?? 32);
  }

  /** Start a computer: in an engine with room, or a new one. */
  start(spec: PoolComputerSpec): RawSession {
    let target: PoolProcess | undefined;
    for (const p of this.processes)
      if (!p.retired && !p.exited && p.live < this.capacity) {
        target = p;
        break;
      }
    if (!target) {
      target = new PoolProcess(this, this.options);
      this.processes.add(target);
    }
    return target.start(spec);
  }

  /** Engines running now, and their computers. */
  get stats(): { processes: number; computers: number } {
    let computers = 0;
    for (const p of this.processes) computers += p.live;
    return { processes: this.processes.size, computers };
  }

  /** Close every engine (their computers quit as a closed window makes them). */
  close(): void {
    for (const p of [...this.processes]) p.close();
  }

  /** @internal */
  forget(p: PoolProcess): void {
    this.processes.delete(p);
  }
}
