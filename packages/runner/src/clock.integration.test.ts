// The world clock a person controls (clock.ts, engine/src/simclock.hpp): pause, step, speed, as fast as possible,
// jumps, and the world's time of day.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  type Session,
  SessionManager,
  VIEWER_OWNER,
  WorldClock,
  checkConfig,
  describeWorldTime,
  loadConfig,
  parseDuration,
  readClock,
  waitForBoot,
} from "./index.js";

const scratch = mkdtempSync(join(tmpdir(), "clock-ws-"));
const config = { ...loadConfig(), workspaceDir: scratch };
const ready = checkConfig(config).length === 0;
let sessions = new SessionManager(config);
afterEach(async () => {
  await sessions.destroyAll();
  sessions = new SessionManager(config);
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** A computer running `source` (saved as prog.lua), started from the shell. */
async function start(source: string, owner = VIEWER_OWNER): Promise<Session> {
  writeFileSync(join(scratch, "prog.lua"), source);
  const session = sessions.create([], 1, { addons: [] });
  sessions.setOwner(session.id, owner);
  await waitForBoot(session.handle.session);
  session.handle.session.typeLine("prog");
  return session;
}

/** Lines the program wrote to /log.txt, on the computer's own disk. */
function log(session: Session): string[] {
  try {
    return readFileSync(
      join(session.handle.dir, "computer", "0", "log.txt"),
      "utf8",
    )
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function until(
  check: () => boolean,
  timeoutMs = 10000,
  what = "condition",
): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs)
      throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

// A timer every half second; each line is os.clock() when it fired
const TICKER = `
local f = fs.open("log.txt", "w")
while true do
  local id = os.startTimer(0.5)
  repeat local _, p = os.pullEvent("timer") until p == id
  f.writeLine(string.format("%.3f", os.clock()))
  f.flush()
end`;

describe("clock helpers", () => {
  it("reads lengths of time", () => {
    expect(parseDuration("90")).toBe(90_000);
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("1d")).toBe(1_200_000);
    expect(parseDuration("3 ticks")).toBe(150);
    expect(() => parseDuration("soon")).toThrow(/not a length of time/);
  });
  it("names the time of day as os.time and os.day do", () => {
    expect(describeWorldTime(0).text).toBe("Day 1, 06:00");
    expect(describeWorldTime(600_000).text).toBe("Day 1, 18:00");
    expect(describeWorldTime(900_000).text).toBe("Day 1, 00:00");
    expect(describeWorldTime(1_200_000 + 50_000).text).toBe("Day 2, 07:00");
  });
});

describe.skipIf(!ready)("world clock", () => {
  it("pauses: timers stop, the clock stands still, and nothing fires in a burst after", async () => {
    const session = await start(TICKER);
    const clock = new WorldClock(sessions);
    await until(() => log(session).length >= 2, 15000, "two ticks");
    const paused = await clock.pause();
    expect(paused.paused).toBe(true);
    expect(paused.stopped).toBe(true);
    const held = readClock(session.handle)!;
    const count = log(session).length;
    // 8 s paused: longer than the 7 s limit without yielding, which a waiting computer never trips
    await sleep(8000);
    expect(log(session).length).toBe(count);
    expect(readClock(session.handle)!.virtualMs).toBe(held.virtualMs);
    await clock.resume();
    await until(
      () => log(session).length >= count + 3,
      10000,
      "three more ticks",
    );
    const times = log(session).map(Number);
    for (let i = 1; i < times.length; i++) {
      // no burst: every timer still came half a second of the computer's clock after the one before
      expect(times[i]! - times[i - 1]!).toBeGreaterThan(0.45);
      expect(times[i]! - times[i - 1]!).toBeLessThan(0.7);
    }
    // os.clock went on from where it stood: the 8 s paused are not in it
    expect(times[times.length - 1]!).toBeLessThan(times[0]! + 5);
    expect(session.handle.session.screen(0)?.lines.join("\n")).not.toMatch(
      /Too long without yielding/,
    );
  }, 60000);

  it("lets a computer finish its work before the clock stands still", async () => {
    // busy for 1.5 s of os.epoch, then waits: a clock held mid-work would spin it into the 7 s limit
    const session = await start(`
local f = fs.open("log.txt", "w")
f.writeLine("busy") f.flush()
local t = os.epoch("utc")
while os.epoch("utc") - t < 1500 do end
f.writeLine("done") f.flush()
os.pullEvent("never")`);
    const clock = new WorldClock(sessions);
    await until(() => log(session).length >= 1, 15000, "the work to start");
    const status = await clock.pause(6000);
    expect(status.stopped).toBe(true);
    expect(log(session)).toEqual(["busy", "done"]);
    await clock.resume();
  }, 60000);

  it("steps one tick at a time", async () => {
    const session = await start(`
local f = fs.open("log.txt", "w")
local n = 0
while true do
  local id = os.startTimer(0.05)
  repeat local _, p = os.pullEvent("timer") until p == id
  n = n + 1
  f.writeLine(n) f.flush()
end`);
    const clock = new WorldClock(sessions);
    await until(() => log(session).length >= 1, 15000, "a tick");
    await clock.pause();
    const before = log(session).length;
    for (let i = 1; i <= 3; i++) {
      await clock.step();
      await until(() => log(session).length >= before + i, 3000, `step ${i}`);
    }
    await sleep(500);
    expect(log(session).length).toBe(before + 3);
    // five ticks in one step: five timers
    await clock.step(5);
    await until(() => log(session).length >= before + 8, 3000, "five more");
    await sleep(300);
    expect(log(session).length).toBe(before + 8);
    await clock.resume();
  }, 60000);

  it("runs faster, and as fast as possible", async () => {
    const session = await start(`
local f = fs.open("log.txt", "w")
sleep(3)
f.writeLine("fast " .. string.format("%.1f", os.clock())) f.flush()
sleep(600)
f.writeLine("max " .. string.format("%.1f", os.clock())) f.flush()
os.pullEvent("never")`);
    const clock = new WorldClock(sessions);
    const t0 = Date.now();
    await clock.setSpeed(10);
    await until(() => log(session).length >= 1, 5000, "three seconds at 10x");
    expect(Date.now() - t0).toBeLessThan(2500);
    // ten minutes of sleep pass at once: nothing to do until the timer, so the clock jumps there
    await clock.setSpeed("max");
    await until(() => log(session).length >= 2, 5000, "ten minutes at max");
    expect(Date.now() - t0).toBeLessThan(6000);
    const [fast, max] = log(session);
    expect(Number(fast!.split(" ")[1])).toBeGreaterThanOrEqual(3);
    expect(Number(max!.split(" ")[1])).toBeGreaterThanOrEqual(603);
    await clock.setSpeed(1);
    expect(clock.current.speed).toBe(1);
  }, 60000);

  it("jumps ahead while paused: the timers on the way fire in order, the program runs, and it stands still again", async () => {
    const session = await start(`
local f = fs.open("log.txt", "w")
local a, b = os.startTimer(30), os.startTimer(10)
f.writeLine("ready") f.flush()
for i = 1, 2 do
  local _, p = os.pullEvent("timer")
  f.writeLine(p == a and "a" or p == b and "b" or "?") f.flush()
end
sleep(5)
f.writeLine("after") f.flush()
os.pullEvent("never")`);
    const clock = new WorldClock(sessions);
    await until(() => log(session).length >= 1, 15000, "the timers");
    await clock.pause();
    await clock.jump(parseDuration("1m"));
    await sleep(300);
    expect(log(session)).toEqual(["ready", "b", "a", "after"]);
    expect((await clock.status()).paused).toBe(true);
  }, 60000);

  it("runs a sleep loop in a jump as often as the time it skips (a 1 s loop and 10 s: ten lines)", async () => {
    const session = await start(`
local f = fs.open("log.txt", "w")
f.writeLine("ready") f.flush()
while true do
  sleep(1)
  f.writeLine(string.format("%.2f", os.clock())) f.flush()
end`);
    const clock = new WorldClock(sessions);
    await until(() => log(session).length >= 1, 15000, "the program");
    await clock.pause();
    const before = log(session).length;
    await clock.jump(10_000);
    await sleep(300);
    const lines = log(session).slice(before).map(Number);
    expect(lines.length).toBe(10);
    for (let i = 1; i < lines.length; i++)
      expect(lines[i]! - lines[i - 1]!).toBeCloseTo(1, 1);
  }, 60000);

  it("harvests six times in an hour's jump with sleep(600) in a loop, running or paused", async () => {
    const session = await start(`
local f = fs.open("log.txt", "w")
f.writeLine("ready") f.flush()
while true do
  sleep(600)
  f.writeLine("harvest") f.flush()
end`);
    const clock = new WorldClock(sessions);
    await until(() => log(session).length >= 1, 15000, "the program");
    await clock.jump(parseDuration("1h"));
    await sleep(300);
    expect(log(session).filter((l) => l === "harvest")).toHaveLength(6);
    await clock.pause();
    await clock.jump(parseDuration("1h"));
    await sleep(300);
    expect(log(session).filter((l) => l === "harvest")).toHaveLength(12);
  }, 60000);

  it("keeps one time of day for the app's computers, through a reboot", async () => {
    const session = await start(`
local f = fs.open("log.txt", "w")
f.writeLine(string.format("%d %.2f", os.day(), os.time())) f.flush()
os.pullEvent("never")`);
    const clock = new WorldClock(sessions);
    await clock.sync();
    await clock.setWorldTime(1_200_000 + 600_000); // day 2, 18:00
    expect((await clock.status()).time).toMatch(/^Day 2, 18:0/);
    await session.handle.session.stop();
    session.handle.restart();
    await waitForBoot(session.handle.session);
    rmSync(join(session.handle.dir, "computer", "0", "log.txt"), {
      force: true,
    });
    session.handle.session.typeLine("prog");
    await until(() => log(session).length >= 1, 10000, "the time");
    const [day, time] = log(session)[0]!.split(" ").map(Number);
    expect(day).toBe(2);
    expect(time).toBeGreaterThanOrEqual(18);
    expect(time).toBeLessThan(18.5);
  }, 60000);

  it("leaves an agent's computers on their own clock until a control is used", async () => {
    const session = await start(
      `local f = fs.open("log.txt", "w") f.writeLine(os.day()) f.flush() os.pullEvent("never")`,
      "an agent",
    );
    const clock = new WorldClock(sessions);
    await clock.sync();
    await until(() => log(session).length >= 1, 10000, "the day");
    expect(log(session).map(Number)).toEqual([1]);
    expect((await clock.status()).computers.length).toBeLessThanOrEqual(1);
  }, 60000);
});
