import { existsSync, readFileSync } from "node:fs";
import type { ScreenCapture } from "./engine.js";
import { writeWorkspaceFile } from "./workspace.js";

export interface SnapshotScreen {
  readonly peripheral: string | null;
  readonly width: number;
  readonly height: number;
  readonly lines: string[];
}

export interface SnapshotComparison {
  readonly name: string;
  readonly status: "match" | "mismatch" | "created" | "updated";
  readonly path: string;
  /** First differing screen/line when status is "mismatch". */
  readonly diff?: {
    screen: string;
    line: number;
    expected: string;
    actual: string;
  }[];
}

function normalize(screens: readonly ScreenCapture[]): SnapshotScreen[] {
  return screens
    .filter((s) => s.lines.length > 0)
    .map((s) => ({
      peripheral: s.peripheral ?? null,
      width: s.width,
      height: s.height,
      // Trailing blank lines are noise from scrolling.
      lines: s.lines.slice(
        0,
        Math.max(1, s.lines.findLastIndex((l) => l.length > 0) + 1),
      ),
    }));
}

export function snapshotPath(name: string): string {
  if (!/^[\w.-]+$/.test(name))
    throw new Error(`snapshot name must match [\\w.-]+: ${name}`);
  return `__snapshots__/${name}.json`;
}

/** Compare terminal/monitor text with a golden file in the workspace. */
export function compareSnapshot(
  workspaceDir: string,
  fullPath: (relative: string) => string,
  name: string,
  screens: readonly ScreenCapture[],
  update: boolean,
): SnapshotComparison {
  const relative = snapshotPath(name);
  const file = fullPath(relative);
  const actual = normalize(screens);
  const write = (): void => {
    writeWorkspaceFile(
      workspaceDir,
      relative,
      JSON.stringify(actual, null, 2) + "\n",
    );
  };
  if (!existsSync(file)) {
    write();
    return { name, status: "created", path: relative };
  }
  const expected = JSON.parse(readFileSync(file, "utf8")) as SnapshotScreen[];
  const diff: NonNullable<SnapshotComparison["diff"]> = [];
  const count = Math.max(expected.length, actual.length);
  for (let i = 0; i < count; i++) {
    const e = expected[i];
    const a = actual[i];
    const label = (a ?? e)?.peripheral ?? "terminal";
    const rows = Math.max(e?.lines.length ?? 0, a?.lines.length ?? 0);
    for (let row = 0; row < rows; row++) {
      const el = e?.lines[row] ?? "";
      const al = a?.lines[row] ?? "";
      if (el !== al)
        diff.push({ screen: label, line: row + 1, expected: el, actual: al });
    }
  }
  if (diff.length === 0) return { name, status: "match", path: relative };
  if (update) {
    write();
    return { name, status: "updated", path: relative };
  }
  return { name, status: "mismatch", path: relative, diff: diff.slice(0, 20) };
}
