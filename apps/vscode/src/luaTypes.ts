// CC:Tweaked types (fs, term, peripheral, the mod peripherals, ccunit...) for the Lua language server (sumneko.lua).
//
// The build (esbuild.mjs) packs packages/cc-types as `lua-addons/cc-tweaked/` (config.json and library/). Here:
// - on activation it is copied to globalStorage, because the extension's own folder is renamed by every update and a
//   settings.json naming it would point at nothing afterwards;
// - in a ComputerCraft workspace the copy's library is added to Lua.workspace.library, at workspace scope, appended
//   to whatever is there, and the runtime settings of config.json are set only where the user has none. By default
//   (craftos-mcp.luaTypes "ask") the extension asks first, once per workspace; Set Up Lua Types does it right away;
// - the first time it is set up, the addons folder goes into the user-level Lua.workspace.userThirdParty, so the
//   language server itself offers the types in CC workspaces the extension did not recognise;
// - with the Lua extension missing it offers, once, to install it, and finishes the setup when it arrives.
// packages/cc-types/INTEGRATION.md has the reasons.
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as vscode from "vscode";
import { oneAtATime } from "./prompts";
import {
  addonSettings,
  isCcProject,
  planLuaSettings,
  withoutOurLibrary,
} from "./luaSettings";

const LUA = "sumneko.lua";
const SECTION = "Lua";
const ASKED = "craftos-mcp.luaTypes.asked"; // workspaceState: the prompt was shown here
const SUGGESTED = "craftos-mcp.luaTypes.suggestedLua"; // globalState: the Lua extension was offered
const REGISTERED = "craftos-mcp.luaTypes.userThirdParty"; // globalState: the addons folder went into userThirdParty

type Mode = "auto" | "ask" | "off";

/** The packed addon (`lua-addons/cc-tweaked`), if this build has one. */
export function bundledAddon(
  context: vscode.ExtensionContext,
): string | undefined {
  const dir = context.asAbsolutePath(join("lua-addons", "cc-tweaked"));
  return existsSync(join(dir, "config.json")) ? dir : undefined;
}

/** Copies the addon into globalStorage when this version has not yet. Returns the folder that holds `cc-tweaked/`. */
export async function installLuaAddon(
  context: vscode.ExtensionContext,
  bundled: string,
): Promise<string> {
  const addons = join(context.globalStorageUri.fsPath, "lua-addons");
  const stamp = join(addons, ".version");
  const version = String(context.extension.packageJSON.version);
  const installed = await readFile(stamp, "utf8").catch(() => "");
  const dev = context.extensionMode === vscode.ExtensionMode.Development;
  if (
    dev ||
    installed !== version ||
    !existsSync(join(addons, "cc-tweaked", "config.json"))
  ) {
    await rm(join(addons, "cc-tweaked"), { recursive: true, force: true });
    await mkdir(addons, { recursive: true });
    await cp(bundled, join(addons, "cc-tweaked"), { recursive: true });
    await writeFile(stamp, version);
  }
  return addons;
}

function mode(): Mode {
  const value = vscode.workspace
    .getConfiguration("craftos-mcp")
    .get<string>("luaTypes", "ask");
  return value === "auto" || value === "off" ? value : "ask";
}

/** Workspace scope only: the folder's settings in a multi-root workspace, else .vscode/settings.json. */
function scope() {
  const target = vscode.workspace.workspaceFile
    ? vscode.ConfigurationTarget.WorkspaceFolder
    : vscode.ConfigurationTarget.Workspace;
  const pick = <T>(
    i: { workspaceValue?: T; workspaceFolderValue?: T } | undefined,
  ) =>
    target === vscode.ConfigurationTarget.WorkspaceFolder
      ? i?.workspaceFolderValue
      : i?.workspaceValue;
  return { target, pick };
}

function hasOurs(folder: vscode.WorkspaceFolder, library: string): boolean {
  const config = vscode.workspace.getConfiguration(SECTION, folder.uri);
  return (
    scope().pick(config.inspect<string[]>("workspace.library")) ?? []
  ).includes(library);
}

