#!/usr/bin/env node
// craftos-mcp: the command line. Every file in commands/ default-exports a Command (command.ts); this finds them.
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { didYouMean, packageVersion } from "@craftos-mcp/runner";
import type { Command } from "./command.js";

const dir = fileURLToPath(new URL("./commands/", import.meta.url));
const commands: Command[] = [];
for (const file of readdirSync(dir).sort()) {
  if (!file.endsWith(".js")) continue;
  const mod = (await import(pathToFileURL(join(dir, file)).href)) as {
    default?: Command;
  };
  if (mod.default) commands.push(mod.default);
}

function help(name?: string): number {
  const one = name ? commands.find((c) => c.name === name) : undefined;
  if (one) {
    console.log(`craftos-mcp ${one.name}: ${one.summary}`);
    if (one.usage) console.log(one.usage);
    return 0;
  }
  console.log("craftos-mcp <command> [options]\n");
  const width = Math.max(...commands.map((c) => c.name.length), 4);
  for (const c of commands)
    console.log(`  ${c.name.padEnd(width)}  ${c.summary}`);
  console.log("\ncraftos-mcp help <command> shows its options.");
  return 0;
}

const [name, ...rest] = process.argv.slice(2);
if (!name || name === "help" || name === "--help" || name === "-h") {
  process.exitCode = help(rest[0]);
} else if (name === "--version" || name === "-v" || name === "version") {
  console.log(packageVersion() ?? "clone");
} else {
  const command = commands.find((c) => c.name === name);
  if (!command) {
    // `craftos-mcp door.lua`: a program, so the command that runs one
    const close = /\.lua$/i.test(name)
      ? "run"
      : didYouMean(
          name,
          commands.map((c) => c.name),
        );
    console.error(
      `unknown command ${JSON.stringify(name)}${
        close
          ? `. Did you mean: craftos-mcp ${close}${close === "run" && /\.lua$/i.test(name) ? ` ${name}` : ""}`
          : ""
      }`,
    );
    if (!close) help();
    else console.error("craftos-mcp help lists the commands.");
    process.exitCode = 2;
  } else {
    process.exitCode = await command.run(rest);
  }
}
