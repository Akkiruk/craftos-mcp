// World snapshots (world-snapshot.ts): run, snapshot, change everything, restore, and the world is the same again.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  type Session,
  SessionManager,
  VIEWER_OWNER,
  type WorldConfig,
  checkConfig,
  decodeSnapshot,
  deleteSnapshot,
  importSnapshot,
  listSnapshots,
  loadConfig,
  readSnapshot,
  restoreSnapshot,
  saveSnapshot,
  sendCommandResult,
  snapshotFile,
  waitForBoot,
  worldClockFor,
} from "./index.js";

const scratch = mkdtempSync(join(tmpdir(), "snapshot-ws-"));
const store = mkdtempSync(join(tmpdir(), "snapshot-store-"));
process.env["CRAFTOS_SNAPSHOTS"] = store;
const config = { ...loadConfig(), workspaceDir: scratch };
const ready = checkConfig(config).length === 0;
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(store, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

const WORLD: WorldConfig = {
  addons: [],
  players: [
    { name: "Alice", balance: 100 },
    { name: "Bob", online: false },
  ],
  peripherals: [{ name: "chest_0", type: "minecraft:chest", size: 27 }],
} as WorldConfig;

/** Every file and folder on the computer's own disk, as text. */
function disk(session: Session): Record<string, string> {
  const root = join(session.handle.dir, "computer", "0");
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(path).isDirectory()) {
        out[`${r}/`] = "";
        walk(path, r);
      } else out[r] = readFileSync(path, "utf8");
    }
  };
  if (existsSync(root)) walk(root, "");
  return out;
}

function state(session: Session): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(session.handle.resultsDir, "state.json"), "utf8"),
  ) as Record<string, unknown>;
}

async function command(
  session: Session,
  cmd: Record<string, unknown>,
): Promise<void> {
  const result = await sendCommandResult(session.handle, cmd as never, 10000);
  expect(result, JSON.stringify(cmd)).toEqual({ applied: true });
}

/** The program waits for events, so every command lands; it says what it sees after a restore too. */
const PROGRAM = `
os.setComputerLabel("base")
local f = fs.open("notes.txt", "w") f.write("v1") f.close()
while true do os.pullEvent() end`;

