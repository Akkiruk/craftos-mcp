// The workspace suggestion, the .vscode/mcp.json check and the pinned-version fallback.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  FALLBACK_PACKAGE,
  NPM_PACKAGE,
  fallbackFor,
  missingVersion,
} from "../../src/launcher.ts";
import {
  ccProjectSign,
  countFiles,
  craftosServers,
  suggestWorkspace,
} from "../../src/projectScan.ts";

function project(files) {
  const root = mkdtempSync(join(tmpdir(), "craftos-scan-"));
  for (const f of files) {
    mkdirSync(join(root, f, ".."), { recursive: true });
    writeFileSync(join(root, f), "");
  }
  return root;
}

test("a big repo with Lua in workspace/ gets workspace suggested", () => {
  const root = project([
    "node_modules/x/index.js",
    "package.json",
    "workspace/games/snake.lua",
    "src/index.ts",
  ]);
  assert.equal(suggestWorkspace(root), "workspace");
  rmSync(root, { recursive: true });
});

test("a small Lua project gets nothing suggested", () => {
  const root = project(["main.lua", "lib/util.lua", "workspace/x.lua"]);
  assert.equal(suggestWorkspace(root), undefined);
  rmSync(root, { recursive: true });
});

test("a big repo without a Lua folder gets nothing suggested", () => {
  const root = project(["node_modules/x/index.js", "src/index.ts", "init.lua"]);
  assert.equal(suggestWorkspace(root), undefined);
  rmSync(root, { recursive: true });
});

test("thousands of files count as big even without node_modules", () => {
  const files = Array.from({ length: 3001 }, (_, i) => `data/f${i}.txt`);
  const root = project([...files, "lua/startup.lua"]);
  assert.equal(countFiles(root, 3000), 3000);
  assert.equal(suggestWorkspace(root), "lua");
  rmSync(root, { recursive: true });
});

test("finds craftos servers in a .vscode/mcp.json with comments", () => {
  const text = `{
    // the dev build, https://example.com/x
    "servers": {
      "craftos-dev": { "command": "node", "args": ["\${workspaceFolder}/apps/mcp-server/dist/index.js"], },
      "npx-one": { "command": "npx", "args": ["-y", "craftos-mcp", "serve"] },
      "other": { "command": "node", "args": ["\${workspaceFolder}/server.js"] },
      /* not this */
    },
  }`;
  assert.deepEqual(craftosServers(text, "C:/repos/craftos-agent"), [
    "craftos-dev",
    "npx-one",
  ]);
});

test("the folder's own path does not make every server a craftos one", () => {
  const text = JSON.stringify({
    servers: {
      tools: { command: "node", args: ["C:/repos/craftos-stuff/tools.js"] },
    },
  });
  assert.deepEqual(craftosServers(text, "C:/repos/craftos-stuff"), []);
  assert.deepEqual(craftosServers("not json", "C:/x"), []);
});

test("only the default pinned npx command falls back, and only on ETARGET", () => {
  assert.deepEqual(fallbackFor(["npx", "-y", NPM_PACKAGE]), [
    "npx",
    "-y",
    FALLBACK_PACKAGE,
  ]);
  assert.equal(fallbackFor(["node", "x/index.js"]), undefined);
  assert.equal(
    missingVersion(
      "npm error code ETARGET\nnpm error notarget No matching version found for craftos-mcp@0.4.0.",
    ),
    true,
  );
  assert.equal(
    missingVersion("npm error code ENOTFOUND registry.npmjs.org"),
    false,
  );
});

test("registerServer auto: what makes a folder a ComputerCraft project", () => {
  assert.equal(
    ccProjectSign(project(["README.md", "src/index.ts"])),
    undefined,
  );
  assert.equal(ccProjectSign(project(["craftos.json"])), "craftos.json");
  assert.equal(ccProjectSign(project(["src/deep/door.lua"])), "Lua files");
  assert.equal(ccProjectSign(project(["base.world.json"])), "a world file");
  // Lua only inside node_modules or a dot folder does not count
  assert.equal(
    ccProjectSign(project(["node_modules/x/a.lua", ".git/hooks/b.lua"])),
    undefined,
  );
  const typed = project([]);
  mkdirSync(join(typed, ".vscode"), { recursive: true });
  writeFileSync(
    join(typed, ".vscode", "settings.json"),
    '{ "Lua.workspace.library": ["C:/x/globalStorage/rogiedoji.craftos-mcp/lua-addons/cc-tweaked/library"] }',
  );
  assert.equal(
    ccProjectSign(typed),
    "the CC:Tweaked types in .vscode/settings.json",
  );
  assert.equal(ccProjectSign(join(typed, "missing")), undefined);
});
