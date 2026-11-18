// The per-user cache of an installed package (craftosHome: %LOCALAPPDATA%\craftos-mcp, ~/.cache/craftos-mcp): one
// <version>/ folder per package version that ever set up (engine and ROMs, about 60 MB each), plus jars/ and
// runtime/. Every upgrade leaves the old version behind, so pruning keeps the current version and the newest one
// before it (something still running it, an `npx craftos-mcp@<older>`) and removes the rest. A folder whose setup is
// running (setup.lock) is never touched.
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export interface CachedVersion {
  readonly version: string;
  readonly dir: string;
  readonly bytes: number;
  /** Its setup is running (or was killed mid-way): setup.lock is there. */
  readonly locked: boolean;
}

const VERSION_DIR = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;

/** Compare two versions as semver does (a pre-release sorts before its release). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = "", pre] = v.split(/[-+]/, 2);
    return { nums: core.split(".").map(Number), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** Bytes in a folder, recursively; 0 when it is gone. */
export function folderBytes(dir: string): number {
  let total = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) total += folderBytes(full);
    else
      try {
        total += statSync(full).size;
      } catch {
        // went away meanwhile
      }
  }
  return total;
}

/** The version folders in the cache, oldest first. */
export function listCachedVersions(home: string): CachedVersion[] {
  if (!existsSync(home)) return [];
  return readdirSync(home, { withFileTypes: true })
    .filter((e) => e.isDirectory() && VERSION_DIR.test(e.name))
    .map((e) => {
      const dir = join(home, e.name);
      return {
        version: e.name,
        dir,
        bytes: folderBytes(dir),
        locked: existsSync(join(dir, "setup.lock")),
      };
    })
    .sort((a, b) => compareVersions(a.version, b.version));
}

/**
 * Which versions a prune keeps: `current` (when given) and the newest version before it. With no current version
 * (a clone looking at the cache) the newest two.
 */
export function versionsToKeep(
  versions: readonly string[],
  current: string | undefined,
): Set<string> {
  const sorted = [...versions].sort(compareVersions);
  if (current === undefined) return new Set(sorted.slice(-2));
  const older = sorted.filter((v) => compareVersions(v, current) < 0);
  return new Set([current, ...older.slice(-1)]);
}

export interface PruneResult {
  readonly removed: CachedVersion[];
  readonly kept: CachedVersion[];
  /** Folders a prune should have removed but could not (a running engine holds a file, say). */
  readonly failed: { version: string; error: string }[];
}

/** Remove the cached versions versionsToKeep leaves out. `dryRun` only says what it would remove. */
export function pruneCache(
  home: string,
  current: string | undefined,
  { dryRun = false }: { dryRun?: boolean } = {},
): PruneResult {
  const all = listCachedVersions(home);
  const keep = versionsToKeep(
    all.map((v) => v.version),
    current,
  );
  const removed: CachedVersion[] = [];
  const kept: CachedVersion[] = [];
  const failed: { version: string; error: string }[] = [];
  for (const v of all) {
    if (keep.has(v.version) || v.locked) {
      kept.push(v);
      continue;
    }
    if (!dryRun)
      try {
        rmSync(v.dir, { recursive: true, force: true });
      } catch (error) {
        failed.push({ version: v.version, error: (error as Error).message });
        continue;
      }
    removed.push(v);
  }
  return { removed, kept, failed };
}

export const megabytes = (bytes: number): string =>
  `${(bytes / 1024 / 1024).toFixed(1)} MB`;
