// New Test for This File and New World for This File in the browser: src/scaffold.ts through vscode.workspace.fs,
// so it works on any file system the editor has (a GitHub repository on vscode.dev, a local folder in Chrome).
import * as vscode from "vscode";
import { PACK } from "../packData";
import { worldText } from "../worldTemplate";

async function snippetBody(
  context: vscode.ExtensionContext,
  file: string,
  name: string,
): Promise<string> {
  const data = await vscode.workspace.fs.readFile(
    vscode.Uri.joinPath(context.extensionUri, "snippets", file),
  );
  const json = JSON.parse(new TextDecoder().decode(data)) as Record<
    string,
    { body: string[] }
  >;
  return json[name]!.body.join("\n");
}

function program(uri?: vscode.Uri): vscode.Uri | undefined {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  return target && /\.lua$/i.test(target.path) ? target : undefined;
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function make(
  file: vscode.Uri,
  snippet: vscode.SnippetString,
): Promise<void> {
  if (await exists(file)) {
    await vscode.window.showTextDocument(file);
    return;
  }
  await vscode.workspace.fs.writeFile(file, new Uint8Array());
  const editor = await vscode.window.showTextDocument(file);
  await editor.insertSnippet(snippet);
}

const sibling = (target: vscode.Uri, name: string) =>
  target.with({ path: target.path.replace(/[^/]*$/, name) });
const baseName = (target: vscode.Uri) =>
  target.path.replace(/^.*\//, "").replace(/(\.test)?\.lua$/i, "");

export function registerWebScaffold(
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
        const name = baseName(target);
        const body = (
          await snippetBody(context, "lua.json", "craftos-mcp test file")
        ).replace(/\$\{1:program\}/g, `\${1:${name}}`);
        await make(
          sibling(target, `${name}.test.lua`),
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
        // a world with what the program asks for (peripheral.find/wrap, rednet.open, turtle), in the World Editor
        const file = sibling(target, `${baseName(target)}.world.json`);
        if (!(await exists(file))) {
          const open = vscode.workspace.textDocuments.find(
            (d) => d.uri.toString() === target.toString(),
          );
          const source = open
            ? open.getText()
            : new TextDecoder().decode(
                await vscode.workspace.fs.readFile(target),
              );
          await vscode.workspace.fs.writeFile(
            file,
            new TextEncoder().encode(worldText(source, PACK)),
          );
        }
        await vscode.commands.executeCommand(
          "vscode.openWith",
          file,
          "craftos-mcp.worldEditor",
        );
      },
    ),
  ];
}
