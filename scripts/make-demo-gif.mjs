#!/usr/bin/env node
// Makes the pictures for the README: an animated GIF of the fission reactor controller reacting as the
// reactor heats up, and a few still PNGs of the other examples, all rendered from real runs in the emulator.
//
//   npm run build && node scripts/make-demo-gif.mjs [outDir]
//
// Output (default docs/media): demo.gif, reactor-scram.png, train-board.png, gpu-demo.png, power-monitor.png.
// No dependencies beyond the repo: the GIF encoder (palette, LZW) is in this file.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SessionManager,
  checkConfig,
  loadConfig,
  pixelScreenPng,
  pixelScreens,
  sendAndWait,
} from "@craftos-mcp/runner";
import { renderFrame, encodePng } from "@craftos-mcp/rawterm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(process.argv[2] ?? join(ROOT, "docs", "media"));
const SCALE = 3; // output pixels per emulated screen pixel
const TICK_MS = 100; // real time between captured frames

const config = loadConfig();
const problems = checkConfig(config);
if (problems.length) {
  console.error("The emulator is not ready:\n  " + problems.join("\n  "));
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const world = (name) =>
  JSON.parse(readFileSync(join(config.workspaceDir, name), "utf8"));

// ---------------------------------------------------------------------------------------------------------------
// Minimal GIF89a writer: one global palette, LZW, only the rectangle that changed is stored for each frame.

function lzw(indices, minBits) {
  const clear = 1 << minBits;
  const end = clear + 1;
  const out = [];
  let acc = 0;
  let accBits = 0;
  const emit = (code, width) => {
    acc |= code << accBits;
    accBits += width;
    while (accBits >= 8) {
      out.push(acc & 255);
      acc >>>= 8;
      accBits -= 8;
    }
  };
  let width = minBits + 1;
  let next = end + 1;
  let table = new Map();
  emit(clear, width);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const byte = indices[i];
    const key = prefix * 256 + byte;
    const hit = table.get(key);
    if (hit !== undefined) {
      prefix = hit;
      continue;
    }
    emit(prefix, width);
    if (next < 4096) {
      table.set(key, next++);
      if (next > 1 << width && width < 12) width++;
    } else {
      emit(clear, width);
      table = new Map();
      width = minBits + 1;
      next = end + 1;
    }
    prefix = byte;
  }
  emit(prefix, width);
  emit(end, width);
  if (accBits > 0) out.push(acc & 255);
  return out;
}

function subBlocks(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i += 255) {
    const part = bytes.slice(i, i + 255);
    out.push(part.length, ...part);
  }
  out.push(0);
  return out;
}

/** frames: [{ image: {width, height, rgba}, delayMs }]. Returns a Buffer. */
function encodeGif(frames) {
  const { width, height } = frames[0].image;
  // Global palette from every colour that appears
  const palette = new Map();
  const indexed = frames.map(({ image }) => {
    const px = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++) {
      const key =
        (image.rgba[i * 4] << 16) |
        (image.rgba[i * 4 + 1] << 8) |
        image.rgba[i * 4 + 2];
      let index = palette.get(key);
      if (index === undefined) {
        if (palette.size >= 256) throw new Error("more than 256 colours");
        index = palette.size;
        palette.set(key, index);
      }
      px[i] = index;
    }
    return px;
  });
  let bits = 1;
  while (1 << bits < palette.size) bits++;
  const bytes = [];
  const u16 = (n) => [n & 255, n >> 8];
  bytes.push(...Buffer.from("GIF89a"), ...u16(width), ...u16(height));
  bytes.push(0x80 | (bits - 1), 0, 0);
  const table = new Array((1 << bits) * 3).fill(0);
  for (const [key, index] of palette) {
    table[index * 3] = (key >> 16) & 255;
    table[index * 3 + 1] = (key >> 8) & 255;
    table[index * 3 + 2] = key & 255;
  }
  bytes.push(...table);
  bytes.push(0x21, 0xff, 11, ...Buffer.from("NETSCAPE2.0"), 3, 1, 0, 0, 0); // loop forever

  let previous;
  frames.forEach(({ delayMs }, f) => {
    const px = indexed[f];
    // Bounding box of what changed since the last frame
    let x0 = width,
      y0 = height,
      x1 = -1,
      y1 = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!previous || previous[y * width + x] !== px[y * width + x]) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) x0 = y0 = x1 = y1 = 0; // identical: one pixel keeps the delay
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    const part = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        part[y * w + x] = px[(y0 + y) * width + x0 + x];
    const minBits = Math.max(2, bits);
    bytes.push(
      0x21,
      0xf9,
      4,
      0x04,
      ...u16(Math.max(2, Math.round(delayMs / 10))),
      0,
      0,
    ); // keep the previous frame
    bytes.push(0x2c, ...u16(x0), ...u16(y0), ...u16(w), ...u16(h), 0);
    bytes.push(minBits, ...subBlocks(lzw(part, minBits)));
    previous = px;
  });
  bytes.push(0x3b);
  return Buffer.from(bytes);
}

