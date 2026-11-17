// Bundle the extension into dist/extension.js and the MCP server supervisor into dist/supervisor.js: CommonJS,
// `vscode` left to the editor. Also copies in what other parts of the repo build, when they are there:
// - schemas/world.schema.json, the *.world.json schema (package.json jsonValidation). Without it a schema that
//   accepts any object stands in, so world files get no errors from a missing file.
// - lua-addons/cc-tweaked/, packages/cc-types as a lua-language-server addon: its config.json and library/
//   (src/luaTypes.ts). Without it the extension has no types and Set Up Lua Types says so.
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { context } from "esbuild";

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

const watch = process.argv.includes("--watch");
const ctx = await context({
  entryPoints: ["src/extension.ts", "src/supervisor.ts"],
  bundle: true,
  outdir: "dist",
  format: "cjs",
  platform: "node",
  target: "node20",
  external: ["vscode"],
  sourcemap: true,
  minify: !watch,
  logLevel: "info",
});
if (watch) await ctx.watch();
else {
  await ctx.rebuild();
  await ctx.dispose();
}
