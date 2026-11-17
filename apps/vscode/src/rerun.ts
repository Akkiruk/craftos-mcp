// Rerun on save: while a Run in CraftOS panel is open, saving its program, any other .lua in the folder the app runs
// in, or the program's world file runs the program over in the panel (craftos-mcp.rerunOnSave, on by default).
import { isAbsolute, relative } from "node:path";
import * as vscode from "vscode";
import {
  type RunningPanel,
  enqueue,
  rerunProgram,
  runningPanels,
} from "./runPanel";
import { worldFor } from "./tests";

/** Saves close together (Save All) run the program once. */
const DEBOUNCE_MS = 300;

function inside(folder: string, path: string): boolean {
  const rel = relative(folder, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Whether saving `path` reruns the panel's program. */
export function rerunsOnSave(
  panel: Pick<RunningPanel, "file" | "folder">,
  path: string,
): boolean {
  const lower = path.toLowerCase();
  if (lower.endsWith(".lua")) return inside(panel.folder, path);
  const world = worldFor(panel.file);
  return !!world && relative(world, path) === "";
}

export function registerRerunOnSave(): vscode.Disposable {
  const timers = new Map<RunningPanel, NodeJS.Timeout>();
  const save = vscode.workspace.onDidSaveTextDocument((doc) => {
    if (doc.uri.scheme !== "file") return;
    if (
      !vscode.workspace
        .getConfiguration("craftos-mcp")
        .get<boolean>("rerunOnSave", true)
    )
      return;
    for (const panel of runningPanels()) {
      if (panel.debugging || !rerunsOnSave(panel, doc.uri.fsPath)) continue;
      clearTimeout(timers.get(panel));
      timers.set(
        panel,
        setTimeout(() => {
          timers.delete(panel);
          void enqueue(panel, "rerun after save", () => rerunProgram(panel));
        }, DEBOUNCE_MS),
      );
    }
  });
  return {
    dispose() {
      save.dispose();
      for (const t of timers.values()) clearTimeout(t);
    },
  };
}
