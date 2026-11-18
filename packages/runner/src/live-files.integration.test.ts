// A computer whose files are a folder of the person's, live (StartOptions.liveDir), as CraftOS-PC mounts its computer
// folder: what the program saves lands in the folder, what is saved there is seen at once, and the browser app gives
// people that by default while agents keep their copies.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type EngineHandle,
  SessionManager,
  checkConfig,
  liveFolderArgs,
  loadConfig,
  startWebApp,
} from "./index.js";

const scratch = mkdtempSync(join(tmpdir(), "live-files-"));
const folder = join(scratch, "project");
mkdirSync(join(folder, ".git"), { recursive: true });
writeFileSync(join(folder, ".git", "config"), "[core]\n");
mkdirSync(join(folder, "node_modules", "left-pad"), { recursive: true });
writeFileSync(
  join(folder, "save.lua"),
  'local h = fs.open("made.txt", "w") h.write("from the computer") h.close() print("saved")\n',
);
writeFileSync(
  join(folder, "hidden.lua"),
  'print("git " .. #fs.list(".git") .. " " .. tostring(fs.isReadOnly(".git")) .. " " .. tostring((pcall(fs.delete, ".git/config"))))\n' +
    'print("modules " .. #fs.list("node_modules"))\n',
);
const config = { ...loadConfig(), workspaceDir: folder };
const ready = checkConfig(config).length === 0;
const sessions = new SessionManager(config);

afterAll(async () => {
  await sessions.destroyAll();
  rmSync(scratch, { recursive: true, force: true });
});

