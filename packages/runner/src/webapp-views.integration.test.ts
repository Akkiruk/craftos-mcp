// The browser app's views against real computers, through the app's HTTP API as the page uses it: a turtle's block
// world as it digs, builds and places a computer, and a network's messages with who heard them.
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
import type {
  BlocksReply,
  NetworkMessage,
  NetworkNode,
} from "./webapp-views.js";

const scratch = mkdtempSync(join(tmpdir(), "webapp-views-"));
writeFileSync(
  join(scratch, "walk.lua"),
  [
    "turtle.dig()", // the stone ahead
    "turtle.forward()",
    "turtle.turnRight()",
    "turtle.select(1)",
    "turtle.place()", // cobblestone to the east
    "turtle.turnLeft()",
    "turtle.turnLeft()",
    "turtle.select(2)",
    "turtle.place()", // a computer to the west
    'peripheral.call("front", "turnOn")',
    'print("walked")',
  ].join("\n"),
);
writeFileSync(
  join(scratch, "talk.lua"),
  [
    'rednet.open("back")',
    "local id = os.getComputerID()",
    'if id == 0 then sleep(1) rednet.broadcast({ hello = "all" }, "greet") rednet.send(1, "just you", "note")',
    'else local from, message = rednet.receive("note", 20) print("got " .. tostring(message) .. " from " .. tostring(from)) end',
    'peripheral.call("back", "transmit", 7, 8, "raw")',
    'print("talked")',
  ].join("\n"),
);
writeFileSync(
  join(scratch, "listen.lua"),
  'rednet.open("back") print("listening")\n',
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

async function call(path: string, body?: unknown, method?: string) {
  const res = await fetch(base + path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
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

async function until<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  ms = 30000,
): Promise<T> {
  const start = Date.now();
  let value = await read();
  while (!done(value) && Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, 100));
    value = await read();
  }
  return value;
}

const terminal = (id: string, re: RegExp, ms = 30000): Promise<string> =>
  until(
    async () => {
      const screens = (await call(`/api/sessions/${id}/screens`)) as {
        peripheral?: string;
        lines: string[];
      }[];
      return screens.find((s) => !s.peripheral)?.lines.join("\n") ?? "";
    },
    (text) => re.test(text),
    ms,
  );

const type = (id: string, text: string): Promise<unknown> =>
  call(`/api/sessions/${id}/input`, {
    events: [
      { type: "char", text },
      { type: "key", key: "enter" },
      { type: "keyup", key: "enter" },
    ],
  });

/** A viewer's copy of the world: every answer applied in turn, as the page does. */
class Viewer {
  seq: number | undefined;
  readonly blocks = new Map<string, string>();
  readonly facings = new Map<string, number>();
  readonly trail: number[] = [];
  readonly replies: BlocksReply[] = [];
  constructor(private readonly id: string) {}
  async read(): Promise<BlocksReply> {
    const reply = (await call(
      `/api/sessions/${this.id}/blocks${this.seq === undefined ? "" : `?since=${this.seq}`}`,
    )) as BlocksReply;
    if (reply.full) this.blocks.clear();
    for (let i = 0; i < reply.blocks.length; i += 5) {
      const [x, y, z, n, f] = reply.blocks.slice(i, i + 5);
      this.blocks.set(`${x},${y},${z}`, n! < 0 ? "air" : reply.names[n!]!);
      this.facings.set(`${x},${y},${z}`, f!);
    }
    this.trail.push(...(reply.trails["0"] ?? []));
    this.seq = reply.seq;
    this.replies.push(reply);
    return reply;
  }
}

