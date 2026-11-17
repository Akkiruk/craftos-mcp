// Claude Code's command on Windows, Cursor and Windsurf config merging, test discovery excludes, setup progress lines.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readSetupLine } from "../../src/launcher.ts";
import {
  claudeCodeCommand,
  editorKind,
  editorTargets,
  mergeMcpServer,
} from "../../src/mcpConfig.ts";
import { globToRegExp, isExcluded } from "../../src/projectScan.ts";

test("Claude Code gets cmd /c npx on Windows and plain npx elsewhere", () => {
  const npx = ["npx", "-y", "craftos-mcp", "serve"];
  assert.deepEqual(claudeCodeCommand(npx, "win32"), ["cmd", "/c", ...npx]);
  assert.deepEqual(claudeCodeCommand(npx, "linux"), npx);
  const node = ["node", "C:/x/index.js", "serve"];
  assert.deepEqual(claudeCodeCommand(node, "win32"), node);
});

test("Cursor and Windsurf are told apart from VS Code, with their config files", () => {
  assert.equal(editorKind("Visual Studio Code"), undefined);
  assert.equal(editorKind("Cursor"), "cursor");
  assert.equal(editorKind("Windsurf"), "windsurf");
  const cursor = editorTargets("cursor", "/p", "/home/u").map((t) => [
    t.scope,
    t.file.replace(/\\/g, "/"),
  ]);
  assert.deepEqual(cursor, [
    ["project", "/p/.cursor/mcp.json"],
    ["user", "/home/u/.cursor/mcp.json"],
  ]);
  const windsurf = editorTargets("windsurf", "/p", "/home/u").map((t) =>
    t.file.replace(/\\/g, "/"),
  );
  assert.deepEqual(windsurf, ["/home/u/.codeium/windsurf/mcp_config.json"]);
});

test("merging adds craftos and keeps everything else", () => {
  const server = { command: "npx", args: ["-y", "craftos-mcp", "serve"] };
  const fresh = mergeMcpServer(undefined, "craftos", server);
  assert.equal(fresh.status, "added");
  assert.deepEqual(JSON.parse(fresh.text), { mcpServers: { craftos: server } });

  const other = JSON.stringify({
    mcpServers: { git: { command: "git-mcp" } },
    theme: "x",
  });
  const merged = mergeMcpServer(other, "craftos", server);
  assert.deepEqual(JSON.parse(merged.text), {
    mcpServers: { git: { command: "git-mcp" }, craftos: server },
    theme: "x",
  });

  const has = JSON.stringify({ mcpServers: { craftos: { command: "mine" } } });
  assert.deepEqual(mergeMcpServer(has, "craftos", server), {
    status: "exists",
  });
  assert.equal(
    mergeMcpServer("{ nope", "craftos", server).status,
    "unreadable",
  );
  assert.equal(
    mergeMcpServer('{"mcpServers": []}', "craftos", server).status,
    "unreadable",
  );
});

test("test discovery skips copies, dependencies and the user's excludes", () => {
  const globs = ["**/tmp", "**/*.bak.lua", "out/**", "**/{build,dist}/**"].map(
    globToRegExp,
  );
  for (const skipped of [
    ".runtime/run-1/a.test.lua",
    ".claude/worktrees/x/a.test.lua",
    "node_modules/p/a.test.lua",
    "pkg/node_modules/p/a.test.lua",
    "workspace/tmp/a.test.lua",
    "out/a.test.lua",
    "src/build/a.test.lua",
    "x.bak.lua",
  ])
    assert.equal(isExcluded(skipped, globs), true, skipped);
  for (const kept of [
    "a.test.lua",
    "workspace/games/a.test.lua",
    ".claude/skills/a.test.lua",
    "tmpl/a.test.lua",
  ])
    assert.equal(isExcluded(kept, globs), false, kept);
});

test("reads the first-run setup's progress lines", () => {
  assert.deepEqual(
    readSetupLine(
      "craftos-mcp: setting up 0.2.1 in C:\\x (once; about a minute)",
    ),
    {
      kind: "setting-up",
      detail: "starting",
    },
  );
  assert.deepEqual(readSetupLine("craftos-mcp:   engine: 50% of 9.1 MB"), {
    kind: "setting-up",
    detail: "engine 50%",
  });
  assert.deepEqual(
    readSetupLine("craftos-mcp: engine: release v0.2.1 (win32-x64)"),
    {
      kind: "setting-up",
      detail: "engine: release v0.2.1",
    },
  );
  assert.deepEqual(readSetupLine("craftos-mcp: ready (41 s)"), {
    kind: "ready",
  });
  assert.deepEqual(readSetupLine("craftos-mcp: setup failed: fetch failed"), {
    kind: "failed",
    why: "fetch failed",
  });
  assert.equal(readSetupLine("something else"), undefined);
});
