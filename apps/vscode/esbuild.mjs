// Bundle the extension into dist/extension.js and the MCP server supervisor into dist/supervisor.js: CommonJS,
// `vscode` left to the editor. Also copies in what other parts of the repo build, when they are there:
// - schemas/world.schema.json, the *.world.json schema (package.json jsonValidation). Without it a schema that
//   accepts any object stands in, so world files get no errors from a missing file.
// - lua-addons/cc-tweaked/, packages/cc-types as a lua-language-server addon: its config.json and library/
//   (src/luaTypes.ts). Without it the extension has no types and Set Up Lua Types says so.
// - packages/runner's Minecraft versions and addons, as __CRAFTOS_PACK__ (pack-data.mjs, src/packData.ts): the
//   version and addon pickers and the diagnostics.
// The web extension (package.json `browser`, src/web) is a second bundle, dist/web/extension.js, for VS Code's web
// extension host (a Web Worker: no Node). web-assets.mjs lays out what it loads besides: the ROM overlay and the
// browser engine.
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, context } from "esbuild";
import { loadPackData } from "./pack-data.mjs";
import { buildWebAssets } from "./web-assets.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const WORLD_SCHEMA_SOURCE = join(repo, "schemas", "world.schema.json");
const LUA_TYPES_SOURCE = join(repo, "packages", "cc-types");

mkdirSync(join(here, "schemas"), { recursive: true });
const schema = join(here, "schemas", "world.schema.json");
if (existsSync(WORLD_SCHEMA_SOURCE)) cpSync(WORLD_SCHEMA_SOURCE, schema);
else {
  console.warn(
    `no ${WORLD_SCHEMA_SOURCE}: packing a stand-in schema that accepts any object`,
  );
  writeFileSync(
    schema,
    `${JSON.stringify({ $schema: "http://json-schema.org/draft-07/schema#", title: "craftos-mcp world", type: "object" }, null, 2)}\n`,
  );
}
// - schemas/craftos.schema.json, the craftos.json schema (jsonValidation too), with the same kind of stand-in
const PROJECT_SCHEMA_SOURCE = join(repo, "schemas", "craftos.schema.json");
const projectSchema = join(here, "schemas", "craftos.schema.json");
if (existsSync(PROJECT_SCHEMA_SOURCE))
  cpSync(PROJECT_SCHEMA_SOURCE, projectSchema);
else {
  console.warn(
    `no ${PROJECT_SCHEMA_SOURCE}: packing a stand-in craftos.json schema`,
  );
  writeFileSync(
    projectSchema,
    `${JSON.stringify({ $schema: "http://json-schema.org/draft-07/schema#", title: "craftos-mcp project", type: "object" }, null, 2)}\n`,
  );
}
// types/ is where an earlier build put the library
rmSync(join(here, "types"), { recursive: true, force: true });
rmSync(join(here, "lua-addons"), { recursive: true, force: true });
if (existsSync(join(LUA_TYPES_SOURCE, "config.json"))) {
  const addon = join(here, "lua-addons", "cc-tweaked");
  cpSync(join(LUA_TYPES_SOURCE, "library"), join(addon, "library"), {
    recursive: true,
  });
  cpSync(join(LUA_TYPES_SOURCE, "config.json"), join(addon, "config.json"));
} else console.warn(`no ${LUA_TYPES_SOURCE}: packing no Lua types`);

// - schemas/addons.json, packages/runner/src/addons.ts's addon list (ids, names, versions, block types, world keys)
//   for the World Editor's mod list. Without it the editor still works, with no addon list.
const ADDONS_SOURCE = join(repo, "packages", "runner", "src", "addons.ts");
const addonsJson = join(here, "schemas", "addons.json");
if (existsSync(ADDONS_SOURCE)) {
  const out = await build({
    stdin: {
      contents:
        'export { ADDONS } from "./addons.ts"; export { NEWEST_MC } from "./versions.ts";',
      resolveDir: dirname(ADDONS_SOURCE),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  });
  // the published server's default is its newest version, as in pack-data.mjs: the World Editor and the status
  // bar must name the same one
  const { ADDONS, NEWEST_MC } = await import(
    `data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`
  );
  const addons = ADDONS.map(
    ({ id, name, versions, types, worldKeys, requires, docs }) => ({
      id,
      name,
      versions,
      types,
      ...(worldKeys ? { worldKeys } : {}),
      ...(requires ? { requires } : {}),
      ...(docs ? { docs } : {}),
    }),
  );
  writeFileSync(
    addonsJson,
    `${JSON.stringify({ defaultMc: NEWEST_MC, addons })}\n`,
  );
} else {
  console.warn(`no ${ADDONS_SOURCE}: the World Editor gets no addon list`);
  writeFileSync(
    addonsJson,
    `${JSON.stringify({ defaultMc: "1.18.2", addons: [] })}\n`,
  );
}

const watch = process.argv.includes("--watch");
const ctx = await context({
  entryPoints: ["src/extension.ts", "src/supervisor.ts"],
  bundle: true,
  outdir: "dist",
  format: "cjs",
  platform: "node",
  target: "node20",
  external: ["vscode"],
  define: { __CRAFTOS_PACK__: JSON.stringify(await loadPackData()) },
  sourcemap: true,
  minify: !watch,
  logLevel: "info",
});

buildWebAssets(here, repo);
const webCtx = await context({
  entryPoints: { "web/extension": "src/web/extension.ts" },
  bundle: true,
  outdir: "dist",
  format: "cjs",
  platform: "browser",
  target: "es2022",
  external: ["vscode"],
  // packages/runner's world code imports these for things the browser never does (src/web/shims)
  alias: {
    "node:fs": "./src/web/shims/node-fs.ts",
    "node:path": "./src/web/shims/node-path.ts",
  },
  inject: ["./src/web/shims/globals.ts"],
  loader: { ".lua": "text" },
  // the mods' block types, for New World for This File (src/worldTemplate.ts)
  define: { __CRAFTOS_PACK__: JSON.stringify(await loadPackData()) },
  sourcemap: true,
  minify: !watch,
  logLevel: "info",
});
// the World Editor's webview: browser code and its stylesheet (dist/worldEditor.js, dist/worldEditor.css)
const webview = await context({
  entryPoints: { worldEditor: "src/worldEditor/webview/main.ts" },
  bundle: true,
  outdir: "dist",
  format: "iife",
  platform: "browser",
  target: "es2022",
  sourcemap: watch,
  minify: !watch,
  logLevel: "info",
});
if (watch) await Promise.all([ctx.watch(), webCtx.watch(), webview.watch()]);
else {
  await Promise.all([ctx.rebuild(), webCtx.rebuild(), webview.rebuild()]);
  await Promise.all([ctx.dispose(), webCtx.dispose(), webview.dispose()]);
}
