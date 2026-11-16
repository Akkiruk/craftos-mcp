// Run CC:Tweaked's own conformance suite (mcfly + spec) against the engine.
// usage: node scripts/run-cct-conformance.mjs <path to CC-Tweaked checkout> [outFile] [specPath] [timeoutSec]
// specPath is a path inside the computer, e.g. /test-rom/spec/apis/fs_spec.lua
// skip is a comma list of spec subdirectories to remove first (e.g. "lua,programs").
// The checkout must be the tag matching the pinned ROM (v1.18.2-1.101.3).
import {
  appendFileSync,
  cpSync,
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
  startEngine,
} from "../packages/runner/dist/index.js";

const [
  checkout,
  outFile,
  specPath = "/test-rom/spec",
  timeoutSec = "900",
  skip = "",
] = process.argv.slice(2);
if (!checkout) {
  console.error(
    "usage: node scripts/run-cct-conformance.mjs <CC-Tweaked checkout> [outFile]",
  );
  process.exit(2);
}

const workspace = mkdtempSync(join(tmpdir(), "cct-ws-"));
cpSync(
  join(resolve(checkout), "src/test/resources/test-rom"),
  join(workspace, "test-rom"),
  { recursive: true },
);
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
// CC's harness gives the test computer a 10 MB disk (ComputerTestDelegate); fs_spec checks fs.getCapacity against it
const handle = startEngine(config, boot, {
  label: "cct",
  computerSpaceLimit: 10_000_000,
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
