// worker.js: one computer, in its own Web Worker (web/README.md). The page's player.js starts it; it runs the engine
// (craftos.js / craftos.wasm, engine/build-web.cmd) on the engine's own pthreads, which are Web Workers nested in this
// one, so terminating this worker stops the computer and every thread it has.
//
// It speaks the CraftOS-PC raw protocol with the engine (a port of packages/rawterm: framing.ts and packets.ts) and
// plain messages with the page:
//   page -> worker  {type:"start", ...}  {type:"event", name, params}  {type:"pause", on}
//   worker -> page  {type:"started"}  {type:"window", ...}  {type:"frames", frames}  {type:"message", ...}
//                   {type:"net", lines}  {type:"pixels", name, width, height, rgba}  {type:"off"}  {type:"log", text}
//                   {type:"error", message}
// "net" lines are what the computer's modems sent (ccsim writes them to /results/modem.out); the page's router hands
// them to the other computers as ccsim_net / ccsim_link events, as packages/runner/src/network.ts does.
"use strict";

// worker.js?js=<hash>: the version of craftos.js to load (player.js passes it from runtime/manifest.json)
const craftosVersion = new URLSearchParams(self.location.search).get("js");
importScripts(
  new URL(
    `craftos.js${craftosVersion ? `?v=${craftosVersion}` : ""}`,
    self.location.href,
  ).href,
);

// The engine's own threads load this file too (Emscripten names them "em-pthread"); craftos.js runs them by itself.
if (self.name !== "em-pthread") host();

