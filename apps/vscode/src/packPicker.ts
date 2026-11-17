// The pack pickers: the Minecraft version (with its CC:Tweaked version) and the addons (a checklist), from the status
// bar item's menu (status.ts) or the palette. Both are workspace settings (craftos-mcp.minecraftVersion,
// craftos-mcp.addons), which become CRAFTOS_VERSION and CRAFTOS_ADDONS for everything the extension starts; a change
// restarts the MCP server and the open Run in CraftOS panels so they run in the new pack.
import * as vscode from "vscode";
import { restartForNewSettings } from "./clients";
import {
  addonSpec,
  addonsOn,
  ccFor,
  enabledAddons,
  specForVersion,
} from "./pack";
import { PACK } from "./packData";
import { enqueue, restartPanel, runningPanels } from "./runPanel";
import { settings } from "./settings";

const target = (): vscode.ConfigurationTarget =>
  vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;

async function write(
  key: "minecraftVersion" | "addons",
  value: string | undefined,
): Promise<void> {
  await vscode.workspace
    .getConfiguration("craftos-mcp")
    .update(key, value, target());
}

/** After the pack changed: the running MCP server and every open panel start again in it. */
async function restartEverything(): Promise<void> {
  await restartForNewSettings();
  await Promise.all(
    runningPanels().map((p) =>
      enqueue(p, "restart for the new pack", () => restartPanel(p)),
    ),
  );
}

interface VersionItem extends vscode.QuickPickItem {
  mc: string;
}

/**
 * craftos-mcp: Pick Minecraft Version. `choice` ("1.18.2", or "" for the default) skips the picker. Resolves with
 * the version set, or undefined when nothing changed.
 */
export async function pickMinecraftVersion(
  choice?: string,
): Promise<string | undefined> {
  const now = settings().mc;
  let mc = choice;
  if (mc === undefined) {
    const items: VersionItem[] = [
      {
        mc: "",
        label: `Default (${PACK.newest})`,
        description: `CC:Tweaked ${ccFor(PACK, PACK.newest) ?? "?"}`,
        detail: "Whatever the emulator starts on: the newest version",
        picked: now === "",
      },
      ...[...PACK.versions].reverse().map((v) => ({
        mc: v.mc,
        label: `Minecraft ${v.mc}`,
        description: `CC:Tweaked ${v.cc}${v.cc === "1.101.3" ? " (Lua 5.1)" : ""}`,
        detail: `${addonsOn(PACK, v.mc).length} of ${PACK.addons.length} addons have a release for it`,
        picked: now === v.mc,
      })),
    ];
    for (const item of items)
      if (item.picked) item.label = `$(check) ${item.label}`;
    const pick = await vscode.window.showQuickPick(items, {
      title: "craftos-mcp: Minecraft version",
      placeHolder:
        "The Minecraft version computers start on (a world file's own version still wins)",
    });
    if (!pick) return undefined;
    mc = pick.mc;
  }
  if (mc !== "" && !PACK.versions.some((v) => v.mc === mc))
    throw new Error(
      `unknown Minecraft version ${mc}: ${PACK.versions.map((v) => v.mc).join(", ")}`,
    );
  if (mc === now) return undefined;
  await write("minecraftVersion", mc || undefined);
  // listed addons the new version has no release for come out, or every computer would refuse to start
  const { spec, dropped } = specForVersion(
    PACK,
    settings().addons,
    mc || PACK.newest,
  );
  if (dropped.length) {
    await write("addons", spec);
    void vscode.window.showInformationMessage(
      `Minecraft ${mc || PACK.newest} has no ${dropped.map((a) => a.name).join(", ")}, so ${dropped.length === 1 ? "it was" : "they were"} taken out of craftos-mcp.addons.`,
    );
  }
  await restartEverything();
  return mc;
}

interface AddonItem extends vscode.QuickPickItem {
  id: string;
}

/**
 * craftos-mcp: Pick Addons, a checklist of the addons with a release on the current version. `choice` (ids, or a
 * spec such as "all") skips the checklist. Resolves with the new craftos-mcp.addons value, or undefined.
 */
export async function pickAddons(
  choice?: string | string[],
): Promise<string | undefined> {
  const s = settings();
  const mc = s.mc || PACK.newest;
  let spec: string;
  if (choice !== undefined) {
    spec = Array.isArray(choice) ? addonSpec(PACK, choice, mc) : choice;
  } else {
    const on = enabledAddons(PACK, s.addons, mc).on;
    const available = addonsOn(PACK, mc);
    const missing = PACK.addons.length - available.length;
    const items: AddonItem[] = available.map((a) => ({
      id: a.id,
      label: a.name,
      description: `${a.id} ${a.versions[mc]}`,
      detail: a.requires.length
        ? `Needs ${a.requires.map((r) => PACK.addons.find((x) => x.id === r)?.name ?? r).join(", ")} (switched on with it)`
        : undefined,
      picked: on.has(a.id),
    }));
    const quick = vscode.window.createQuickPick<AddonItem>();
    quick.title = `craftos-mcp: addons on Minecraft ${mc}`;
    quick.placeholder = `The mods computers see besides CC:Tweaked${missing ? ` (${missing} more have no ${mc} release)` : ""}. A world file's own addons still win.`;
    quick.canSelectMany = true;
    quick.matchOnDescription = true;
    quick.items = items;
    quick.selectedItems = items.filter((i) => i.picked);
    const picked = await new Promise<readonly AddonItem[] | undefined>(
      (resolve) => {
        quick.onDidAccept(() => {
          resolve(quick.selectedItems);
          quick.hide();
        });
        quick.onDidHide(() => resolve(undefined));
        quick.show();
      },
    );
    quick.dispose();
    if (!picked) return undefined;
    spec = addonSpec(
      PACK,
      picked.map((i) => i.id),
      mc,
    );
  }
  // "all" while nothing is set is the same pack: leave the setting out
  const same = spec === s.addons || (spec === "all" && s.addons === "");
  if (same) return undefined;
  await write("addons", spec);
  await restartEverything();
  return spec;
}

/** The commands behind the status bar menu's Minecraft Version and Addons (and the diagnostics' quick fixes). */
export function registerPackPicker(): vscode.Disposable[] {
  const report = (error: Error) =>
    vscode.window.showErrorMessage(`craftos-mcp: ${error.message}`);
  return [
    vscode.commands.registerCommand(
      "craftos-mcp.pickMinecraftVersion",
      (choice?: string) =>
        pickMinecraftVersion(
          typeof choice === "string" ? choice : undefined,
        ).catch(report),
    ),
    vscode.commands.registerCommand(
      "craftos-mcp.pickAddons",
      (choice?: string | string[]) =>
        pickAddons(
          typeof choice === "string" || Array.isArray(choice)
            ? choice
            : undefined,
        ).catch(report),
    ),
  ];
}
