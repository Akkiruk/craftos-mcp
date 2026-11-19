import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { EnginePool, type PoolComputerSpec } from "./pool.js";
import type { RawSession } from "./session.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const executable =
  process.env["CRAFTOS_EXE"] ?? join(root, "engine/build/craftos.exe");
const rom = process.env["CRAFTOS_ROM"] ?? join(root, "rom/cc-1.101.3");
const available = existsSync(executable) && existsSync(join(rom, "bios.lua"));

const pools: EnginePool[] = [];
const sessions: RawSession[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.stop()));
  for (const pool of pools.splice(0)) pool.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function pool(capacity = 8): EnginePool {
  const base = mkdtempSync(join(tmpdir(), "craftos-pool-"));
  dirs.push(base);
  const p = new EnginePool({
    executable,
    args: ["--directory", base, "--rom", rom],
    capacity,
    idleMs: 0,
  });
  pools.push(p);
  return p;
}

/** A computer of its own folder, with `files` on it and `boot` as its --script. */
function computer(
  p: EnginePool,
  files: Record<string, string>,
  boot?: string,
  extra: Partial<PoolComputerSpec> = {},
): { session: RawSession; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "craftos-pooled-"));
  dirs.push(dir);
  const id = extra.id ?? 0;
  mkdirSync(join(dir, "computer", String(id)), { recursive: true });
  for (const [name, content] of Object.entries(files))
    writeFileSync(join(dir, "computer", String(id), name), content);
  let script: string | undefined;
  if (boot) {
    script = join(dir, "boot.lua");
    writeFileSync(script, boot);
  }
  const session = p.start({
    id,
    base: dir,
    computers: join(dir, "computer"),
    ...(script && { script }),
    ...extra,
  });
  sessions.push(session);
  return { session, dir };
}

