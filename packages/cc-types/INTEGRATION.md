# Shipping the types in the VS Code extension

How `apps/vscode` should ship `packages/cc-types` and switch it on. Nothing here is wired up yet: this is the plan,
checked against the Lua extension 3.19.2 (`sumneko.lua`, lua-language-server 3.19.2), whose source is named where it
decides something.

## The short version

1. Pack the addon into the extension: `lua-addons/cc-tweaked/config.json` and `lua-addons/cc-tweaked/library/**`.
2. On activation copy it to `context.globalStorageUri`, because the extension's own folder is renamed by every update.
3. In a CC workspace, **add** the copied `library` folder to `Lua.workspace.library` in the workspace's settings, and
   set `Lua.runtime.version` and `Lua.runtime.builtin` only where the user has not.
4. Once, at user level, add the copied `lua-addons` folder to `Lua.workspace.userThirdParty`. That covers every
   workspace the extension did not recognise: the language server itself asks when it sees CC code.
5. When the Lua extension is missing, offer to install it. Once.

## Why not `contributes.configurationDefaults`

An extension can give new defaults to another extension's settings there, but it cannot do this job:

- It is static JSON in `package.json`, with no way to name the extension's install folder. `Lua.workspace.library`
  only expands `${workspaceFolder}`, `${3rd}`, `${addons}`, `${env:NAME}` and `~` (`script/files.lua`).
- A default applies to every Lua workspace, CC or not: a LÖVE project would get `Lua 5.2` and lose `os.execute`.
- A default for a list is replaced, not added to, by the first value the user sets.

So the settings are written by code, where the workspace is known.

## 1. Pack it

`apps/vscode/esbuild.mjs`, after the bundle (one more step, no new dependency):

```js
import { cpSync, rmSync } from "node:fs";
rmSync("lua-addons", { recursive: true, force: true });
cpSync("../../packages/cc-types/library", "lua-addons/cc-tweaked/library", {
  recursive: true,
});
cpSync(
  "../../packages/cc-types/config.json",
  "lua-addons/cc-tweaked/config.json",
);
```

`apps/vscode/.vscodeignore` (it is an allow list):

```
!lua-addons/**
```

`apps/vscode/.gitignore`: add `lua-addons/`. The copy is about 550 KB of Lua, 65 KB compressed.

The folder name `cc-tweaked` matters: the language server lists an addon by its folder, and the path it adds to
`Lua.workspace.library` is `<userThirdParty entry>/<folder>/library`.

## 2. A path that survives updates

`context.extensionPath` is `…/extensions/<publisher>.craftos-mcp-0.2.0`. After an update that folder is gone and
every `settings.json` that names it points at nothing. `context.globalStorageUri` stays put, so copy there and point
at the copy:

```ts
import * as vscode from "vscode";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Copies the addon next to the extension's other data. Returns the folder that holds `cc-tweaked/`. */
export async function installLuaAddon(
  context: vscode.ExtensionContext,
): Promise<string> {
  const addons = join(context.globalStorageUri.fsPath, "lua-addons");
  const stamp = join(addons, ".version");
  const version = String(context.extension.packageJSON.version);
  const installed = await readFile(stamp, "utf8").catch(() => "");
  if (installed !== version) {
    await rm(join(addons, "cc-tweaked"), { recursive: true, force: true });
    await mkdir(addons, { recursive: true });
    await cp(
      join(context.extensionPath, "lua-addons", "cc-tweaked"),
      join(addons, "cc-tweaked"),
      { recursive: true },
    );
    await writeFile(stamp, version);
  }
  return addons;
}
```

In development (`extensionMode === Development`) skip the stamp and copy every time, so an edited definition shows
up after a reload.

## 3. Switch it on in a CC workspace

Only where the extension already knows it is looking at CC code. Use what the extension has for that (the project
scan: a `.craftos` folder, a `*.test.lua`, a `startup.lua`, a world file); do not add a second detector. A workspace
it is not sure about is left to step 4.

Three rules keep the user's settings whole:

- **Add, never replace.** Read the workspace value with `inspect`, append our path when it is not there, write it
  back. Somebody else's library stays.
- **Do not overrule a choice.** `Lua.runtime.version` and each key of `Lua.runtime.builtin` are written only when no
  workspace or folder value exists.
- **Workspace scope only.** Never `ConfigurationTarget.Global` for these: they would change every other Lua project.

