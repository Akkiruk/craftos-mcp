// `craftos-mcp window` for a network and a turtle: real engines, and in place of the raw client's desktop windows a
// stand-in that speaks its protocol (the keys and clicks it sends, the windows it is told to open and close).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  FrameParser,
  decodeServerPacket,
  encodeFrame,
} from "@craftos-mcp/rawterm";
import { afterAll, describe, expect, it } from "vitest";
import {
  type BridgedComputer,
  type EngineHandle,
  SessionManager,
  WindowBridge,
  checkConfig,
  loadConfig,
} from "./index.js";

const scratch = mkdtempSync(join(tmpdir(), "window-bridge-"));
writeFileSync(
  join(scratch, "receiver.lua"),
  'rednet.open("back") print("waiting") local id, msg = rednet.receive() print("got " .. id .. " " .. msg)\n',
);
writeFileSync(
  join(scratch, "sender.lua"),
  'rednet.open("back") rednet.broadcast("hi there") print("sent")\n',
);
writeFileSync(
  join(scratch, "touch.lua"),
  'peripheral.wrap("top").write("touch me") print("ready")\n' +
    'local _, side, x, y = os.pullEvent("monitor_touch") print("touched " .. side .. " " .. x .. "," .. y)\n',
);
writeFileSync(
  join(scratch, "place.lua"),
  'turtle.select(1) assert(turtle.place(), "place") peripheral.call("front", "turnOn") print("placed")\n',
);
const config = { ...loadConfig(), workspaceDir: scratch };
const ready = checkConfig(config).length === 0;
const sessions = new SessionManager(config);

afterAll(async () => {
  await sessions.destroyAll();
  rmSync(scratch, { recursive: true, force: true });
});

/** The raw client, as far as the bridge can tell: two pipes, and what it was told to show. */
class FakeClient {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  /** Open windows: client id -> title. */
  readonly windows = new Map<number, string>();
  quit = false;
  private readonly parser = new FrameParser({ binaryCrc: false });

  constructor() {
    this.stdin.on("data", (chunk: Buffer) => {
      for (const payload of this.parser.push(chunk)) {
        const frame = decodeServerPacket(payload);
        if (frame.type !== "window") continue;
        if (frame.closing === 0) this.windows.set(frame.window, frame.title);
        else if (frame.closing === 1) this.windows.delete(frame.window);
        else this.quit = true;
      }
    });
  }

  send(bytes: number[]): void {
    this.stdout.write(
      encodeFrame(Uint8Array.from(bytes), { binaryCrc: false }),
    );
  }

  idOf(title: string): number {
    const found = [...this.windows].find(([, t]) => t === title);
    if (!found)
      throw new Error(`no window ${title}: ${[...this.windows.values()]}`);
    return found[0];
  }

  /** Type a line as the client does: a character packet for each letter, then Enter down and up (LWJGL 28). */
  typeLine(title: string, text: string): void {
    const id = this.idOf(title);
    for (const ch of text) this.send([1, id, ch.charCodeAt(0), 8]);
    this.send([1, id, 28, 0]);
    this.send([1, id, 28, 1]);
  }
}