describe.skipIf(!available)("EnginePool against a real engine", () => {
  it("runs several computers in one engine, each with its own screen, files and input", async () => {
    const p = pool();
    const a = computer(p, { "who.lua": 'print("I am A")' });
    const b = computer(p, { "who.lua": 'print("I am B")' });
    expect(p.stats).toEqual({ processes: 1, computers: 2 });
    await a.session.waitForText(">", 0, 15000);
    await b.session.waitForText(">", 0, 15000);
    b.session.typeLine("who");
    await b.session.waitForText("I am B", 0, 10000);
    a.session.typeLine("who");
    await a.session.waitForText("I am A", 0, 10000);
    expect(a.session.screen()?.lines.join("\n")).not.toContain("I am B");
    expect(b.session.screen()?.lines.join("\n")).not.toContain("I am A");
  }, 40000);

  it("reports each computer's own os.shutdown code, and the others run on", async () => {
    const p = pool();
    const a = computer(p, {}, "os.shutdown(3)");
    const b = computer(p, { "x.lua": 'print("still here")' });
    expect((await a.session.waitForExit(15000)).code).toBe(3);
    await b.session.waitForText(">", 0, 15000);
    b.session.typeLine("x");
    await b.session.waitForText("still here", 0, 10000);
    expect(b.session.running).toBe(true);
  }, 40000);

  it("gives every computer a monitor window numbered as its own, with touches going to it", async () => {
    const p = pool();
    const program = (tag: string): string => `
      local m = peripheral.wrap("top")
      m.write("${tag}")
      local _, side, x, y = os.pullEvent("monitor_touch")
      m.setCursorPos(1, 2)
      m.write("touched ${tag} " .. x .. "," .. y)
      sleep(0.1)
      os.shutdown(0)
    `;
    const a = computer(
      p,
      { "startup.lua": program("A") },
      'periphemu.create("top", "monitor")',
    );
    const b = computer(
      p,
      { "startup.lua": program("B") },
      'periphemu.create("top", "monitor")',
    );
    for (const [c, tag] of [
      [a, "A"],
      [b, "B"],
    ] as const)
      await c.session.waitFor(
        () =>
          [...c.session.windows.values()].some(
            (w) =>
              w.isMonitor &&
              w.frame !== undefined &&
              c.session.screen(w.id)?.lines[0]?.startsWith(tag),
          ),
        15000,
      );
    const monitorOf = (s: RawSession): number =>
      [...s.windows.values()].find((w) => w.isMonitor)!.id;
    // each computer numbers its own windows: terminal 0, its monitor next
    expect(monitorOf(a.session)).toBe(monitorOf(b.session));
    b.session.touchMonitor("top", 2, 1);
    await b.session.waitForExit(10000);
    expect(
      b.session.closedWindows.some(
        (w) => w.isMonitor && w.frame && w.frame.text.length > 0,
      ),
    ).toBe(true);
    expect(a.session.running).toBe(true);
    a.session.touchMonitor("top", 3, 1);
    expect((await a.session.waitForExit(10000)).code).toBe(0);
  }, 40000);

  it("keeps a clock per computer: pausing one leaves the other running", async () => {
    const p = pool();
    const tick = `local n = 0 while true do sleep(0.05) n = n + 1 local h = fs.open("ticks", "w") h.write(n) h.close() end`;
    const a = computer(p, { "startup.lua": tick });
    const b = computer(p, { "startup.lua": tick });
    const ticks = (dir: string): number => {
      try {
        return Number(
          readFileSync(join(dir, "computer", "0", "ticks"), "utf8"),
        );
      } catch {
        return 0;
      }
    };
    await a.session
      .waitFor(() => ticks(a.dir) > 2 && ticks(b.dir) > 2, 15000)
      .catch(() => undefined);
    const until = async (ok: () => boolean, ms: number): Promise<void> => {
      const end = Date.now() + ms;
      while (!ok() && Date.now() < end)
        await new Promise((r) => setTimeout(r, 50));
    };
    await until(() => ticks(a.dir) > 2 && ticks(b.dir) > 2, 15000);
    a.session.event("ccsim_clock:1:pause");
    await new Promise((r) => setTimeout(r, 400));
    const aPaused = ticks(a.dir);
    const bBefore = ticks(b.dir);
    await new Promise((r) => setTimeout(r, 800));
    expect(ticks(a.dir)).toBe(aPaused);
    expect(ticks(b.dir)).toBeGreaterThan(bBefore + 3);
    a.session.event("ccsim_clock:2:resume");
    await until(() => ticks(a.dir) > aPaused + 2, 5000);
    expect(ticks(a.dir)).toBeGreaterThan(aPaused);
  }, 40000);

  it("survives a clock jump on a computer whose clock last belonged to one that left a fired timer unread", async () => {
    // The first computer's timer fires while it is busy, and it shuts down without reading the event: the timer stayed
    // in the engine's table, pointing at the gone computer. The next computer gets the same clock domain, and its
    // os.__ccsimAdvance fired that timer at the dead computer (a crash in notifyEvent, 2026-11-18). Several rounds,
    // and two computers jumping at once.
    const p = pool(8);
    // one that stays on keeps the engine (and its released clock domains) between the others
    const keeper = computer(p, {});
    await keeper.session.waitForText(">", 0, 15000);
    const leaver = `os.startTimer(0.05)
      local t = os.clock() while os.clock() - t < 0.3 do end
      os.shutdown(0)`;
    const jumper = `for i = 1, 20 do os.startTimer(0.5) os.__ccsimAdvance(1) end
      local h = fs.open("done", "w") h.write("yes") h.close()
      os.shutdown(5)`;
    for (let round = 0; round < 3; round++) {
      const left = [computer(p, {}, leaver), computer(p, {}, leaver)];
      for (const l of left)
        expect((await l.session.waitForExit(15000)).code).toBe(0);
      const jumpers = [computer(p, {}, jumper), computer(p, {}, jumper)];
      for (const j of jumpers) {
        expect((await j.session.waitForExit(15000)).code).toBe(5);
        expect(readFileSync(join(j.dir, "computer", "0", "done"), "utf8")).toBe(
          "yes",
        );
      }
    }
    expect(p.stats).toEqual({ processes: 1, computers: 1 });
    expect(keeper.session.running).toBe(true);
  }, 60000);

  it("stops a computer stuck in a loop, and starts a second engine when the first is full", async () => {
    const p = pool(2);
    const stuck = computer(p, { "startup.lua": "while true do end" });
    computer(p, {});
    const third = computer(p, { "x.lua": 'print("third")' });
    expect(p.stats.processes).toBe(2);
    await third.session.waitForText(">", 0, 15000);
    const info = await stuck.session.stop(500);
    expect(stuck.session.running).toBe(false);
    expect(info).toBeDefined();
  }, 40000);
});
