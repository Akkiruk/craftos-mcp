// The browser app's (and the desktop app's) CraftOS-PC import, over HTTP. webapp.ts hands every /api/craftos-pc
// request here:
//   GET  /api/craftos-pc[?folder=]           what is in the CraftOS-PC folder (default: found on this machine); reads only
//   POST /api/craftos-pc/import              {folder?, out?, ids?, force?}: write the project (craftospc-import.ts)
//   GET  /api/craftos-pc/project[?dir=]      the computers an import wrote there (default: the app's project, else `out`)
// A computer starts with POST /api/sessions and its `world`, `monitors` and `dir` (its own files).
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  type ImportedComputer,
  craftosPcFolders,
  findCraftosPc,
  importCraftosPc,
  importedComputers,
  isCraftosPcFolder,
  readCraftosPc,
} from "./craftospc-import.js";
import { PROJECT_FILE, readProject } from "./project.js";

/** Where the app puts an import when the page names no folder. */
export const DEFAULT_IMPORT_DIR = join(homedir(), "craftos-mcp", "craftos-pc");

export interface CraftosPcApiOptions {
  /** The folder of the app's craftos.json, if it has one: its imported computers are listed first. */
  readonly projectDir?: string;
}

/** An answer: the status and the JSON body. */
export interface ApiAnswer {
  readonly status: number;
  readonly body: unknown;
}

/** The Minecraft version and mods a project's craftos.json names, for starting its computers from anywhere. */
function projectSettings(dir: string): { version?: string; addons?: string[] } {
  try {
    const { data } = readProject(join(dir, PROJECT_FILE));
    const addons =
      data.addons === undefined
        ? undefined
        : data.addons === "none"
          ? []
          : Array.isArray(data.addons)
            ? data.addons
            : undefined;
    return {
      ...(typeof data.minecraft === "string" && { version: data.minecraft }),
      ...(addons && { addons }),
    };
  } catch {
    return {};
  }
}

/**
 * What the page gets for each computer of a project: the body of POST /api/sessions that starts it (`start`), and
 * what to show.
 */
function forPage(
  c: ImportedComputer,
  settings: { version?: string; addons?: string[] },
) {
  const { monitors = [], ...world } = c.world;
  return {
    id: c.id,
    label: c.label ?? null,
    files: c.files,
    dir: c.dir,
    worldFile: c.worldFile,
    start: {
      name: c.label ?? `computer ${c.id}`,
      advanced: world.advanced !== false,
      world,
      monitors,
      dir: c.dir,
      ...settings,
    },
  };
}

/** Handle one /api/craftos-pc request; undefined when the path is not one of these. */
export async function craftosPcApi(
  method: string,
  url: URL,
  body: () => Promise<Record<string, unknown>>,
  options: CraftosPcApiOptions = {},
): Promise<ApiAnswer | undefined> {
  const path = url.pathname;
  const fail = (status: number, error: unknown): ApiAnswer => ({
    status,
    body: { error: error instanceof Error ? error.message : String(error) },
  });

  if (method === "GET" && path === "/api/craftos-pc") {
    const given = url.searchParams.get("folder")?.trim();
    const folder = given ? resolve(given) : findCraftosPc();
    const base = {
      looked: craftosPcFolders(),
      defaultOut: DEFAULT_IMPORT_DIR,
    };
    if (!folder || !isCraftosPcFolder(folder))
      return {
        status: 200,
        body: {
          ...base,
          folder: folder ?? null,
          found: false,
          computers: [],
          disks: [],
          notes: [],
        },
      };
    try {
      const data = readCraftosPc(folder);
      return {
        status: 200,
        body: {
          ...base,
          folder: data.folder,
          found: true,
          initial: data.initial,
          computers: data.computers.map((c) => ({
            id: c.id,
            label: c.label ?? null,
            files: c.files,
            bytes: c.bytes,
            isColor: c.isColor,
            width: c.width,
            height: c.height,
            attaches: c.attaches.map((a) => ({ side: a.side, type: a.type })),
            usesCraftosPcApis: c.usesCraftosPcApis,
          })),
          disks: data.disks,
          notes: data.notes,
        },
      };
    } catch (error) {
      return fail(400, error);
    }
  }

  if (method === "POST" && path === "/api/craftos-pc/import") {
    const form = await body();
    const folder =
      typeof form["folder"] === "string" && form["folder"].trim()
        ? resolve(form["folder"].trim())
        : findCraftosPc();
    if (!folder)
      return fail(
        400,
        `no CraftOS-PC folder found (looked in ${craftosPcFolders().join(", ")}): type where yours is`,
      );
    const out =
      typeof form["out"] === "string" && form["out"].trim()
        ? resolve(form["out"].trim())
        : DEFAULT_IMPORT_DIR;
    const ids = Array.isArray(form["ids"])
      ? form["ids"].map(Number).filter((n) => Number.isInteger(n) && n >= 0)
      : undefined;
    try {
      const result = importCraftosPc(folder, out, {
        ...(form["force"] === true && { force: true }),
        ...(ids && { ids }),
      });
      return {
        status: 200,
        body: {
          from: result.from,
          project: result.project,
          projectFile: result.projectFile,
          computers: result.computers.map((c) =>
            forPage(c, projectSettings(result.project)),
          ),
          notes: result.notes,
        },
      };
    } catch (error) {
      // an earlier import in the way: the page offers to replace it
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: 409,
        body: { error: message, exists: /is there already/.test(message) },
      };
    }
  }

  if (method === "GET" && path === "/api/craftos-pc/project") {
    const given = url.searchParams.get("dir")?.trim();
    const candidates = given
      ? [resolve(given)]
      : [options.projectDir, DEFAULT_IMPORT_DIR].filter(
          (d): d is string => !!d,
        );
    for (const dir of candidates) {
      const computers = importedComputers(dir);
      if (computers.length)
        return {
          status: 200,
          body: {
            project: dir,
            computers: computers.map((c) => forPage(c, projectSettings(dir))),
          },
        };
    }
    return {
      status: 200,
      body: { project: candidates[0] ?? null, computers: [] },
    };
  }

  return undefined;
}
