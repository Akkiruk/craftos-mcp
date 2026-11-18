import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { type IncomingMessage, type Server, createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type WorldConfig,
  checkConfig,
  loadConfig,
  readResultFile,
  resolveVersion,
  romDirFor,
  startEngine,
  testBoot,
} from "./index.js";

// CC:Tweaked 1.121.0's http, websocket and path changes against 1.101.3: custom verbs, websocket close frames and
// response headers, and path parts trimmed when a file is opened. A local server answers both versions.

const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "versions-io-ws-"));
const config = { ...base, workspaceDir: scratch };
const ready = checkConfig(config).length === 0;
const newer = existsSync(
  join(romDirFor(config, resolveVersion("1.20.1", {})), "bios.lua"),
);

/** A websocket server just big enough for these tests (RFC 6455 frames, no extensions). */
function frame(opcode: number, payload: Buffer): Buffer {
  const head =
    payload.length < 126
      ? Buffer.from([0x80 | opcode, payload.length])
      : payload.length < 65536
        ? Buffer.from([
            0x80 | opcode,
            126,
            payload.length >> 8,
            payload.length & 255,
          ])
        : Buffer.concat([
            Buffer.from([0x80 | opcode, 127]),
            (() => {
              const b = Buffer.alloc(8);
              b.writeBigUInt64BE(BigInt(payload.length));
              return b;
            })(),
          ]);
  return Buffer.concat([head, payload]);
}

function closeFrame(code: number, reason: string): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(code);
  return frame(8, Buffer.concat([b, Buffer.from(reason)]));
}

function onFrames(
  socket: Socket,
  handle: (opcode: number, payload: Buffer) => void,
): void {
  let buf = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0]! & 15;
      let len = buf[1]! & 127;
      let at = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        at = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        at = 10;
      }
      const masked = (buf[1]! & 128) !== 0;
      const mask = masked ? buf.subarray(at, at + 4) : undefined;
      if (masked) at += 4;
      if (buf.length < at + len) return;
      const payload = Buffer.from(buf.subarray(at, at + len));
      if (mask)
        for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i % 4]!;
      buf = buf.subarray(at + len);
      handle(opcode, payload);
    }
  });
}

let server: Server;
let port = 0;
const seen: string[] = [];
const sockets = new Set<Socket>();

