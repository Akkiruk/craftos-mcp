/**
 * The browser app's world panel, server side: the page's code (../webapp/worldpanel.js, and packages/world-editor's
 * modules, which the VS Code World Editor shares), the world schema and mod list it builds forms from, each
 * computer's world as the panel shows it, and changes to it applied to the running computer (world-live.ts) as the
 * game would make them. Project world files (*.world.json) are listed and read here too, for "Open".
 *
 * webapp.ts calls `handle` before its own routes and `remember` when it makes a computer.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ADDONS } from "./addons.js";
import type { RunnerConfig } from "./config.js";
import { sendCommandResult } from "./drive.js";
import type { MonitorSpec } from "./lua.js";
import type { Session, SessionManager } from "./sessions.js";
import { DEFAULT_MC, resolveVersion } from "./versions.js";
import { type LiveStep, planLive, worldForPanel } from "./world-live.js";
import { type WorldConfig, worldJson } from "./world.js";
import { listWorkspace, resolveInWorkspace } from "./workspace.js";

/** packages/world-editor/dist: plain ES modules the page imports as they are. */
const editorDir = fileURLToPath(
  new URL("../../world-editor/dist/", import.meta.url),
);
/** schemas/world.schema.json at the repo's (or the npm package's) root. */
const schemaFile = fileURLToPath(
  new URL("../../../schemas/world.schema.json", import.meta.url),
);

interface Kept {
  /** The world as the panel shows it and saves it. */
  world: WorldConfig;
  /** What the engine was given besides (simProgram), put back when world.json is written again. */
  extra: Record<string, unknown>;
  /** Players who left during this run, lower case: they come back by joining. */
  departed: Set<string>;
  /** Blocks the computer would not take (an unknown type, a mod it lacks): left out of world.json. */
  broken: Set<string>;
  /** When the panel's last change was done: a state.json older than that does not have it yet. */
  appliedAt?: number;
}

