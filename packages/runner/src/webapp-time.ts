/**
 * The browser app's time controls and world snapshots (webapp/timecontrol.js is the page's side): the clock of every
 * computer (clock.ts) and named snapshots of the whole world (world-snapshot.ts).
 *
 *   GET    /api/clock[?front=<id>]          the clock: paused, speed, the world's time of day
 *   POST   /api/clock {action, ...}         pause | resume | toggle | step {ticks} | speed {speed} | jump {amount}
 *                                           | time {amount}: set the time of day ("18:00", or ms since day 1, 06:00)
 *   GET    /api/snapshots                   the saved snapshots
 *   POST   /api/snapshots {name}            save the world as it stands
 *   POST   /api/snapshots/<name>/restore    put the world back as it was
 *   DELETE /api/snapshots/<name>
 *   GET    /api/snapshots/<name>/file       the .craftos-world file, to share
 *   POST   /api/snapshots/import?name=<n>   take in a .craftos-world file (the body)
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  DAY_MS,
  type WorldClock,
  parseDuration,
  worldClockFor,
} from "./clock.js";
import type { RunnerConfig } from "./config.js";
import type { SessionManager } from "./sessions.js";
import {
  type SnapshotHooks,
  SNAPSHOT_EXT,
  deleteSnapshot,
  importSnapshot,
  listSnapshots,
  restoreBackupsDir,
  restoreSnapshot,
  saveSnapshot,
  snapshotFile,
} from "./world-snapshot.js";

export interface TimeRoutesOptions {
  readonly sessions: SessionManager;
  readonly config: RunnerConfig;
  readonly hooks: SnapshotHooks;
}

class RouteError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function readRaw(req: IncomingMessage, limit = 200_000_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) reject(new RouteError(413, "that file is too large"));
      else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const body = (await readRaw(req, 1_000_000)).toString("utf8");
  try {
    return body ? (JSON.parse(body) as Record<string, unknown>) : {};
  } catch {
    throw new RouteError(400, "body is not JSON");
  }
}

function reply(res: ServerResponse, value: unknown, status = 200): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
}

/** "18:00" or "6:30" as world ms on the current day, else a length of time from day 1, 06:00. */
function timeOfDay(text: string, now: number): number {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(text);
  if (!m) return parseDuration(text);
  const hours = Number(m[1]) + Number(m[2]) / 60;
  if (hours >= 24) throw new Error("a time of day is 00:00 to 23:59");
  const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
  // os.time 6:00 is the start of the day count
  const into = (((hours - 6 + 24) % 24) / 24) * DAY_MS;
  const at = dayStart + into;
  return at < now ? at + DAY_MS : at; // the next time it is that o'clock, as /time set does not go back
}

async function clockAction(
  clock: WorldClock,
  body: Record<string, unknown>,
): Promise<void> {
  const action = String(body["action"] ?? "");
  switch (action) {
    case "pause":
      await clock.pause();
      return;
    case "resume":
      await clock.resume();
      return;
    case "toggle":
      await (clock.current.paused ? clock.resume() : clock.pause());
      return;
    case "step":
      await clock.step(Math.max(1, Math.floor(Number(body["ticks"]) || 1)));
      return;
    case "speed": {
      const speed = body["speed"] === "max" ? "max" : Number(body["speed"]);
      await clock.setSpeed(speed);
      return;
    }
    case "jump": {
      const amount = body["amount"];
      await clock.jump(
        typeof amount === "number"
          ? amount
          : parseDuration(String(amount ?? "")),
      );
      return;
    }
    case "time": {
      const amount = body["amount"];
      const now = (await clock.status()).worldMs ?? 0;
      await clock.setWorldTime(
        typeof amount === "number"
          ? amount
          : timeOfDay(String(amount ?? ""), now),
      );
      return;
    }
    default:
      throw new RouteError(
        400,
        "action is pause, resume, toggle, step, speed, jump or time",
      );
  }
}

/** The routes, as one handler: true when it answered the request. */
export function timeRoutes(
  options: TimeRoutesOptions,
): (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean> {
  const { sessions, config, hooks } = options;
  const clock = worldClockFor(sessions);
  return async (req, res, url) => {
    const path = url.pathname;
    const method = req.method ?? "GET";
    try {
      if (path === "/api/clock") {
        if (method === "POST") await clockAction(clock, await readJson(req));
        else if (method !== "GET") return false;
        reply(
          res,
          await clock.status(url.searchParams.get("front") ?? undefined),
        );
        return true;
      }
      if (path === "/api/snapshots" && method === "GET") {
        reply(res, {
          snapshots: listSnapshots(config),
          // where a restore keeps a copy of the project files it overwrites or removes
          backups: restoreBackupsDir(config),
        });
        return true;
      }
      if (path === "/api/snapshots" && method === "POST") {
        const body = await readJson(req);
        const saved = await saveSnapshot(
          sessions,
          config,
          String(body["name"] ?? ""),
          hooks,
        );
        reply(res, saved);
        return true;
      }
      if (path === "/api/snapshots/import" && method === "POST") {
        const data = await readRaw(req);
        const name = url.searchParams.get("name") || undefined;
        reply(res, importSnapshot(config, data, name));
        return true;
      }
      const m = /^\/api\/snapshots\/([^/]+)(\/restore|\/file)?$/.exec(path);
      if (!m) return false;
      const name = decodeURIComponent(m[1]!);
      if (method === "DELETE" && !m[2]) {
        deleteSnapshot(config, name);
        reply(res, {});
        return true;
      }
      if (method === "POST" && m[2] === "/restore") {
        reply(res, await restoreSnapshot(sessions, config, name, hooks));
        return true;
      }
      if (method === "GET" && m[2] === "/file") {
        const data = snapshotFile(config, name);
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="${encodeURIComponent(name)}${SNAPSHOT_EXT}"`,
          "cache-control": "no-store",
        });
        res.end(data);
        return true;
      }
      return false;
    } catch (error) {
      const status = error instanceof RouteError ? error.status : 400;
      res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
      res.end(error instanceof Error ? error.message : String(error));
      return true;
    }
  };
}
