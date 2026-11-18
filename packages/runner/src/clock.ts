/**
 * The world clock a person controls: pause and resume every computer, one tick at a time, faster, as fast as possible,
 * or a jump ahead. Each computer's engine keeps its own clock (engine/src/simclock.hpp); this keeps all of them in step
 * and reads back what they say in their clock.json.
 *
 * How it meets the rest of the clock:
 * - Pause: every computer stops at its next yield; once all of an engine's computers wait, its clock stands still, as
 *   a debugger's stop holds it (one hold, never counted twice). A computer in the middle of its work finishes that
 *   piece first, so a pause never trips "Too long without yielding": a computer waiting for its event never counts.
 * - Resume: the clock runs on from where it stood. A timer due in 3 s is still due 3 s later; nothing fires in a burst.
 *   That is the game: a paused (or lagging) server runs no ticks, and CC's timers count ticks.
 * - Step: one tick (50 ms) on, the timers due in it fire, every computer handles its events, and all stand still again.
 * - Jump: the clock moves from one timer to the next up to the end of the jump, and every computer handles each one
 *   (and starts its next) before it moves on, so a loop of sleep(600) runs six times in an hour's jump. Paused, the
 *   computers run through the jump and stand still again at its end. One that would take more than 30 s of real
 *   time does the rest at once. Machines catch up on what they would have made.
 * - In-game time and day (os.time, os.day): one world clock for the app's computers (`worldtime`), so a computer made
 *   later or rebooted keeps the world's time of day, as in the game.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EngineHandle } from "./engine.js";
import { type SessionManager, VIEWER_OWNER } from "./sessions.js";

/** What an engine wrote to its clock.json. */
export interface ClockStatus {
  /** The last control it carried out (EngineHandle.clock's number). */
  readonly seq: number;
  readonly paused: boolean;
  /** The clock stands still (paused and every computer waiting, or a debugger stop). */
  readonly held: boolean;
  /** A step is still being handled. */
  readonly stepping: boolean;
  /** A jump is still moving from one timer to the next (an older engine never says). */
  readonly jumping?: boolean;
  /** As fast as possible. */
  readonly max: boolean;
  readonly speed: number;
  /** The virtual clock (os.epoch "utc"), and the real time it was read at. */
  readonly virtualMs: number;
  readonly realMs: number;
  /** os.clock of the computer, in ms. */
  readonly clockMs: number;
  /** World time since day 1, 06:00, in ms (20 minutes a day). */
  readonly worldMs: number;
}

/** A Minecraft day: 20 minutes. */
export const DAY_MS = 20 * 60 * 1000;
/** One tick. */
export const TICK_MS = 50;
/** The fixed speeds people pick from; "max" is as fast as possible. */
export const SPEEDS = [1, 2, 5, 10] as const;

export function readClock(handle: EngineHandle): ClockStatus | undefined {
  try {
    const text = readFileSync(join(handle.resultsDir, "clock.json"), "utf8");
    const status = JSON.parse(text) as ClockStatus;
    return typeof status.seq === "number" ? status : undefined;
  } catch {
    return undefined;
  }
}

/** World time now: the status moved on by the real time since it was written, at its speed, unless held. */
export function worldNow(status: ClockStatus, now = Date.now()): number {
  if (status.worldMs < 0) return 0;
  if (status.held || status.paused) return status.worldMs;
  return status.worldMs + Math.max(0, now - status.realMs) * status.speed;
}

