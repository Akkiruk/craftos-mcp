// The browser app's world panel, through its HTTP API as the page drives it: the world of a running computer
// changed block by block, with the events the game sends; normal monitors; world files of the project.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const scratch = mkdtempSync(join(tmpdir(), "webapp-world-"));
// prints every peripheral event it hears, and answers "colour?" questions about the monitor on top
writeFileSync(
  join(scratch, "watch.lua"),
  [
    'print("watching")',
    "while true do",
    "  local e = { os.pullEvent() }",
    '  if e[1] == "peripheral" or e[1] == "peripheral_detach" or e[1] == "monitor_resize" or e[1] == "monitor_touch" then',
    '    print(e[1] .. " " .. tostring(e[2]))',
    '  elseif e[1] == "char" and e[2] == "c" then',
    '    local m = peripheral.wrap("top")',
    "    m.setPaletteColour(colours.red, 1, 0, 0)",
    "    local r, g, b = m.getPaletteColour(colours.red)",
    '    print("colour " .. tostring(m.isColour()) .. " " .. r .. "," .. g .. "," .. b .. " " .. #peripheral.getNames())',
    "  end",
    "end",
  ].join("\n"),
);
writeFileSync(
  join(scratch, "base.world.json"),
  `{\n  "players": [{ "name": "Steve" }]\n}\n`,
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
          body: typeof body === "string" ? body : JSON.stringify(body),
        }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text}`);
  return text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text;
}

async function terminal(id: string, re: RegExp, ms = 20000): Promise<string> {
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
  throw new Error(`the terminal never showed ${re}:\n${text}`);
}

interface Result {
  steps: { what: string; ok: boolean; error?: string }[];
  later: string[];
}
const put = (id: string, world: unknown): Promise<Result> =>
  call(`/api/sessions/${id}/world`, { world }, "PUT");

describe.skipIf(!ready)("world panel API", () => {
  it("serves the panel, the shared editor modules, the schema and the mod list", async () => {
    expect(await call("/")).toContain("/worldpanel.js");
    expect(await call("/worldpanel.js")).toContain("/world-editor/picker.js");
    expect(await call("/world-editor/model.js")).toContain(
      "export function thingsOf",
    );
    // the modules import each other as .js, as a browser needs
    expect(await call("/world-editor/form.js")).toContain('from "./schema.js"');
    const meta = await call("/api/world-editor");
    expect(
      meta.schema.definitions.MonitorSpec.properties.advanced,
    ).toBeDefined();
    expect(meta.catalog.addons.map((a: { id: string }) => a.id)).toContain(
      "advanced-peripherals",
    );
    await expect(call("/world-editor/..%2Fpackage.json")).rejects.toThrow(
      /404/,
    );
  });

  it("changes the world of a running computer as the game would, and a reboot keeps them", async () => {
    const { ids } = await call("/api/sessions", {
      name: "panel",
      program: "watch",
    });
    const id = ids[0] as string;
    await terminal(id, /watching/);
    const start = await call(`/api/sessions/${id}/world`);
    expect(start.world.simProgram).toBeUndefined();
    expect(start.running).toBe(true);

    // a chest on the left, a normal monitor on top, a player
    let r = await put(id, {
      peripherals: [{ name: "left", type: "minecraft:chest" }],
      monitors: [
        { name: "top", blocksWide: 2, blocksHigh: 1, advanced: false },
      ],
      players: [{ name: "Alice", x: 1, y: 64, z: 1 }],
    });
    expect(
      r.steps.every((s) => s.ok),
      JSON.stringify(r),
    ).toBe(true);
    await terminal(
      id,
      /peripheral top[\s\S]*peripheral left|peripheral left[\s\S]*peripheral top/,
    );

    // the normal monitor: greys, isColour false, its palette reads back what was set
    await call(`/api/sessions/${id}/input`, {
      events: [{ type: "char", text: "c" }],
    });
    const colour = await terminal(id, /colour /);
    expect(colour).toMatch(/colour false 1,0,0/);
    // a touch on it does nothing
    await call(`/api/sessions/${id}/touch`, { monitor: "top", x: 2, y: 2 });
    await new Promise((res) => setTimeout(res, 600));
    expect(await terminal(id, /watching/)).not.toMatch(/monitor_touch/);

    // contents in place; a wider wall; Alice moves
    r = await put(id, {
      peripherals: [
        {
          name: "left",
          type: "minecraft:chest",
          items: { "2": { name: "minecraft:diamond", count: 4 } },
        },
      ],
      monitors: [
        { name: "top", blocksWide: 3, blocksHigh: 2, advanced: false },
      ],
      players: [{ name: "Alice", x: 7, y: 64, z: 1 }],
    });
    expect(r.steps.map((s) => s.what)).toEqual([
      "The monitor on the top is now 3x2 blocks",
      "Put 4 minecraft:diamond in slot 2 of left",
      "Alice moved to 7, 64, 1",
    ]);
    expect(r.steps.every((s) => s.ok)).toBe(true);
    await terminal(id, /monitor_resize top/);
    const state = await call(`/api/sessions/${id}/state`);
    expect(state.inventories.left["2"]).toMatchObject({
      name: "minecraft:diamond",
      count: 4,
    });

    // the chest moves to the network; a mod block that is not in this world fails with the reason
    r = await put(id, {
      peripherals: [
        { name: "minecraft:chest_0", type: "minecraft:chest" },
        { name: "right", type: "no_such_block_type" },
      ],
      monitors: [
        { name: "top", blocksWide: 3, blocksHigh: 2, advanced: false },
      ],
      players: [{ name: "Alice", x: 7, y: 64, z: 1 }],
    });
    await terminal(
      id,
      /peripheral_detach left[\s\S]*peripheral minecraft:chest_0/,
    );
    expect(r.steps.find((s) => s.what.includes("no_such_block_type"))?.ok).toBe(
      false,
    );

    // world.json now has the chest on the network: after a reboot it is still there
    const engineWorld = JSON.parse(
      readFileSync(
        join(manager.get(id).handle.resultsDir, "world.json"),
        "utf8",
      ),
    );
    expect(
      engineWorld.peripherals.map((p: { name: string }) => p.name),
    ).toContain("minecraft:chest_0");
    expect(engineWorld.simProgram).toBe(true);
    await call(`/api/sessions/${id}/reboot`, {});
    // the screen clears and the shell is back: run the watcher again
    await terminal(id, /^CraftOS[^\n]*\n>\s*$/);
    await call(`/api/sessions/${id}/input`, {
      events: [
        { type: "paste", text: "watch" },
        { type: "key", key: "enter" },
      ],
    });
    await terminal(id, /watching/);
    await call(`/api/sessions/${id}/input`, {
      events: [{ type: "char", text: "c" }],
    });
    // top (the monitor, still normal), minecraft:chest_0: right failed to attach
    expect(await terminal(id, /colour /)).toMatch(/colour false 1,0,0 2/);

    // the world as the panel keeps it, for Save
    const now = await call(`/api/sessions/${id}/world`);
    expect(now.world.monitors).toEqual([
      { name: "top", blocksWide: 3, blocksHigh: 2, advanced: false },
    ]);
    await call(`/api/sessions/${id}`, undefined, "DELETE");
  }, 90_000);

  it("gives each computer of a network its own id", async () => {
    const { ids } = await call("/api/sessions", { name: "base", count: 3 });
    const worlds = await Promise.all(
      (ids as string[]).map((id) => call(`/api/sessions/${id}/world`)),
    );
    expect(worlds.map((w) => w.world.computerId)).toEqual([0, 1, 2]);
    for (const id of ids as string[])
      await call(`/api/sessions/${id}`, undefined, "DELETE").catch(
        () => undefined,
      );
  });

  it("follows what the shell changes: a monitor attached, a player who joined, a block broken", async () => {
    const { ids } = await call("/api/sessions", { name: "shell" });
    const id = ids[0] as string;
    await terminal(id, /> ?$/m);
    const type = async (line: string, until: RegExp): Promise<void> => {
      await call(`/api/sessions/${id}/input`, {
        events: [
          { type: "paste", text: line },
          { type: "key", key: "enter" },
        ],
      });
      await terminal(id, until);
    };
    const world = async (
      check: (w: Record<string, unknown>) => boolean,
    ): Promise<Record<string, unknown>> => {
      let got: Record<string, unknown> = {};
      for (let i = 0; i < 100; i++) {
        got = (await call(`/api/sessions/${id}/world`)).world;
        if (check(got)) return got;
        await new Promise((r) => setTimeout(r, 100));
      }
      return got;
    };
    await type("attach top monitor", /Placed a monitor/);
    await type("sim join Alice", /join Alice\s*\nok/);
    await type("attach left chest", /Placed a chest/);
    let w = await world(
      (x) =>
        Array.isArray(x["players"]) &&
        Array.isArray(x["monitors"]) &&
        Array.isArray(x["peripherals"]),
    );
    expect(w["monitors"]).toEqual([
      { name: "top", blocksWide: 5, blocksHigh: 3 },
    ]);
    expect(w["players"]).toEqual([{ name: "Alice" }]);
    expect(w["peripherals"]).toEqual([
      { name: "left", type: "minecraft:chest", size: 27 },
    ]);

    // a change from the panel starts from there: nothing done twice
    const r = await put(id, {
      ...w,
      players: [{ name: "Alice", x: 5, y: 64, z: 0 }],
    });
    expect(r.steps.map((s) => s.what)).toEqual([
      expect.stringMatching(/Alice/),
    ]);
    expect(r.steps.every((s) => s.ok)).toBe(true);

    await type("detach top", /Took the peripheral off top/);
    await type("sim leave Alice", /leave Alice\s*\nok/);
    w = await world(
      (x) =>
        x["monitors"] === undefined &&
        JSON.stringify(x["players"]).includes('"online":false'),
    );
    expect(w["monitors"]).toBeUndefined();
    expect(w["players"]).toMatchObject([
      { name: "Alice", x: 5, online: false },
    ]);
  }, 60000);

  it("lists, reads and writes the project's world files", async () => {
    expect((await call("/api/world-files")).files).toEqual(["base.world.json"]);
    expect(
      JSON.stringify(await call("/api/world-file?path=base.world.json")),
    ).toContain("Steve");
    await call(
      "/api/world-file?path=saved.world.json",
      '{\n  "players": []\n}\n',
      "PUT",
    );
    expect(readFileSync(join(scratch, "saved.world.json"), "utf8")).toContain(
      '"players"',
    );
    await expect(
      call("/api/world-file?path=../escape.world.json", "{}", "PUT"),
    ).rejects.toThrow(/400/);
    await expect(
      call("/api/world-file?path=notes.txt", "{}", "PUT"),
    ).rejects.toThrow(/400/);
    await expect(
      call("/api/world-file?path=x.world.json", "not json", "PUT"),
    ).rejects.toThrow(/400/);
  });
});
