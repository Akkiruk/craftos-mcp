/*
 * Copying a workspace onto a computer. Every computer gets its own copy (as a real one has its own disk), so this has
 * to stay cheap: it skips what is never a computer's files (.git, node_modules, the runtime folder, anything the
 * folder's .gitignore files ignore), stops with a clear error on a folder far too big for a computer, and has an async
 * form so a big copy never blocks every other client of the MCP server while it runs.
 */
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import {
  cp,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { WorkspaceError } from "./workspace.js";

/** Folder and file names never copied, wherever they are. */
export const COPY_SKIP: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "__snapshots__",
  ".runtime",
  ".claude",
  ".cache",
]);
/** Paths under the workspace root never copied (a clone of this repo used as the workspace). */
export const COPY_SKIP_PATHS: readonly string[] = ["engine/build"];
/** A copy past these is a wrong folder (a repo, a home folder), not a computer's files: 25 MB fills a real one. */
export const MAX_COPY_BYTES = 128_000_000;
export const MAX_COPY_FILES = 20_000;

export interface CopyOptions {
  /** Absolute folders never copied: the runtime folder, so a workspace that holds it never copies its old runs. */
  readonly exclude?: readonly string[];
  /** Follow the .gitignore files in the folder (default true). */
  readonly gitignore?: boolean;
  readonly maxBytes?: number;
  readonly maxFiles?: number;
  /** Stops the async copy (a cancelled or timed-out request). */
  readonly signal?: AbortSignal;
}

export interface CopyStats {
  files: number;
  bytes: number;
}

// ---- .gitignore -----------------------------------------------------------

interface IgnoreRule {
  readonly re: RegExp;
  readonly negate: boolean;
  readonly dirOnly: boolean;
  /** The folder of the .gitignore, relative to the copy's root, "" for the root. */
  readonly base: string;
}

function globToRegex(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slashAfter = glob[i + 2] === "/";
        out += slashAfter ? "(?:.*/)?" : ".*";
        i += slashAfter ? 2 : 1;
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end < 0) out += "\\[";
      else {
        let set = glob.slice(i + 1, end).replace(/\\/g, "\\\\");
        if (set.startsWith("!")) set = "^" + set.slice(1);
        out += `[${set}]`;
        i = end;
      }
    } else if (c === "\\" && i + 1 < glob.length) {
      out += glob[i + 1]!.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
      i++;
    } else out += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  return out;
}