/** os.time and os.day for a world time: "Day 3, 14:05". */
export function describeWorldTime(worldMs: number): {
  day: number;
  hour: number;
  minute: number;
  text: string;
} {
  const ms = Math.max(0, worldMs);
  const day = Math.floor(ms / DAY_MS) + 1;
  // os.time: ((ms + 6 h) mod a day) / 50 ms = ticks, 1000 ticks an hour
  const hours = (((ms + DAY_MS / 4) % DAY_MS) / TICK_MS / 1000) % 24;
  const hour = Math.floor(hours);
  const minute = Math.floor((hours - hour) * 60);
  return {
    day,
    hour,
    minute,
    text: `Day ${day}, ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

/** Parse "90", "90s", "5m", "2h", "1d" (a Minecraft day), "3t" (ticks) into ms. */
export function parseDuration(text: string): number {
  const m =
    /^\s*(\d+(?:\.\d+)?)\s*(t|ticks?|s|sec|seconds?|m|min|minutes?|h|hours?|d|days?)?\s*$/i.exec(
      text,
    );
  if (!m)
    throw new Error(
      `not a length of time: ${text} (try 90s, 5m, 2h, 1d or 20t)`,
    );
  const n = Number(m[1]);
  const unit = (m[2] ?? "s").toLowerCase();
  const scale = unit.startsWith("t")
    ? TICK_MS
    : unit.startsWith("m")
      ? 60_000
      : unit.startsWith("h")
        ? 3_600_000
        : unit.startsWith("d")
          ? DAY_MS
          : 1000;
  return Math.round(n * scale);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Wait until the engine has carried out control `seq` and `until` holds (or the time is up). */
export async function waitForClock(
  handle: EngineHandle,
  seq: number,
  until: (s: ClockStatus) => boolean = () => true,
  timeoutMs = 3000,
): Promise<ClockStatus | undefined> {
  const start = Date.now();
  let last: ClockStatus | undefined;
  while (Date.now() - start < timeoutMs) {
    last = readClock(handle);
    if (last && last.seq >= seq && until(last)) return last;
    if (!handle.session.running) return last;
    await sleep(10);
  }
  return last;
}

export interface WorldClockState {
  readonly paused: boolean;
  /** 1, 2, 5, 10 (or any 0.1 to 1000), or "max": as fast as possible. */
  readonly speed: number | "max";
}

export interface WorldClockStatus extends WorldClockState {
  /** Every computer stands still (paused and waiting). False while one still finishes its work. */
  readonly stopped: boolean;
  /** The world's time: the computer in front's, or the first one's. */
  readonly worldMs: number | null;
  readonly time: string | null;
  readonly computers: { id: string; worldMs: number; held: boolean }[];
}

/** One clock over every computer of a SessionManager (the app's world), including those a turtle placed. */
export class WorldClock {
  private state: { paused: boolean; speed: number | "max" } = {
    paused: false,
    speed: 1,
  };
  private readonly known = new WeakSet<EngineHandle>();

  constructor(
    private readonly sessions: SessionManager,
    /**
     * Computers that share one world time of day (os.time, os.day). Default: the ones a person made in the app; an
     * agent's computers keep counting from their own start, as its tests expect.
     */
    private readonly sharesWorldTime: (id: string) => boolean = (id) =>
      sessions.ownerOf(id.split("/")[0]!) === VIEWER_OWNER,
  ) {}

  /** Every running computer: session id (a placed computer: "<session>/<name>") and its engine. */
  handles(): { id: string; handle: EngineHandle }[] {
    const out: { id: string; handle: EngineHandle }[] = [];
    for (const summary of this.sessions.list()) {
      const session = this.sessions.get(summary.id);
      if (session.handle.session.running)
        out.push({ id: session.id, handle: session.handle });
      for (const placed of session.blockWorld?.host.computers() ?? []) {
        if (placed.handle.session.running)
          out.push({
            id: `${session.id}/${placed.name}`,
            handle: placed.handle,
          });
      }
    }
    return out;
  }

  get current(): WorldClockState {
    return { ...this.state };
  }

  /**
   * Computers made since the last look get the world's clock: paused if it is, its speed, and (for computers that share
   * it) the world's time of day. Called by every control and status read, so no path that makes computers is missed.
   */
  async sync(): Promise<void> {
    const all = this.handles();
    const fresh: { handle: EngineHandle; seq: number }[] = [];
    const reference = all.find(
      (h) => this.known.has(h.handle) && this.sharesWorldTime(h.id),
    );
    const refStatus = reference ? readClock(reference.handle) : undefined;
    for (const { id, handle } of all) {
      if (this.known.has(handle) || !handle.clock) continue;
      this.known.add(handle);
      // the world's time of day; the first computer starts the world at day 1, 06:00
      if (this.sharesWorldTime(id))
        handle.clock(
          "worldtime",
          refStatus ? Math.round(worldNow(refStatus)) : 0,
        );
      if (this.state.speed === "max") handle.clock("max");
      else if (this.state.speed !== 1) handle.clock("speed", this.state.speed);
      if (this.state.paused) handle.clock("pause");
      // and at least once what its clock says
      fresh.push({ handle, seq: handle.clock("status") });
    }
    await Promise.all(
      fresh.map(({ handle, seq }) =>
        waitForClock(handle, seq, undefined, 2000),
      ),
    );
  }

  private async all(
    verb: string,
    arg: number | undefined,
    until?: (s: ClockStatus) => boolean,
    timeoutMs = 3000,
  ): Promise<ClockStatus[]> {
    await this.sync();
    const sent = this.handles().flatMap(({ handle }) =>
      handle.clock ? [{ handle, seq: handle.clock(verb, arg) }] : [],
    );
    const statuses = await Promise.all(
      sent.map(({ handle, seq }) =>
        waitForClock(handle, seq, until, timeoutMs),
      ),
    );
    return statuses.filter((s): s is ClockStatus => !!s);
  }

  /** Pause every computer; resolves once all of them stand still (or after `timeoutMs`, one still working). */
  async pause(timeoutMs = 3000): Promise<WorldClockStatus> {
    this.state.paused = true;
    await this.all("pause", undefined, (s) => s.held, timeoutMs);
    return this.status();
  }

  async resume(): Promise<WorldClockStatus> {
    this.state.paused = false;
    await this.all("resume", undefined);
    return this.status();
  }

  /**
   * Pause (if running) and move on by `ticks` ticks, one at a time as the game runs them: the timers due in each tick
   * fire and every computer handles its events before the next. Resolves when every computer is done with the last.
   */
  async step(ticks = 1): Promise<WorldClockStatus> {
    if (!(ticks >= 1 && ticks <= 1200))
      throw new Error("a step is 1 to 1200 ticks");
    this.state.paused = true;
    for (let i = 0; i < Math.floor(ticks); i++)
      await this.all("step", TICK_MS, (s) => !s.stepping, 8000);
    return this.status();
  }

  async setSpeed(speed: number | "max"): Promise<WorldClockStatus> {
    if (speed !== "max" && !(speed >= 0.1 && speed <= 1000))
      throw new Error("speed is 0.1 to 1000, or max");
    this.state.speed = speed;
    if (speed === "max") await this.all("max", undefined);
    else await this.all("speed", speed);
    return this.status();
  }

  /**
   * Jump every computer's clock ahead by `ms`, one timer at a time: each fires and every computer handles it before
   * the next. Resolves when every computer is at the end of the jump.
   */
  async jump(ms: number): Promise<WorldClockStatus> {
    if (!(ms > 0) || ms > 30 * DAY_MS)
      throw new Error("a jump is more than 0 and at most 30 Minecraft days");
    await this.all("advance", ms, (s) => !s.jumping, 45_000);
    return this.status();
  }

  /** Set the world's time of day on every computer that shares it: ms since day 1, 06:00. */
  async setWorldTime(ms: number): Promise<void> {
    await this.sync();
    await Promise.all(
      this.handles()
        .filter((h) => this.sharesWorldTime(h.id) && h.handle.clock)
        .map(({ handle }) =>
          waitForClock(handle, handle.clock!("worldtime", Math.round(ms))),
        ),
    );
  }

  async status(front?: string): Promise<WorldClockStatus> {
    await this.sync();
    const computers: WorldClockStatus["computers"] = [];
    for (const { id, handle } of this.handles()) {
      const s = readClock(handle);
      if (s)
        computers.push({ id, worldMs: Math.round(worldNow(s)), held: s.held });
    }
    const pick =
      computers.find((c) => c.id === front) ??
      computers.find((c) => this.sharesWorldTime(c.id)) ??
      computers[0];
    return {
      ...this.state,
      stopped:
        this.state.paused &&
        computers.length > 0 &&
        computers.every((c) => c.held),
      worldMs: pick ? pick.worldMs : null,
      time: pick ? describeWorldTime(pick.worldMs).text : null,
      computers,
    };
  }
}

const clocks = new WeakMap<SessionManager, WorldClock>();

/** The one WorldClock of a SessionManager (the app and the MCP server's tools share it). */
export function worldClockFor(sessions: SessionManager): WorldClock {
  let clock = clocks.get(sessions);
  if (!clock) {
    clock = new WorldClock(sessions);
    clocks.set(sessions, clock);
  }
  return clock;
}
