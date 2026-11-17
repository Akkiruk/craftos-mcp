// Integration test: install the packaged .vsix into a throwaway profile, open VS Code on a small Lua project and run
// suite.cjs inside it (the extension's MCP server definition, the Testing view, Run in CraftOS).
//
//   node test/integration/run.mjs [path/to/craftos-mcp.vsix]
//
// CODE: the VS Code executable to use (default: download one). Nothing touches your own profile: the user data and
// extensions folders are new temp folders, removed at the end. CRAFTOS_HOME is passed through to the emulator.
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
  runTests,
} from "@vscode/test-electron";

// run from a VS Code terminal or extension, this is set, and Code.exe would start as plain Node
delete process.env.ELECTRON_RUN_AS_NODE;

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const cloneCli = resolve(root, "..", "cli", "dist", "index.js");
const vsix =
  process.argv[2] ??
  join(
    root,
    readdirSync(root).find((f) => f.endsWith(".vsix")) ?? "missing.vsix",
  );

const scratch = mkdtempSync(join(tmpdir(), "craftos-vscode-it-"));
const userData = join(scratch, "user-data");
const extensions = join(scratch, "extensions");
const project = join(scratch, "project");
mkdirSync(join(project, "lib"), { recursive: true });

// a test file with a pass and a fail on a known line, a program with a world and a monitor
writeFileSync(
  join(project, "math.test.lua"),
  [
    'ccunit.test("adds", function() ccunit.eq(1 + 1, 2) end)',
    'ccunit.test("breaks", function()',
    "  ccunit.eq(1 + 1, 3)",
    "end)",
    "",
  ].join("\n"),
);
// copies of it where scratch runs and agent worktrees live: the Testing view must not list them
for (const copy of [
  ".runtime/run-1",
  ".claude/worktrees/wt",
  "node_modules/pkg",
]) {
  mkdirSync(join(project, copy), { recursive: true });
  writeFileSync(
    join(project, copy, "math.test.lua"),
    'ccunit.test("copy", function() end)\n',
  );
}
writeFileSync(
  join(project, "clock.lua"),
  [
    'local m = peripheral.find("monitor")',
    "m.clear()",
    "m.setCursorPos(1, 1)",
    'm.write("HELLO " .. peripheral.find("playerDetector").getOnlinePlayers()[1])',
    'print("clock started")',
    "while true do sleep(1) end",
    "",
  ].join("\n"),
);
// a program for the debugger: a loop to stop in, and an error nothing catches
writeFileSync(
  join(project, "debugme.lua"),
  [
    "local count = 0", // 1
    "for i = 1, 3 do", // 2
    "  count = count + i", // 3
    "end", // 4
    'print("count", count)', // 5
    'error("debug boom")', // 6
    "",
  ].join("\n"),
);
writeFileSync(
  join(project, "clock.world.json"),
  JSON.stringify({
    addons: ["advanced-peripherals"],
    monitors: [{ name: "top", blocksWide: 2, blocksHigh: 1 }],
    players: [{ name: "Alice", x: 1, y: 64, z: 0 }],
    peripherals: [
      { name: "playerDetector_0", type: "playerDetector", x: 0, y: 64, z: 0 },
    ],
  }),
);

