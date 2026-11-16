import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "../command.js";
import { configFor, guarded, parse } from "../shared.js";
import { addonReport, checkConfig } from "@craftos-mcp/runner";

const USAGE = [
  "usage: craftos-mcp info [--dir folder]",
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
      console.log("CC:Tweaked 1.101.3 (Minecraft 1.18.2) emulator");
      console.log(
        `  ${mark(existsSync(config.engineExe))} engine     ${config.engineExe}`,
      );
      console.log(
        `  ${mark(existsSync(join(config.romDir, "bios.lua")))} ROM        ${config.romDir}`,
      );
      console.log(`  ok      workspace  ${config.workspaceDir}`);
      const report = addonReport();
      console.log(`\nAddons (${report.source}):`);
      for (const a of report.addons) {
        console.log(
          `  ${a.on ? "on " : "off"}  ${a.id.padEnd(22)} ${a.name} ${a.version}`,
        );
      }
      if (problems.length) {
        console.log("\nProblems:");
        for (const p of problems) console.log(`  - ${p}`);
        console.log("\nnpm run setup fixes the usual ones.");
        return 1;
      }
      console.log("\nReady.");
      return 0;
    }),
};
export default info;
