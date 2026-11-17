// What a browser computer needs, from the extension and from globalStorage: the engine (dist/web/runtime, packed by
// esbuild.mjs), and the ROM and font made once from CC:Tweaked's jar (rom.ts) and kept in globalStorage, so later
// runs, and later sessions in the same browser, start without a download.
import * as vscode from "vscode";
import { JAR, buildRom } from "./rom";

export interface Engine {
  readonly playerJs: string;
  readonly workerJs: string;
  readonly craftosJs: string;
  readonly wasm: Uint8Array;
}

export interface RomFiles {
  readonly rom: Uint8Array;
  readonly font: Uint8Array;
}

const text = new TextDecoder();

async function read(uri: vscode.Uri): Promise<Uint8Array | undefined> {
  try {
    return await vscode.workspace.fs.readFile(uri);
  } catch {
    return undefined;
  }
}

/** The engine files, or undefined when this build of the extension has none (no engine\build-web.cmd output). */
export async function loadEngine(
  extensionUri: vscode.Uri,
): Promise<Engine | undefined> {
  const dir = vscode.Uri.joinPath(extensionUri, "dist", "web", "runtime");
  const [player, worker, craftos, wasm] = await Promise.all(
    ["player.js", "worker.js", "craftos.js", "craftos.wasm"].map((f) =>
      read(vscode.Uri.joinPath(dir, f)),
    ),
  );
  if (!player || !worker || !craftos || !wasm) return undefined;
  return {
    playerJs: text.decode(player),
    workerJs: text.decode(worker),
    craftosJs: text.decode(craftos),
    wasm,
  };
}

let building: Promise<RomFiles> | undefined;

/** The ROM and font: from globalStorage when this version of the extension made them, else built from the jar. */
export function loadRom(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): Promise<RomFiles> {
  building ??= buildOrLoad(context, output).finally(
    () => (building = undefined),
  );
  return building;
}

async function buildOrLoad(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): Promise<RomFiles> {
  const dir = vscode.Uri.joinPath(context.globalStorageUri, "web-rom");
  const stampUri = vscode.Uri.joinPath(dir, "version");
  const romUri = vscode.Uri.joinPath(dir, "rom.pack");
  const fontUri = vscode.Uri.joinPath(dir, "font.bin");
  // the overlay comes with the extension, so a new version makes the ROM again
  const stamp = `${String(context.extension.packageJSON.version)} ${JAR.sha512.slice(0, 16)}`;
  const dev = context.extensionMode === vscode.ExtensionMode.Development;
  const [had, rom, font] = await Promise.all([
    read(stampUri),
    read(romUri),
    read(fontUri),
  ]);
  if (!dev && had && text.decode(had) === stamp && rom && font)
    return { rom, font };

  const overlay = await read(
    vscode.Uri.joinPath(context.extensionUri, "dist", "web", "overlay.pack"),
  );
  if (!overlay)
    throw new Error(
      "this build of the extension has no ROM overlay (dist/web/overlay.pack)",
    );
  const built = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "craftos-mcp: getting CC:Tweaked 1.101.3 from Modrinth (once)",
    },
    async () => {
      output.appendLine(`web: downloading ${JAR.url}`);
      const res = await fetch(JAR.url);
      if (!res.ok) throw new Error(`download ${JAR.url}: HTTP ${res.status}`);
      const jar = new Uint8Array(await res.arrayBuffer());
      return buildRom(jar, overlay);
    },
  );
  output.appendLine(
    `web: ROM built (${(built.rom.length / 1024).toFixed(0)} KB)`,
  );
  await vscode.workspace.fs.createDirectory(dir);
  await vscode.workspace.fs.writeFile(romUri, built.rom);
  await vscode.workspace.fs.writeFile(fontUri, built.font);
  await vscode.workspace.fs.writeFile(
    stampUri,
    new TextEncoder().encode(stamp),
  );
  return built;
}
