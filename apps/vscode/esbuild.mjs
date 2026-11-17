// Bundle the extension into dist/extension.js: one CommonJS file, `vscode` left to the editor.
import { context } from "esbuild";

const watch = process.argv.includes("--watch");
const ctx = await context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
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