export interface StepResult {
  readonly what: string;
  readonly ok: boolean;
  readonly error?: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(
  res: ServerResponse,
  status: number,
  type: string,
  body: string | Buffer,
): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

const json = (res: ServerResponse, value: unknown, status = 200): void =>
  send(res, status, "application/json", JSON.stringify(value));

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
      if (body.length > 5_000_000) reject(new HttpError(413, "body too large"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** CC's JSON writes an empty list as {}. */
const listOf = (v: unknown): Record<string, unknown>[] =>
  (Array.isArray(v) ? v : []).filter(isObj);

/** The same JSON, whatever order the keys were written in. */
function same(a: unknown, b: unknown): boolean {
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : isObj(v)
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, canon(v[k])]),
          )
        : v;
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

/** What a player is when the world file says nothing (rom/ccsim/core.lua addPlayer). */
const PLAYER_DEFAULTS: Record<string, unknown> = {
  online: true,
  x: 0,
  y: 64,
  z: 0,
  yaw: 0,
  pitch: 0,
  dimension: "minecraft:overworld",
  health: 20,
  maxHealth: 20,
  balance: 0,
};
/** Of what the sim says of a player, what the panel shows (a uuid it made up is not the person's). */
const PLAYER_KEYS = Object.keys(PLAYER_DEFAULTS);

/**
 * The world as the computer has it now (state.json `live`, written by rom/ccsim/core.lua liveWorld) laid over what
 * the panel knew: players who joined, left or moved, blocks put down or broken, the weather, from the shell (`sim join`,
 * `attach`), a program, the MCP tools or the panel itself. `broken`: blocks the computer would not take, kept as they
 * are so the panel still shows them.
 */
export function withLiveWorld(
  world: WorldConfig,
  live: unknown,
  broken: ReadonlySet<string> = new Set(),
): WorldConfig {
  if (!isObj(live)) return world;
  const out: Record<string, unknown> = {
    ...(world as Record<string, unknown>),
  };
  const keptPlayers = listOf(out["players"]);
  const byName = new Map(
    keptPlayers.map((p) => [String(p["name"]).toLowerCase(), p]),
  );
  const livePlayers = listOf(live["players"]).filter(
    // the sim's stand-in for a world that started with nobody in it (rom/ccsim/core.lua): first, named Player
    (p, i) => !(i === 0 && p["name"] === "Player" && !byName.has("player")),
  );
  if (livePlayers.length || keptPlayers.length) {
    const players = livePlayers.map((p) => {
      const kept = byName.get(String(p["name"]).toLowerCase());
      const entry: Record<string, unknown> = kept
        ? { ...kept }
        : { name: p["name"] };
      for (const key of PLAYER_KEYS) {
        if (p[key] === undefined) continue;
        if (!same(p[key], entry[key] ?? PLAYER_DEFAULTS[key]))
          entry[key] = p[key];
      }
      return entry;
    });
    if (!same(players, keptPlayers)) out["players"] = players;
  }
  // the engine's own blocks: monitor walls (the panel's "monitors") and drives
  const engine =
    Array.isArray(live["engine"]) || isObj(live["engine"])
      ? listOf(live["engine"])
      : undefined;
  if (Array.isArray(live["peripherals"]) || isObj(live["peripherals"])) {
    const keptList = listOf(out["peripherals"]);
    const liveDefs = listOf(live["peripherals"]).filter(
      (p) => p["type"] !== "drive",
    );
    const liveNames = new Set(liveDefs.map((p) => p["name"]));
    const keptNames = new Set(keptList.map((p) => p["name"]));
    const next = [
      ...keptList.filter((p) =>
        p["type"] === "drive"
          ? !engine || engine.some((e) => e["name"] === p["name"])
          : liveNames.has(p["name"]) || broken.has(String(p["name"])),
      ),
      ...liveDefs.filter((p) => !keptNames.has(p["name"])),
      ...(engine ?? [])
        .filter((e) => e["type"] === "drive" && !keptNames.has(e["name"]))
        .map((e) => ({ name: e["name"], type: "drive" })),
    ];
    if (!same(next, keptList))
      if (next.length || out["peripherals"] !== undefined)
        out["peripherals"] = next;
  }
  if (engine) {
    const keptMonitors = listOf(out["monitors"]);
    const next = engine
      .filter((e) => e["type"] === "monitor")
      .map((e) => {
        const kept = keptMonitors.find((m) => m["name"] === e["name"]);
        const entry: Record<string, unknown> = kept
          ? { ...kept }
          : { name: e["name"] };
        for (const key of ["blocksWide", "blocksHigh"])
          if (typeof e[key] === "number") entry[key] = e[key];
        if (e["advanced"] === false) entry["advanced"] = false;
        return entry;
      });
    // a monitor the computer would not take stays, as the panel's other blocks do
    for (const m of keptMonitors)
      if (
        broken.has(String(m["name"])) &&
        !next.some((n) => n["name"] === m["name"])
      )
        next.push(m);
    if (!same(next, keptMonitors))
      if (next.length) out["monitors"] = next;
      else delete out["monitors"];
  }
  for (const key of ["environment", "entities"]) {
    const value = live[key];
    if (value === undefined) continue;
    const empty = isObj(value) && Object.keys(value).length === 0;
    if (empty && out[key] === undefined) continue;
    const plain = key === "entities" && empty ? [] : value;
    if (!same(plain, out[key])) out[key] = plain;
  }
  return out as WorldConfig;
}

export class WorldPanel {
  private readonly kept = new Map<string, Kept>();
  private readonly busy = new Map<string, Promise<unknown>>();

  constructor(
    private readonly sessions: SessionManager,
    private readonly config: RunnerConfig,
  ) {}

  /** A computer the app made, with the world and monitors it was made with. */
  remember(
    id: string,
    world: WorldConfig,
    monitors: readonly MonitorSpec[],
  ): void {
    const extra: Record<string, unknown> = {};
    if ((world as Record<string, unknown>)["simProgram"] !== undefined)
      extra["simProgram"] = (world as Record<string, unknown>)["simProgram"];
    this.kept.set(id, {
      world: worldForPanel(world, monitors),
      extra,
      departed: new Set(),
      broken: new Set(),
    });
  }

  forget(id: string): void {
    this.kept.delete(id);
  }

  /** An app computer whose world was put back from elsewhere (a snapshot restore): read it again from world.json. */
  reread(session: Session): void {
    this.kept.delete(session.id);
    delete this.keptOf(session).extra["__foreign"];
  }

  /** The world of a computer made elsewhere (the MCP server's): what its engine was given. */
  private keptOf(session: Session): Kept {
    let k = this.kept.get(session.id);
    if (k) return k;
    let world: Record<string, unknown> = {};
    try {
      world = JSON.parse(
        readFileSync(join(session.handle.resultsDir, "world.json"), "utf8"),
      ) as Record<string, unknown>;
    } catch {
      // no world written
    }
    // world.json holds the resolved version ({mc, cc, ...}): the file form is the Minecraft version
    if (isObj(world["version"]) && typeof world["version"]["mc"] === "string")
      world["version"] = world["version"]["mc"];
    const monitors: MonitorSpec[] = [];
    for (const w of session.handle.session.allWindows())
      if (w.peripheral && !monitors.some((m) => m.name === w.peripheral))
        monitors.push({ name: w.peripheral });
    k = {
      world: worldForPanel(world as WorldConfig, monitors),
      extra: { simProgram: world["simProgram"] },
      departed: new Set(),
      broken: new Set(),
    };
    // it was made elsewhere: world.json is its engine's, not ours to write again
    k.extra["__foreign"] = true;
    this.kept.set(session.id, k);
    return k;
  }

