// New Test for This File and New World for This File: make `name.test.lua` or `name.world.json` next to the open
// program from the extension's own snippets (snippets/*.json), with the program's name filled in.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import * as vscode from "vscode";

function snippetBody(
  context: vscode.ExtensionContext,
  file: string,
  name: string,
): string {
  const json = JSON.parse(
    readFileSync(context.asAbsolutePath(join("snippets", file)), "utf8"),
  ) as Record<string, { body: string[] }>;
  return json[name]!.body.join("\n");
}

/** The open program, if it is a plain .lua file (not a test). */
function program(uri?: vscode.Uri): vscode.Uri | undefined {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!target || target.scheme !== "file" || !/\.lua$/i.test(target.fsPath))
    return undefined;
  return target;
}

async function make(
  file: string,
  snippet: vscode.SnippetString,
): Promise<void> {
  if (existsSync(file)) {
    await vscode.window.showTextDocument(vscode.Uri.file(file));
    return;
  }
  writeFileSync(file, "");
  const editor = await vscode.window.showTextDocument(vscode.Uri.file(file));
  await editor.insertSnippet(snippet);
}

export function registerScaffold(
  context: vscode.ExtensionContext,
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(
      "craftos-mcp.newTest",
      async (uri?: vscode.Uri) => {
        const target = program(uri);
        if (!target) {
          void vscode.window.showErrorMessage(
            "New Test needs a .lua program open.",
          );
          return;
        }
        const name = basename(target.fsPath).replace(/(\.test)?\.lua$/i, "");
        const body = snippetBody(context, "lua.json", "craftos-mcp test file")
          // the snippet's own ${TM_FILENAME_BASE/...} works out the world file's name from the new file
          .replace(/\$\{1:program\}/g, `\${1:${name}}`);
        await make(
          join(dirname(target.fsPath), `${name}.test.lua`),
          new vscode.SnippetString(body),
        );
      },
    ),
    vscode.commands.registerCommand(
      "craftos-mcp.newWorld",
      async (uri?: vscode.Uri) => {
        const target = program(uri);
        if (!target) {
          void vscode.window.showErrorMessage(
            "New World needs a .lua program open.",
          );
          return;
        }
        const name = basename(target.fsPath).replace(/(\.test)?\.lua$/i, "");
        const body = snippetBody(context, "world.json", "craftos-mcp world");
        await make(
          join(dirname(target.fsPath), `${name}.world.json`),
          new vscode.SnippetString(body),
        );
      },
    ),
  ];
}