describe.skipIf(!ready)("the views of the browser app", () => {
  it("serves the views with the page", async () => {
    const page = (await call("/")) as string;
    expect(page).toContain('src="/views.js"');
    expect(page).toContain('href="/views.css"');
    for (const file of ["/views.js", "/views-gl.js", "/views.css"]) {
      const res = await fetch(base + file);
      expect(res.status).toBe(200);
      expect((await res.text()).length).toBeGreaterThan(500);
    }
    expect((await fetch(`${base}/views-nothing.js`)).status).toBe(404);
    expect((await fetch(`${base}/views..js`)).status).toBe(404);
  });

  it("a turtle's world: all of it first, then each change as the turtle digs, turns, builds and places a computer", async () => {
    const { ids } = await call("/api/sessions", {
      kind: "turtle",
      name: "digger",
      world: {
        turtle: {
          x: 0,
          y: 64,
          z: 0,
          facing: "north",
          fuel: 100,
          left: "minecraft:diamond_pickaxe",
          inventory: {
            "1": { name: "minecraft:cobblestone", count: 4 },
            "2": { name: "computercraft:computer_advanced", count: 1 },
          },
        },
        ground: {
          y: 63,
          name: "minecraft:stone",
          top: "minecraft:grass_block",
        },
        fills: [
          { from: [0, 64, -1], to: [0, 65, -1], name: "minecraft:stone" },
        ],
        blocks: [{ x: 3, y: 64, z: 0, name: "minecraft:chest" }],
      },
    });
    const id = ids[0] as string;
    const listed = (await call("/api/sessions")).sessions[0];
    expect(listed).toMatchObject({
      id,
      kind: "turtle",
      blocks: true,
      network: null,
      placedBy: null,
    });
    await terminal(id, />/);

    const viewer = new Viewer(id);
    // the turtle tells the world where it stands as it boots
    await until(
      () => viewer.read(),
      () => viewer.blocks.has("0,64,0"),
    );
    const first = viewer.replies[0]!;
    expect(first.full).toBe(true);
    expect(first.ground).toMatchObject({ y: 63 });
    expect(first.names[first.ground!.top]).toBe("minecraft:grass_block");
    expect(first.fills).toHaveLength(1);
    expect(first.main).toBe(0);
    expect(viewer.blocks.get("3,64,0")).toBe("minecraft:chest");
    expect(viewer.blocks.get("0,64,0")).toBe("computercraft:turtle_advanced");
    expect(viewer.facings.get("0,64,0")).toBe(1); // north

    await type(id, "walk");
    await terminal(id, /walked/);
    await until(
      () => viewer.read(),
      () => viewer.blocks.get("-1,64,-1") === "computercraft:computer_advanced",
    );
    // every answer after the first held only changes
    expect(viewer.replies.slice(1).every((r) => !r.full)).toBe(true);
    expect(viewer.replies.slice(1).every((r) => r.ground === undefined)).toBe(
      true,
    );
    // it dug into the stone box and stands there, facing west; cobblestone to the east, a computer to the west
    expect(viewer.blocks.get("0,64,0")).toBe("air");
    expect(viewer.blocks.get("0,64,-1")).toBe("computercraft:turtle_advanced");
    expect(viewer.facings.get("0,64,-1")).toBe(4); // west: turning alone is a change too
    expect(viewer.blocks.get("1,64,-1")).toBe("minecraft:cobblestone");
    expect(viewer.trail).toEqual([0, 64, 0, 0, 64, -1]);
    const last = await viewer.read();
    expect(last.blocks).toEqual([]);

    // the computer it placed and turned on is a computer of the app too, on the world's network
    const sessions = (
      await until(
        () => call("/api/sessions"),
        (list) => list.sessions.length === 2,
      )
    ).sessions as Record<string, unknown>[];
    expect(sessions.map((s) => s["id"])).toEqual([id, `${id}-p1`]);
    expect(sessions[1]).toMatchObject({
      name: "computer 1",
      kind: "computer",
      placedBy: id,
      network: "world1",
      blocks: false,
      running: true,
    });
    expect(sessions[0]).toMatchObject({ network: "world1" });
    // its screen, and typing on it
    expect(await terminal(`${id}-p1`, /CraftOS/)).toMatch(/CraftOS/);
    await type(`${id}-p1`, "id");
    expect(await terminal(`${id}-p1`, /computer #1/)).toMatch(/computer #1/);
    // closing it is the turtle's business
    const refused = await fetch(`${base}/api/sessions/${id}-p1`, {
      method: "DELETE",
    });
    expect(refused.status).toBe(400);
    const network = await call("/api/networks/world1");
    expect(
      (network.nodes as NetworkNode[]).map((n) => [n.name, n.session, n.id]),
    ).toEqual([
      ["main", id, 0],
      ["computer_1", `${id}-p1`, 1],
    ]);

    // a computer without blocks has no block world to show
    const plain = await call("/api/sessions", { name: "plain" });
    const none = await fetch(`${base}/api/sessions/${plain.ids[0]}/blocks`);
    expect(none.status).toBe(404);
    await call(`/api/sessions/${plain.ids[0]}`, undefined, "DELETE");
    await call(`/api/sessions/${id}`, undefined, "DELETE");
    expect((await call("/api/sessions")).sessions).toEqual([]);
  }, 120000);

  it("a network: its computers, what joins them, each message with who heard it, and the whole message on request", async () => {
    const { ids, network } = await call("/api/sessions", {
      name: "pc",
      count: 3,
      modem: "wireless",
    });
    expect(ids).toHaveLength(3);
    const listed = (await call("/api/sessions")).sessions as {
      network: string;
    }[];
    expect(listed.map((s) => s.network)).toEqual([network, network, network]);
    expect(await call("/api/networks")).toEqual([
      {
        name: network,
        computers: ["pc 1", "pc 2", "pc 3"].map((name, i) => ({
          name,
          session: ids[i],
        })),
      },
    ]);
    for (const id of ids as string[]) await terminal(id, />/);
    // the third computer only listens
    await type(ids[2], "listen");
    await terminal(ids[2], /listening/);
    await type(ids[1], "talk");
    await type(ids[0], "talk");
    expect(await terminal(ids[1], /got just you from 0/)).toMatch(
      /got just you from 0/,
    );
    await terminal(ids[0], /talked/);
    await terminal(ids[1], /talked/);

    const view = await until(
      () => call(`/api/networks/${network}`),
      (v) =>
        (v.messages as NetworkMessage[]).filter((m) => m.channel === 7)
          .length === 2,
    );
    const nodes = view.nodes as NetworkNode[];
    expect(nodes.map((n) => [n.name, n.id, n.session, n.running])).toEqual([
      ["pc 1", 0, ids[0], true],
      ["pc 2", 1, ids[1], true],
      ["pc 3", 2, ids[2], true],
    ]);
    expect(nodes[2]!.modems).toEqual([
      {
        name: "back",
        kind: "wireless",
        channels: expect.arrayContaining([2, 65535]),
      },
    ]);
    expect(view.links).toEqual([
      { a: "pc 1", b: "pc 2", kind: "wireless" },
      { a: "pc 1", b: "pc 3", kind: "wireless" },
      { a: "pc 2", b: "pc 3", kind: "wireless" },
    ]);
    const messages = view.messages as NetworkMessage[];
    const hello = messages.find(
      (m) => m.rednet?.protocol === "greet" && !m.rednet.repeat,
    )!;
    expect(hello).toMatchObject({
      from: "pc 1",
      modem: "back",
      kind: "wireless",
      channel: 65535,
      reply: 0,
      rednet: { to: "everyone", protocol: "greet", repeat: false },
      preview: '{hello = "all"}',
    });
    expect(hello.to.sort()).toEqual(["pc 2", "pc 3"]);
    // rednet's second copy, for repeaters: nobody here repeats
    expect(
      messages.find((m) => m.rednet?.protocol === "greet" && m.rednet.repeat),
    ).toMatchObject({ channel: 65533, to: [] });
    // a message for one computer is heard by that one only
    expect(
      messages.find((m) => m.rednet?.protocol === "note" && !m.rednet.repeat),
    ).toMatchObject({
      from: "pc 1",
      to: ["pc 2"],
      rednet: { to: 1 },
      preview: '"just you"',
    });
    // a plain transmit on a channel nobody opened
    const raw = messages.filter((m) => m.channel === 7);
    expect(raw.map((m) => [m.from, m.to, m.reply, m.preview]).sort()).toEqual([
      ["pc 1", [], 8, '"raw"'],
      ["pc 2", [], 8, '"raw"'],
    ]);
    expect(raw[0]).not.toHaveProperty("rednet");

    // only what is new, from then on
    const later = await call(`/api/networks/${network}?since=${view.seq}`);
    expect(later.messages).toEqual([]);
    expect(later.seq).toBe(view.seq);

    // the whole message
    const whole = await call(`/api/networks/${network}/messages/${hello.seq}`);
    expect(whole).toMatchObject({
      seq: hello.seq,
      message: {
        nRecipient: 65535,
        nSender: 0,
        sProtocol: "greet",
        message: { hello: "all" },
      },
      distanceFrom: { x: 0, y: 64, z: 0 },
    });
    expect(
      (await fetch(`${base}/api/networks/${network}/messages/99999`)).status,
    ).toBe(404);
    expect((await fetch(`${base}/api/networks/nope`)).status).toBe(404);

    // a computer that is shut down shows as off, and the network goes with its last computer
    await call(`/api/sessions/${ids[2]}/shutdown`, {});
    const off = await until(
      () => call(`/api/networks/${network}`),
      (v) => (v.nodes as NetworkNode[])[2]!.running === false,
      10000,
    );
    expect((off.nodes as NetworkNode[])[2]!.running).toBe(false);
    for (const id of ids as string[])
      await call(`/api/sessions/${id}`, undefined, "DELETE");
    expect(await call("/api/networks")).toEqual([]);
  }, 120000);
});