  /** The panel's world brought up to what the computer has now (withLiveWorld). */
  private syncLive(session: Session, k: Kept): void {
    let live: unknown;
    try {
      const file = join(session.handle.resultsDir, "state.json");
      if (k.appliedAt && statSync(file).mtimeMs < k.appliedAt) return;
      live = (JSON.parse(readFileSync(file, "utf8")) as { live?: unknown })
        .live;
    } catch {
      return; // not written yet
    }
    const next = withLiveWorld(k.world, live, k.broken);
    if (next !== k.world) k.world = next;
  }

  /** Change a computer's world to `next`: the steps run one by one, in order, as the game would do them. */
  async apply(
    session: Session,
    next: WorldConfig,
  ): Promise<{ steps: StepResult[]; later: string[]; world: WorldConfig }> {
    const k = this.keptOf(session);
    // one change at a time per computer: a second waits for the first
    const prev = this.busy.get(session.id) ?? Promise.resolve();
    const run = prev
      .catch(() => undefined)
      .then(() => {
        // a change from the panel starts from the world as it is now, shell changes included
        this.syncLive(session, k);
        return this.applyNow(session, k, next);
      })
      .finally(() => {
        k.appliedAt = Date.now();
      });
    this.busy.set(session.id, run);
    void run
      .finally(() => {
        if (this.busy.get(session.id) === run) this.busy.delete(session.id);
      })
      .catch(() => undefined);
    return run;
  }

  private async applyNow(
    session: Session,
    k: Kept,
    next: WorldConfig,
  ): Promise<{ steps: StepResult[]; later: string[]; world: WorldConfig }> {
    const plan = planLive(k.world, next, k.departed);
    const steps: StepResult[] = [];
    const handle = session.handle;
    let stuck = !handle.session.running;
    /** A block placed (or not): it goes into world.json only once the computer has it. */
    const placed = (step: LiveStep, ok: boolean): void => {
      if (step.command.cmd !== "attachPeripheral") return;
      const name = (step.command.peripheral as { name?: unknown }).name;
      if (typeof name !== "string") return;
      if (ok) k.broken.delete(name);
      else k.broken.add(name);
    };
    const run = async (step: LiveStep): Promise<boolean> => {
      if (stuck) {
        placed(step, false);
        steps.push({
          what: step.what,
          ok: false,
          error: handle.session.running
            ? "not sent: the program was busy"
            : "the computer is off",
        });
        return false;
      }
      const result = await sendCommandResult(handle, step.command, 5000);
      if (!result.applied) {
        stuck = true;
        placed(step, false);
        steps.push({
          what: step.what,
          ok: false,
          error: "the program did not take it: it is not waiting for an event",
        });
        return false;
      }
      if (result.error && step.fallback?.length) {
        for (const f of step.fallback) await run(f);
        return true;
      }
      placed(step, !result.error);
      steps.push({
        what: step.what,
        ok: !result.error,
        ...(result.error ? { error: result.error } : {}),
      });
      return !result.error;
    };
    for (const step of plan.steps) await run(step);

    // players who left, for the next change
    const names = (w: WorldConfig): Set<string> =>
      new Set(
        (Array.isArray(w.players) ? w.players : [])
          .map((p) =>
            isObj(p) && typeof p["name"] === "string"
              ? p["name"].toLowerCase()
              : "",
          )
          .filter(Boolean),
      );
    const before = names(k.world);
    const after = names(next);
    for (const n of before) if (!after.has(n)) k.departed.add(n);
    for (const n of after) k.departed.delete(n);
    k.world = next;

    // A reboot starts from world.json: the blocks placed now are still there after it, as in game. A block the
    // computer would not take stays out of it, or the next boot would fail on it.
    if (
      !k.extra["__foreign"] &&
      !session.blockWorld &&
      !(next as Record<string, unknown>)["modemLink"]
    ) {
      try {
        const { simProgram } = k.extra;
        const keep = (list: unknown): unknown =>
          Array.isArray(list)
            ? list.filter(
                (p) =>
                  !(
                    isObj(p) &&
                    typeof p["name"] === "string" &&
                    k.broken.has(p["name"])
                  ),
              )
            : list;
        const engineWorld: Record<string, unknown> = {
          ...(next as Record<string, unknown>),
          ...(simProgram !== undefined ? { simProgram } : {}),
        };
        if (engineWorld["peripherals"] !== undefined)
          engineWorld["peripherals"] = keep(engineWorld["peripherals"]);
        if (engineWorld["monitors"] !== undefined)
          engineWorld["monitors"] = keep(engineWorld["monitors"]);
        writeFileSync(
          join(handle.resultsDir, "world.json"),
          worldJson(engineWorld as WorldConfig),
        );
      } catch (error) {
        plan.later.push(
          `After a reboot the computer starts from its old world: ${(error as Error).message}`,
        );
      }
    }
    return { steps, later: plan.later, world: next };
  }

