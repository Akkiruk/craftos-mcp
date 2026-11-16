// Run CC:Tweaked's own conformance suite (mcfly + spec) against the engine.
// usage: node scripts/run-cct-conformance.mjs [--mc <version>] <path to CC-Tweaked checkout> [outFile] [specPath]
//                                             [timeoutSec] [skip]
// specPath is a path inside the computer, e.g. /test-rom/spec/apis/fs_spec.lua
// skip is a comma list of spec subdirectories to remove first (e.g. "lua,programs").
// --mc is the Minecraft version the computer runs as (packages/runner/src/versions.ts; default 1.18.2, or
// CRAFTOS_VERSION): it picks the ROM and the engine's CC:Tweaked behaviour. The checkout must be the matching tag:
// v1.18.2-1.101.3 for 1.18.2, v1.20.1-1.121.0 for 1.20.1. Both suite layouts work: src/test/resources/test-rom
// (1.101.x) and projects/core/src/test/resources/test-rom (newer). On Windows a full checkout of the newer tags fails
// on long paths; export the tag instead, e.g.
//   git -C <clone> archive v1.20.1-1.121.0 projects/core/src/test/resources/test-rom | tar -x -C <dir>
// or clone with  git -c core.longpaths=true clone ...
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  captureScreens,
  loadConfig,
  resolveVersion,
  romDirFor,
  startEngine,
} from "../packages/runner/dist/index.js";

const argv = process.argv.slice(2);
let mc;
const mcAt = argv.indexOf("--mc");
if (mcAt >= 0) {
  mc = argv[mcAt + 1];
  argv.splice(mcAt, 2);
}
const [
  checkout,
  outFile,
  specPath = "/test-rom/spec",
  timeoutSec = "900",
  skip = "",
] = argv;
if (!checkout) {
  console.error(
    "usage: node scripts/run-cct-conformance.mjs [--mc <version>] <CC-Tweaked checkout> [outFile] [specPath] [timeoutSec] [skip]",
  );
  process.exit(2);
}
const version = resolveVersion(mc);

const layouts = [
  "src/test/resources/test-rom",
  "projects/core/src/test/resources/test-rom",
];
const testRom = layouts
  .map((l) => join(resolve(checkout), l))
  .find((p) => existsSync(join(p, "mcfly.lua")));
if (!testRom) {
  console.error(
    `${checkout}: no test-rom/mcfly.lua under ${layouts.join(" or ")}`,
  );
  process.exit(2);
}
const workspace = mkdtempSync(join(tmpdir(), "cct-ws-"));
cpSync(testRom, join(workspace, "test-rom"), { recursive: true });
for (const dir of skip.split(",").filter(Boolean)) {
  rmSync(join(workspace, "test-rom/spec", dir), {
    recursive: true,
    force: true,
  });
}
// CC's own harness runs on a computer that already has a startup.lua; several fs specs rely on it.
writeFileSync(join(workspace, "startup.lua"), "");
// Make the runner report the number of failed tests as the exit code.
appendFileSync(
  join(workspace, "test-rom/mcfly.lua"),
  "\n_G.failed_tests = actual_count - test_status.pass\n",
);

// The specs see what a program sees: the plain CC:Tweaked surface, no emulator extras (scripts/rom-patches).
const boot = `
if emulator then emulator.hide() end
package.path = "/test-rom/?.lua;/test-rom/spec/?.lua;" .. package.path
local log = assert(io.open("/results/test-log.txt", "w"))
io.output(log)
shell.run("/test-rom/mcfly ${specPath}")
log:close()
os.shutdown(_G.failed_tests or 255)
`;

const config = { ...loadConfig(), workspaceDir: workspace };
console.log(
  `Minecraft ${version.mc}, CC:Tweaked ${version.cc}, ROM ${romDirFor(config, version)}`,
);
// CC's harness gives the test computer a 10 MB disk (ComputerTestDelegate); fs_spec checks fs.getCapacity against it
const handle = startEngine(config, boot, {
  label: "cct",
  computerSpaceLimit: 10_000_000,
  // only a version: the computer is otherwise the plain one CC's harness has
  ...(mc !== undefined && { world: { version: mc } }),
});
const started = Date.now();
const exit = await handle.session
  .waitForExit(Number(timeoutSec) * 1000)
  .catch(async () => {
    console.error("timed out; stopping engine");
    return handle.session.stop(0);
  });
let log = "";
try {
  log = readFileSync(join(handle.resultsDir, "test-log.txt"), "utf8");
} catch {
  /* engine died before writing */
}
const summary =
  /Ran \d+ test\(s\).*/.exec(log)?.[0] ?? "(no summary line found)";
console.log(
  `exit code (failed tests): ${exit.code}  elapsed: ${((Date.now() - started) / 1000).toFixed(1)}s`,
);
console.log(summary);
if (summary.startsWith("(no summary")) {
  console.log("--- terminal ---");
  for (const screen of captureScreens(handle.session)) {
    console.log(screen.lines.filter(Boolean).join("\n"));
  }
}
if (outFile) writeFileSync(outFile, log);
handle.dispose();
rmSync(workspace, { recursive: true, force: true });
