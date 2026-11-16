import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  SessionManager,
  actAndSettle,
  checkConfig,
  describeAll,
  loadConfig,
  readWaiting,
  settle,
} from "./index.js";

const scratch = mkdtempSync(join(tmpdir(), "ui-ws-"));
const config = { ...loadConfig(), workspaceDir: scratch };
const ready = checkConfig(config).length === 0;
const manager = new SessionManager(config);

afterEach(async () => {
  await manager.destroyAll();
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// A text-mode button on a 2x2 monitor that counts touches, written for nobody in particular:
// the harness needs no cooperation from the program.
const PROGRAM = `
local m = peripheral.wrap("top")
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
local count = 0
while true do
  os.pullEvent("monitor_touch")
  count = count + 1
  m.setCursorPos(1, 9)
  m.write("touched " .. count)
end
`;

describe.skipIf(!ready)("monitor text scale", () => {
  it("resizes the grid like CC:Tweaked when setTextScale is called", async () => {
    writeFileSync(
      join(scratch, "startup.lua"),
      `local m = peripheral.wrap("top")
local sizes = {}
for _, s in ipairs({1, 0.5, 2, 5}) do
  m.setTextScale(s)
  local w, h = m.getSize()
  sizes[#sizes + 1] = s .. "=" .. w .. "x" .. h .. "@" .. m.getTextScale()
end
m.setTextScale(0.5)
m.clear()
m.setCursorPos(1, 1)
m.write(table.concat(sizes, " "))
while true do sleep(60) end
`,
    );
    const s = manager.create([{ name: "top", blocksWide: 5, blocksHigh: 6 }]);
    await settle(s.handle);
    // under load settle can return before the monitor's first frame is in
    const end = Date.now() + 10000;
    const top = () =>
      describeAll(s.handle).find(
        (u) => u.peripheral === "top" && u.texts[0]?.text.includes("5="),
      );
    while (!top() && Date.now() < end)
      await new Promise((r) => setTimeout(r, 50));
    const ui = top()!;
    expect([ui.width, ui.height]).toEqual([100, 81]);
    expect(ui.texts[0]?.text).toBe(
      "1=50x40@1 0.5=100x81@0.5 2=25x20@2 5=10x8@5",
    );
  }, 60000);
});

describe.skipIf(!ready)("screenshot-free introspection", () => {
  it("finds a button, touches it, and sees the program consume the touch", async () => {
    writeFileSync(join(scratch, "startup.lua"), PROGRAM);
    const s = manager.create([{ name: "top", blocksWide: 2, blocksHigh: 2 }]);
    const first = await settle(s.handle);
    expect(first.settled).toBe(true);
    expect(first.waiting?.blocked).toBe(true);

    const screens = describeAll(s.handle);
    const monitor = screens.find((u) => u.peripheral === "top")!;
    const button = monitor.rects.find((r) => r.color === "#7fcc19");
    expect(button).toBeDefined();
    expect(button!.w).toBeGreaterThanOrEqual(12);
    expect(monitor.texts.some((t) => t.text.includes("GO !!"))).toBe(true);

    const before = monitor.hash;
    const result = await actAndSettle(
      s.handle,
      () => s.handle.session.touchMonitor("top", button!.cx, button!.cy),
      { expect: "monitor_touch" },
    );
    expect(result.consumed).toBe(true);
    expect(result.settled).toBe(true);
    expect(readWaiting(s.handle)?.delivered["monitor_touch"]).toBeGreaterThan(
      0,
    );

    const after = describeAll(s.handle).find((u) => u.peripheral === "top")!;
    expect(after.hash).not.toBe(before);
    expect(after.texts.map((t) => t.text)).toContain("touched 1");
  }, 60000);
});
