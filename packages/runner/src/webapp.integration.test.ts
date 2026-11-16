// The browser app's HTTP API, driven with fetch as the page drives it: make a computer, type, touch a monitor, send
// sim commands, edit a file. (The page itself is tested with Playwright by hand; see webapp.ts.)
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

const scratch = mkdtempSync(join(tmpdir(), "webapp-ws-"));
writeFileSync(join(scratch, "hello.lua"), 'print("hello from the folder")\n');
writeFileSync(
  join(scratch, "touch.lua"),
  'local m = peripheral.wrap("top") m.write("ready")\n' +
    'while true do local _, _, x, y = os.pullEvent("monitor_touch") print("touch " .. x .. "," .. y) end\n',
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

async function terminal(id: string, re: RegExp, ms = 15000): Promise<string> {
  const start = Date.now();
  let text = "";
  while (Date.now() - start < ms) {
    const screens = (await call(`/api/sessions/${id}/screens`)) as {
      peripheral?: string;
      lines: string[];
    }[];
    text = screens.find((s) => !s.peripheral)?.lines.join("\n") ?? "";
    if (re.test(text)) return text;
    await new Promise((r) => setTimeout(r, 100));
  }
  return text;
}

describe.skipIf(!ready)("browser app API", () => {
  it("serves the page and what the form needs", async () => {
    expect(await call("/")).toContain("New computer");
    const meta = await call("/api/meta");
    expect(meta.addons.map((a: { id: string }) => a.id)).toContain(
      "toms-peripherals",
    );
    expect(meta.programs).toEqual(
      expect.arrayContaining(["hello.lua", "touch.lua"]),
    );
  });

  it("refuses requests from other sites", async () => {
    const res = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: {
        origin: "http://evil.example",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  it("makes a computer, types, touches, sends sim commands and edits files", async () => {
    const { ids } = await call("/api/sessions", {
      name: "t",
      monitors: [{ name: "top", blocksWide: 2, blocksHigh: 1 }],
      program: "touch.lua",
      world: {},
    });
    const id = ids[0] as string;
    const list = await call("/api/sessions");
    expect(list.sessions[0]).toMatchObject({
      id,
      name: "t",
      kind: "computer",
      advanced: true,
    });

    // the program from the form starts, and a touch lands on the right cell
    await terminal(id, /touch\.lua/);
    await new Promise((r) => setTimeout(r, 300));
    await call(`/api/sessions/${id}/touch`, { monitor: "top", x: 3, y: 2 });
    expect(await terminal(id, /touch 3,2/)).toMatch(/touch 3,2/);

    // a PNG of each screen
    const png = await fetch(`${base}/api/sessions/${id}/window/0.png`);
    expect(png.headers.get("content-type")).toBe("image/png");

    // Ctrl+T, then type a command
    await call(`/api/sessions/${id}/shortcut`, { key: "t" });
    await terminal(id, /Terminated/);
    await call(`/api/sessions/${id}/input`, {
      events: [
        { type: "char", text: "hello" },
        { type: "key", key: "enter" },
        { type: "keyup", key: "enter" },
      ],
    });
    expect(await terminal(id, /hello from the folder/)).toMatch(
      /hello from the folder/,
    );

    // sim commands: one that works, one the world does not know
    expect(
      await call(`/api/sessions/${id}/command`, {
        command: { cmd: "addPlayer", name: "Alex" },
      }),
    ).toEqual({
      applied: true,
    });
    const bad = await call(`/api/sessions/${id}/command`, {
      command: { cmd: "nope" },
    });
    expect(bad.error).toMatch(/unknown command/);
    const state = await call(`/api/sessions/${id}/state`);
    expect(JSON.stringify(state)).toContain("Alex");
    const { commands } = await call(`/api/sessions/${id}/commands`);
    expect(commands.map((c: { cmd: string }) => c.cmd)).toEqual(
      expect.arrayContaining(["advance", "chat", "tmTouch"]),
    );

    // files: edit one and run it
    const files = await call(`/api/sessions/${id}/files`);
    expect(files.entries.map((e: { path: string }) => e.path)).toContain(
      "hello.lua",
    );
    await call(`/api/sessions/${id}/file?path=hello.lua`, undefined, "GET");
    const put = await fetch(`${base}/api/sessions/${id}/file?path=hello.lua`, {
      method: "PUT",
      body: 'print("edited")',
    });
    expect(put.ok).toBe(true);
    const escape = await fetch(
      `${base}/api/sessions/${id}/file?path=../x.lua`,
      { method: "PUT", body: "" },
    );
    expect(escape.status).toBe(400);
    await call(`/api/sessions/${id}/input`, {
      events: [
        { type: "paste", text: "hello" },
        { type: "key", key: "enter" },
      ],
    });
    expect(await terminal(id, /edited/)).toMatch(/edited/);

    // reboot is seen through, not timed out into a hard restart; shut down, then turn on again
    let start = Date.now();
    await call(`/api/sessions/${id}/reboot`, {});
    expect(Date.now() - start).toBeLessThan(2500);
    expect(await terminal(id, /^CraftOS 1\.8(?![\s\S]*edited)/)).not.toMatch(
      /edited/,
    );
    await call(`/api/sessions/${id}/shutdown`, {});
    start = Date.now();
    let off = (await call("/api/sessions")).sessions[0];
    while (off.running && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 50));
      off = (await call("/api/sessions")).sessions[0];
    }
    expect(off.running).toBe(false);
    await call(`/api/sessions/${id}/start`, {});
    expect(await terminal(id, /^CraftOS 1\.8/)).toMatch(/CraftOS/);
    expect((await call("/api/sessions")).sessions[0].running).toBe(true);

    await call(`/api/sessions/${id}`, undefined, "DELETE");
    expect((await call("/api/sessions")).sessions).toHaveLength(0);
  }, 60000);

  it("makes a normal computer without colour", async () => {
    const { ids } = await call("/api/sessions", { advanced: false, world: {} });
    const id = ids[0] as string;
    await terminal(id, />/);
    await call(`/api/sessions/${id}/input`, {
      events: [
        { type: "char", text: "lua" },
        { type: "key", key: "enter" },
      ],
    });
    await terminal(id, /lua>/);
    await call(`/api/sessions/${id}/input`, {
      events: [
        { type: "char", text: "term.isColor()" },
        { type: "key", key: "enter" },
      ],
    });
    expect(await terminal(id, /false/)).toMatch(
      /lua> term\.isColor\(\)\s*\nfalse/,
    );
    await call(`/api/sessions/${id}`, undefined, "DELETE");
  }, 30000);
});