function upgrade(req: IncomingMessage, socket: Socket): void {
  const accept = createHash("sha1")
    .update(
      `${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
    )
    .digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "X-Test: hello",
      "X-Dup: a",
      "X-Dup: b",
      "",
      "",
    ].join("\r\n"),
  );
  const path = req.url ?? "/";
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => undefined);
  if (path === "/drop") {
    setTimeout(() => socket.destroy(), 300);
    return;
  }
  if (path === "/bye") {
    setTimeout(() => socket.end(closeFrame(4000, "bye")), 300);
    return;
  }
  if (path === "/stall") {
    // a server that stops reading: the client's frames back up behind a full socket
    socket.pause();
    return;
  }
  if (path === "/quiet") socket.on("end", () => seen.push("/quiet end"));
  if (path === "/big") {
    setTimeout(() => socket.write(frame(2, Buffer.alloc(131072 + 1, 65))), 300);
    return;
  }
  onFrames(socket, (opcode, payload) => {
    if (opcode === 1)
      socket.write(frame(1, Buffer.from(payload.toString().toUpperCase())));
    else if (opcode === 8) {
      seen.push(
        `${path} close ${payload.length >= 2 ? payload.readUInt16BE(0) : "-"}`,
      );
      // "/silent" never answers a close, so 1.121.0 gives up after 5 seconds
      if (path !== "/silent") socket.end(frame(8, payload));
    }
  });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.setHeader("X-Method", req.method ?? "");
    res.end(req.method === "HEAD" ? undefined : `method ${req.method}`);
  });
  server.on("upgrade", upgrade);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(scratch, { recursive: true, force: true });
});

interface Case {
  name: string;
  passed: boolean;
  error?: string;
}

async function runLua(
  lua: string,
  world: WorldConfig | undefined,
  name: string,
): Promise<string[]> {
  writeFileSync(join(scratch, name), lua.replaceAll("PORT", String(port)));
  const handle = startEngine(config, testBoot(name, []), {
    label: "test",
    world,
    httpRules: { deny: [] },
  });
  try {
    // a run that never finishes names the test it was in (results.jsonl streams each start), and the engine is
    // stopped before its folder goes: deleting it under a live engine failed with EPERM and hid what happened
    await handle.session.waitForExit(50000).catch(async () => {
      await handle.session.stop(0);
      let streamed = "";
      try {
        streamed = readFileSync(
          join(handle.resultsDir, "results.jsonl"),
          "utf8",
        );
      } catch {
        // nothing streamed: it never got to a test
      }
      throw new Error(
        `${name} still running after 50 s; streamed: ${streamed.slice(-600)}`,
      );
    });
    const parsed = readResultFile<{ tests: Case[] }>(
      handle.resultsDir,
      "results.json",
    );
    expect(parsed?.tests.length ?? 0).toBeGreaterThan(0);
    return (parsed?.tests ?? [])
      .filter((t) => !t.passed)
      .map((t) => `${t.name}: ${t.error}`);
  } finally {
    handle.dispose();
  }
}

// Shared by both versions: helpers to pull a websocket's events with a deadline
const wsLua = `
local function open(path)
  local url = "ws://127.0.0.1:PORT" .. path
  local ws, err = http.websocket(url)
  ccunit.truthy(ws, err)
  return ws, url
end
local function closedEvent(url)
  local timer = os.startTimer(10)
  while true do
    local ev = table.pack(os.pullEvent())
    if ev[1] == "websocket_closed" and ev[2] == url then return ev end
    if ev[1] == "timer" and ev[2] == timer then error("no websocket_closed for " .. url) end
  end
end
local function noEvent(name, seconds)
  local timer = os.startTimer(seconds)
  while true do
    local ev = os.pullEvent()
    if ev == name then error("unexpected " .. name) end
    if ev == "timer" then return end
  end
end
`;

describe.skipIf(!ready)("http, websockets and paths per CC version", () => {
  it("1.18.2: CC:Tweaked 1.101.3", async () => {
    const failed = await runLua(
      `${wsLua}
ccunit.test("only the ROM's list of methods, case and all", function()
  http.request({ url = "http://127.0.0.1:PORT/a", method = "PATCH" })
  local ev, url, h = os.pullEvent()
  ccunit.eq(ev, "http_success", tostring(h)) ccunit.eq(h.readAll(), "method PATCH") h.close()
  ccunit.raises(function() http.request({ url = "http://127.0.0.1:PORT/a", method = "patch" }) end, "Unsupported HTTP method")
  ccunit.raises(function() http.request({ url = "http://127.0.0.1:PORT/a", method = "PROPFIND" }) end, "Unsupported HTTP method")
end)
ccunit.test("CONNECT is refused", function()
  ccunit.raises(function() http.request({ url = "http://127.0.0.1:PORT/", method = "connect" }) end, "Unsupported HTTP method")
end)
ccunit.test("a local close queues nothing", function()
  local ws, url = open("/echo")
  ws.send("hi") ccunit.eq(ws.receive(5), "HI")
  ws.close()
  noEvent("websocket_closed", 2)
  ccunit.raises(function() ws.send("x") end, "attempt to use a closed file")
end)
ccunit.test("close drops the connection, with no close frame (row 100)", function()
  local ws = open("/quiet")
  ws.send("hi") ccunit.eq(ws.receive(5), "HI")
  ws.close()
  noEvent("websocket_closed", 1)
end)
ccunit.test("send never waits for a server that stopped reading (row 100)", function()
  local ws = open("/stall")
  local chunk = ("x"):rep(65536)
  local t = os.epoch("utc")
  for _ = 1, 600 do ws.send(chunk) end -- 39 MB: far more than the socket takes
  ccunit.truthy(os.epoch("utc") - t < 5000, "600 sends took " .. (os.epoch("utc") - t) .. " ms")
  ws.close()
end)
ccunit.test("no getResponseHeaders before 1.117", function()
  local ws = open("/echo") ccunit.eq(ws.getResponseHeaders, nil) ws.close()
end)
ccunit.test("the server's close frame", function()
  local ws, url = open("/bye")
  local ev = closedEvent(url)
  ccunit.eq(ev.n, 4) ccunit.eq(ev[3], "bye") ccunit.eq(ev[4], 4000)
end)
ccunit.test("a dropped connection", function()
  local ws, url = open("/drop")
  local ev = closedEvent(url)
  ccunit.eq(ev.n, 4) ccunit.eq(ev[3], "Websocket is inactive") ccunit.eq(ev[4], nil)
end)
ccunit.test("path parts are trimmed before . and .. are read", function()
  fs.makeDir("d")
  local h = fs.open(" d / . / x.txt ", "w") h.write("hi") h.close()
  ccunit.truthy(fs.exists("d/x.txt"))
  ccunit.eq(fs.list(" d ")[1], "x.txt")
  h = fs.open("d/ .. /d/x.txt", "r") ccunit.eq(h.readAll(), "hi") h.close()
  local ok, out = pcall(fs.open, " .. /x", "w") ccunit.truthy(not ok or out == nil, "a spaced .. leaves the computer")
  h = fs.open(" e / f .txt", "w") h.write("y") h.close()
  ccunit.truthy(fs.isDir("e")) ccunit.truthy(fs.exists("e/f .txt"))
  ccunit.eq(fs.isReadOnly(" rom /x"), true)
  ccunit.eq(fs.isReadOnly("   /x"), false)
end)
`,
      { version: "1.18.2" },
      "io-default.test.lua",
    );
    expect(failed).toEqual([]);
    // WebsocketHandle.close closes the channel: the server saw the connection go, and no close frame before it
    expect(seen).toContain("/quiet end");
    expect(seen.filter((s) => s.startsWith("/quiet close"))).toEqual([]);
  }, 60000);

  it.skipIf(!newer)(
    "1.20.1: CC:Tweaked 1.121.0",
    async () => {
      const failed = await runLua(
        `${wsLua}
ccunit.test("any verb, upper-cased", function()
  -- verbs outside the old ROM's list (node's server only parses the verbs it knows)
  for _, m in ipairs({ "patch", "PROPFIND", "purge", "MKCOL" }) do
    http.request({ url = "http://127.0.0.1:PORT/v", method = m })
    local ev, url, h = os.pullEvent()
    ccunit.eq(ev, "http_success", tostring(h)) ccunit.eq(h.readAll(), "method " .. m:upper()) h.close()
  end
  ccunit.truthy(http.request({ url = "http://127.0.0.1:PORT/h", method = "HEAD" }))
  local ev, url, h = os.pullEvent()
  ccunit.eq(ev, "http_success") ccunit.eq(h.getResponseHeaders()["X-Method"], "HEAD") h.close()
end)
ccunit.test("bad verbs", function()
  ccunit.raises(function() http.request({ url = "http://127.0.0.1:PORT/", method = "CONNECT" }) end, "Unsupported HTTP method")
  ccunit.raises(function() http.request({ url = "http://127.0.0.1:PORT/", method = "GET me" }) end, "Invalid HTTP method")
  ccunit.raises(function() http.request({ url = "http://127.0.0.1:PORT/", method = "" }) end, "Invalid HTTP method")
  ccunit.raises(function() http.request({ url = "http://127.0.0.1:PORT/", method = ("A"):rep(33) }) end, "Invalid HTTP method")
  ccunit.raises(function() http.request({ url = "http://127.0.0.1:PORT/", method = "GET2" }) end, "Invalid HTTP method")
end)
ccunit.test("close sends a close frame and the answer queues websocket_closed", function()
  local ws, url = open("/echo")
  ws.send("hi") ccunit.eq(ws.receive(5), "HI")
  ws.close()
  ccunit.raises(function() ws.send("x") end, "attempt to use a closed websocket")
  local ev = closedEvent(url)
  ccunit.eq(ev.n, 4) ccunit.eq(ev[3], nil) ccunit.eq(ev[4], 1000)
  ccunit.raises(function() ws.receive() end, "attempt to use a closed websocket")
end)
ccunit.test("at most 512 frames waiting to be written (row 100)", function()
  local ws, url = open("/stall")
  local chunk = ("x"):rep(65536)
  local sent, err = 0, nil
  for _ = 1, 2000 do
    local ok, e = pcall(ws.send, chunk)
    if not ok then err = e break end
    sent = sent + 1
  end
  ccunit.truthy(tostring(err):find("Too many ongoing websocket messages$"), err)
  ccunit.truthy(sent >= 512 and sent < 2000, "sent " .. sent)
  ws.close()
end)
ccunit.test("receive answers a close with its reason", function()
  local ws, url = open("/bye")
  local msg, reason = ws.receive(10)
  ccunit.eq(msg, nil) ccunit.eq(reason, "bye")
  local ws2 = open("/echo")
  msg, reason = ws2.receive(0.2)
  ccunit.eq(msg, nil) ccunit.eq(reason, "Timed out")
  ws2.close()
end)
ccunit.test("getResponseHeaders", function()
  local ws = open("/echo")
  local h = ws.getResponseHeaders()
  ccunit.eq(h["X-Test"], "hello") ccunit.eq(h["X-Dup"], "a,b")
  h["X-Test"] = "changed" ccunit.eq(ws.getResponseHeaders()["X-Test"], "hello")
  ws.close()
  ccunit.eq(ws.getResponseHeaders()["X-Test"], "hello")
end)
ccunit.test("a dropped connection", function()
  local ws, url = open("/drop")
  local ev = closedEvent(url)
  ccunit.eq(ev.n, 4) ccunit.eq(ev[3], "Connection closed") ccunit.eq(ev[4], nil)
end)
ccunit.test("a too-large message", function()
  local ws, url = open("/big")
  local ev = closedEvent(url)
  ccunit.eq(ev[3], "Received a too-large message") ccunit.eq(ev[4], nil)
end)
ccunit.test("no answer to a close: 1006 after 5 seconds", function()
  local ws, url = open("/silent")
  ws.close()
  local ev = closedEvent(url)
  ccunit.eq(ev.n, 4) ccunit.eq(ev[3], nil) ccunit.eq(ev[4], 1006)
end)
ccunit.test("paths trimmed and . . skipped when a file is opened", function()
  fs.makeDir("d")
  local h = fs.open(" d / . . / x.txt ", "w") h.write("hi") h.close()
  ccunit.truthy(fs.exists("d/x.txt"))
  ccunit.eq(#fs.list("d"), 1)
  ccunit.eq(fs.list(" d / . ")[1], "x.txt")
  h = fs.open("d/ .. /d/ ... /x.txt", "r") ccunit.eq(h.readAll(), "hi") h.close()
  local ok, out = pcall(fs.open, " .. /x", "w") ccunit.truthy(not ok or out == nil, "a spaced .. leaves the computer")
  ccunit.eq(fs.isReadOnly(" rom /x"), true)
end)
`,
        { version: "1.20.1" },
        "io-newer.test.lua",
      );
      expect(failed).toEqual([]);
      expect(seen).toContain("/echo close 1000");
      expect(seen).toContain("/silent close 1000");
    },
    60000,
  );
});