// ---------------------------------------------------------------------------------------------------------------
// Running an example and looking at its monitor

class Scene {
  constructor(example, monitors, timeScale) {
    this.manager = new SessionManager(config);
    this.session = this.manager.create(
      monitors,
      timeScale,
      world(`examples/${example}.world.json`),
    );
    this.handle = this.session.handle;
    this.raw = this.handle.session;
    this.example = example;
  }

  async start(args = "") {
    await this.raw.waitForText(">", 0, 30000);
    this.raw.typeLine(`examples/${this.example}${args}`);
    await sleep(500);
  }

  frame(peripheral = "top") {
    let found;
    for (const w of this.raw.allWindows())
      if (w.peripheral === peripheral && w.frame) found = w;
    return found?.frame;
  }

  image(peripheral = "top") {
    const frame = this.frame(peripheral);
    return frame && renderFrame(frame, { scale: SCALE, cursor: false });
  }

  text(peripheral = "top") {
    const frame = this.frame(peripheral);
    if (!frame) return "";
    const rows = [];
    for (let y = 0; y < frame.height; y++)
      rows.push(
        Buffer.from(
          frame.text.subarray(y * frame.width, (y + 1) * frame.width),
        ).toString("latin1"),
      );
    return rows.join("\n");
  }

  async sim(command) {
    await sendAndWait(this.handle, command);
  }

  async waitFor(condition, limitMs = 60000) {
    const end = Date.now() + limitMs;
    while (!condition()) {
      if (Date.now() > end)
        throw new Error(`timed out waiting for ${condition}\n${this.text()}`);
      await sleep(TICK_MS / 2);
    }
  }

  async close() {
    await this.manager.destroyAll();
  }
}

function savePng(name, image) {
  writeFileSync(join(OUT, name), encodePng(image));
  console.log("wrote", name, `${image.width}x${image.height}`);
}

// ---------------------------------------------------------------------------------------------------------------
// The GIF: the reactor controller, from running through the scram to the restart

