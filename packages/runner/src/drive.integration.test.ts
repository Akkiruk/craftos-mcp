import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  SessionManager,
  checkConfig,
  loadConfig,
  readTrace,
  runScript,
  sendAndWait,
  setLabels,
  settle,
  simState,
  uiDelta,
} from "./index.js";

const scratch = mkdtempSync(join(tmpdir(), "drive-ws-"));
const config = { ...loadConfig(), workspaceDir: scratch };
const ready = checkConfig(config).length === 0;
const manager = new SessionManager(config);

afterEach(async () => {
  await manager.destroyAll();
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// Seeds itself from the clock, like many games do, and has a 30 s timeout.
const PROGRAM = `
local m = peripheral.wrap("top")
math.randomseed(os.epoch("utc"))
print("roll", math.random(1000000))
m.setBackgroundColor(colors.black)
m.clear()
m.setBackgroundColor(colors.lime)
m.setTextColor(colors.black)
for y = 2, 5 do
  m.setCursorPos(2, y)
  m.write(y == 3 and "    GO !!   " or "            ")
end
m.setBackgroundColor(colors.black)
m.setTextColor(colors.white)
local timer = os.startTimer(30)
local count = 0
while true do
  local e, a = os.pullEvent()
  if e == "monitor_touch" then
    count = count + 1
    m.setCursorPos(1, 9)
    m.write("touched " .. count)
  elseif e == "timer" and a == timer then
    m.setCursorPos(1, 11)
    m.write("timeout")
    print("timed out")
  end
end
`;

const CHEST = {
  name: "chest_0",
  type: "minecraft:chest",
  items: { "1": { name: "minecraft:dirt", count: 5 } },
};

function start(seed?: number) {
  writeFileSync(join(scratch, "startup.lua"), PROGRAM);
  const s = manager.create([{ name: "top", blocksWide: 2, blocksHigh: 2 }], 1, {
    players: [{ name: "Alice" }],
    peripherals: [CHEST],
    ...(seed === undefined ? {} : { seed }),
  });
  return s;
}

describe.skipIf(!ready)("scripted driving", () => {
  it("runs a whole scenario in one call: labels, touch, expect, clock jump, trace", async () => {
    const { handle } = start(42);
    await settle(handle);
    setLabels(handle, { GO: { color: "#7fcc19" } });

    const result = await runScript(handle, [
      { expect: [{ rect: { name: "GO" } }, { text: { contains: "GO !!" } }] },
      { touch: { name: "GO" } },
      { expect: [{ text: { contains: "touched 1" } }] },
      {
        sim: {
          cmd: "setItem",
          peripheral: "chest_0",
          slot: 1,
          item: { name: "minecraft:dirt", count: 9 },
        },
      },
      {
        expect: [{ sim: { path: "inventories.chest_0.1.count", equals: 9 } }],
      },
      { advance: 31 },
      { expect: [{ text: { contains: "timeout" } }] },
    ]);
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.ran).toBe(7);

    const trace = readTrace(handle);
    expect(trace.events.some((e) => e.includes("monitor_touch top"))).toBe(
      true,
    );
    expect(trace.output.some((o) => o.includes("roll"))).toBe(true);
    expect(trace.output.some((o) => o.includes("timed out"))).toBe(true);
    expect(readTrace(handle).events).toEqual([]);
  }, 60000);

  it("reports the nearest matches and saves evidence when an expectation fails", async () => {
    const { handle } = start();
    await settle(handle);
    const result = await runScript(handle, [
      { expect: [{ rect: { color: "#7fcc18" } }] },
      { touch: { name: "NOPE" } },
    ]);
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    const failure = result.failures[0]!;
    expect(failure.step).toBe(0);
    expect(failure.failures?.[0]?.nearest?.[0]).toContain("#7fcc19");
    expect(result.evidence?.length).toBeGreaterThan(0);
    for (const file of result.evidence!) expect(existsSync(file)).toBe(true);
  }, 60000);

  it("fails a touch the program never consumed", async () => {
    writeFileSync(join(scratch, "startup.lua"), "while true do sleep(1) end");
    const { handle } = manager.create([
      { name: "top", blocksWide: 1, blocksHigh: 1 },
    ]);
    await settle(handle);
    const result = await runScript(
      handle,
      [{ touch: { monitor: "top", x: 2, y: 2 } }],
      { timeoutMs: 1500 },
    );
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.reason).toContain("never consumed");
  }, 60000);

  it("returns only what changed between views", async () => {
    const { handle } = start();
    await settle(handle);
    const first = uiDelta(handle);
    expect(first.some((s) => "rects" in s && Array.isArray(s.rects))).toBe(
      true,
    );
    const second = uiDelta(handle);
    expect(second.every((s) => "unchanged" in s && s.unchanged)).toBe(true);
    await runScript(handle, [{ touch: { monitor: "top", x: 5, y: 3 } }], {
      ui: "none",
    });
    const third = uiDelta(handle).find((s) => s.screen === "top")!;
    expect(third).not.toHaveProperty("unchanged");
    expect(JSON.stringify(third)).toContain("touched 1");
  }, 60000);

  it("diffs the sim state", async () => {
    const { handle } = start();
    await settle(handle);
    simState(handle, true);
    await sendAndWait(handle, {
      cmd: "setItem",
      peripheral: "chest_0",
      slot: 1,
      item: { name: "minecraft:dirt", count: 7 },
    });
    const diff = simState(handle, true) as { changed: Record<string, unknown> };
    expect(diff.changed["inventories.chest_0.1.count"]).toEqual({
      from: 5,
      to: 7,
    });
    expect(simState(handle, true)).toEqual({ changed: {} });
  }, 60000);

  it("pins math.random even when the program seeds itself from the clock", async () => {
    const rolls: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { handle } = start(1234);
      await settle(handle);
      await new Promise((r) => setTimeout(r, 1100)); // the clock moves between runs
      rolls.push(
        readTrace(handle).output.find((o) => o.includes("roll")) ?? "",
      );
      await manager.destroyAll();
    }
    expect(rolls[0]).toContain("roll");
    expect(rolls[0]!.replace(/^\S+ /, "")).toBe(rolls[1]!.replace(/^\S+ /, ""));
  }, 90000);
});
