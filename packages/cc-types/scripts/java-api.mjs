// List every Lua function CC:Tweaked defines in Java (its @LuaFunction methods), from checkouts of its source, into
// data/cct-java-api.json. check.mjs then makes sure the hand-written files define each one.
//
//   git clone --depth 1 --branch v1.18.2-1.101.3 https://github.com/cc-tweaked/CC-Tweaked.git cct-1.101.3
//   git clone --depth 1 --branch v1.20.1-1.121.0 https://github.com/cc-tweaked/CC-Tweaked.git cct-1.121.0
//   node packages/cc-types/scripts/java-api.mjs 1.101.3=cct-1.101.3 1.121.0=cct-1.121.0
//
// (On Windows: git config --global core.longpaths true first.) Only names are kept: the definitions are written by
// hand, in our own words.
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "data",
  "cct-java-api.json",
);

/** Java class -> where its functions live in the library: a global table, or a class local in a hand-written file. */
const OWNERS = {
  FSAPI: "fs",
  OSAPI: "os",
  HTTPAPI: "http",
  PeripheralAPI: "peripheral",
  RedstoneAPI: "redstone",
  RedstoneMethods: "redstone",
  TermAPI: "term",
  TermMethods: "Redirect",
  CommandAPI: "commands",
  PocketAPI: "pocket",
  TurtleAPI: "turtle",
  ComputerPeripheral: "Computer",
  CommandBlockPeripheral: "CommandBlock",
  DiskDrivePeripheral: "Drive",
  ModemPeripheral: "Modem",
  WiredModemPeripheral: "Modem",
  MonitorPeripheral: "Monitor",
  PrinterPeripheral: "Printer",
  SpeakerPeripheral: "Speaker",
  CraftingTablePeripheral: "Workbench",
  InventoryMethods: "Inventory",
  AbstractInventoryMethods: "Inventory",
  FluidMethods: "FluidStorage",
  AbstractFluidMethods: "FluidStorage",
  EnergyMethods: "EnergyStorage",
  AbstractEnergyMethods: "EnergyStorage",
  HttpResponseHandle: "Response",
  WebsocketHandle: "Websocket",
  TransferredFile: "TransferredFile",
  TransferredFiles: "TransferredFiles",
  // file handles: every method is on one of the read or write classes
  HandleGeneric: "ReadHandle",
  AbstractHandle: "ReadHandle",
  BinaryReadableHandle: "ReadHandle",
  EncodedReadableHandle: "ReadHandle",
  ReadHandle: "ReadHandle",
  BinaryWritableHandle: "WriteHandle",
  EncodedWritableHandle: "WriteHandle",
  WriteHandle: "WriteHandle",
};
/** Read-write handles repeat the read and write ones; the turtle's own inventory peripheral is not reachable from Lua. */
const SKIP = new Set([
  "ReadWriteHandle",
  "TurtleStorage",
  "GenericSource",
  "Generator",
]);

function javaFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (
      [
        ".git",
        "build",
        "test",
        "testMod",
        "testFixtures",
        "examples",
        "web",
        "gametest",
      ].includes(name)
    )
      continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) javaFiles(full, out);
    else if (name.endsWith(".java")) out.push(full);
  }
  return out;
}

function functionsOf(source) {
  const names = [];
  let at = 0;
  for (;;) {
    at = source.indexOf("@LuaFunction", at);
    if (at < 0) break;
    let i = at + "@LuaFunction".length;
    let explicit = [];
    if (source[i] === "(") {
      const close = source.indexOf(")", i);
      explicit = [...source.slice(i, close).matchAll(/"([^"]+)"/g)].map(
        (m) => m[1],
      );
      i = close + 1;
    }
    // the method name is the identifier in front of the next parameter list
    const m = /([A-Za-z_]\w*)\s*\(/.exec(
      source.slice(i).replace(/@\w+(\([^)]*\))?/g, (s) => " ".repeat(s.length)),
    );
    at = i;
    if (!m) continue;
    names.push(...(explicit.length ? explicit : [m[1]]));
  }
  return names;
}

const result = {};
const unknown = new Set();
for (const arg of process.argv.slice(2)) {
  const [version, dir] = arg.split("=");
  if (!dir) {
    console.error(
      "usage: node java-api.mjs <version>=<CC-Tweaked checkout> ...",
    );
    process.exit(2);
  }
  for (const file of javaFiles(dir)) {
    const source = readFileSync(file, "utf8");
    if (!source.includes("@LuaFunction")) continue;
    const cls = file.split(/[\\/]/).pop().replace(".java", "");
    if (SKIP.has(cls)) continue;
    const owner = OWNERS[cls];
    if (!owner) {
      unknown.add(cls);
      continue;
    }
    for (const name of functionsOf(source)) {
      const entry = ((result[owner] ??= {})[name] ??= []);
      if (!entry.includes(version)) entry.push(version);
    }
  }
}
if (unknown.size)
  console.warn(
    `classes with @LuaFunction that java-api.mjs does not know: ${[...unknown].join(", ")}`,
  );
const sorted = Object.fromEntries(
  Object.keys(result)
    .sort()
    .map((owner) => [
      owner,
      Object.fromEntries(
        Object.keys(result[owner])
          .sort()
          .map((n) => [n, result[owner][n]]),
      ),
    ]),
);
writeFileSync(OUT, JSON.stringify(sorted, null, 1) + "\n");
console.log(
  `${Object.values(sorted).reduce((n, o) => n + Object.keys(o).length, 0)} functions of ${Object.keys(sorted).length} tables and classes written to ${OUT}`,
);