/** The rules of one .gitignore file, in the folder `base` (relative to the copy's root). Exported for tests. */
export function parseGitignore(text: string, base = ""): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.replace(/(?<!\\)\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1);
    }
    if (line.startsWith("\\#") || line.startsWith("\\!")) line = line.slice(1);
    const dirOnly = line.endsWith("/");
    if (dirOnly) line = line.slice(0, -1);
    if (!line) continue;
    const anchored = line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    const body = globToRegex(line);
    rules.push({
      re: new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`),
      negate,
      dirOnly,
      base,
    });
  }
  return rules;
}

/** Whether `rel` (relative to the copy's root, forward slashes) is ignored; the last rule that matches wins. */
export function ignoredBy(
  rules: readonly IgnoreRule[],
  rel: string,
  isDir: boolean,
): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    let path = rel;
    if (rule.base) {
      if (!rel.startsWith(rule.base + "/")) continue;
      path = rel.slice(rule.base.length + 1);
    }
    if (rule.re.test(path)) ignored = !rule.negate;
  }
  return ignored;
}

// ---- the walk -------------------------------------------------------------

const inside = (path: string, dir: string): boolean => {
  // relative() ignores case on Windows, so C:\ and c:\ match
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

class Walk {
  readonly root: string;
  readonly stats: CopyStats = { files: 0, bytes: 0 };
  private readonly exclude: string[];
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  readonly gitignore: boolean;

  constructor(from: string, to: string | undefined, options: CopyOptions) {
    this.root = resolve(from);
    // A folder that holds the workspace itself excludes nothing: the test suites lay their scratch workspaces out
    // inside the runtime folder, and excluding it there left every one of their computers empty.
    this.exclude = [
      ...(to === undefined ? [] : [resolve(to)]),
      ...(options.exclude ?? []).map((d) => resolve(d)),
    ].filter((dir) => !inside(this.root, dir));
    this.maxBytes = options.maxBytes ?? MAX_COPY_BYTES;
    this.maxFiles = options.maxFiles ?? MAX_COPY_FILES;
    this.gitignore = options.gitignore ?? true;
  }

  rel(path: string): string {
    return relative(this.root, path).split("\\").join("/");
  }

  skip(
    child: string,
    name: string,
    isDir: boolean,
    rules: readonly IgnoreRule[],
  ): boolean {
    if (COPY_SKIP.has(name)) return true;
    const rel = this.rel(child);
    if (COPY_SKIP_PATHS.includes(rel)) return true;
    if (this.exclude.some((dir) => inside(child, dir))) return true;
    return ignoredBy(rules, rel, isDir);
  }

  count(size: number): void {
    this.stats.files++;
    this.stats.bytes += size;
    if (this.stats.bytes > this.maxBytes || this.stats.files > this.maxFiles)
      throw new WorkspaceError(
        `the workspace ${this.root} holds more than ${this.maxFiles} files or ${Math.round(this.maxBytes / 1e6)} MB ` +
          "(after skipping .git, node_modules, .runtime and what .gitignore ignores), far more than a computer holds. " +
          "Point the workspace at the folder with your programs (--dir, CRAFTOS_WORKSPACE), or give the world a " +
          'deploy list ({"deploy": [{"from": "src", "to": "."}]}) to copy only those folders.',
      );
  }
}

function rulesFor(
  walk: Walk,
  dir: string,
  parent: readonly IgnoreRule[],
  text: string | undefined,
): readonly IgnoreRule[] {
  if (!walk.gitignore || text === undefined) return parent;
  return [...parent, ...parseGitignore(text, walk.rel(dir))];
}

/**
 * A file or folder that went between listing its folder and copying it: another program (an editor's temporary file, a
 * test that cleans up) deleted it meanwhile. The copy is of what is there, so it is left out, not an error.
 */
function vanished(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/**
 * Copy a workspace folder (or one file) onto a computer, skipping COPY_SKIP, COPY_SKIP_PATHS, `exclude` and the copy's
 * own target, and what .gitignore files ignore. Throws a WorkspaceError past maxBytes / maxFiles. A walk of our own,
 * not cpSync: cpSync's copy-into-itself check compares paths with case, so a workspace of C:\x against a runtime
 * folder of c:\x\.runtime (cwd against import.meta.url) recursed into its own target for ever.
 */
export function copyWorkspace(
  from: string,
  to: string,
  options: CopyOptions = {},
): CopyStats {
  const walk = new Walk(from, to, options);
  const copy = (
    src: string,
    dest: string,
    rules: readonly IgnoreRule[],
  ): void => {
    const info = lstatSync(src);
    if (info.isDirectory()) {
      mkdirSync(dest, { recursive: true });
      const ignoreFile = join(src, ".gitignore");
      const mine = rulesFor(
        walk,
        src,
        rules,
        walk.gitignore && existsSync(ignoreFile)
          ? readFileSync(ignoreFile, "utf8")
          : undefined,
      );
      for (const entry of readdirSync(src, { withFileTypes: true })) {
        const child = join(src, entry.name);
        if (walk.skip(child, entry.name, entry.isDirectory(), mine)) continue;
        try {
          copy(child, join(dest, entry.name), mine);
        } catch (error) {
          if (!vanished(error)) throw error;
        }
      }
    } else if (info.isFile()) {
      walk.count(info.size);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
    } else if (info.isSymbolicLink()) {
      cpSync(src, dest);
    }
  };
  try {
    copy(walk.root, resolve(to), []);
  } catch (error) {
    if (error instanceof WorkspaceError)
      rmSync(to, { recursive: true, force: true });
    throw error;
  }
  return walk.stats;
}

/**
 * copyWorkspace without blocking: the MCP server keeps answering other clients while a big folder copies. Stops on
 * `signal` (a cancelled or timed-out request) and removes what it copied.
 */
export async function copyWorkspaceAsync(
  from: string,
  to: string,
  options: CopyOptions = {},
): Promise<CopyStats> {
  const walk = new Walk(from, to, options);
  const copy = async (
    src: string,
    dest: string,
    rules: readonly IgnoreRule[],
  ): Promise<void> => {
    options.signal?.throwIfAborted();
    const info = await lstat(src);
    if (info.isDirectory()) {
      await mkdir(dest, { recursive: true });
      const text = walk.gitignore
        ? await readFile(join(src, ".gitignore"), "utf8").catch(() => undefined)
        : undefined;
      const mine = rulesFor(walk, src, rules, text);
      for (const entry of await readdir(src, { withFileTypes: true })) {
        const child = join(src, entry.name);
        if (walk.skip(child, entry.name, entry.isDirectory(), mine)) continue;
        await copy(child, join(dest, entry.name), mine).catch((error) => {
          if (!vanished(error)) throw error;
        });
      }
    } else if (info.isFile()) {
      walk.count(info.size);
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(src, dest);
    } else if (info.isSymbolicLink()) {
      await cp(src, dest);
    }
  };
  try {
    await copy(walk.root, resolve(to), []);
  } catch (error) {
    await rm(to, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return walk.stats;
}

export interface WorkspaceSize extends CopyStats {
  /** The copy would stop: past maxBytes or maxFiles. */
  readonly tooBig: boolean;
  /** Heavy folders at the top that the copy skips (node_modules, .git, .runtime ...): a sign of a repo root. */
  readonly skippedHeavy: string[];
}

/** What a copy of the workspace would hold, without copying (craftos_info's warning). Stops at the limits. */
export async function measureWorkspace(
  from: string,
  options: CopyOptions = {},
): Promise<WorkspaceSize> {
  const walk = new Walk(from, undefined, options);
  const skippedHeavy = (await readdir(walk.root).catch(() => [] as string[]))
    .filter((n) => COPY_SKIP.has(n) && n !== "__snapshots__")
    .sort();
  const visit = async (
    src: string,
    rules: readonly IgnoreRule[],
  ): Promise<void> => {
    const text = walk.gitignore
      ? await readFile(join(src, ".gitignore"), "utf8").catch(() => undefined)
      : undefined;
    const mine = rulesFor(walk, src, rules, text);
    for (const entry of await readdir(src, { withFileTypes: true })) {
      const child = join(src, entry.name);
      if (walk.skip(child, entry.name, entry.isDirectory(), mine)) continue;
      if (entry.isDirectory()) await visit(child, mine);
      else if (entry.isFile()) walk.count((await lstat(child)).size);
    }
  };
  try {
    await visit(walk.root, []);
    return { ...walk.stats, tooBig: false, skippedHeavy };
  } catch (error) {
    if (!(error instanceof WorkspaceError)) throw error;
    return { ...walk.stats, tooBig: true, skippedHeavy };
  }
}
