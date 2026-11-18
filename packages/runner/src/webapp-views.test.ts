// What the browser app's views read, without an engine: packets decoded, block colours, the block world's changes
// as a viewer gets them, and who hears a packet.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BlockWorldHost } from "./blockworld.js";
import { loadConfig } from "./config.js";
import type { EngineHandle } from "./engine.js";
import { ComputerNetwork } from "./network.js";
import {
  BlockColours,
  NetworkLog,
  blocksReply,
  decodePacket,
  luaPreview,
} from "./webapp-views.js";
import type { WorldConfig } from "./world.js";

/** ccsim/modem.lua's `encode`, for values a test can write down (no shared or self-holding tables unless asked). */
function encode(root: unknown, selfKey?: string): string {
  const out: string[] = [];
  const tables: Record<string, unknown>[] = [];
  const value = (v: unknown): void => {
    if (typeof v === "string") {
      const text = v.replace(
        /[%\x00-\x1f\x7f-\xff]/g,
        (c) =>
          `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
      );
      out.push(`s${text.length}:${text}`);
    } else if (typeof v === "number")
      out.push(
        `d${Number.isNaN(v) ? "nan" : v === Infinity ? "inf" : v === -Infinity ? "-inf" : String(v)};`,
      );
    else if (typeof v === "boolean") out.push(v ? "T" : "F");
    else if (v && typeof v === "object") {
      let id = tables.indexOf(v as Record<string, unknown>) + 1;
      if (!id) id = tables.push(v as Record<string, unknown>);
      out.push(`r${id};`);
    } else out.push("N");
  };
  value(root);
  for (let i = 0; i < tables.length; i++) {
    const table = tables[i]!;
    const pairs: [unknown, unknown][] = Array.isArray(table)
      ? table.map((v, index) => [index + 1, v])
      : Object.entries(table).map(([k, v]) => [
          /^-?\d+$/.test(k) ? Number(k) : k,
          k === selfKey ? table : v,
        ]);
    out.push(`${pairs.length};`);
    for (const [k, v] of pairs) {
      value(k);
      value(v);
    }
  }
  return out.join("");
}

describe("decodePacket", () => {
  it("reads what the modem wrote: strings, numbers, lists, tables", () => {
    const message = {
      kind: "say",
      text: "hi; there: 100%\n",
      n: [1, 2.5, -3],
      ok: true,
      deep: { a: { b: "c" } },
    };
    expect(decodePacket(encode(message))).toEqual(message);
    expect(decodePacket(encode("plain"))).toBe("plain");
    expect(decodePacket(encode(null))).toBeNull();
    expect(decodePacket(encode([NaN, Infinity, -Infinity]))).toEqual([
      "nan",
      "inf",
      "-inf",
    ]);
  });

  it("a table with gaps or other keys is an object, not a list", () => {
    expect(decodePacket(encode({ 1: "a", 3: "c" }))).toEqual({
      1: "a",
      3: "c",
    });
    expect(decodePacket(encode({ 1: "a", 2: "b" }))).toEqual(["a", "b"]);
  });

  it("a table that holds itself ends, and so does one nested too deep", () => {
    expect(decodePacket(encode({ name: "loop", me: 0 }, "me"))).toEqual({
      name: "loop",
      me: "(the same table again)",
    });
    expect(decodePacket(encode({ a: { b: { c: 1 } } }), 2)).toEqual({
      a: { b: "(more)" },
    });
  });

  it("text that is no packet reads as that, and nothing is thrown", () => {
    expect(decodePacket("s99:short")).toBe("short");
    expect(decodePacket("r1;x;")).toBe("(could not be read)");
  });

  it("previews a value as one short line of Lua", () => {
    expect(luaPreview({ kind: "say", n: [1, 2], "a b": true })).toBe(
      '{kind = "say", n = {1, 2}, [a b] = true}',
    );
    expect(luaPreview(null)).toBe("nil");
    expect(luaPreview("x".repeat(200), 20)).toHaveLength(20);
  });
});

const config = loadConfig();
const dataDir = join(config.romDir, "rom", "ccsim", "turtle", "data", "1.20.1");

describe("BlockColours", () => {
  const colours = new BlockColours([dataDir]);

  it.skipIf(!existsSync(join(dataDir, "minecraft.lua")))(
    "takes the game's map colours from the 1.20.1 turtle data",
    () => {
      expect(colours.colour("minecraft:stone")).toEqual({
        rgb: 7368816,
        alpha: 1,
      });
      expect(colours.colour("minecraft:grass_block").rgb).toBe(8368696);
      // a log's entry depends on its axis: the bark
      expect(colours.colour("minecraft:oak_log").rgb).toBe(8476209);
    },
  );

  it("gives ores, CC blocks and see-through blocks colours of their own", () => {
    const stone = colours.colour("minecraft:stone").rgb;
    expect(colours.colour("minecraft:diamond_ore").rgb).not.toBe(stone);
    expect(colours.colour("minecraft:deepslate_iron_ore").rgb).toBe(
      colours.colour("minecraft:iron_ore").rgb,
    );
    expect(colours.colour("computercraft:turtle_advanced").rgb).not.toBe(
      colours.colour("computercraft:turtle_normal").rgb,
    );
    expect(colours.colour("minecraft:glass").alpha).toBeLessThan(1);
    expect(colours.colour("minecraft:water").alpha).toBeLessThan(1);
    expect(colours.colour("minecraft:red_stained_glass")).toEqual({
      rgb: 0xcc4c4c,
      alpha: 0.45,
    });
  });

  it("reads a colour from the name of a block no data knows, the same one every time", () => {
    const none = new BlockColours([]);
    expect(none.colour("somemod:polished_stone_tiles").rgb).toBe(0x808080);
    expect(none.colour("somemod:light_blue_banner_thing").rgb).toBe(0x99b2f2);
    const odd = none.colour("somemod:zzyzx");
    expect(odd).toEqual(new BlockColours([]).colour("somemod:zzyzx"));
    expect(odd.rgb).toBeGreaterThan(0);
  });
});

describe("the block world for a viewer", () => {
  const base: WorldConfig = {
    turtle: { x: 0, y: 64, z: 0 },
    ground: { y: 63, name: "stone", top: "minecraft:grass_block" },
    fills: [
      { from: [3, 66, 3], to: [1, 64, 1], name: "minecraft:oak_planks" },
      { from: [2, 65, 2], to: [2, 65, 2] },
    ],
    blocks: [
      { x: 5, y: 64, z: 5, name: "minecraft:chest" },
      { x: 6, y: 64, z: 5, name: "minecraft:air" },
    ],
  };
  const host = new BlockWorldHost(config, base, new ComputerNetwork());
  afterAll(() => host.dispose());
  const colours = new BlockColours([]);
  const turtle = (facing: string): string =>
    JSON.stringify({
      name: "computercraft:turtle_advanced",
      state: { facing },
      blockEntity: { ComputerId: 0, label: "Digger", on: true },
    });
  const named = (reply: ReturnType<typeof blocksReply>): string[] => {
    const out: string[] = [];
    for (let i = 0; i < reply.blocks.length; i += 5) {
      const [x, y, z, n, f] = reply.blocks.slice(i, i + 5);
      out.push(`${x},${y},${z} ${n! < 0 ? "air" : reply.names[n!]} ${f}`);
    }
    return out.sort();
  };

  it("first the whole world: listed blocks, the ground, the boxes", () => {
    const reply = blocksReply(host, colours);
    expect(reply.full).toBe(true);
    expect(reply.seq).toBe(0);
    expect(named(reply)).toEqual(["5,64,5 minecraft:chest 0", "6,64,5 air 0"]);
    expect(reply.ground).toEqual({
      y: 63,
      name: reply.names.indexOf("minecraft:stone"),
      top: reply.names.indexOf("minecraft:grass_block"),
    });
    // corners sorted, and a box with no name is a box of air
    expect(reply.fills).toEqual([
      [1, 64, 1, 3, 66, 3, reply.names.indexOf("minecraft:oak_planks")],
      [2, 65, 2, 2, 65, 2, -1],
    ]);
    expect(reply.colours).toHaveLength(reply.names.length);
    expect(reply.alphas.every((a) => a > 0 && a <= 1)).toBe(true);
  });

  it("then only what changed, each block once, with where the turtle went", () => {
    host.onLines([`0,64,0\t${turtle("north")}`]);
    const first = blocksReply(host, colours, 0);
    expect(first.full).toBe(false);
    expect(first.seq).toBe(1);
    expect(named(first)).toEqual(["0,64,0 computercraft:turtle_advanced 1"]);
    expect(first.computers).toEqual([
      { x: 0, y: 64, z: 0, id: 0, label: "Digger", on: true },
    ]);
    expect(first.trails).toEqual({ "0": [0, 64, 0] });
    expect(first.ground).toBeUndefined();

    // it turns, digs the block ahead, moves in, and places one behind
    host.onLines([
      `0,64,0\t${turtle("east")}`,
      "1,64,0\tfalse",
      `1,64,0\t${turtle("east")}`,
      "0,64,0\tfalse",
      `0,64,0\t${JSON.stringify({ name: "minecraft:cobblestone" })}`,
    ]);
    const next = blocksReply(host, colours, first.seq);
    expect(next.seq).toBe(6);
    expect(named(next)).toEqual([
      "0,64,0 minecraft:cobblestone 0",
      "1,64,0 computercraft:turtle_advanced 2",
    ]);
    expect(next.trails).toEqual({ "0": [1, 64, 0] });
    expect(next.main).toBeNull(); // no computer was started in this test

    // nothing new: an empty answer
    const idle = blocksReply(host, colours, next.seq);
    expect(idle.blocks).toEqual([]);
    expect(idle.trails).toEqual({});
    expect(idle.full).toBe(false);
  });

  it("a viewer that asks from further back than the log reaches, or ahead of it, gets the whole world", () => {
    expect(blocksReply(host, colours, 999).full).toBe(true);
    const whole = blocksReply(host, colours);
    expect(named(whole)).toContain("0,64,0 minecraft:cobblestone 0");
    expect(whole.trails).toEqual({ "0": [0, 64, 0, 1, 64, 0] });
  });

  it("many changes cost a viewer only the blocks that differ", () => {
    const lines: string[] = [];
    for (let i = 0; i < 5000; i++)
      lines.push(
        `${i % 50},70,${Math.floor(i / 50) % 10}\t${JSON.stringify({ name: i % 2 ? "minecraft:stone" : "minecraft:dirt" })}`,
      );
    const before = host.changeCount;
    host.onLines(lines);
    const reply = blocksReply(host, colours, before);
    expect(reply.full).toBe(false);
    expect(reply.blocks.length / 5).toBe(500); // 5000 changes on 500 positions
    expect(reply.names.sort()).toEqual(["minecraft:dirt", "minecraft:stone"]);
  });
});

describe("NetworkLog", () => {
  interface Fake {
    name: string;
    world: WorldConfig;
    state?: Record<string, unknown>;
    running?: boolean;
  }
  function networkOf(computers: Fake[]): ComputerNetwork {
    const fake = {
      onPacket: undefined,
      computers: () =>
        computers.map((c) => ({
          name: c.name,
          world: c.world,
          running: c.running !== false,
          handle: {
            readState: () => c.state,
            session: { running: c.running !== false },
          } as unknown as EngineHandle,
        })),
    };
    return fake as unknown as ComputerNetwork;
  }
  const modem = (kind: string, extra: object = {}) => ({
    name: "back",
    type: "modem" as const,
    kind: kind as "wireless",
    ...extra,
  });
  const packet = (
    from: number,
    channel: number,
    message: unknown,
    extra: object = {},
  ): string =>
    encode({
      sender: `${from}/back`,
      kind: "wireless",
      channel,
      reply: from,
      x: 0,
      y: 64,
      z: 0,
      dimension: "minecraft:overworld",
      ender: false,
      range: 64,
      payload: encode(message),
      ...extra,
    });
  const send = (network: ComputerNetwork, from: string, text: string): void =>
    (
      network as unknown as { onPacket: (from: string, text: string) => void }
    ).onPacket(from, text);

  const three: Fake[] = [
    {
      name: "a",
      world: { computerId: 0, label: "A", peripherals: [modem("wireless")] },
      state: {
        peripherals: { back: { kind: "wireless", channels: [0, 65535] } },
      },
    },
    {
      name: "b",
      world: { computerId: 1, peripherals: [modem("wireless")] },
      state: {
        peripherals: { back: { kind: "wireless", channels: [1, 65535] } },
      },
    },
    {
      name: "far",
      world: {
        computerId: 2,
        position: { x: 500, y: 64, z: 0 },
        peripherals: [modem("wireless")],
      },
      state: {
        peripherals: { back: { kind: "wireless", channels: [2, 65535] } },
      },
    },
  ];

  it("lists the computers with their modems, and which can hear each other", () => {
    const network = networkOf(three);
    const log = new NetworkLog("net1", network, (n) => `s-${n}`);
    const view = log.view();
    expect(view.nodes.map((n) => [n.name, n.session, n.id, n.x])).toEqual([
      ["a", "s-a", 0, 0],
      ["b", "s-b", 1, 0],
      ["far", "s-far", 2, 500],
    ]);
    expect(view.nodes[0]!.label).toBe("A");
    expect(view.nodes[0]!.modems).toEqual([
      { name: "back", kind: "wireless", channels: [0, 65535] },
    ]);
    // 500 blocks is out of a wireless modem's 64
    expect(view.links).toEqual([{ a: "a", b: "b", kind: "wireless" }]);
    expect(view.messages).toEqual([]);
  });

  it("a rednet broadcast is heard by every computer in reach with the channel open; the repeater copy is marked", () => {
    const network = networkOf(three);
    let now = 1000;
    const log = new NetworkLog(
      "net1",
      network,
      () => undefined,
      () => now,
    );
    const message = {
      nMessageID: 42,
      nRecipient: 65535,
      nSender: 0,
      sProtocol: "chat",
      message: { kind: "say", text: "hello" },
    };
    send(network, "a", packet(0, 65535, message));
    now = 1001;
    send(network, "a", packet(0, 65533, message));
    const view = log.view();
    expect(view.seq).toBe(2);
    expect(view.messages).toEqual([
      {
        seq: 1,
        at: 1000,
        from: "a",
        modem: "back",
        kind: "wireless",
        channel: 65535,
        reply: 0,
        to: ["b"],
        rednet: { to: "everyone", protocol: "chat", repeat: false },
        preview: '{kind = "say", text = "hello"}',
        size: encode(message).length,
      },
      expect.objectContaining({
        seq: 2,
        channel: 65533,
        to: [], // nobody repeats
        rednet: { to: "everyone", protocol: "chat", repeat: true },
      }),
    ]);
    // only what is new
    expect(log.view(1).messages.map((m) => m.seq)).toEqual([2]);
    expect(log.view(2).messages).toEqual([]);
    // the whole message, on request
    expect(log.message(1)).toMatchObject({
      seq: 1,
      message,
      distanceFrom: { x: 0, y: 64, z: 0, dimension: "minecraft:overworld" },
    });
    expect(log.message(99)).toBeUndefined();
  });

  it("a message to one computer is heard by that one; a plain transmit shows its channel", () => {
    const network = networkOf(three);
    const log = new NetworkLog("net1", network, () => undefined);
    send(
      network,
      "b",
      packet(1, 0, {
        nMessageID: 1,
        nRecipient: 0,
        nSender: 1,
        message: "psst",
      }),
    );
    send(network, "b", packet(1, 7, "raw"));
    const [direct, raw] = log.view().messages;
    expect(direct).toMatchObject({
      to: ["a"],
      rednet: { to: 0, repeat: false },
      preview: '"psst"',
    });
    expect(direct!.rednet).not.toHaveProperty("protocol");
    expect(raw).toMatchObject({ to: [], channel: 7, preview: '"raw"' });
    expect(raw).not.toHaveProperty("rednet");
  });

  it("ender modems reach any distance and dimension; wired ones only their own cable", () => {
    const computers: Fake[] = [
      {
        name: "ender",
        world: {
          computerId: 0,
          position: { x: 0, y: 64, z: 0, dimension: "minecraft:the_nether" },
          peripherals: [modem("ender")],
        },
      },
      three[2]!, // wireless, 500 blocks off in the overworld
      {
        name: "w1",
        world: { computerId: 3, peripherals: [modem("wired", { net: "n1" })] },
      },
      {
        name: "w2",
        world: { computerId: 4, peripherals: [modem("wired", { net: "n1" })] },
      },
      {
        name: "w3",
        world: { computerId: 5, peripherals: [modem("wired", { net: "n2" })] },
      },
      {
        name: "off",
        running: false,
        world: { computerId: 6, peripherals: [modem("wired", { net: "n1" })] },
      },
    ];
    const network = networkOf(computers);
    const log = new NetworkLog("net1", network, () => undefined);
    expect(log.view().links).toEqual([
      { a: "ender", b: "far", kind: "ender" },
      { a: "w1", b: "w2", kind: "wired" },
      { a: "w1", b: "off", kind: "wired" },
      { a: "w2", b: "off", kind: "wired" },
    ]);
    send(
      network,
      "ender",
      packet(0, 65535, "from the nether", {
        ender: true,
        kind: "ender",
        range: 0,
        dimension: "minecraft:the_nether",
      }),
    );
    send(
      network,
      "w1",
      packet(3, 5, "down the cable", { kind: "wired", net: "n1", range: 256 }),
    );
    const [far, cable] = log.view().messages;
    // `far` has channel 65535 open; the wired computers are on another kind of modem
    expect(far).toMatchObject({ kind: "ender", to: ["far"] });
    // w2 has not said which channels it has open: it counts as listening. The one that is off hears nothing
    expect(cable).toMatchObject({ kind: "wired", to: ["w2"] });
  });

  it("keeps the last messages only, and says how many a viewer missed", () => {
    const network = networkOf(three);
    const log = new NetworkLog("net1", network, () => undefined);
    for (let i = 0; i < 7000; i++) send(network, "a", packet(0, 65535, i));
    const view = log.view(10);
    expect(view.seq).toBe(7000);
    expect(view.messages).toHaveLength(500);
    expect(view.messages.at(-1)!.preview).toBe("6999");
    expect(view.missed).toBe(7000 - 10 - 500);
    expect(log.message(1)).toBeUndefined();
    expect(log.message(7000)).toMatchObject({ message: 6999 });
  });

  it("stops listening when closed", () => {
    const network = networkOf(three);
    const log = new NetworkLog("net1", network, () => undefined);
    log.close();
    expect(
      (network as unknown as { onPacket: unknown }).onPacket,
    ).toBeUndefined();
  });
});
