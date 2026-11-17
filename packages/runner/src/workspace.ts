import {
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export class WorkspaceError extends Error {}

/**
 * Resolve a workspace-relative path and refuse anything that escapes the
 * workspace (absolute paths, `..`, drive letters, or symlinks pointing out).
 */
export function resolveInWorkspace(
  workspaceDir: string,
  userPath: string,
): string {
  if (userPath.includes("\0"))
    throw new WorkspaceError("path contains a NUL byte");
  if (
    isAbsolute(userPath) ||
    /^[a-zA-Z]:/.test(userPath) ||
    userPath.startsWith("\\\\")
  ) {
    throw new WorkspaceError(`path must be workspace-relative: ${userPath}`);
  }
  const root = resolve(workspaceDir);
  const target = resolve(root, userPath);
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new WorkspaceError(`path escapes the workspace: ${userPath}`);
  // Resolve symlinks on the deepest existing ancestor.
  let probe = target;
  for (;;) {
    try {
      const real = realpathSync(probe);
      const realRoot = realpathSync(root);
      const realRel = relative(realRoot, real);
      if (realRel.startsWith("..") || isAbsolute(realRel)) {
        throw new WorkspaceError(
          `path escapes the workspace via a link: ${userPath}`,
        );
      }
      break;
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  return target;
}

export function writeWorkspaceFile(
  workspaceDir: string,
  userPath: string,
  content: string,
): string {
  const target = resolveInWorkspace(workspaceDir, userPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  return target;
}

export function readWorkspaceFile(
  workspaceDir: string,
  userPath: string,
): string {
  return readFileSync(resolveInWorkspace(workspaceDir, userPath), "utf8");
}

export interface WorkspaceEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly size: number;
}

/** List files under a workspace directory (recursive), using forward slashes. */
export function listWorkspace(
  workspaceDir: string,
  userPath = ".",
  /** Names not listed or walked into (COPY_SKIP: what never goes onto a computer). */
  skip?: ReadonlySet<string>,
): WorkspaceEntry[] {
  const start = resolveInWorkspace(workspaceDir, userPath);
  const root = resolve(workspaceDir);
  const entries: WorkspaceEntry[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (skip?.has(name)) continue;
      const full = join(dir, name);
      const info = statSync(full);
      const path = relative(root, full).split(sep).join("/");
      entries.push({
        path,
        kind: info.isDirectory() ? "directory" : "file",
        size: info.size,
      });
      if (info.isDirectory()) walk(full);
    }
  };
  if (statSync(start).isDirectory()) walk(start);
  return entries;
}
