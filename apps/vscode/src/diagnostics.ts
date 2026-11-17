// Version-aware warnings for .lua files (luaScan.ts scanLua): goto and labels on Minecraft 1.18.2 (Lua 5.1), calls
// only the emulator or CraftOS-PC has, and peripherals of an addon that is off. The pack is the file's world file
// (`version`, `addons`) when it has one, else the craftos-mcp settings. Quick fixes where there is an obvious one.
// craftos-mcp.diagnostics turns them off.
import { readFileSync } from "node:fs";
import * as vscode from "vscode";
import { type Finding, scanLua } from "./luaScan";
import { effectiveMc, enabledAddons } from "./pack";
import { PACK } from "./packData";
import { settings } from "./settings";
import { worldFor } from "./tests";

const SOURCE = "craftos-mcp";
const DEBOUNCE_MS = 400;

function readWorld(
  file: string,
): { version?: unknown; addons?: unknown } | undefined {
  const world = worldFor(file);
  if (!world) return undefined;
  try {
    return JSON.parse(readFileSync(world, "utf8")) as {
      version?: unknown;
      addons?: unknown;
    };
  } catch {
    return undefined;
  }
}

const isLua = (doc: vscode.TextDocument) =>
  doc.uri.scheme === "file" && doc.uri.fsPath.toLowerCase().endsWith(".lua");

/** The findings for one document, with the pack it was checked against. */
export function findingsFor(doc: vscode.TextDocument): Finding[] {
  const s = settings(doc.uri);
  const world = readWorld(doc.uri.fsPath);
  const mc = effectiveMc(PACK, s.mc, world?.version);
  const worldAddons =
    typeof world?.addons === "string" || Array.isArray(world?.addons)
      ? (world.addons as string | string[])
      : undefined;
  return scanLua(doc.getText(), {
    data: PACK,
    mc,
    addons: worldAddons ?? s.addons,
    addonsFrom:
      worldAddons !== undefined
        ? "the world file's addons"
        : s.addons
          ? `craftos-mcp.addons is "${s.addons}"`
          : "craftos-mcp.addons",
  });
}

const DATA = new WeakMap<vscode.Diagnostic, Finding>();

function toDiagnostic(f: Finding): vscode.Diagnostic {
  const d = new vscode.Diagnostic(
    new vscode.Range(f.start.line, f.start.col, f.end.line, f.end.col),
    f.message,
    vscode.DiagnosticSeverity.Warning,
  );
  d.source = SOURCE;
  d.code = f.code;
  DATA.set(d, f);
  return d;
}

class Fixes implements vscode.CodeActionProvider {
  provideCodeActions(
    doc: vscode.TextDocument,
    _range: vscode.Range,
    ctx: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    for (const d of ctx.diagnostics) {
      const f = DATA.get(d);
      if (!f) continue;
      if (f.remove) {
        const a = new vscode.CodeAction(
          "Remove the exit code (a real computer has none)",
          vscode.CodeActionKind.QuickFix,
        );
        a.edit = new vscode.WorkspaceEdit();
        a.edit.delete(
          doc.uri,
          new vscode.Range(
            f.remove.start.line,
            f.remove.start.col,
            f.remove.end.line,
            f.remove.end.col,
          ),
        );
        a.diagnostics = [d];
        a.isPreferred = true;
        actions.push(a);
      }
      if (
        f.code === "goto-lua51" ||
        f.code === "label-lua51" ||
        f.code === "missing-on-lua51"
      ) {
        const newer = [...PACK.versions]
          .reverse()
          .find((v) => v.cc !== "1.101.3");
        if (newer) {
          const a = new vscode.CodeAction(
            `Target Minecraft ${newer.mc} (CC:Tweaked ${newer.cc}) instead`,
            vscode.CodeActionKind.QuickFix,
          );
          a.command = {
            title: a.title,
            command: "craftos-mcp.pickMinecraftVersion",
            arguments: [newer.mc],
          };
          a.diagnostics = [d];
          actions.push(a);
        }
      }
      if (f.addon && !readWorld(doc.uri.fsPath)?.addons) {
        const addon = PACK.addons.find((x) => x.id === f.addon);
        const a = new vscode.CodeAction(
          `Switch on ${addon?.name ?? f.addon} in craftos-mcp.addons`,
          vscode.CodeActionKind.QuickFix,
        );
        a.command = {
          title: a.title,
          command: "craftos-mcp.enableAddon",
          arguments: [f.addon],
        };
        a.diagnostics = [d];
        actions.push(a);
      }
    }
    return actions;
  }
}

export function registerDiagnostics(): vscode.Disposable[] {
  const collection = vscode.languages.createDiagnosticCollection(SOURCE);
  const timers = new Map<string, NodeJS.Timeout>();
  const enabled = () =>
    vscode.workspace
      .getConfiguration("craftos-mcp")
      .get<boolean>("diagnostics", true);
  const check = (doc: vscode.TextDocument) => {
    if (!isLua(doc)) return;
    if (!enabled() || !PACK.versions.length) {
      collection.delete(doc.uri);
      return;
    }
    collection.set(doc.uri, findingsFor(doc).map(toDiagnostic));
  };
  const later = (doc: vscode.TextDocument) => {
    const key = doc.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        check(doc);
      }, DEBOUNCE_MS),
    );
  };
  const all = () => vscode.workspace.textDocuments.forEach(check);
  all();
  const worlds = vscode.workspace.createFileSystemWatcher("**/*.world.json");
  return [
    collection,
    worlds,
    worlds.onDidChange(all),
    worlds.onDidCreate(all),
    worlds.onDidDelete(all),
    vscode.workspace.onDidOpenTextDocument(check),
    vscode.workspace.onDidChangeTextDocument((e) => later(e.document)),
    vscode.workspace.onDidCloseTextDocument((doc) =>
      collection.delete(doc.uri),
    ),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("craftos-mcp")) all();
    }),
    vscode.languages.registerCodeActionsProvider(
      { pattern: "**/*.lua" },
      new Fixes(),
      {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
      },
    ),
    vscode.commands.registerCommand(
      "craftos-mcp.enableAddon",
      async (id: string) => {
        const s = settings();
        const mc = s.mc || PACK.newest;
        const on = enabledAddons(PACK, s.addons, mc).on;
        on.add(id);
        await vscode.commands.executeCommand("craftos-mcp.pickAddons", [...on]);
      },
    ),
    { dispose: () => timers.forEach((t) => clearTimeout(t)) },
  ];
}
