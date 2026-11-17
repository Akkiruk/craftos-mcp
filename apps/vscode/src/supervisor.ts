// The process VS Code starts as the MCP server (dist/supervisor.js, run by the editor's own Node). It runs
// `craftos-mcp serve` through Supervisor and tells the extension what happens over a local pipe, so the extension
// can say when the server keeps crashing and offer Restart.
//
// CRAFTOS_SUPERVISE: JSON { base: string[], sub: string[], pipe?: string }.
import { connect } from "node:net";
import { Supervisor, type SupervisorEvent } from "./supervise";

interface Setup {
  base: string[];
  sub: string[];
  pipe?: string;
}

const setup = JSON.parse(process.env["CRAFTOS_SUPERVISE"] ?? "{}") as Setup;
if (!Array.isArray(setup.base) || !setup.base.length) {
  process.stderr.write(
    "craftos-mcp supervisor: CRAFTOS_SUPERVISE is missing\n",
  );
  process.exit(2);
}

const env = { ...process.env };
delete env["CRAFTOS_SUPERVISE"];
delete env["ELECTRON_RUN_AS_NODE"];

let pipe: ReturnType<typeof connect> | undefined;
const sent: string[] = [];
let connected = false;
const tell = (event: SupervisorEvent): void => {
  const line = `${JSON.stringify({ ...event, supervisor: process.pid })}\n`;
  if (connected) pipe?.write(line);
  else sent.push(line);
};

const supervisor = new Supervisor({
  base: setup.base,
  sub: setup.sub ?? ["serve"],
  env,
  write: (line) => process.stdout.write(`${line}\n`),
  log: (text) => {
    process.stderr.write(text);
    tell({ type: "log", text });
  },
  events: tell,
});

if (setup.pipe) {
  pipe = connect(setup.pipe, () => {
    connected = true;
    for (const line of sent.splice(0)) pipe!.write(line);
  });
  pipe.on("error", () => {
    // the extension is gone or never listened: run without it
    connected = false;
    pipe = undefined;
  });
  let buffer = "";
  pipe.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      try {
        const msg = JSON.parse(line) as { type?: string };
        if (msg.type === "restart") supervisor.restart();
      } catch {
        // ignore
      }
    }
  });
  pipe.unref();
}

let input = "";
process.stdin.on("data", (chunk: Buffer) => {
  input += chunk.toString();
  for (let nl = input.indexOf("\n"); nl >= 0; nl = input.indexOf("\n")) {
    const line = input.slice(0, nl).replace(/\r$/, "");
    input = input.slice(nl + 1);
    if (line.trim()) supervisor.fromClient(line);
  }
});

// the client closes stdin to stop a stdio server: stop the child, say so, and go
const shutdown = (): void => {
  supervisor.stop();
  if (pipe && connected) pipe.end(() => process.exit(0));
  else process.exit(0);
  setTimeout(() => process.exit(0), 1000).unref();
};
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

supervisor.start();