```ts
const SECTION = "Lua";

async function addLibrary(
  folder: vscode.WorkspaceFolder,
  library: string,
): Promise<void> {
  const config = vscode.workspace.getConfiguration(SECTION, folder.uri);
  const target = vscode.workspace.workspaceFile
    ? vscode.ConfigurationTarget.WorkspaceFolder
    : vscode.ConfigurationTarget.Workspace;
  const pick = <T>(
    i: { workspaceValue?: T; workspaceFolderValue?: T } | undefined,
  ) =>
    target === vscode.ConfigurationTarget.WorkspaceFolder
      ? i?.workspaceFolderValue
      : i?.workspaceValue;

  // Lua.workspace.library: ours added once; an older copy of ours (a path from before globalStorage) dropped
  const current = pick(config.inspect<string[]>("workspace.library")) ?? [];
  const ours = (p: string) =>
    /[\\/]lua-addons[\\/]cc-tweaked[\\/]library$/.test(p);
  const next = [
    ...current.filter((p) => !ours(p) || p === library),
    ...(current.includes(library) ? [] : [library]),
  ];
  if (next.join("\n") !== current.join("\n"))
    await config.update("workspace.library", next, target);

  // the two runtime settings of config.json, only where nothing is set
  const version = config.inspect<string>("runtime.version");
  if (
    version?.workspaceValue === undefined &&
    version?.workspaceFolderValue === undefined
  ) {
    await config.update("runtime.version", "Lua 5.2", target);
  }
  const builtin =
    pick(config.inspect<Record<string, string>>("runtime.builtin")) ?? {};
  const wanted = { os: "disable", io: "disable" };
  const merged = { ...wanted, ...builtin }; // theirs wins
  if (JSON.stringify(merged) !== JSON.stringify(builtin))
    await config.update("runtime.builtin", merged, target);
}
```

Read the values to write from the packed `config.json` (`settings`) instead of repeating them, so the addon and the
extension cannot drift apart.

Give the user the switch, in `contributes.configuration`:

```json
"craftos-mcp.luaTypes": {
  "type": "string",
  "enum": ["auto", "ask", "off"],
  "default": "ask",
  "markdownDescription": "CC:Tweaked types for the Lua language server. `auto` adds them to a ComputerCraft workspace's settings, `ask` asks first, `off` leaves the workspace alone."
}
```

`ask` is the default because it writes into `.vscode/settings.json`, which people commit: one notification per
workspace, "Add CC:Tweaked types to this workspace? [Add] [Not here] [Never]", the answer kept in `workspaceState`
("Not here") or by setting `craftos-mcp.luaTypes` to `off` at user level ("Never"). `off` also removes our path again
(the `ours` filter above with nothing added), and so should a command `craftos-mcp.removeLuaTypes`, so there is a way
back that is not hand-editing JSON.

A committed `settings.json` then holds an absolute path of one machine. That is the price of `Lua.workspace.library`
in the workspace file; the Lua extension's own addon manager does the same. People who mind should pick "Not here"
and rely on step 4, or commit a `.luarc.json` of their own (the README shows it).

Do this on activation and on `onDidChangeWorkspaceFolders`. The language server picks the change up by itself: it
watches `Lua.workspace.library` and reloads, no restart command needed.

## 4. Everything else: let the language server detect it

`config.json` makes the folder a lua-language-server addon. Its `words` and `files` say what CC code looks like
(`os.pullEvent`, `peripheral.wrap`, `term.setCursorPos`, `require "cc.…"`, a `startup.lua`). Tell the language
server where addons are, once, at user level:

```ts
async function registerAddons(addons: string): Promise<void> {
  const config = vscode.workspace.getConfiguration(SECTION);
  const current =
    config.inspect<string[]>("workspace.userThirdParty")?.globalValue ?? [];
  if (!current.includes(addons)) {
    await config.update(
      "workspace.userThirdParty",
      [...current, addons],
      vscode.ConfigurationTarget.Global,
    );
  }
}
```

From then on, in any workspace, opening a Lua file that matches makes the language server ask "Do you need to
configure your work environment as `CC:Tweaked`?" with "Apply and modify settings", "Apply but do not modify
settings" and "Don't show again". It does not ask where our `library` path is already in `Lua.workspace.library`
(`script/library.lua`, `check3rdByWords`), so steps 3 and 4 never both speak up, as long as both use the same copy in
globalStorage.

This is the one user-level setting the extension writes, and it only adds a folder to a list. It changes nothing by
itself. Remove it again in `deactivate` only on uninstall, which an extension cannot see: so leave it, and have the
`craftos-mcp.removeLuaTypes` command take it out.