function host() {
  const latin1 = new TextDecoder("latin1");
  const utf8 = new TextEncoder();
  let M = null;
  const queued = [];
  let off = false;

  const post = (message, transfer) => self.postMessage(message, transfer ?? []);
  const log = (text) => post({ type: "log", text: String(text) });

  // ---- framing (packages/rawterm/src/framing.ts, binaryCrc off: the CRC covers the Base64 text) ----
  const CRC_TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c >>> 0;
  }
  function crc32(text) {
    let c = 0xffffffff;
    for (let i = 0; i < text.length; i++)
      c = CRC_TABLE[(c ^ text.charCodeAt(i)) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function toBase64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromBase64(b64) {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  function encodeFrame(payload) {
    const b64 = toBase64(payload);
    const crc = crc32(b64).toString(16).padStart(8, "0");
    if (b64.length > 0xffff)
      return `!CPD${b64.length.toString(16).toUpperCase().padStart(12, "0")}${b64}${crc}\n`;
    return `!CPC${b64.length.toString(16).toUpperCase().padStart(4, "0")}${b64}${crc}\n`;
  }

  let inBuffer = "";
  function* parseFrames(chunk) {
    inBuffer += chunk;
    for (;;) {
      const a = inBuffer.indexOf("!CPC");
      const b = inBuffer.indexOf("!CPD");
      const start = a < 0 ? b : b < 0 ? a : Math.min(a, b);
      if (start < 0) {
        inBuffer = inBuffer.slice(Math.max(0, inBuffer.length - 3));
        return;
      }
      if (start > 0) inBuffer = inBuffer.slice(start);
      const sizeLength = inBuffer[3] === "D" ? 12 : 4;
      const header = 4 + sizeLength;
      if (inBuffer.length < header) return;
      const size = parseInt(inBuffer.slice(4, header), 16);
      if (!Number.isFinite(size)) {
        inBuffer = inBuffer.slice(4);
        continue;
      }
      const total = header + size + 8;
      if (inBuffer.length < total) return;
      const b64 = inBuffer.slice(header, header + size);
      const expected = parseInt(inBuffer.slice(header + size, total), 16);
      inBuffer = inBuffer.slice(total).replace(/^\r?\n/, "");
      if (crc32(b64) !== expected) {
        log("raw frame CRC mismatch, dropped");
        continue;
      }
      yield fromBase64(b64);
    }
  }

  // ---- packets (packages/rawterm/src/packets.ts) ----
  function rle(data, pos, expected) {
    const out = new Uint8Array(expected);
    let produced = 0;
    while (produced < expected) {
      if (pos + 1 >= data.length) throw new Error("truncated RLE stream");
      const value = data[pos];
      const run = Math.min(data[pos + 1], expected - produced);
      pos += 2;
      out.fill(value, produced, produced + run);
      produced += run;
    }
    return [out, pos];
  }
  function cString(data, offset) {
    let end = offset;
    while (end < data.length && data[end] !== 0) end++;
    return [latin1.decode(data.subarray(offset, end)), end + 1];
  }
  function decode(data) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const window = data[1] ?? 0;
    switch (data[0]) {
      case 0: {
        const mode = data[2];
        if (mode > 2) return null;
        const width = view.getUint16(4, true);
        const height = view.getUint16(6, true);
        const cells = width * height;
        let text = null;
        let colors = null;
        let pixels = null;
        let next = 0x10;
        if (mode === 0) {
          [text, next] = rle(data, next, cells);
          [colors, next] = rle(data, next, cells);
        } else [pixels, next] = rle(data, next, cells * 54);
        const palette = data.slice(next, next + (mode === 2 ? 768 : 48));
        return {
          type: "terminal",
          window,
          mode,
          blink: data[3] !== 0,
          width,
          height,
          cursorX: view.getUint16(8, true),
          cursorY: view.getUint16(10, true),
          grayscale: data[12] === 1,
          text,
          colors,
          pixels,
          palette,
        };
      }
      case 4: {
        const computer = data[3] ?? 0;
        return {
          type: "window",
          window,
          closing: data[2] ?? 0,
          computerId: computer > 0 ? computer - 1 : undefined,
          width: view.getUint16(4, true),
          height: view.getUint16(6, true),
          title: cString(data, 8)[0],
        };
      }
      case 5: {
        const [title, next] = cString(data, 6);
        return {
          type: "message",
          flags: view.getUint32(2, true),
          title,
          message: cString(data, next)[0],
        };
      }
      default:
        return null;
    }
  }

  function encodeValue(value, out) {
    if (value === null || value === undefined) out.push(5);
    else if (typeof value === "boolean") out.push(2, value ? 1 : 0);
    else if (typeof value === "number") {
      const b = new DataView(new ArrayBuffer(8));
      if (Number.isInteger(value) && value >= 0 && value <= 0xffffffff) {
        b.setUint32(0, value, true);
        out.push(0);
        for (let i = 0; i < 4; i++) out.push(b.getUint8(i));
      } else {
        b.setFloat64(0, value, true);
        out.push(1);
        for (let i = 0; i < 8; i++) out.push(b.getUint8(i));
      }
    } else if (typeof value === "string") {
      out.push(3);
      // CC 1.101.3 strings are bytes: characters past Latin-1 become "?"
      for (let i = 0; i < value.length; i++) {
        const c = value.charCodeAt(i);
        out.push(c === 0 ? 32 : c < 256 ? c : 63);
      }
      out.push(0);
    } else if (typeof value === "object") {
      const entries = Array.isArray(value)
        ? value.map((v, i) => [i + 1, v])
        : Object.entries(value);
      out.push(4, entries.length);
      for (const [k] of entries) encodeValue(k, out);
      for (const [, v] of entries) encodeValue(v, out);
    } else out.push(5);
  }
  function encodeEvent(name, params) {
    const out = [3, 0, params.length];
    for (let i = 0; i < name.length; i++) out.push(name.charCodeAt(i) & 0xff);
    out.push(0);
    for (const p of params) encodeValue(p, out);
    return Uint8Array.from(out);
  }

  function sendPayload(payload) {
    if (!M) {
      queued.push(payload);
      return;
    }
    const text = encodeFrame(payload);
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    const ptr = M._malloc(bytes.length);
    M.writeArrayToMemory(bytes, ptr);
    M._craftos_web_input(ptr, bytes.length);
    M._free(ptr);
  }

  // ---- output: frames go to the page at most once a frame per window ----
  const pending = new Map();
  let flushTimer = 0;
  function flush() {
    flushTimer = 0;
    if (pending.size === 0) return;
    const frames = [...pending.values()];
    pending.clear();
    const transfer = [];
    for (const f of frames)
      for (const k of ["text", "colors", "pixels", "palette"])
        if (f[k]) transfer.push(f[k].buffer);
    post({ type: "frames", frames }, transfer);
  }
  function onRawOutput(chunk) {
    let payloads;
    try {
      payloads = [...parseFrames(chunk)];
    } catch (e) {
      log(`raw output: ${e.message}`);
      return;
    }
    for (const payload of payloads) {
      let frame;
      try {
        frame = decode(payload);
      } catch (e) {
        log(`raw packet: ${e.message}`);
        continue;
      }
      if (!frame) continue;
      if (frame.type === "terminal") {
        pending.set(frame.window, frame);
        if (!flushTimer) flushTimer = setTimeout(flush, 12);
      } else if (frame.type === "window") {
        flush();
        post(frame);
        if (
          frame.closing === 2 ||
          (frame.closing === 1 && frame.window === 0)
        ) {
          if (!off) {
            off = true;
            post({ type: "off" });
          }
        }
      } else post(frame);
    }
  }

  // ---- the computer's files ----
  function writeFile(FS, path, data) {
    const dir = path.slice(0, path.lastIndexOf("/"));
    if (dir) FS.mkdirTree(dir);
    FS.writeFile(path, data);
  }
  function unpackRom(FS, rom) {
    const bytes = new Uint8Array(rom);
    const view = new DataView(rom);
    if (latin1.decode(bytes.subarray(0, 11)) !== "CRAFTOSROM1")
      throw new Error("not a ROM pack");
    const length = view.getUint32(12, true);
    const index = JSON.parse(
      new TextDecoder().decode(bytes.subarray(16, 16 + length)),
    );
    const base = 16 + length;
    for (const f of index)
      writeFile(
        FS,
        f.path,
        bytes.subarray(base + f.offset, base + f.offset + f.size),
      );
  }
  function fileBytes(value) {
    if (typeof value === "string") return utf8.encode(value);
    return fromBase64(value.base64);
  }

  // ---- what the computer writes for the host: modem traffic and pixel screens ----
  const RESULTS = "/user-data/results";
  let modemOffset = 0;
  const pixelSeen = new Map();
  function readNewLines(path) {
    let st;
    try {
      st = M.FS.stat(path);
    } catch {
      return null;
    }
    if (st.size <= modemOffset) return null;
    const buf = new Uint8Array(st.size - modemOffset);
    const stream = M.FS.open(path, "r");
    try {
      M.FS.read(stream, buf, 0, buf.length, modemOffset);
    } finally {
      M.FS.close(stream);
    }
    const end = buf.lastIndexOf(10);
    if (end < 0) return null; // caught halfway through its first line
    modemOffset += end + 1;
    return latin1
      .decode(buf.subarray(0, end))
      .split("\n")
      .map((l) => l.replace(/\r$/, ""))
      .filter(Boolean);
  }
  function pollModem() {
    if (!M || off) return;
    const lines = readNewLines(`${RESULTS}/modem.out`);
    if (lines && lines.length) post({ type: "net", lines });
  }
  function pollPixels() {
    if (!M || off) return;
    let names;
    try {
      names = M.FS.readdir(`${RESULTS}/pixels`);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".ppm")) continue;
      const path = `${RESULTS}/pixels/${name}`;
      let st;
      try {
        st = M.FS.stat(path);
      } catch {
        continue;
      }
      const stamp = `${+st.mtime}:${st.size}`;
      if (pixelSeen.get(name) === stamp) continue;
      const data = M.FS.readFile(path);
      const head = /^P6\n(\d+) (\d+)\n255\n/.exec(
        latin1.decode(data.subarray(0, 32)),
      );
      if (!head) continue;
      const width = +head[1];
      const height = +head[2];
      const body = data.subarray(head[0].length);
      if (body.length < width * height * 3) continue; // being written
      pixelSeen.set(name, stamp);
      const rgba = new Uint8ClampedArray(width * height * 4);
      for (let i = 0, j = 0; i < width * height; i++, j += 3) {
        rgba[i * 4] = body[j];
        rgba[i * 4 + 1] = body[j + 1];
        rgba[i * 4 + 2] = body[j + 2];
        rgba[i * 4 + 3] = 255;
      }
      post({ type: "pixels", name: name.slice(0, -4), width, height, rgba }, [
        rgba.buffer,
      ]);
    }
  }

  async function start(m) {
    const { computer, rom, wasmModule, runtimeUrls } = m;
    const id = computer.id ?? 0;
    const module = await CraftOS({
      onRawOutput,
      print: (s) => log(s),
      printErr: (s) => log(s),
      locateFile: (path) =>
        runtimeUrls[path] ?? new URL(path, self.location.href).href,
      ...(wasmModule && {
        instantiateWasm(imports, done) {
          WebAssembly.instantiate(wasmModule, imports).then(
            (instance) => done(instance, wasmModule),
            (e) => post({ type: "error", message: `wasm: ${e.message}` }),
          );
          return {};
        },
      }),
      preRun: [
        (mod) => {
          const FS = mod.FS;
          unpackRom(FS, rom);
          const root = `/user-data/computer/${id}`;
          FS.mkdirTree(root);
          for (const [path, value] of Object.entries(computer.files ?? {}))
            writeFile(FS, `${root}/${path}`, fileBytes(value));
          writeFile(
            FS,
            `${RESULTS}/world.json`,
            utf8.encode(computer.world ?? "{}"),
          );
          writeFile(
            FS,
            "/user-data/config/global.json",
            utf8.encode(
              JSON.stringify({
                computerSpaceLimit: 1000000,
                http_enable: false,
                ...(computer.config ?? {}),
              }),
            ),
          );
          if (computer.advanced === false)
            writeFile(
              FS,
              `/user-data/config/${id}.json`,
              utf8.encode(JSON.stringify({ isColor: false })),
            );
          writeFile(
            FS,
            "/user-data/boot.lua",
            utf8.encode(computer.boot ?? ""),
          );
        },
      ],
    });
    M = module;
    M._craftos_web_attach();
    sendPayload(Uint8Array.from([6, 0, 4, 0])); // features: announce windows on handshake
    for (const p of queued.splice(0)) sendPayload(p);
    const args = [
      "--raw",
      "--directory",
      "/user-data",
      "--rom",
      "/craftos",
      "--mount-rw",
      `results=${RESULTS}`,
    ];
    if (id !== 0) args.push("--id", String(id));
    args.push("--script", "/user-data/boot.lua");
    M.callMain(args);
    setInterval(pollModem, 4);
    setInterval(pollPixels, 40);
    post({ type: "started" });
  }

  self.onmessage = (e) => {
    const m = e.data;
    try {
      if (m.type === "start")
        start(m).catch((err) =>
          post({ type: "error", message: String(err?.message ?? err) }),
        );
      else if (m.type === "event")
        sendPayload(encodeEvent(m.name, m.params ?? []));
      else if (m.type === "pause") M?._craftos_web_pause(m.on ? 1 : 0);
    } catch (err) {
      post({ type: "error", message: String(err?.message ?? err) });
    }
  };
}
