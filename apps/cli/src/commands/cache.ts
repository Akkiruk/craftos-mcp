import { join } from "node:path";
import {
  craftosHome,
  folderBytes,
  listCachedVersions,
  megabytes,
  packageVersion,
  pruneCache,
  versionsToKeep,
} from "@craftos-mcp/runner";
import type { Command } from "../command.js";
import { UsageError, guarded, parse } from "../shared.js";

const USAGE = [
  "usage: craftos-mcp cache list",
  "       craftos-mcp cache prune [--dry-run]",
  "",
  "The per-user cache (CRAFTOS_HOME, else %LOCALAPPDATA%\\craftos-mcp on Windows, ~/.cache/craftos-mcp elsewhere)",
  "keeps the engine and ROMs of every package version that set up. list shows them; prune keeps this version and",
  "the newest one before it and removes the rest (a setup does that by itself after setting up a new version).",
].join("\n");

const cache: Command = {
  name: "cache",
  summary: "list or prune old versions in the per-user cache",
  usage: USAGE,
  run: (args) =>
    guarded(USAGE, async () => {
      const { values, positionals } = parse(args, {
        "dry-run": { type: "boolean" },
      });
      if (values.help) {
        console.log(USAGE);
        return 0;
      }
      const [action, ...extra] = positionals;
      if (extra.length || (action !== "list" && action !== "prune"))
        throw new UsageError("say cache list or cache prune");
      const home = craftosHome();
      const current = packageVersion();
      if (action === "list") {
        const versions = listCachedVersions(home);
        const keep = versionsToKeep(
          versions.map((v) => v.version),
          current,
        );
        console.log(`cache: ${home}`);
        if (!versions.length) console.log("  no versions set up here");
        for (const v of versions) {
          const notes = [
            v.version === current && "this version",
            v.locked && "setting up",
            !keep.has(v.version) && !v.locked && "prune removes it",
          ].filter(Boolean);
          console.log(
            `  ${v.version.padEnd(12)} ${megabytes(v.bytes).padStart(9)}${notes.length ? `  (${notes.join(", ")})` : ""}`,
          );
        }
        for (const dir of ["jars", "runtime"]) {
          const bytes = folderBytes(join(home, dir));
          if (bytes)
            console.log(`  ${dir.padEnd(12)} ${megabytes(bytes).padStart(9)}`);
        }
        return 0;
      }
      const dryRun = Boolean((values as { "dry-run"?: boolean })["dry-run"]);
      const { removed, kept, failed } = pruneCache(home, current, { dryRun });
      const freed = megabytes(removed.reduce((n, v) => n + v.bytes, 0));
      if (!removed.length) console.log(`nothing to prune in ${home}`);
      else
        console.log(
          `${dryRun ? "would remove" : "removed"} ${removed.map((v) => v.version).join(", ")} (${freed}); kept ${kept.map((v) => v.version).join(", ") || "none"}`,
        );
      for (const f of failed)
        console.error(`could not remove ${f.version}: ${f.error}`);
      return failed.length ? 1 : 0;
    }),
};
export default cache;