/** Adds the library to one folder's settings, appending and never overruling. Returns whether anything was written. */
async function addLibrary(
  folder: vscode.WorkspaceFolder,
  library: string,
  configJson: string,
): Promise<boolean> {
  const config = vscode.workspace.getConfiguration(SECTION, folder.uri);
  const { target, pick } = scope();
  const version = config.inspect<string>("runtime.version");
  const writes = planLuaSettings(
    {
      library: pick(config.inspect<string[]>("workspace.library")),
      version: version?.workspaceValue ?? version?.workspaceFolderValue,
      builtin: pick(config.inspect<Record<string, string>>("runtime.builtin")),
    },
    { library, ...addonSettings(configJson) },
  );
  if (writes.library)
    await config.update("workspace.library", writes.library, target);
  if (writes.version)
    await config.update("runtime.version", writes.version, target);
  if (writes.builtin)
    await config.update("runtime.builtin", writes.builtin, target);
  return Object.keys(writes).length > 0;
}

/** The addons folder into the user-level userThirdParty, once ever: it only adds a folder to a list. */
async function registerAddons(
  context: vscode.ExtensionContext,
  addons: string,
): Promise<void> {
  if (context.globalState.get(REGISTERED)) return;
  const config = vscode.workspace.getConfiguration(SECTION);
  const current =
    config.inspect<string[]>("workspace.userThirdParty")?.globalValue ?? [];
  if (!current.includes(addons))
    await config.update(
      "workspace.userThirdParty",
      [...current, addons],
      vscode.ConfigurationTarget.Global,
    );
  await context.globalState.update(REGISTERED, true);
}

function fileFolders(folders: readonly vscode.WorkspaceFolder[] | undefined) {
  return (folders ?? []).filter((f) => f.uri.scheme === "file");
}