The language server's prompt depends on `Lua.workspace.checkThirdParty` (`Ask` by default; `Apply`, `ApplyInMemory`,
`Disable`). Do not set it for the user.

`scripts/addon-words.test.lua` checks the `words` against CC and non-CC lines the way the language server matches
them. One thing to know: its "Don't show again" sets `checkThirdParty` to `Disable` for that workspace, for every
addon. That is the language server's wording, not ours.

### The Lua extension's API

`vscode.extensions.getExtension("sumneko.lua")?.exports` has `setConfig(changes)` (`client/src/extension.ts`), which
takes `{ action: "add" | "set" | "prop", key, value, uri, global? }` and ends in the same `config.update` calls as
above. It is fine to use for the `add` in step 3, but it is not documented as stable, it needs the extension active,
and it has no "only if unset". The plain configuration API does everything needed, so prefer it.

## 5. When the Lua extension is not installed

Do not make it an `extensionDependency`: the emulator, the tests and the MCP server work without it, and a hard
dependency blocks installing in editors where it is missing.

```ts
const LUA = "sumneko.lua";

async function suggestLuaExtension(
  context: vscode.ExtensionContext,
): Promise<void> {
  if (
    vscode.extensions.getExtension(LUA) ||
    context.globalState.get("luaTypes.dontSuggest")
  )
    return;
  const pick = await vscode.window.showInformationMessage(
    "Install the Lua extension for autocomplete and type checking of your ComputerCraft programs? craftos-mcp has the CC:Tweaked types for it.",
    "Install",
    "Not now",
    "Don't ask again",
  );
  if (pick === "Install")
    await vscode.commands.executeCommand(
      "workbench.extensions.installExtension",
      LUA,
    );
  if (pick === "Don't ask again")
    await context.globalState.update("luaTypes.dontSuggest", true);
}
```

- Ask only in a CC workspace, and only once per session ("Not now" asks again next time, quietly: no modal).
- After an install, `vscode.extensions.onDidChange` fires: run steps 3 and 4 then. Writing the `Lua.*` settings
  before the Lua extension exists also works (they are just keys in a JSON file and it reads them when it arrives),
  but VS Code shows them greyed as unknown, so wait.
- `sumneko.lua` is on Open VSX as well, so the same id installs in VSCodium and Cursor.
- Also list it in the repo's `.vscode/extensions.json` `recommendations`, for people who open this repo.

## Order on activation

```ts
export async function activate(context: vscode.ExtensionContext) {
  // ... what is there now ...
  void luaTypes(context).catch((error) => log(`lua types: ${error}`)); // never block or fail activation
}

async function luaTypes(context: vscode.ExtensionContext) {
  const mode = vscode.workspace
    .getConfiguration("craftos-mcp")
    .get<string>("luaTypes", "ask");
  if (mode === "off") return;
  const ccFolders = (vscode.workspace.workspaceFolders ?? []).filter(
    isCcWorkspace,
  ); // the extension's own scan
  if (!vscode.extensions.getExtension(LUA)) {
    if (ccFolders.length) await suggestLuaExtension(context);
    return;
  }
  const addons = await installLuaAddon(context);
  await registerAddons(addons);
  const library = join(addons, "cc-tweaked", "library");
  for (const folder of ccFolders) {
    if (mode === "auto" || (await askOnce(context, folder)))
      await addLibrary(folder, library);
  }
}
```

## What to test

- Unit, no VS Code: `addLibrary`'s merge as a pure function over (current library list, current builtin, current
  version) → (next values). Cases: empty settings; another library already there (kept, ours appended); ours already
  there (no write); an old path of ours (replaced); the user's `runtime.version` set (untouched); the user's
  `builtin.os` set to `enable` (kept).
- Integration (`test/integration`): open a fixture CC workspace with `luaTypes: "auto"`, assert `.vscode/settings.json`
  gets the globalStorage path once, and that a second activation writes nothing.
- By hand, once per release: a file with `term.setCurserPos(1, 1)` shows "Undefined field", `term.` completes,
  hovering `os.pullEvent` shows the event list.
- `node packages/cc-types/scripts/check.mjs` stays a local check: it needs lua-language-server, which CI does not
  have and should not download (CI here only builds and publishes).

## Standalone use

For people without the extension the README has the `.luarc.json` snippet. The folder also works with the Lua
extension's own addon mechanism as it is, and could be offered to [LLS-Addons](https://github.com/LuaLS/LLS-Addons)
later; that wants its own repository with the addon at the top, which the public export could produce.