  /** The panel's routes; false when `path` is not one of them. */
  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    const path = url.pathname;
    const method = req.method ?? "GET";
    try {
      let m = /^\/world-editor\/([\w-]+\.js)$/.exec(path);
      if (method === "GET" && m) {
        const file = join(editorDir, m[1]!);
        if (!existsSync(file))
          throw new HttpError(
            404,
            `no ${m[1]}: build packages/world-editor (npm run build)`,
          );
        send(res, 200, "text/javascript; charset=utf-8", readFileSync(file));
        return true;
      }
      if (method === "GET" && path === "/api/world-editor") {
        let defaultMc = DEFAULT_MC;
        try {
          defaultMc = resolveVersion(undefined).mc;
        } catch {
          // CRAFTOS_VERSION is invalid: the default
        }
        let schema: unknown = { type: "object" };
        try {
          schema = JSON.parse(readFileSync(schemaFile, "utf8"));
        } catch {
          // no schema next to this install: forms of plain JSON boxes
        }
        json(res, {
          schema,
          catalog: {
            defaultMc,
            addons: ADDONS.map(
              ({ id, name, versions, types, worldKeys, requires }) => ({
                id,
                name,
                versions,
                types,
                ...(worldKeys ? { worldKeys } : {}),
                ...(requires ? { requires } : {}),
              }),
            ),
          },
        });
        return true;
      }
      if (method === "GET" && path === "/api/world-files") {
        let files: string[] = [];
        try {
          files = listWorkspace(this.config.workspaceDir)
            .filter((e) => e.kind === "file" && e.path.endsWith(".world.json"))
            .map((e) => e.path)
            .slice(0, 500);
        } catch {
          files = [];
        }
        json(res, { files });
        return true;
      }
      if (method === "GET" && path === "/api/world-file") {
        const rel = url.searchParams.get("path") ?? "";
        if (!rel.endsWith(".json"))
          throw new HttpError(400, "not a world file");
        let target: string;
        try {
          target = resolveInWorkspace(this.config.workspaceDir, rel);
        } catch (error) {
          throw new HttpError(400, (error as Error).message);
        }
        if (!existsSync(target)) throw new HttpError(404, "no such file");
        send(res, 200, "text/plain; charset=utf-8", readFileSync(target));
        return true;
      }
      if (method === "PUT" && path === "/api/world-file") {
        const rel = url.searchParams.get("path") ?? "";
        if (!rel.endsWith(".world.json"))
          throw new HttpError(400, "a world file's name ends in .world.json");
        let target: string;
        try {
          target = resolveInWorkspace(this.config.workspaceDir, rel);
        } catch (error) {
          throw new HttpError(400, (error as Error).message);
        }
        const text = await readBody(req);
        try {
          JSON.parse(text);
        } catch {
          throw new HttpError(400, "that is not JSON");
        }
        writeFileSync(target, text);
        json(res, { path: rel });
        return true;
      }
      m = /^\/api\/sessions\/([\w-]+)\/world$/.exec(path);
      if (!m) return false;
      let session: Session;
      try {
        session = this.sessions.get(m[1]!);
      } catch {
        throw new HttpError(404, `no such computer: ${m[1]}`);
      }
      if (method === "GET") {
        const k = this.keptOf(session);
        // not while a change from the panel is on its way: it would come back half done
        if (!this.busy.has(session.id)) this.syncLive(session, k);
        json(res, { world: k.world, running: session.handle.session.running });
        return true;
      }
      if (method === "PUT") {
        let body: unknown;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          throw new HttpError(400, "body is not JSON");
        }
        const world =
          isObj(body) && isObj(body["world"]) ? body["world"] : undefined;
        if (!world) throw new HttpError(400, 'send {"world": {...}}');
        json(res, await this.apply(session, world as WorldConfig));
        return true;
      }
      return false;
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (!res.headersSent)
        send(
          res,
          status,
          "text/plain",
          error instanceof Error ? error.message : String(error),
        );
      return true;
    }
  }
}