export function registerLuaTypes(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): vscode.Disposable[] {
  const bundled = bundledAddon(context);
  void vscode.commands.executeCommand(
    "setContext",
    "craftos-mcp.hasLuaTypes",
    !!bundled,
  );
  const log = (line: string) => output.appendLine(`lua types: ${line}`);
  // folders waiting for the Lua extension to finish installing
  let pending: vscode.WorkspaceFolder[] | undefined;

  /** Copy, register, write. Returns the folders whose settings changed. */
  async function apply(
    folders: readonly vscode.WorkspaceFolder[],
  ): Promise<string[]> {
    if (!bundled) return [];
    const addons = await installLuaAddon(context, bundled);
    await registerAddons(context, addons);
    const library = join(addons, "cc-tweaked", "library");
    const configJson = readFileSync(
      join(addons, "cc-tweaked", "config.json"),
      "utf8",
    );
    const changed: string[] = [];
    for (const folder of folders)
      if (await addLibrary(folder, library, configJson))
        changed.push(folder.name);
    log(changed.length ? `set up in ${changed.join(", ")}` : "already set up");
    return changed;
  }

  async function installLua(
    folders: readonly vscode.WorkspaceFolder[],
  ): Promise<void> {
    pending = [...folders];
    await vscode.commands.executeCommand(
      "workbench.extensions.installExtension",
      LUA,
    );
    // apply() runs from onDidChange once VS Code has the extension (and its settings) loaded
    if (vscode.extensions.getExtension(LUA)) await finishPending();
  }

  async function finishPending(): Promise<void> {
    if (!pending || !vscode.extensions.getExtension(LUA)) return;
    const folders = pending;
    pending = undefined;
    await apply(folders);
  }

  /** On activation and for added folders: ask (or just do it on auto) in the CC folders not set up yet. */
  async function offer(
    folders: readonly vscode.WorkspaceFolder[],
  ): Promise<void> {
    if (!bundled || mode() === "off") return;
    // keep the copy current for workspaces that already point at it
    const addons = await installLuaAddon(context, bundled);
    const library = join(addons, "cc-tweaked", "library");
    const cc = fileFolders(folders).filter((f) => isCcProject(f.uri.fsPath));
    if (!cc.length) return;
    if (!vscode.extensions.getExtension(LUA)) {
      if (context.globalState.get(SUGGESTED)) return;
      await context.globalState.update(SUGGESTED, true);
      const pick = await oneAtATime(() =>
        vscode.window.showInformationMessage(
          "Set up Lua autocomplete for CC:Tweaked? It works through the Lua extension (sumneko.lua), which isn't installed yet.",
          "Install and Set Up",
          "Not Now",
        ),
      );
      if (pick === "Install and Set Up") await installLua(cc);
      return;
    }
    const todo = cc.filter((f) => !hasOurs(f, library));
    if (!todo.length) return;
    if (mode() === "auto") {
      await apply(todo);
      return;
    }
    if (context.workspaceState.get(ASKED)) return;
    await context.workspaceState.update(ASKED, true);
    const pick = await oneAtATime(() =>
      vscode.window.showInformationMessage(
        "Set up Lua autocomplete for CC:Tweaked? It adds the types for fs, term, peripheral and the mod peripherals to this workspace's Lua settings.",
        "Set Up",
        "Not Here",
        "Never",
      ),
    );
    if (pick === "Set Up") await apply(todo);
    else if (pick === "Never")
      await vscode.workspace
        .getConfiguration("craftos-mcp")
        .update("luaTypes", "off", vscode.ConfigurationTarget.Global);
  }

  const setUp = vscode.commands.registerCommand(
    "craftos-mcp.setUpLuaTypes",
    async () => {
      if (!bundled) {
        void vscode.window.showInformationMessage(
          "This build of craftos-mcp has no Lua type definitions.",
        );
        return;
      }
      const folders = fileFolders(vscode.workspace.workspaceFolders);
      if (!folders.length) {
        void vscode.window.showInformationMessage(
          "Open a folder first: the types go into a workspace's settings.",
        );
        return;
      }
      await context.workspaceState.update(ASKED, true);
      if (!vscode.extensions.getExtension(LUA)) {
        const pick = await vscode.window.showInformationMessage(
          "The CC:Tweaked types are for the Lua extension (sumneko.lua), which isn't installed. Install it?",
          "Install and Set Up",
        );
        if (pick) await installLua(folders);
        return;
      }
      const changed = await apply(folders);
      void vscode.window.showInformationMessage(
        changed.length
          ? "CC:Tweaked Lua types are set up. The Lua extension picks them up by itself."
          : "The CC:Tweaked Lua types were already set up here.",
      );
    },
  );

  const remove = vscode.commands.registerCommand(
    "craftos-mcp.removeLuaTypes",
    async () => {
      const { target, pick } = scope();
      for (const folder of fileFolders(vscode.workspace.workspaceFolders)) {
        const config = vscode.workspace.getConfiguration(SECTION, folder.uri);
        const next = withoutOurLibrary(
          pick(config.inspect<string[]>("workspace.library")),
        );
        if (next)
          await config.update(
            "workspace.library",
            next.length ? next : undefined,
            target,
          );
      }
      const config = vscode.workspace.getConfiguration(SECTION);
      const third = config.inspect<string[]>(
        "workspace.userThirdParty",
      )?.globalValue;
      const addons = join(context.globalStorageUri.fsPath, "lua-addons");
      if (third?.includes(addons)) {
        const rest = third.filter((p) => p !== addons);
        await config.update(
          "workspace.userThirdParty",
          rest.length ? rest : undefined,
          vscode.ConfigurationTarget.Global,
        );
      }
      await context.globalState.update(REGISTERED, undefined);
      await context.workspaceState.update(ASKED, true);
      void vscode.window.showInformationMessage(
        "Took the CC:Tweaked types out of this workspace's Lua settings. The runtime version and builtin settings are left as they are.",
      );
    },
  );

  const fail = (error: unknown) =>
    log(String(error instanceof Error ? error.message : error));
  void offer(vscode.workspace.workspaceFolders ?? []).catch(fail);
  return [
    setUp,
    remove,
    vscode.workspace.onDidChangeWorkspaceFolders(
      (e) => void offer(e.added).catch(fail),
    ),
    vscode.extensions.onDidChange(() => void finishPending().catch(fail)),
  ];
}