async function screenMatching(
  handle: EngineHandle,
  re: RegExp,
  ms = 20000,
): Promise<string> {
  const start = Date.now();
  let text = "";
  while (Date.now() - start < ms) {
    text = handle.session.screen(0)?.lines.join("\n") ?? "";
    if (re.test(text)) return text;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no ${re} on the screen:\n${text}`);
}

describe("the engine flags for a live folder", () => {
  it("make the folder the computer's root and cover what a copy leaves out", () => {
    const args = liveFolderArgs(
      { runtimeDir: join(scratch, "elsewhere") },
      folder,
      join(scratch, "empty"),
    );
    expect(args.slice(0, 2)).toEqual(["--start-dir", folder]);
    const covered = args
      .filter((_, i) => args[i - 1] === "--mount-ro")
      .map((m) => m.split("=")[0]);
    // only what is there: no __snapshots__ or .cache in this folder
    expect(covered.sort()).toEqual([".git", "node_modules"]);
    expect(existsSync(join(scratch, "empty"))).toBe(true);
  });

  it("cover the runtime folder when it sits at the top of the folder, and never a folder of the person's", () => {
    const top = liveFolderArgs(
      { runtimeDir: join(folder, "runs") },
      folder,
      join(scratch, "empty"),
    );
    mkdirSync(join(folder, "runs"), { recursive: true });
    const again = liveFolderArgs(
      { runtimeDir: join(folder, "runs") },
      folder,
      join(scratch, "empty"),
    );
    expect(top).not.toContain(`runs=${join(scratch, "empty")}`); // not there yet: nothing to cover
    expect(again).toContain(`runs=${join(scratch, "empty")}`);
    const deep = liveFolderArgs(
      { runtimeDir: join(folder, "mine", "runs") },
      folder,
      join(scratch, "empty"),
    );
    expect(deep.join(" ")).not.toMatch(/mine=/);
    rmSync(join(folder, "runs"), { recursive: true });
  });
});

describe.skipIf(!ready)("a computer on a live folder", () => {
  it("saves into the folder, sees the folder's changes at once, and cannot reach .git or node_modules", async () => {
    const session = sessions.create(
      [],
      1,
      {},
      undefined,
      undefined,
      undefined,
      folder,
    );
    const { handle } = session;
    expect(handle.liveDir).toBe(folder);
    expect(handle.computerDir).toBe(folder);
    await screenMatching(handle, /> ?$/m);

    handle.session.typeLine("save");
    await screenMatching(handle, /saved/);
    expect(readFileSync(join(folder, "made.txt"), "utf8")).toBe(
      "from the computer",
    );

    // a file saved in the folder while the computer runs: no copy, no reboot
    writeFileSync(join(folder, "later.lua"), 'print("seen at once")\n');
    handle.session.typeLine("later");
    await screenMatching(handle, /seen at once/);

    handle.session.typeLine("hidden");
    const text = await screenMatching(handle, /modules \d+/);
    expect(text).toMatch(/git 0 true false/);
    expect(text).toMatch(/modules 0/);
    expect(existsSync(join(folder, ".git", "config"))).toBe(true);

    // closing the computer leaves the folder as it is
    await sessions.destroy(session.id);
    expect(existsSync(join(folder, "made.txt"))).toBe(true);
    expect(existsSync(join(folder, "later.lua"))).toBe(true);
    expect(existsSync(handle.dir)).toBe(false);
  }, 60000);

  it("still gives a copy when asked for none: what it saves stays on the computer", async () => {
    rmSync(join(folder, "made.txt"), { force: true });
    const session = sessions.create([], 1, {});
    expect(session.handle.liveDir).toBeUndefined();
    await screenMatching(session.handle, /> ?$/m);
    session.handle.session.typeLine("save");
    await screenMatching(session.handle, /saved/);
    expect(existsSync(join(folder, "made.txt"))).toBe(false);
    expect(existsSync(join(session.handle.computerDir, "made.txt"))).toBe(true);
    await sessions.destroy(session.id);
  }, 60000);
});

describe.skipIf(!ready)("the browser app's computers", () => {
  const servers: Server[] = [];
  const bases: string[] = [];
  const appSessions: SessionManager[] = [];
  beforeAll(async () => {
    for (const files of [undefined, "copy"] as const) {
      const manager = new SessionManager(config);
      const server = startWebApp({
        port: 0,
        sessions: manager,
        config,
        ...(files && { files }),
        onListening: () => undefined,
      });
      if (!server.listening)
        await new Promise((r) => server.once("listening", r));
      servers.push(server);
      appSessions.push(manager);
      bases.push(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    }
  });
  afterAll(async () => {
    for (const s of servers) s.close();
    for (const m of appSessions) await m.destroyAll();
  });

  const call = async (
    base: string,
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> => {
    const res = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      ...(body !== undefined && {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text}`);
    return JSON.parse(text) as Record<string, unknown>;
  };
  const listed = async (base: string, id: string) =>
    (
      (await call(base, "/api/sessions")).sessions as {
        id: string;
        liveDir: string | null;
      }[]
    ).find((s) => s.id === id)!;

  it("use the project folder itself unless the form asks for a copy or a folder each", async () => {
    const [base] = bases as [string];
    expect((await call(base, "/api/meta")).files).toBe("project");

    // the default: the folder, live, and the Files tab says so (and never walks into .git or node_modules)
    const one = ((await call(base, "/api/sessions", {})).ids as string[])[0]!;
    expect((await listed(base, one)).liveDir).toBe(folder);
    const files = await call(base, `/api/sessions/${one}/files`);
    expect(files.live).toBe(true);
    expect(files.dir).toBe(folder);
    const paths = (files.entries as { path: string }[]).map((e) => e.path);
    expect(paths).toContain("save.lua");
    expect(
      paths.some((p) => p.startsWith(".git") || p.startsWith("node_modules")),
    ).toBe(false);
    // a file saved in the app's editor is in the folder
    const put = await fetch(
      `${base}/api/sessions/${one}/file?path=edited.lua`,
      {
        method: "PUT",
        body: 'print("edited in the app")',
      },
    );
    expect(put.ok).toBe(true);
    expect(readFileSync(join(folder, "edited.lua"), "utf8")).toContain(
      "edited in the app",
    );
    // "copy in" has nothing to copy: it reboots
    await call(base, `/api/sessions/${one}/sync`, {});

    // a scratch copy
    const copy = (
      (await call(base, "/api/sessions", { files: "copy" })).ids as string[]
    )[0]!;
    expect((await listed(base, copy)).liveDir).toBeNull();
    expect((await call(base, `/api/sessions/${copy}/files`)).live).toBe(false);

    // a network, a folder each: computer/<id> as CraftOS-PC keeps them
    const net = (await call(base, "/api/sessions", { files: "own", count: 2 }))
      .ids as string[];
    const dirs = await Promise.all(
      net.map(async (id) => (await listed(base, id)).liveDir),
    );
    expect(dirs.sort()).toEqual([
      join(folder, "computer", "0"),
      join(folder, "computer", "1"),
    ]);
    expect(existsSync(join(folder, "computer", "1"))).toBe(true);

    await expect(
      call(base, "/api/sessions", { files: "everywhere" }),
    ).rejects.toThrow(/files must be/);
  }, 60000);

  it("give copies by default when the app is started with --copy", async () => {
    const base = bases[1]!;
    expect((await call(base, "/api/meta")).files).toBe("copy");
    const id = ((await call(base, "/api/sessions", {})).ids as string[])[0]!;
    expect((await listed(base, id)).liveDir).toBeNull();
    const live = (
      (await call(base, "/api/sessions", { files: "project" })).ids as string[]
    )[0]!;
    expect((await listed(base, live)).liveDir).toBe(folder);
  }, 60000);
});
