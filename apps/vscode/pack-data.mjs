// The Minecraft versions and addons the emulator knows, read from packages/runner/src (versions.ts, addons.ts) at
// build time: esbuild.mjs puts them into the bundle as __CRAFTOS_PACK__ (src/packData.ts), and the unit tests read
// the same list. Without packages/runner the list is empty and the pickers say so.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(here, "..", "..", "packages", "runner", "src");

/** @returns {Promise<{ newest: string, versions: {mc: string, cc: string}[], addons: {id: string, name: string, versions: Record<string, string>, types: string[], requires: string[]}[] }>} */
export async function loadPackData() {
  if (!existsSync(join(RUNNER, "addons.ts"))) {
    console.warn(`no ${RUNNER}: packing no Minecraft versions or addons`);
    return { newest: "", versions: [], addons: [] };
  }
  const out = await build({
    stdin: {
      contents:
        'export { ADDONS } from "./addons.ts"; export { VERSIONS, NEWEST_MC } from "./versions.ts";',
      resolveDir: RUNNER,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    logLevel: "silent",
  });
  const code = out.outputFiles[0].text;
  const mod = await import(
    `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
  );
  return {
    // the published server's default (versions.ts DEFAULT_MC in the public build)
    newest: mod.NEWEST_MC,
    versions: mod.VERSIONS.map((v) => ({ mc: v.mc, cc: v.cc })),
    addons: mod.ADDONS.map((a) => ({
      id: a.id,
      name: a.name,
      versions: { ...a.versions },
      types: [...a.types],
      requires: [...(a.requires ?? [])],
    })),
  };
}
