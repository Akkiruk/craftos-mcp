// The World Editor: *.world.json as a picture of the computer and what is around it, with a form for the selected
// block. A CustomTextEditor, so the file stays a text document: undo/redo, the dirty dot, git diffs and "Reopen
// Editor With... Text Editor" are VS Code's own. Each change in the webview becomes the smallest text edit
// (jsonDoc.ts), so what you did not touch keeps its exact text.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import * as vscode from "vscode";
import {
  type EditOp,
  JsonParseError,
  applyOps,
  lineCol,
  detectFormat,
  minimalEdit,
  nodeAt,
  parseTree,
  stringify,
} from "../../../../packages/world-editor/src/jsonDoc.ts";
import {
  type AddonCatalog,
  type Neighbour,
  type World,
  neighbourOf,
  worldProblems,
} from "../../../../packages/world-editor/src/model.ts";
import {
  type Problem,
  type Schema,
  validate,
} from "../../../../packages/world-editor/src/schema.ts";

export const VIEW_TYPE = "craftos-mcp.worldEditor";

/** Messages the webview sends. */
type FromView =
  | { type: "ready" }
  | { type: "edit"; ops: EditOp[] }
  | { type: "showText"; path?: (string | number)[] }
  | { type: "openFile"; file: string }
  | { type: "editOther"; file: string; ops: EditOp[] }
  | { type: "newComputer" }
  | {
      type: "rendered";
      tiles: number;
      rows: number;
      problems: number;
      parseError: boolean;
    };

/** What each open World Editor last drew, by document URI: the integration test reads it. */
export const lastRender = new Map<
  string,
  Omit<Extract<FromView, { type: "rendered" }>, "type">
>();

/** Apply edit ops to a text document as one minimal replacement (an undo step of its own). */
export async function editDocument(
  document: vscode.TextDocument,
  ops: readonly EditOp[],
): Promise<void> {
  const before = document.getText();
  let after: string;
  try {
    after = applyOps(before, ops);
  } catch (error) {
    void vscode.window.showErrorMessage(
      `World Editor: could not make that change: ${(error as Error).message}`,
    );
    return;
  }
  const change = minimalEdit(before, after);
  if (!change) return;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    document.uri,
    new vscode.Range(
      document.positionAt(change.start),
      document.positionAt(change.end),
    ),
    change.text,
  );
  await vscode.workspace.applyEdit(edit);
}

/** A world file next to `dir`, by its bare name; undefined for anything else. */
function sibling(dir: string, file: string): string | undefined {
  const target = resolve(dir, basename(file));
  return dirname(target) === dir && existsSync(target) ? target : undefined;
}

/** The schema the file names in `$schema` when it is a file next to it, else the one the extension ships. */
class SchemaCache {
  private readonly loaded = new Map<
    string,
    { mtime: number; schema: Schema }
  >();
  constructor(private readonly bundled: string) {}

  pick(file: string, world: World | undefined): string {
    const named =
      typeof world?.["$schema"] === "string"
        ? (world["$schema"] as string)
        : "";
    if (named && !/^[a-z]+:/i.test(named)) {
      const path = isAbsolute(named) ? named : resolve(dirname(file), named);
      if (existsSync(path)) return path;
    }
    return this.bundled;
  }

  get(path: string): Schema {
    const mtime = statSync(path).mtimeMs;
    const hit = this.loaded.get(path);
    if (hit && hit.mtime === mtime) return hit.schema;
    const schema = JSON.parse(readFileSync(path, "utf8")) as Schema;
    this.loaded.set(path, { mtime, schema });
    return schema;
  }
}

function readCatalog(extensionUri: vscode.Uri): AddonCatalog {
  try {
    return JSON.parse(
      readFileSync(join(extensionUri.fsPath, "schemas", "addons.json"), "utf8"),
    ) as AddonCatalog;
  } catch {
    return { defaultMc: "1.18.2", addons: [] };
  }
}

/** The other world files in the same folder: other computers that may share a network with this one. */
function neighbours(file: string): Neighbour[] {
  const dir = dirname(file);
  const inWorlds = basename(dir) === "worlds";
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Neighbour[] = [];
  for (const name of names) {
    if (!(name.endsWith(".world.json") || (inWorlds && name.endsWith(".json"))))
      continue;
    const path = join(dir, name);
    if (resolve(path) === resolve(file)) continue;
    try {
      const world = parseTree(readFileSync(path, "utf8"))?.value;
      if (world && typeof world === "object" && !Array.isArray(world))
        out.push(neighbourOf(path, world as World));
    } catch {
      // a broken neighbour is not this file's problem
    }
    if (out.length >= 24) break;
  }
  return out;
}

export interface DocState {
  readonly world?: World;
  readonly parseError?: { message: string; line: number; col: number };
  readonly problems: readonly Problem[];
  readonly schemaKey: string;
}

