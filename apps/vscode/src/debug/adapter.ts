// The `craftos` debug type in VS Code: F5 on a .lua file (or a launch.json entry, or Debug in the Testing view)
// starts the file in the Run in CraftOS panel with the engine's debugger attached. The adapter runs inside the
// extension (session.ts does the protocol); this file is only the wiring to VS Code and to the panel.
import { existsSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import * as vscode from "vscode";
import { runInCraftOS } from "../runPanel";
import { projectFolder, runFolder } from "../settings";
import { EngineLink } from "./engineLink.ts";
import { hoverExpression, toComputerPath } from "./paths.ts";
import {
  type DapMessage,
  DebugSession,
  type LaunchArguments,
  type Located,
} from "./session.ts";

export const DEBUG_TYPE = "craftos";

const isTestFile = (file: string): boolean => /\.test\.lua$/i.test(file);

/** Whether a launch runs its program under ccunit: what it says, else by the file's name. */
const asTest = (args: LaunchArguments, file: string): boolean =>
  typeof args.test === "boolean" ? args.test : isTestFile(file);

function programFile(
  args: LaunchArguments,
  folder: vscode.WorkspaceFolder | undefined,
): string {
  const program = typeof args.program === "string" ? args.program.trim() : "";
  if (!program)
    throw new Error(
      'The launch configuration has no "program": the .lua file to debug.',
    );
  const base =
    folder?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const file = isAbsolute(program) || !base ? program : resolve(base, program);
  if (!file.toLowerCase().endsWith(".lua"))
    throw new Error(`CraftOS debugs .lua files; "program" is ${program}.`);
  if (!existsSync(file)) throw new Error(`There is no ${file}.`);
  return file;
}

class InlineAdapter implements vscode.DebugAdapter {
  private readonly emitter =
    new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  readonly onDidSendMessage = this.emitter.event;
  private readonly session: DebugSession;

  constructor(
    folder: vscode.WorkspaceFolder | undefined,
    output: vscode.OutputChannel,
    extensionUri: vscode.Uri,
  ) {
    this.session = new DebugSession({
      send: (message) =>
        this.emitter.fire(message as vscode.DebugProtocolMessage),
      listen: () => EngineLink.listen(),
      locate: (args): Located => {
        const file = programFile(args, folder);
        const uri = vscode.Uri.file(file);
        // a test sees the project as the Testing view gives it; a program its own folder, as Run in CraftOS does
        const root = asTest(args, file) ? projectFolder(uri) : runFolder(uri);
        const program = toComputerPath(file, root);
        if (!program) throw new Error(`${file} is not inside ${root}.`);
        return { root, program };
      },
      launch: async (args, located, link) => {
        const file = programFile(args, folder);
        const running = await runInCraftOS(
          vscode.Uri.file(file),
          output,
          extensionUri,
          {
            ...(args.noDebug !== true && { debug: link }),
            test: asTest(args, file),
            folder: located.root,
          },
        );
        // runInCraftOS has shown why
        if (!running) throw new Error("The computer did not start.");
        return {
          dispose: () => running.panel.dispose(),
          onDidEnd: (listener) => {
            running.panel.onDidDispose(listener);
          },
        };
      },
    });
  }

  handleMessage(message: vscode.DebugProtocolMessage): void {
    this.session.handle(message as unknown as DapMessage);
  }

  dispose(): void {
    this.session.dispose();
    this.emitter.dispose();
  }
}

class ConfigurationProvider implements vscode.DebugConfigurationProvider {
  provideDebugConfigurations(): vscode.DebugConfiguration[] {
    return [
      {
        type: DEBUG_TYPE,
        request: "launch",
        name: "Debug in CraftOS",
        program: "${file}",
      },
    ];
  }

  /** F5 with no launch.json: debug the Lua file in the editor. */
  resolveDebugConfiguration(
    _folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
  ): vscode.DebugConfiguration | undefined {
    if (!config.type && !config.request && !config.name) {
      const doc = vscode.window.activeTextEditor?.document;
      if (!doc || !doc.uri.fsPath.toLowerCase().endsWith(".lua")) {
        void vscode.window.showInformationMessage(
          "Open the .lua file to debug in CraftOS first.",
        );
        return undefined;
      }
      config.type = DEBUG_TYPE;
      config.request = "launch";
      config.name = "Debug in CraftOS";
    }
    if (!config["program"]) config["program"] = "${file}";
    return config;
  }
}

/** Start a debug session on a file: the Debug in CraftOS command and the Testing view's Debug. */
export function debugFile(
  uri: vscode.Uri,
  extra: Record<string, unknown> = {},
): Thenable<boolean> {
  return vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(uri), {
    type: DEBUG_TYPE,
    request: "launch",
    name: `Debug ${basename(uri.fsPath)} in CraftOS`,
    program: uri.fsPath,
    ...extra,
  });
}

export function registerDebugger(
  output: vscode.OutputChannel,
  extensionUri: vscode.Uri,
): vscode.Disposable[] {
  return [
    vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, {
      createDebugAdapterDescriptor: (session) =>
        new vscode.DebugAdapterInlineImplementation(
          new InlineAdapter(session.workspaceFolder, output, extensionUri),
        ),
    }),
    vscode.debug.registerDebugConfigurationProvider(
      DEBUG_TYPE,
      new ConfigurationProvider(),
    ),
    // Hovering a field shows the field: `config.screen.width`, not the global `width`. Only while a CraftOS session
    // is the one being looked at; any other Lua debugger keeps VS Code's own choice.
    vscode.languages.registerEvaluatableExpressionProvider("lua", {
      provideEvaluatableExpression(document, position) {
        if (vscode.debug.activeDebugSession?.type !== DEBUG_TYPE)
          return undefined;
        const hit = hoverExpression(
          document.lineAt(position.line).text,
          position.character,
        );
        if (!hit) return undefined;
        return new vscode.EvaluatableExpression(
          new vscode.Range(position.line, hit.start, position.line, hit.end),
          hit.expression,
        );
      },
    }),
    vscode.commands.registerCommand(
      "craftos-mcp.debugInCraftOS",
      async (uri?: vscode.Uri) => {
        const target = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (!target || !target.fsPath.toLowerCase().endsWith(".lua")) {
          void vscode.window.showErrorMessage(
            "Debug in CraftOS needs a .lua file: open one, or right-click it in the Explorer.",
          );
          return false;
        }
        return debugFile(target);
      },
    ),
    // "Debug test" above a test (testLens.ts): the test's file under ccunit, with the debugger attached
    vscode.commands.registerCommand(
      "craftos-mcp.debugTest",
      async (uri?: vscode.Uri) => {
        const target = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (!target) return false;
        const doc = vscode.workspace.textDocuments.find(
          (d) => d.uri.toString() === target.toString(),
        );
        if (doc?.isDirty) await doc.save();
        return debugFile(target, { test: true });
      },
    ),
  ];
}
