import { relative, resolve } from "node:path";
import {
  WorkspaceError,
  craftosPcFolders,
  findCraftosPc,
  importCraftosPc,
  readCraftosPc,
} from "@craftos-mcp/runner";
import type { Command } from "../command.js";
import { UsageError, guarded, parse } from "../shared.js";

const USAGE = [
  "usage: craftos-mcp import craftos-pc [folder] [--out folder] [--only 0,2] [--list] [--force]",
  "",
  "Brings your CraftOS-PC computers over: each computer's files, its label, its colour and screen size, and the",
  "peripherals its startup attaches, as a craftos-mcp project (craftos.json, computer/<id>, computer-<id>.world.json).",
  "Your CraftOS-PC folder is only read, never changed.",
  "",
  "  folder   CraftOS-PC's data folder. Default: where CraftOS-PC keeps it on this machine",
  `           (${craftosPcFolders().join(", ")})`,
  "  --out    where the new project goes (default: a craftos-pc folder here)",
  "  --only   just these computer ids, by commas",
  "  --list   show what would come over, and write nothing",
  "  --force  write over an earlier import in --out",
].join("\n");

const files = (n: number): string => `${n} file${n === 1 ? "" : "s"}`;

/** `craftos-mcp import craftos-pc`: a CraftOS-PC data folder into a craftos-mcp project. */
const importCommand: Command = {
  name: "import",
  summary: "bring your CraftOS-PC computers over as a project",
  usage: USAGE,
  run: (args) =>
    guarded(USAGE, async () => {
      const { values, positionals } = parse(args, {
        out: { type: "string" },
        only: { type: "string" },
        list: { type: "boolean" },
        force: { type: "boolean" },
      });
      if (values.help) {
        console.log(USAGE);
        return 0;
      }
      const v = values as typeof values & {
        out?: string;
        only?: string;
        list?: boolean;
        force?: boolean;
      };
      const [what, given, ...extra] = positionals;
      if (what !== "craftos-pc")
        throw new UsageError(
          what
            ? `craftos-mcp import knows craftos-pc, not ${JSON.stringify(what)}`
            : "import what? craftos-mcp import craftos-pc",
        );
      if (extra.length)
        throw new UsageError(`one folder only (got ${extra.join(" ")})`);
      const folder = given ? resolve(given) : findCraftosPc();
      if (!folder)
        throw new WorkspaceError(
          `no CraftOS-PC data folder here (looked in ${craftosPcFolders().join(", ")}): name it, craftos-mcp import craftos-pc <folder>`,
        );
      const ids = v.only
        ? v.only.split(",").map((s) => {
            const n = Number(s.trim());
            if (!Number.isInteger(n) || n < 0)
              throw new UsageError(
                `--only: ${JSON.stringify(s)} is not a computer id`,
              );
            return n;
          })
        : undefined;
      try {
        if (v.list) {
          const data = readCraftosPc(folder);
          console.log(`CraftOS-PC folder: ${data.folder}`);
          if (!data.computers.length) console.log("no computers");
          for (const c of data.computers) {
            if (ids && !ids.includes(c.id)) continue;
            const bits = [
              files(c.files),
              c.isColor ? "" : "no colour",
              c.width !== 51 || c.height !== 19 ? `${c.width}x${c.height}` : "",
              c.attaches.length
                ? `attaches ${c.attaches.map((a) => `${a.type} on ${a.side}`).join(", ")}`
                : "",
            ].filter(Boolean);
            console.log(
              `  computer ${c.id}${c.label ? ` "${c.label}"` : ""}: ${bits.join(", ")}`,
            );
          }
          if (data.disks.length)
            console.log(`  disks: ${data.disks.join(", ")}`);
          return 0;
        }
        const out = resolve(v.out ?? "craftos-pc");
        const result = importCraftosPc(folder, out, {
          ...(v.force && { force: true }),
          ...(ids && { ids }),
        });
        console.log(
          `Brought ${result.computers.length} computer${result.computers.length === 1 ? "" : "s"} over from ${result.from}`,
        );
        console.log(`into ${result.project}:`);
        for (const c of result.computers)
          console.log(
            `  computer ${c.id}${c.label ? ` "${c.label}"` : ""}: ${files(c.files)} in ${relative(result.project, c.dir)}`,
          );
        for (const note of result.notes) console.log(`note: ${note}`);
        const rel = relative(process.cwd(), result.project) || ".";
        const first = result.computers[0]!;
        console.log("");
        console.log("Next:");
        console.log(`  cd ${rel}`);
        console.log(
          `  craftos-mcp window               computer ${first.id} in a window (craftos.json picks it)`,
        );
        for (const c of result.computers.slice(1, 4))
          console.log(
            `  craftos-mcp window ${relative(result.project, c.worldFile)} --dir computer/${c.id}`,
          );
        console.log(
          "  craftos-mcp app                  in your browser; its From CraftOS-PC button starts any of them",
        );
        return 0;
      } catch (error) {
        if (error instanceof UsageError) throw error;
        const message = (error as Error).message;
        throw new WorkspaceError(
          /is there already/.test(message) ? `${message} (--force)` : message,
        );
      }
    }),
};
export default importCommand;