/** Parse and check a world text: schema problems first, then the addon and side checks. */
export function analyse(
  text: string,
  file: string,
  schemas: {
    pick(file: string, world: World | undefined): string;
    get(path: string): Schema;
  },
  catalog: AddonCatalog,
  defaults: { mc: string; addons: string },
): DocState & { schema: Schema } {
  let world: World | undefined;
  try {
    const root = parseTree(text);
    const value = root?.value ?? {};
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      const key = schemas.pick(file, undefined);
      return {
        parseError: {
          message: "A world file is one JSON object.",
          line: 1,
          col: 1,
        },
        problems: [],
        schemaKey: key,
        schema: schemas.get(key),
      };
    }
    world = value as World;
  } catch (error) {
    const key = schemas.pick(file, undefined);
    const offset = error instanceof JsonParseError ? error.offset : 0;
    const { line, col } = lineCol(text, offset);
    return {
      parseError: { message: (error as Error).message, line, col },
      problems: [],
      schemaKey: key,
      schema: schemas.get(key),
    };
  }
  const key = schemas.pick(file, world);
  const schema = schemas.get(key);
  const problems = [
    ...validate(schema, world),
    ...worldProblems(world, catalog, defaults.mc, defaults.addons),
  ];
  return { world, problems, schemaKey: key, schema };
}

export class WorldEditorProvider implements vscode.CustomTextEditorProvider {
  private readonly schemas: SchemaCache;
  private readonly catalog: AddonCatalog;

