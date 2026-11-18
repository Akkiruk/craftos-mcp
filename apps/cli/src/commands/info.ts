import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "../command.js";
import { UsageError, configFor, guarded, parse, project } from "../shared.js";
import {
  addonReport,
  checkConfig,
  missingRomProblem,
  packageVersion,
  resolveVersion,
  romDirFor,
  versionReport,
} from "@craftos-mcp/runner";

const USAGE = [
  "usage: craftos-mcp info [--dir folder] [--mc version]",
  "",
  "Prints where the engine, ROM and workspace are, which mods (addons) are on, and anything missing.",
  "Exits 1 when the engine or ROM is missing, 0 when everything is ready.",
].join("\n");

const info: Command = {
  name: "info",
  summary: "show the engine, ROM and addons status",
  usage: USAGE,
  run: (args) =>
    guarded(USAGE, async () => {
      const { values } = parse(args, {});
      if (values.help) {
        console.log(USAGE);
        return 0;
      }
      const config = configFor(values.dir);
      const problems = checkConfig(config);
      const mark = (ok: boolean) => (ok ? "ok     " : "MISSING");
      let version;
      try {
        version = resolveVersion(values.mc);
      } catch (error) {
        throw new UsageError(
          `--mc: ${(error as Error).message.replace(/^world\.version: /, "")}`,
        );
      }
      const romDir = romDirFor(config, version);
      console.log(
        `CC:Tweaked ${version.cc} (Minecraft ${version.mc}, ${version.loader}) emulator`,
      );
      console.log(
        `  ${mark(existsSync(config.engineExe))} engine     ${config.engineExe}`,
      );
      console.log(
        `  ${mark(existsSync(join(romDir, "bios.lua")))} ROM        ${romDir}`,
      );
      console.log(`  ok      workspace  ${config.workspaceDir}`);
      const found = project();
      if (found) console.log(`  ok      project    ${found.file}`);
      const versions = versionReport();
      console.log(
        `\nVersions (${versions.source}; --mc or world.version picks one):`,
      );
      for (const v of versions.versions) {
        const dir = romDirFor(config, resolveVersion(v.mc));
        console.log(
          `  ${v.mc === version.mc ? "*" : " "} ${v.mc.padEnd(7)} CC:Tweaked ${v.cc.padEnd(8)} ${v.loaders.join("/").padEnd(15)} ` +
            `ROM ${existsSync(join(dir, "bios.lua")) ? "built" : packageVersion() ? "not built yet (built when a world asks for it, or craftos-mcp setup --all)" : `missing (node scripts/build-rom.mjs --download ${v.mc})`}`,
        );
      }
      const missingRom = missingRomProblem(romDir, version.mc);
      if (missingRom && !problems.some((p) => p.startsWith("ROM not found")))
        problems.push(missingRom);
      const report = addonReport(process.env, version.mc);
      console.log(`\nAddons (${report.source}):`);
      for (const a of report.addons) {
        console.log(
          `  ${a.on ? "on " : "off"}  ${a.id.padEnd(22)} ${a.name} ${a.version === "none" ? `(no release for ${version.mc})` : a.actsAs !== a.version ? `${a.version} (acts as ${a.actsAs})` : a.version}`,
        );
      }
      if (problems.length) {
        console.log("\nProblems:");
        for (const p of problems) console.log(`  - ${p}`);
        console.log(
          packageVersion()
            ? "\ncraftos-mcp setup fixes the usual ones."
            : "\nnpm run setup fixes the usual ones.",
        );
        return 1;
      }
      console.log("\nReady.");
      return 0;
    }),
};
export default info;
