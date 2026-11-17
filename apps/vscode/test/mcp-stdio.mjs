// End to end: start the MCP server the way the extension hands it to VS Code (dist/supervisor.js on Node, running
// baseCommand([]) serve, spawned without a shell, as VS Code does), then initialize, list the tools and run a Lua
// program through it. Needs `npm run build` first.
//
//   node --experimental-strip-types test/mcp-stdio.mjs      (CRAFTOS_HOME may point at a scratch cache)
//
// The first run downloads craftos-mcp, the engine and the ROMs (about a minute).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { baseCommand } from "../src/launcher.ts";

const supervisor = fileURLToPath(
  new URL("../dist/supervisor.js", import.meta.url),
);
const launch = { command: process.execPath, args: [supervisor] };
const supervise = JSON.stringify({ base: baseCommand([]), sub: ["serve"] });
const project = mkdtempSync(join(tmpdir(), "craftos-mcp-stdio-"));
writeFileSync(
  join(project, "hello.lua"),
  'print("hello from " .. os.version())\n',
);
console.log(
  `command: ${launch.command} ${launch.args.join(" ")} -> ${supervise}`,
);

const child = spawn(launch.command, launch.args, {
  cwd: project,
  env: {
    ...process.env,
    CRAFTOS_WORKSPACE: project,
    CRAFTOS_SUPERVISE: supervise,
    CRAFTOS_VIEWER_PORT: "off",
  },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
child.stderr.on("data", (c) => process.stderr.write(`  [server] ${c}`));

let buffer = "";
const waiting = new Map();
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
  }
});

let nextId = 1;
function request(method, params, timeoutMs = 180_000) {
  const id = nextId++;
  child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
  );
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${method} timed out`)),
      timeoutMs,
    );
    waiting.set(id, (msg) => {
      clearTimeout(timer);
      msg.error
        ? reject(new Error(JSON.stringify(msg.error)))
        : resolve(msg.result);
    });
  });
}

const fail = (why) => {
  console.error(`FAIL: ${why}`);
  child.kill();
  process.exit(1);
};

try {
  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "craftos-vscode-test", version: "0" },
  });
  console.log(
    `initialize: ${init.serverInfo.name} ${init.serverInfo.version}, protocol ${init.protocolVersion}`,
  );
  child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
      "\n",
  );

  const { tools } = await request("tools/list", {});
  const names = tools.map((t) => t.name);
  console.log(`tools/list: ${names.length} tools`);
  for (const want of [
    "craftos_info",
    "craftos_run",
    "craftos_test",
    "craftos_session_create",
  ])
    if (!names.includes(want)) fail(`no ${want} in ${names.join(", ")}`);

  const ran = await request("tools/call", {
    name: "craftos_run",
    arguments: { program: "hello.lua" },
  });
  const text = ran.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  if (!/hello from CraftOS/.test(text))
    fail(`craftos_run did not print hello:\n${text}`);
  console.log("tools/call craftos_run: hello from CraftOS");
} catch (error) {
  fail(error.message);
}

// an MCP client stops a stdio server by closing its stdin: it must exit by itself
child.stdin.end();
const code = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve("still running"), 10_000);
  child.on("exit", (c) => {
    clearTimeout(timer);
    resolve(c);
  });
});
rmSync(project, { recursive: true, force: true });
if (code === "still running")
  fail("the server kept running after stdin closed");
console.log(`exit after stdin closed: code ${code}`);
console.log("PASS");