  static register(context: vscode.ExtensionContext): vscode.Disposable[] {
    const provider = new WorldEditorProvider(context.extensionUri);
    return [
      vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
        webviewOptions: { retainContextWhenHidden: false },
        supportsMultipleEditorsPerDocument: true,
      }),
      vscode.commands.registerCommand(
        "craftos-mcp.openWorldEditor",
        (uri?: vscode.Uri) => {
          const target = uri ?? vscode.window.activeTextEditor?.document.uri;
          if (target)
            return vscode.commands.executeCommand(
              "vscode.openWith",
              target,
              VIEW_TYPE,
            );
          return undefined;
        },
      ),
    ];
  }

  constructor(private readonly extensionUri: vscode.Uri) {
    this.schemas = new SchemaCache(
      join(extensionUri.fsPath, "schemas", "world.schema.json"),
    );
    this.catalog = readCatalog(extensionUri);
  }

  resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
  ): void {
    const dist = vscode.Uri.joinPath(this.extensionUri, "dist");
    panel.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    panel.webview.html = html(panel.webview, dist);
    let sentSchema = "";
    let ready = false;

    const defaults = (): { mc: string; addons: string } => {
      const config = vscode.workspace.getConfiguration(
        "craftos-mcp",
        document.uri,
      );
      return {
        mc: config.get<string>("minecraftVersion") || this.catalog.defaultMc,
        addons: config.get<string>("addons") ?? "",
      };
    };
    const post = (withNeighbours: boolean): void => {
      if (!ready) return;
      const state = analyse(
        document.getText(),
        document.uri.fsPath,
        this.schemas,
        this.catalog,
        defaults(),
      );
      if (state.schemaKey !== sentSchema) {
        sentSchema = state.schemaKey;
        void panel.webview.postMessage({
          type: "schema",
          schema: state.schema,
          catalog: this.catalog,
          schemaName: basename(state.schemaKey),
        });
      }
      void panel.webview.postMessage({
        type: "doc",
        world: state.world,
        parseError: state.parseError,
        problems: state.problems,
        defaults: defaults(),
        file: basename(document.uri.fsPath),
        neighbours:
          withNeighbours && document.uri.scheme === "file"
            ? neighbours(document.uri.fsPath)
            : undefined,
      });
    };

    let timer: NodeJS.Timeout | undefined;
    const subs: vscode.Disposable[] = [
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (
          e.document.uri.toString() !== document.uri.toString() ||
          !e.contentChanges.length
        )
          return;
        clearTimeout(timer);
        timer = setTimeout(() => post(false), 30);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("craftos-mcp")) post(false);
      }),
      panel.onDidChangeViewState(() => {
        if (panel.visible) post(true);
      }),
      panel.webview.onDidReceiveMessage((msg: FromView) =>
        this.receive(
          document,
          msg,
          () => {
            ready = true;
            post(true);
          },
          () => post(true),
        ),
      ),
    ];
    panel.onDidDispose(() => {
      clearTimeout(timer);
      for (const s of subs) s.dispose();
    });
  }

  private async receive(
    document: vscode.TextDocument,
    msg: FromView,
    onReady: () => void,
    refresh: () => void,
  ): Promise<void> {
    if (msg.type === "ready") return onReady();
    if (msg.type === "rendered") {
      const { type: _, ...seen } = msg;
      lastRender.set(document.uri.toString(), seen);
      return;
    }
    if (msg.type === "edit") return editDocument(document, msg.ops);
    const dir = dirname(document.uri.fsPath);
    if (msg.type === "showText") {
      const editor = await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.Beside,
      });
      if (msg.path) {
        try {
          const node = nodeAt(parseTree(document.getText()), msg.path);
          if (node) {
            const range = new vscode.Range(
              document.positionAt(node.start),
              document.positionAt(node.end),
            );
            editor.selection = new vscode.Selection(range.start, range.end);
            editor.revealRange(
              range,
              vscode.TextEditorRevealType.InCenterIfOutsideViewport,
            );
          }
        } catch {
          // unparseable: the text editor is still the place to fix it
        }
      }
      return;
    }
    if (msg.type === "openFile") {
      const target = sibling(dir, msg.file);
      if (target)
        await vscode.commands.executeCommand(
          "vscode.openWith",
          vscode.Uri.file(target),
          VIEW_TYPE,
        );
      return;
    }
    if (msg.type === "editOther") {
      // moving another computer on the map: an edit to its own document, which it saves (and undoes) itself
      const target = sibling(dir, msg.file);
      if (!target) return;
      await editDocument(
        await vscode.workspace.openTextDocument(vscode.Uri.file(target)),
        msg.ops,
      );
      refresh();
      return;
    }
    if (msg.type === "newComputer") return this.newComputer(document, refresh);
  }

  /** Another computer for this one's network: a new world file next to it with the next id, close by, the same modem. */
  private async newComputer(
    document: vscode.TextDocument,
    refresh: () => void,
  ): Promise<void> {
    const dir = dirname(document.uri.fsPath);
    const ext = document.uri.fsPath.endsWith(".world.json")
      ? ".world.json"
      : ".json";
    const here = basename(document.uri.fsPath, ext);
    const name = await vscode.window.showInputBox({
      title: "Add a computer",
      prompt: `A new world file next to ${basename(document.uri.fsPath)}: the computer a network test starts beside this one`,
      value: `${here}-2`,
      validateInput: (v) =>
        !/^[\w.-]+$/.test(v)
          ? "Letters, digits, - _ and . only"
          : existsSync(join(dir, v + ext))
            ? `${v}${ext} is already there`
            : undefined,
    });
    if (!name) return;
    let world: World = {};
    try {
      world = (parseTree(document.getText())?.value ?? {}) as World;
    } catch {
      // a broken file: the new one starts plain
    }
    const ids = [
      world,
      ...neighbours(document.uri.fsPath).map((n) => ({
        computerId: n.computer.id,
      })),
    ].map((w) =>
      typeof w["computerId"] === "number" ? (w["computerId"] as number) : 0,
    );
    const pos = (world["position"] ?? {}) as Record<string, number>;
    const modem = (
      (world["peripherals"] as Record<string, unknown>[] | undefined) ?? []
    ).find((p) => p?.["type"] === "modem");
    const fresh: World = {
      ...(typeof world["$schema"] === "string"
        ? { $schema: world["$schema"] }
        : {}),
      ...(world["version"] !== undefined ? { version: world["version"] } : {}),
      ...(world["addons"] !== undefined ? { addons: world["addons"] } : {}),
      computerId: Math.max(...ids) + 1,
      position: { x: (pos["x"] ?? 0) + 3, y: pos["y"] ?? 64, z: pos["z"] ?? 0 },
      peripherals: [
        {
          name: "top",
          type: "modem",
          ...(modem?.["kind"] ? { kind: modem["kind"] } : {}),
          ...(modem?.["network"] ? { network: modem["network"] } : {}),
        },
      ],
    };
    const { eol } = detectFormat(document.getText());
    const uri = vscode.Uri.file(join(dir, name + ext));
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(uri, {
      ignoreIfExists: false,
      contents: Buffer.from(
        stringify(fresh, { eol, indent: "  ", width: 80 }) + eol,
      ),
    });
    if (!(await vscode.workspace.applyEdit(edit))) return;
    refresh();
    await vscode.commands.executeCommand(
      "vscode.openWith",
      uri,
      VIEW_TYPE,
      vscode.ViewColumn.Beside,
    );
  }
}

function html(webview: vscode.Webview, dist: vscode.Uri): string {
  const nonce = randomBytes(16).toString("base64");
  const script = webview.asWebviewUri(
    vscode.Uri.joinPath(dist, "worldEditor.js"),
  );
  const style = webview.asWebviewUri(
    vscode.Uri.joinPath(dist, "worldEditor.css"),
  );
  return page({
    csp: webview.cspSource,
    nonce,
    script: script.toString(),
    style: style.toString(),
  });
}

/** The webview page. Shared with the screenshot script, which serves the same page outside VS Code. */
export function page(o: {
  csp: string;
  nonce: string;
  script: string;
  style: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${o.csp}; img-src ${o.csp} data:; script-src 'nonce-${o.nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${o.style}">
<title>World Editor</title>
</head>
<body>
<div id="app" role="application" aria-label="World Editor"><p class="loading">Loading the world...</p></div>
<script nonce="${o.nonce}" src="${o.script}"></script>
</body>
</html>`;
}