describe.skipIf(!ready)("world snapshots", () => {
  it("restores exactly: files, players, items, chat, peripherals, weather, the label and the time of day", async () => {
    const sessions = new SessionManager(config);
    try {
      writeFileSync(join(scratch, "prog.lua"), PROGRAM);
      const session = sessions.create([], 1, WORLD);
      sessions.setOwner(session.id, VIEWER_OWNER);
      await waitForBoot(session.handle.session);
      session.handle.session.typeLine("prog");
      const root = join(session.handle.dir, "computer", "0");
      for (let i = 0; i < 200 && !existsSync(join(root, "notes.txt")); i++)
        await sleep(25);
      mkdirSync(join(root, "empty", "inside"), { recursive: true });
      writeFileSync(join(root, "data.bin"), Buffer.from([0, 1, 2, 255, 128]));

      await command(session, {
        cmd: "setItem",
        peripheral: "chest_0",
        slot: 1,
        item: { name: "minecraft:diamond", count: 5 },
      });
      await command(session, {
        cmd: "setPlayerPos",
        player: "Alice",
        x: 10,
        y: 70,
        z: -3,
      });
      await command(session, { cmd: "join", player: "Bob" });
      await command(session, {
        cmd: "chat",
        player: "Alice",
        message: "hello",
      });
      await command(session, {
        cmd: "setEnvironment",
        values: { raining: true, time: 13000 },
      });
      await command(session, {
        cmd: "attachPeripheral",
        peripheral: { name: "barrel_0", type: "minecraft:barrel", size: 27 },
      });
      await command(session, {
        cmd: "setItem",
        peripheral: "barrel_0",
        slot: 3,
        item: { name: "minecraft:apple", count: 2 },
      });
      const clock = worldClockFor(sessions);
      await clock.setWorldTime(1_200_000 + 300_000); // day 2, 12:00
      await sleep(300);

      const before = { disk: disk(session), state: state(session) };
      const saved = await saveSnapshot(sessions, config, "base camp");
      expect(saved.computers).toEqual([
        { name: `session ${session.id}`, kind: "computer" },
      ]);
      expect(saved.time).toMatch(/^Day 2, 12:/);
      expect(listSnapshots(config).map((s) => s.name)).toEqual(["base camp"]);

      // change everything
      writeFileSync(join(root, "notes.txt"), "v2");
      writeFileSync(join(root, "new.txt"), "made after");
      rmSync(join(root, "empty"), { recursive: true });
      await command(session, {
        cmd: "setItem",
        peripheral: "chest_0",
        slot: 1,
        item: null,
      });
      await command(session, {
        cmd: "setPlayerPos",
        player: "Alice",
        x: 0,
        y: 0,
        z: 0,
      });
      await command(session, { cmd: "leave", player: "Bob" });
      await command(session, { cmd: "chat", player: "Alice", message: "gone" });
      await command(session, {
        cmd: "setEnvironment",
        values: { raining: false },
      });
      await command(session, { cmd: "detachPeripheral", name: "barrel_0" });
      await command(session, { cmd: "addPlayer", name: "Carol" });
      session.handle.session.event("terminate");
      await sleep(200);
      session.handle.session.typeLine("label set other");
      await clock.jump(600_000);
      const later = sessions.create([], 1, WORLD);
      sessions.setOwner(later.id, VIEWER_OWNER);
      const agents = sessions.create([], 1, WORLD);
      sessions.setOwner(agents.id, "an agent");
      await sleep(500);
      expect(disk(session)).not.toEqual(before.disk);

      const result = await restoreSnapshot(sessions, config, "base camp");
      expect(result.restored).toEqual([session.id]);
      expect(result.closed).toEqual([later.id]);
      expect(result.made).toEqual([]);
      // an agent's computer the snapshot does not have is left alone
      expect(
        sessions
          .list()
          .map((s) => s.id)
          .sort(),
      ).toEqual([agents.id, session.id].sort());

      await waitForBoot(session.handle.session);
      await sleep(500);
      expect(disk(session)).toEqual(before.disk);
      const after = state(session);
      expect(after).toEqual(before.state);
      expect(readFileSync(join(root, "data.bin"))).toEqual(
        Buffer.from([0, 1, 2, 255, 128]),
      );
      // the restored computer sees the restored world
      writeFileSync(
        join(root, "see.lua"),
        'local b = peripheral.wrap("barrel_0") local f = fs.open("seen.txt", "w") f.write(os.getComputerLabel() .. " " .. (b and b.getItemDetail(3).count or "none") .. " " .. os.day()) f.close()',
      );
      session.handle.session.typeLine("see");
      const seen = (): string => {
        try {
          return readFileSync(join(root, "seen.txt"), "utf8");
        } catch {
          return "";
        }
      };
      for (let i = 0; i < 200 && !seen(); i++) await sleep(25);
      expect(seen(), session.handle.session.screen(0)?.lines.join("\n")).toBe(
        "base 2 2",
      );
      expect((await clock.status()).time).toMatch(/^Day 2, 12:/);
    } finally {
      await sessions.destroyAll();
    }
  }, 120000);

  it("makes the computers again from a shared file, a network's together", async () => {
    const sessions = new SessionManager(config);
    try {
      writeFileSync(join(scratch, "prog.lua"), PROGRAM);
      const linked = sessions.createNetwork({
        computers: [
          {
            name: "a",
            world: {
              ...WORLD,
              peripherals: [{ name: "back", type: "modem", kind: "wireless" }],
            } as WorldConfig,
          },
          {
            name: "b",
            world: {
              ...WORLD,
              peripherals: [{ name: "back", type: "modem", kind: "wireless" }],
            } as WorldConfig,
          },
        ],
      });
      for (const s of Object.values(linked.computers)) {
        sessions.setOwner(s.id, VIEWER_OWNER);
        await waitForBoot(s.handle.session);
      }
      const a = linked.computers["a"]!;
      writeFileSync(
        join(a.handle.dir, "computer", String(0), "hello.txt"),
        "from a",
      );
      const names = new Map<string, string>([
        [a.id, "a"],
        [linked.computers["b"]!.id, "b"],
      ]);
      const hooks = {
        describe: (s: Session) => ({
          name: names.get(s.id) ?? s.id,
          kind: "computer" as const,
          advanced: true,
          network: "net1",
        }),
        adopt: (s: Session, info: { name: string }) =>
          names.set(s.id, info.name),
      };
      await saveSnapshot(sessions, config, "two", hooks);
      const file = snapshotFile(config, "two");
      expect(decodeSnapshot(file).computers.map((c) => c.name)).toEqual([
        "a",
        "b",
      ]);
      importSnapshot(config, file, "two copy");
      deleteSnapshot(config, "two");
      expect(listSnapshots(config).map((s) => s.name)).toContain("two copy");
      expect(readSnapshot(config, "two copy").name).toBe("two copy");

      // every computer gone: the restore makes them again
      await sessions.destroyAll();
      const result = await restoreSnapshot(sessions, config, "two copy", hooks);
      expect(result.made).toHaveLength(2);
      const made = result.made.map((id) => sessions.get(id));
      expect(made.map((s) => names.get(s.id)).sort()).toEqual(["a", "b"]);
      const again = made.find((s) => names.get(s.id) === "a")!;
      await waitForBoot(again.handle.session);
      const id =
        JSON.parse(
          readFileSync(join(again.handle.resultsDir, "world.json"), "utf8"),
        ).computerId ?? 0;
      expect(
        readFileSync(
          join(again.handle.dir, "computer", String(id), "hello.txt"),
          "utf8",
        ),
      ).toBe("from a");
    } finally {
      await sessions.destroyAll();
    }
  }, 120000);

  it("puts a project folder (live) back exactly, keeping a copy of what it overwrote or removed", async () => {
    const sessions = new SessionManager(config);
    const project = mkdtempSync(join(tmpdir(), "snapshot-live-"));
    try {
      mkdirSync(join(project, ".git"), { recursive: true });
      writeFileSync(join(project, ".git", "HEAD"), "ref: main\n");
      writeFileSync(join(project, "kept.txt"), "before");
      mkdirSync(join(project, "lib"), { recursive: true });
      writeFileSync(join(project, "lib", "util.lua"), "return 1");
      const session = sessions.create(
        [],
        1,
        { addons: [] } as WorldConfig,
        undefined,
        undefined,
        undefined,
        project,
      );
      sessions.setOwner(session.id, VIEWER_OWNER);
      await waitForBoot(session.handle.session);
      const saved = await saveSnapshot(sessions, config, "live folder");
      expect(saved.folders).toEqual([project]);

      writeFileSync(join(project, "kept.txt"), "after");
      writeFileSync(join(project, "new.txt"), "made since");
      mkdirSync(join(project, "fresh", "deep"), { recursive: true });
      writeFileSync(join(project, "fresh", "deep", "x.lua"), "x");
      rmSync(join(project, "lib", "util.lua"));
      writeFileSync(join(project, ".git", "HEAD"), "ref: other\n");

      const result = await restoreSnapshot(sessions, config, "live folder");
      expect(readFileSync(join(project, "kept.txt"), "utf8")).toBe("before");
      expect(readFileSync(join(project, "lib", "util.lua"), "utf8")).toBe(
        "return 1",
      );
      expect(existsSync(join(project, "new.txt"))).toBe(false);
      expect(existsSync(join(project, "fresh"))).toBe(false);
      // what the computer cannot see is not the snapshot's to change
      expect(readFileSync(join(project, ".git", "HEAD"), "utf8")).toBe(
        "ref: other\n",
      );
      const [folder] = result.folders;
      expect(folder).toMatchObject({
        dir: project,
        written: ["kept.txt", "lib/util.lua"],
        removed: ["fresh/deep/x.lua", "new.txt"],
      });
      expect(readFileSync(join(folder!.backup!, "kept.txt"), "utf8")).toBe(
        "after",
      );
      expect(readFileSync(join(folder!.backup!, "new.txt"), "utf8")).toBe(
        "made since",
      );
      rmSync(folder!.backup!, { recursive: true, force: true });
      deleteSnapshot(config, "live folder");
    } finally {
      await sessions.destroyAll();
      rmSync(project, { recursive: true, force: true });
    }
  }, 120000);

  it("refuses a file that is not a snapshot, and a bad name", () => {
    expect(() => importSnapshot(config, Buffer.from("hello"))).toThrow(
      /not a craftos world snapshot/,
    );
    expect(() => readSnapshot(config, "../up")).toThrow(/snapshot name/);
  });
});
