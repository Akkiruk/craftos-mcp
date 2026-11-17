// Runs inside VS Code (run.mjs starts it): checks the installed extension end to end against the real emulator.
const assert = require("node:assert/strict");
const { join } = require("node:path");
const vscode = require("vscode");

const project = process.env.CRAFTOS_PROJECT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function step(name, body) {
  const started = Date.now();
  try {
    await body();
    console.log(`  ok   ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    console.log(`  FAIL ${name}: ${error.stack ?? error}`);
    throw error;
  }
}

/** Record what a test run reports, by wrapping the controller's createTestRun. */
function recordRuns(controller) {
  const log = [];
  const create = controller.createTestRun.bind(controller);
  controller.createTestRun = (...args) => {
    const run = create(...args);
    for (const method of ["passed", "failed", "errored", "skipped"]) {
      const original = run[method].bind(run);
      run[method] = (item, message, duration) => {
        log.push({ method, id: item.id, label: item.label, message });
        return original(item, message, duration);
      };
    }
    return run;
  };
  return log;
}

exports.run = async function run() {
  const ext = vscode.extensions.getExtension("Rogiedoji.craftos-mcp");
  assert.ok(ext, "the installed extension is not there");
  const api = await ext.activate();

  await step("commands are registered", async () => {
    const all = await vscode.commands.getCommands(true);
    for (const id of [
      "craftos-mcp.runInCraftOS",
      "craftos-mcp.addToClaudeCode",
      "craftos-mcp.copyMcpJson",
    ])
      assert.ok(all.includes(id), id);
  });

  await step(
    "the MCP server definition is npx craftos-mcp@0.2.0 serve in the project",
    async () => {
      const def = api.serverDefinition();
      assert.ok(def instanceof vscode.McpStdioServerDefinition);
      const line = [def.command, ...def.args].join(" ");
      assert.match(line, /npx -y craftos-mcp@0\.2\.0 serve$/);
      if (process.platform === "win32")
        assert.match(def.command, /cmd(\.exe)?$/i);
      assert.equal(def.cwd.fsPath.toLowerCase(), project.toLowerCase());
      assert.equal(
        def.env.CRAFTOS_WORKSPACE.toLowerCase(),
        project.toLowerCase(),
      );
      console.log(`       ${line}`);
    },
  );

  await step("copied JSON is the README's server entry", async () => {
    const json = JSON.parse(api.mcpJson("mcpServers"));
    assert.deepEqual(json, {
      mcpServers: {
        craftos: { command: "npx", args: ["-y", "craftos-mcp", "serve"] },
      },
    });
  });

  const controller = api.tests.controller;
  await step(
    "math.test.lua shows in the Testing view with its two tests",
    async () => {
      await api.tests.discover();
      const items = [];
      controller.items.forEach((i) => items.push(i));
      const file = items.find((i) => i.label === "math.test.lua");
      assert.ok(file, `no math.test.lua in ${items.map((i) => i.label)}`);
      const kids = [];
      file.children.forEach((c) => kids.push([c.label, c.range.start.line]));
      assert.deepEqual(kids, [
        ["adds", 0],
        ["breaks", 1],
      ]);
    },
  );

  await step(
    "running it passes one test and fails the other at line 3",
    async () => {
      const log = recordRuns(controller);
      const source = new vscode.CancellationTokenSource();
      await api.tests.run(new vscode.TestRunRequest(), source.token);
      const byLabel = Object.fromEntries(log.map((e) => [e.label, e]));
      assert.equal(byLabel["adds"]?.method, "passed", JSON.stringify(log));
      const broke = byLabel["breaks"];
      assert.equal(broke?.method, "failed", JSON.stringify(log));
      const message = Array.isArray(broke.message)
        ? broke.message[0]
        : broke.message;
      assert.match(String(message.message), /expected 3 but got 2/);
      assert.equal(
        message.location.uri.fsPath.toLowerCase(),
        join(project, "math.test.lua").toLowerCase(),
      );
      assert.equal(message.location.range.start.line, 2); // line 3, 0-based
      assert.equal(byLabel["math.test.lua"]?.method, "failed");
    },
  );

  await step(
    "Run in CraftOS shows the program with its world and monitor, and closing stops it",
    async () => {
      const running = await api.runInCraftOS(
        vscode.Uri.file(join(project, "clock.lua")),
      );
      assert.ok(running, "no panel");
      const html = running.panel.webview.html;
      assert.match(html, /Content-Security-Policy/);
      assert.match(
        html,
        /default-src 'none'; frame-src http:\/\/127\.0\.0\.1:\d+;/,
      );
      assert.match(html, /<iframe id="app" src="http:\/\/127\.0\.0\.1:\d+\/"/);

      const page = await fetch(running.url + "/");
      assert.equal(page.status, 200);
      assert.equal(page.headers.get("x-frame-options"), null);

      const { sessions } = await (
        await fetch(`${running.url}/api/sessions`)
      ).json();
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].program, "clock.lua");
      let text = "";
      for (let i = 0; i < 60 && !/HELLO Alice/.test(text); i++) {
        await sleep(500);
        text = JSON.stringify(
          await (
            await fetch(`${running.url}/api/sessions/${sessions[0].id}/screens`)
          ).json(),
        );
      }
      assert.match(text, /HELLO Alice/, text);
      assert.match(text, /clock started/, text);

      const pid = running.child.pid;
      running.panel.dispose();
      for (let i = 0; i < 40 && alive(pid); i++) await sleep(250);
      assert.equal(
        alive(pid),
        false,
        "the app is still running after the panel closed",
      );
      assert.equal(api.runningPanels().length, 0);
      const gone = await fetch(`${running.url}/api/sessions`).then(
        () => "still answering",
        () => "gone",
      );
      assert.equal(gone, "gone");
    },
  );
};
