// The browser app's time controls and snapshots over HTTP (webapp-time.ts), driven as webapp/timecontrol.js drives
// them. The page itself was checked with Playwright screenshots by hand.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SessionManager,
  checkConfig,
  loadConfig,
  startWebApp,
} from "./index.js";

const scratch = mkdtempSync(join(tmpdir(), "webapp-time-ws-"));
const store = mkdtempSync(join(tmpdir(), "webapp-time-snaps-"));
process.env["CRAFTOS_SNAPSHOTS"] = store;
writeFileSync(
  join(scratch, "count.lua"),
  'local n = 0 while true do sleep(1) n = n + 1 term.clear() term.setCursorPos(1, 1) print("count " .. n) end\n',
);
const config = { ...loadConfig(), workspaceDir: scratch };
const ready = checkConfig(config).length === 0;
const manager = new SessionManager(config);
const server = startWebApp({
  port: 0,
  sessions: manager,
  config,
  onListening: () => undefined,
});
let base = "";

beforeAll(async () => {
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await manager.destroyAll();
  rmSync(scratch, { recursive: true, force: true });
  rmSync(store, { recursive: true, force: true });
});

async function call(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
) {
  const res = await fetch(base + path, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text}`);
  return text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

async function screen(id: string): Promise<string> {
  const screens = (await call(`/api/sessions/${id}/screens`)) as {
    peripheral?: string;
    lines: string[];
  }[];
  return screens.find((s) => !s.peripheral)?.lines.join("\n") ?? "";
}

describe.skipIf(!ready)("browser app time controls", () => {
  it("serves the bar's files and hooks them into the page", async () => {
    const page = await call("/");
    expect(page).toContain("/timecontrol.js");
    expect(page).toContain("/timecontrol.css");
    expect(await call("/timecontrol.js")).toContain("Time controls");
    expect(await call("/timecontrol.css")).toContain(".timebar");
  });

  it("says there is nothing to control before there are computers", async () => {
    const clock = await call("/api/clock");
    expect(clock).toMatchObject({ paused: false, speed: 1, computers: [] });
  });

  it("pauses, steps, speeds up, jumps, sets the time of day and resumes", async () => {
    const { ids } = await call("/api/sessions", {
      name: "counter",
      program: "count",
    });
    const id = ids[0] as string;
    const start = Date.now();
    while (!/count 2/.test(await screen(id))) {
      if (Date.now() - start > 20000) throw new Error(await screen(id));
      await sleep(100);
    }
    let clock = await call(`/api/clock?front=${id}`);
    expect(clock.computers.map((c: { id: string }) => c.id)).toEqual([id]);
    expect(clock.time).toMatch(/^Day 1, 06:0/);

    clock = await call("/api/clock", { action: "pause" });
    expect(clock).toMatchObject({ paused: true, stopped: true });
    const frozen = await screen(id);
    await sleep(2500);
    expect(await screen(id)).toBe(frozen);

    // a sim command while paused says why it waits
    const res = await fetch(`${base}/api/sessions/${id}/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: { cmd: "addPlayer", name: "Zed" } }),
    });
    expect(((await res.json()) as { error?: string }).error).toMatch(
      /the world is paused/,
    );

    // twenty ticks are a second: the counter goes up by one
    const before = Number(/count (\d+)/.exec(frozen)![1]);
    await call("/api/clock", { action: "step", ticks: 20 });
    await sleep(300);
    expect(Number(/count (\d+)/.exec(await screen(id))![1])).toBe(before + 1);

    clock = await call("/api/clock", { action: "speed", speed: 5 });
    expect(clock.speed).toBe(5);
    clock = await call("/api/clock", { action: "jump", amount: "1d" });
    expect(clock.time).toMatch(/^Day 2, /);
    clock = await call("/api/clock", { action: "time", amount: "18:00" });
    expect(clock.time).toMatch(/^Day 2, 18:00/);
    await expect(
      call("/api/clock", { action: "jump", amount: "soon" }),
    ).rejects.toThrow(/not a length of time/);
    await expect(call("/api/clock", { action: "fly" })).rejects.toThrow(
      /action is/,
    );

    clock = await call("/api/clock", { action: "toggle" });
    expect(clock.paused).toBe(false);
    clock = await call("/api/clock", { action: "speed", speed: 1 });
    expect(clock).toMatchObject({ paused: false, speed: 1 });
  }, 90000);

  it("saves, lists, exports, imports, restores and deletes snapshots", async () => {
    const saved = await call("/api/snapshots", { name: "first" });
    expect(saved.name).toBe("first");
    expect(saved.computers[0].name).toBe("counter");
    const file = await fetch(`${base}/api/snapshots/first/file`);
    expect(file.headers.get("content-disposition")).toContain(
      "first.craftos-world",
    );
    const data = Buffer.from(await file.arrayBuffer());
    const imported = await fetch(`${base}/api/snapshots/import?name=shared`, {
      method: "POST",
      body: data,
    });
    expect(imported.ok).toBe(true);
    const { snapshots } = await call("/api/snapshots");
    expect(snapshots.map((s: { name: string }) => s.name).sort()).toEqual([
      "first",
      "shared",
    ]);
    // a computer made after the snapshot is closed by the restore; the counter reboots and its program runs again
    const { ids } = await call("/api/sessions", { name: "later" });
    const restored = await call("/api/snapshots/shared/restore", {});
    expect(restored.closed).toEqual(ids);
    const list = (await call("/api/sessions")).sessions as {
      name: string;
    }[];
    expect(list.map((s) => s.name)).toEqual(["counter"]);
    await call("/api/snapshots/shared", undefined, "DELETE");
    await expect(call("/api/snapshots/shared/restore", {})).rejects.toThrow(
      /no snapshot named shared/,
    );
    await expect(call("/api/snapshots", { name: "../escape" })).rejects.toThrow(
      /snapshot name/,
    );
  }, 90000);
});