// world files: one with a typo'd key for the schema's diagnostics
writeFileSync(
  join(project, "typo.world.json"),
  '{\n  "addons": ["advanced-peripherals"],\n  "periferals": []\n}\n',
);
// for the World Editor: a world written the way Prettier writes it, with CRLF line ends, another computer next to
// it, and a file that does not parse
writeFileSync(
  join(project, "base.world.json"),
  [
    "{",
    '  "addons": ["advanced-peripherals"],',
    '  "computerId": 1,',
    '  "monitors": [{ "name": "top", "blocksWide": 3, "blocksHigh": 2 }],',
    '  "peripherals": [',
    '    { "name": "back", "type": "modem", "kind": "ender" },',
    '    { "name": "minecraft:chest_0", "type": "minecraft:chest", "size": 27 }',
    "  ]",
    "}",
    "",
  ].join("\r\n"),
);
writeFileSync(
  join(project, "relay.world.json"),
  '{\n  "computerId": 2,\n  "position": { "x": 5, "y": 64, "z": 0 },\n  "peripherals": [{ "name": "top", "type": "modem" }]\n}\n',
);
writeFileSync(join(project, "broken.world.json"), '{\n  "addons": [\n}\n');
// a CC program for the Lua language server, and Lua settings of the user's own that Set Up Lua Types must keep
writeFileSync(
  join(project, "files.lua"),
  'local h = fs.open("notes.txt", "w")\nif h then h.write("hi") h.close() end\nprint(fs.exists("notes.txt"))\n',
);
mkdirSync(join(project, "otherlib"), { recursive: true });
mkdirSync(join(project, ".vscode"), { recursive: true });
writeFileSync(
  join(project, ".vscode", "settings.json"),
  `${JSON.stringify(
    {
      "Lua.workspace.library": [join(project, "otherlib")],
      "Lua.runtime.builtin": { os: "enable" },
    },
    null,
    2,
  )}\n`,
);

const code = process.env.CODE ?? (await downloadAndUnzipVSCode("stable"));
const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(code, {
  reuseMachineInstall: false,
});
const profile = [
  `--user-data-dir=${userData}`,
  `--extensions-dir=${extensions}`,
];
console.log(`installing ${vsix}`);
// code.cmd on Windows needs a shell; quote by hand, the install path has spaces
const quote = (a) => (/[\s&()]/.test(a) ? `"${a}"` : a);
const line = [
  cli,
  ...cliArgs.filter((a) => !a.startsWith("--")),
  ...profile,
  "--install-extension",
  vsix,
];
execSync(line.map(quote).join(" "), { stdio: "inherit" });
// the Lua extension, into the same throwaway folder, for the "no more Undefined global" check. Without the network
// the Lua steps still check the settings and say the language server part was skipped.
let luaInstalled = "0";
if (process.env.SKIP_LUA_EXTENSION !== "1") {
  try {
    execSync([...line.slice(0, -1), "sumneko.lua"].map(quote).join(" "), {
      stdio: "inherit",
      timeout: 300_000,
    });
    luaInstalled = "1";
  } catch (error) {
    console.warn(`could not install sumneko.lua: ${error.message}`);
  }
}

let failed = false;
try {
  await runTests({
    vscodeExecutablePath: code,
    // a do-nothing extension: the one under test is the installed .vsix
    extensionDevelopmentPath: join(here, "host"),
    extensionTestsPath: join(here, "suite.cjs"),
    launchArgs: [
      project,
      ...profile,
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
    ],
    extensionTestsEnv: {
      CRAFTOS_PROJECT: project,
      CRAFTOS_USER_DATA: userData,
      CRAFTOS_LUA_INSTALLED: luaInstalled,
      // only the lua types and schema steps ("lua") or only the debugger's ("debug"), for a quick run
      CRAFTOS_IT_ONLY: process.env.CRAFTOS_IT_ONLY ?? "",
      // The debugger's steps need a craftos-mcp whose engine has the debugger. Until the pinned npm release has it,
      // they run against this clone's own build (apps/cli/dist and engine/build), or CRAFTOS_IT_DEBUG_COMMAND (a
      // JSON array, as craftos-mcp.command). With neither they are skipped, and say so.
      CRAFTOS_IT_DEBUG_COMMAND:
        process.env.CRAFTOS_IT_DEBUG_COMMAND ??
        (existsSync(cloneCli)
          ? JSON.stringify([process.execPath, cloneCli])
          : ""),
    },
  });
} catch (error) {
  console.error(`integration tests failed: ${error.message ?? error}`);
  failed = true;
} finally {
  rmSync(scratch, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 500,
  });
}
process.exit(failed ? 1 : 0);