async function reactor() {
  const scene = new Scene(
    "mekanism/reactor",
    [{ name: "top", blocksWide: 4, blocksHigh: 3 }],
    5,
  );
  const frames = [];
  let last = "";
  let sinceChange = 0;
  const grab = () => {
    const image = scene.image();
    if (!image) return;
    const key = Buffer.from(image.rgba).toString("base64");
    if (key === last) {
      sinceChange++;
      return;
    }
    if (frames.length)
      frames[frames.length - 1].delayMs = Math.min(
        1500,
        Math.max(150, sinceChange * TICK_MS),
      );
    frames.push({ image, delayMs: TICK_MS });
    last = key;
    sinceChange = 1;
  };
  const watch = async (condition, limitMs = 90000) => {
    const end = Date.now() + limitMs;
    while (!condition()) {
      if (Date.now() > end) throw new Error("timed out\n" + scene.text());
      grab();
      await sleep(TICK_MS);
    }
    grab();
  };
  const hold = async (ticks) => {
    for (let i = 0; i < ticks; i++) {
      grab();
      await sleep(TICK_MS);
    }
  };
  try {
    await scene.start();
    await scene.waitFor(() => scene.text().includes("RUNNING"));
    await hold(6);
    await watch(() => scene.text().includes("SCRAMMED"));
    savePng("reactor-scram.png", scene.image());
    await hold(15);
    await scene.sim({
      cmd: "mekAddTank",
      multiblock: "reactor",
      tank: "coolant",
      amount: 2000000,
    });
    await watch(
      () => Number(/TEMP\s+(\d+) K/.exec(scene.text())?.[1] ?? 9999) <= 520,
    );
    await hold(8);
    const h = scene.frame().height;
    scene.raw.touchMonitor("top", 3, h);
    await watch(() => scene.text().includes("RUNNING"), 15000);
    await hold(15);
    frames[frames.length - 1].delayMs = 2500;
  } finally {
    await scene.close();
  }
  const gif = encodeGif(frames);
  writeFileSync(join(OUT, "demo.gif"), gif);
  console.log(
    "wrote demo.gif",
    frames.length,
    "frames,",
    (gif.length / 1024).toFixed(0),
    "KiB",
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Stills

async function trainBoard() {
  const scene = new Scene(
    "create/train_board",
    [{ name: "top", blocksWide: 6, blocksHigh: 2 }],
    20,
  );
  try {
    await scene.start();
    await scene.waitFor(() => scene.text().includes("NO TRAIN"));
    await scene.sim({
      cmd: "createTrainApproach",
      train: "Harvest",
      station: "Central",
      distance: 300,
    });
    await scene.waitFor(
      () =>
        scene.text().includes("EXPECTED") || scene.text().includes("ARRIVING"),
    );
    await scene.sim({ cmd: "advance", seconds: 25 });
    await scene
      .waitFor(() => scene.text().includes("ARRIVING"), 20000)
      .catch(() => {});
    await sleep(400);
    savePng("train-board.png", scene.image());
  } finally {
    await scene.close();
  }
}

async function gpuDemo() {
  const scene = new Scene("toms-peripherals/gpu_demo", [], 1);
  try {
    await scene.start();
    await scene.waitFor(() => pixelScreens(scene.handle.resultsDir).length > 0);
    await sleep(2500);
    await scene.sim({ cmd: "tmTouch", x: 70, y: 90 });
    await sleep(350);
    await scene.sim({ cmd: "tmTouch", x: 190, y: 60 });
    await sleep(450);
    // the GPU rewrites the file every frame: try again if it was caught half written
    let screens = pixelScreens(scene.handle.resultsDir);
    for (let tries = 0; screens.length === 0 && tries < 50; tries++) {
      await sleep(20);
      screens = pixelScreens(scene.handle.resultsDir);
    }
    writeFileSync(join(OUT, "gpu-demo.png"), pixelScreenPng(screens[0], 3));
    console.log(
      "wrote gpu-demo.png",
      `${screens[0].width * 3}x${screens[0].height * 3}`,
    );
  } finally {
    await scene.close();
  }
}

async function powerMonitor() {
  const scene = new Scene(
    "power/power_monitor",
    [{ name: "top", blocksWide: 4, blocksHigh: 3 }],
    6,
  );
  try {
    await scene.start();
    await scene.waitFor(() => scene.text().includes("FE/t"));
    await scene.waitFor(
      () => /TOTAL\s+\d/.test(scene.text()) && /empty in/.test(scene.text()),
    );
    await sleep(2500);
    savePng("power-monitor.png", scene.image());
  } finally {
    await scene.close();
  }
}

await reactor();
await trainBoard();
await gpuDemo();
await powerMonitor();