async function until<T>(
  what: string,
  check: () => T | undefined | null | false,
  ms = 20000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = check();
    if (value) return value as T;
    if (Date.now() - start > ms)
      throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const screenText = (handle: EngineHandle): string =>
  handle.session.screen(0)?.lines.join("\n") ?? "";

describe.skipIf(!ready)("desktop windows for several computers", () => {
  it("shows each computer of a network in its own window, typing and clicks reach it, rednet works between them", async () => {
    const linked = sessions.createNetwork({
      computers: ["alpha", "beta"].map((name) => ({
        name,
        world: {
          label: name,
          peripherals: [{ name: "back", type: "modem", kind: "wireless" }],
        },
        ...(name === "beta" && {
          monitors: [{ name: "top", blocksWide: 2, blocksHigh: 1 }],
        }),
      })),
    });
    const list = (): BridgedComputer[] =>
      Object.entries(linked.computers).map(([name, s]) => ({
        name,
        handle: s.handle,
      }));
    const client = new FakeClient();
    let emptied = false;
    const bridge = new WindowBridge(list, client, {
      onEmpty: () => (emptied = true),
    });
    try {
      // a window each, named after the computer; beta's monitor has its own, named after beta
      await until("three windows", () => client.windows.size === 3);
      expect([...client.windows.values()].sort()).toEqual([
        "alpha",
        "beta",
        "beta: Monitor top",
      ]);
      expect(new Set(client.windows.keys()).size).toBe(3);
      const alpha = linked.computers["alpha"]!.handle;
      const beta = linked.computers["beta"]!.handle;
      await until("both prompts", () =>
        [alpha, beta].every((h) => /> ?$/m.test(screenText(h))),
      );

      // keys typed in one window reach that computer only
      client.typeLine("beta", "receiver");
      await until("beta waits", () => /waiting/.test(screenText(beta)));
      expect(screenText(alpha)).not.toMatch(/waiting/);
      client.typeLine("alpha", "sender");
      const got = await until("beta hears alpha", () =>
        /got \d+ hi there/.exec(screenText(beta)),
      );
      expect(got[0]).toBe(`got 0 hi there`);

      // a click on beta's monitor window is a touch on that monitor
      client.typeLine("beta", "touch");
      await until("touch ready", () => /ready/.test(screenText(beta)));
      const monitor = client.idOf("beta: Monitor top");
      const click = Buffer.alloc(12);
      click[0] = 2;
      click[1] = monitor;
      click[2] = 0; // pressed
      click[3] = 1; // left button
      click.writeUInt32LE(3, 4);
      click.writeUInt32LE(1, 8);
      client.send([...click]);
      expect(
        await until("the touch", () =>
          /touched top 3,1/.exec(screenText(beta)),
        ),
      ).toBeTruthy();

      // holding Ctrl+T (the client's t is 20, its ctrl flag 4) terminates the program after a second, as in the game
      client.typeLine("beta", "receiver");
      await until("beta waits again", () =>
        /waiting\n?$/.test(screenText(beta).trimEnd()),
      );
      const betaId = client.idOf("beta");
      client.send([1, betaId, 29, 0]);
      client.send([1, betaId, 20, 4]);
      await until(
        "terminated",
        () => /Terminated/.test(screenText(beta)),
        5000,
      );
      client.send([1, betaId, 20, 5]);
      client.send([1, betaId, 29, 1]);

      // closing a computer's window turns it off and takes its windows away; closing the last one ends it all
      client.send([4, client.idOf("alpha"), 1, 0, 0, 0, 0, 0]);
      await until("alpha off", () => !alpha.session.running);
      await until("alpha's window gone", () => client.windows.size === 2);
      expect(emptied).toBe(false);
      client.send([4, betaId, 1, 0, 0, 0, 0, 0]);
      await until("all gone", () => emptied);
      expect(client.windows.size).toBe(0);
    } finally {
      bridge.close();
      expect(client.quit).toBe(true);
    }
  }, 90000);

  it("opens a window for each computer a turtle places and turns on", async () => {
    const session = sessions.create([], 1, {
      turtle: {
        x: 0,
        y: 64,
        z: 0,
        facing: "north",
        fuel: 100,
        inventory: {
          "1": { name: "computercraft:computer_advanced", count: 1 },
        },
      },
      ground: { y: 63, name: "minecraft:stone" },
    });
    const network = session.blockWorld!.network;
    const client = new FakeClient();
    const bridge = new WindowBridge(
      () =>
        network.computers().map((c) => ({
          name: c.name === "main" ? "turtle" : c.name,
          handle: c.handle,
        })),
      client,
      { names: true },
    );
    try {
      await until("the turtle's window", () => client.windows.size === 1);
      expect([...client.windows.values()]).toEqual(["turtle (Computer 0)"]);
      await until("prompt", () => /> ?$/m.test(screenText(session.handle)));
      client.typeLine("turtle (Computer 0)", "place");
      await until("placed", () => /placed/.test(screenText(session.handle)));
      // the computer it placed boots in a window of its own
      await until("a second window", () => client.windows.size === 2);
      const titles = [...client.windows.values()];
      expect(titles).toContain("turtle (Computer 0)");
      expect(titles.find((t) => t !== "turtle (Computer 0)")).toMatch(
        /\(Computer 1\)$/,
      );
    } finally {
      bridge.close();
      await sessions.destroy(session.id);
    }
  }, 60000);
});
