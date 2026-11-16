import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { RawSession } from "./session.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const executable =
  process.env["CRAFTOS_EXE"] ?? join(root, "engine/build/craftos.exe");
const rom = process.env["CRAFTOS_ROM"] ?? join(root, "rom/cc-1.101.3");
const available = existsSync(executable) && existsSync(join(rom, "bios.lua"));

const sessions: RawSession[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.stop()));
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function start(files: Record<string, string>, boot?: string): RawSession {
  const dir = mkdtempSync(join(tmpdir(), "craftos-it-"));
  dirs.push(dir);
  mkdirSync(join(dir, "computer", "0"), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, "computer", "0", name), content);
  }
  // periphemu is only visible to the boot script; programs see plain CC:Tweaked.
  const bootArgs: string[] = [];
  if (boot) {
    const bootPath = join(dir, "boot.lua");
    writeFileSync(bootPath, boot);
    bootArgs.push("--script", bootPath);
  }
  const session = new RawSession({
    executable,
    args: ["--directory", dir, "--rom", rom, ...bootArgs],
  });
  sessions.push(session);
  return session;
}

describe.skipIf(!available)("RawSession against a real engine", () => {
  it("runs a program typed at the shell", async () => {
    const session = start({ "hello.lua": 'print("hi from lua")' });
    await session.waitForText(">", 0, 15000);
    session.typeLine("hello");
    await session.waitForText("hi from lua", 0, 10000);
    expect(session.screen()?.lines.join("\n")).toContain("hi from lua");
  }, 30000);

  it("exposes a monitor as its own window and delivers touch events", async () => {
    const session = start(
      {
        "mon.lua": `
        local m = peripheral.wrap("top")
        m.setBackgroundColor(colors.blue)
        m.clear()
        m.setCursorPos(1, 1)
        m.write("MONITOR READY")
        local _, side, x, y = os.pullEvent("monitor_touch")
        m.setCursorPos(1, 2)
        m.write("touched " .. x .. "," .. y)
        sleep(0.2)
        os.shutdown(7)
      `,
      },
      'periphemu.create("top", "monitor")',
    );
    await session.waitForText(">", 0, 15000);
    session.typeLine("mon");
    await session.waitFor(
      () => [...session.windows.values()].some((w) => w.isMonitor && w.frame),
      10000,
    );
    const monitor = [...session.windows.values()].find((w) => w.isMonitor)!;
    await session.waitForText("MONITOR READY", monitor.id, 10000);
    expect(monitor.peripheral).toBe("top");
    session.touchMonitor("top", 3, 1);
    await session.waitForText("touched 3,1", monitor.id, 10000);
    const exit = await session.waitForExit(10000);
    expect(exit.code).toBe(7);
  }, 40000);
});
