#!/usr/bin/env node
// Makes the showcase videos: real gameplay from the example games, recorded from the emulator's monitors and
// encoded with ffmpeg.
//
//   npm run build && node scripts/make-showcase.mjs [--out dir] [--only id,id] [--no-sizzle] [--keep] [--recut]
//
// --only blightmare records the BLIGHTMARE scenes and cuts blightmare.mp4. --keep leaves the recordings in <out>/.work,
// and --recut cuts again from those without recording.
//
// Output (default docs/media/showcase/): one MP4 and GIF per highlight (board-arcade, action-snake, versus-paddle),
// the sizzle reel (sizzle.mp4), and a PNG still per game.
//
// How it works. Each scene in SCENES below starts one or two computers in the emulator (a game cabinet from
// workspace/examples/games/ on a 6x6 monitor wall) with a driver program from scripts/showcase/ beside it. The driver
// plays the game with real monitor_touch events (the menus, then the game, using the game's own bot or computer player
// to pick moves) and notes every tap and the moments to start, take a still and stop in /events.log. This script
// samples the monitors at a steady 30 frames a second of wall-clock time (the games run in real time, so what is
// sampled is what a player would see), draws a ring where every tap lands, and pipes the frames to ffmpeg, which
// scales, adds a caption and encodes H.264. The drivers pace themselves in the computer's own time, so a busy machine
// only costs a few repeated frames, never a speed-up or a stutter in the game.
//
// Needs ffmpeg: set FFMPEG, or have it on the PATH, or install it with winget (Gyan.FFmpeg).

import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager, checkConfig, loadConfig } from "@craftos-mcp/runner";
import { encodePng, renderFrame } from "@craftos-mcp/rawterm";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const OUT = resolve(option("out") ?? join(ROOT, "docs", "media", "showcase"));
const ONLY = option("only")?.split(",");

const FPS = 30;
const BG = "0x0d0f14";
const CELL_W = 6;
const CELL_H = 9;
const MARGIN = 2;
const DRIVERS = join(ROOT, "scripts", "showcase");
const GAMES = join(ROOT, "workspace", "examples", "games");

// ---------------------------------------------------------------------------------------------------------------
// The scenes

/**
 * kind: "board" (one cabinet, the left of two walls), "action" (one cabinet) or "versus" (two computers, side by side).
 * seconds: how long the driver plays after the game starts. clip: [start, length] in seconds, the part the sizzle
 * reel uses. publish: a file name; the scene is also saved as its own video. gif: [start, length] for the GIF.
 * title and caption: the bars around the picture.
 */
const SCENES = [
  {
    id: "board-reversi",
    kind: "board",
    game: "reversi",
    publish: "board-arcade",
    title: "BOARD ARCADE  -  Reversi",
    caption:
      "Eight two-player board games on touch monitors, plain CC:Tweaked, running in the emulator",
    seconds: 16,
    stillAt: 11,
    clip: [0.5, 5.5],
    gif: [0, 14],
  },
  {
    id: "board-checkers",
    kind: "board",
    game: "checkers",
    title: "BOARD ARCADE  -  Checkers",
    caption:
      "Tap a piece, then where it goes: forced jumps, kings, a computer opponent",
    seconds: 9,
    stillAt: 6,
    clip: [0.5, 4.5],
  },
  {
    id: "board-fourinarow",
    kind: "board",
    game: "fourinarow",
    title: "BOARD ARCADE  -  Four in a Row",
    caption: "Three computer levels, hints, replays and sounds in every game",
    seconds: 9,
    stillAt: 6,
    clip: [0.5, 4.5],
  },
  {
    // a still only: Snake moves too slowly to make a lively clip, so Blocks is the action highlight
    id: "action-snake",
    kind: "action",
    game: "snake",
    title: "ACTION ARCADE  -  Snake",
    caption:
      "Real-time touch games at 10 steps a second, steered by tapping the wall",
    seconds: 16,
    stillAt: 12,
  },
  {
    id: "action-blocks",
    kind: "action",
    game: "blocks",
    publish: "action-blocks",
    title: "ACTION ARCADE  -  Blocks",
    caption: "Tap a column to aim the piece, tap beside the well to turn it",
    seconds: 22,
    stillAt: 14,
    clip: [4, 5],
    gif: [0, 14],
  },
  {
    id: "action-bricks",
    kind: "action",
    game: "bricks",
    title: "ACTION ARCADE  -  Bricks",
    caption: "Tap anywhere and the paddle slides there",
    seconds: 10,
    stillAt: 7,
    clip: [0.5, 4],
  },
  {
    id: "action-lander",
    kind: "action",
    game: "lander",
    title: "ACTION ARCADE  -  Lander",
    caption: "Tilt, thrust, and touch down on a pad before the fuel runs out",
    // a still only: a whole descent and landing takes about 45 s at the game's own pace, too long for the reel
    seconds: 10,
    stillAt: 7,
  },
  {
    id: "action-mines",
    kind: "action",
    game: "mines",
    title: "ACTION ARCADE  -  Mines",
    caption: "Dig, flag, clear the board",
    seconds: 10,
    stillAt: 7,
    clip: [0.5, 4],
  },
  {
    id: "versus-paddle",
    kind: "versus",
    game: "paddle",
    publish: "versus-paddle",
    title: "VERSUS  -  Paddle  (3x speed)",
    caption:
      "Two computers, two monitor walls, one match over wireless modems and rednet",
    timeScale: 3, // a match to 3-2 takes a couple of minutes at the game's own speed; this plays it at triple
    seconds: 90,
    expect: "final 3-2",
    stillAt: 14,
    clip: [3, 5],
    gif: [0, 14],
  },
  {
    id: "versus-trails",
    kind: "versus",
    game: "trails",
    title: "VERSUS  -  Trails",
    caption:
      "Both walls run the same game in step: only the taps cross the network",
    seconds: 13,
    stillAt: 9,
    clip: [4.5, 5],
  },
];

/**
 * BLIGHTMARE (workspace/examples/games/blightmare/): one scene a moment of the story, each played by touch from a saved
 * game the driver writes first (scripts/showcase/blightmare.lua). They are recorded bare, at twice the pixels, and the
 * reel below cuts them into one video with its own captions. The driver marks moments ("at fight"); a reel clip starts
 * at one. still: the picture saved (at the scene's stillAt) as docs/media/showcase/<still>.png.
 */
const BLIGHTMARE = [
  {
    id: "bm-opening",
    scene: "opening",
    pages: 5,
    pageTime: 3.4,
    stillAt: 5,
    still: "blightmare-opening",
  },
  {
    id: "bm-town",
    scene: "town",
    seconds: 150,
    stillAt: 26,
    still: "blightmare-town",
  },
  {
    id: "bm-battle",
    scene: "battle",
    seconds: 110,
    stillAt: 4,
    still: "blightmare-battle",
    battlePace: 0.85,
  },
  {
    id: "bm-boss",
    scene: "boss",
    seconds: 170,
    stillAt: 16,
    still: "blightmare-boss",
  },
  { id: "bm-dream", scene: "dream", seconds: 110 },
].map((s) => ({
  ...s,
  kind: "blightmare",
  raw: true,
  scale: 2,
  seconds: s.seconds ?? 40,
}));
SCENES.push(...BLIGHTMARE);

/**
 * The BLIGHTMARE reel (blightmare.mp4): clips from those scenes, each from a mark, with a caption under it, and title
 * cards. at: the mark the clip starts from (and offset seconds after it); length in seconds.
 */
const BLIGHTMARE_REEL = [
  {
    card: "BLIGHTMARE",
    sub: "A dark first-person RPG for one monitor wall",
    seconds: 2.6,
  },
  {
    clip: "bm-opening",
    at: "intro",
    offset: 0,
    length: 9,
    caption: "An animated opening: the gods, the plague and the wall",
  },
  {
    clip: "bm-town",
    at: "world",
    offset: 0.8,
    length: 4.8,
    caption: "Tap the map and the party walks there",
  },
  {
    clip: "bm-town",
    at: "walking",
    offset: 0,
    length: 8,
    caption: "Towns to walk in first person, a step a tap",
  },
  {
    clip: "bm-town",
    at: "choice2",
    offset: -1.5,
    length: 8,
    caption: "People to talk to, and answers to choose",
  },
  {
    clip: "bm-battle",
    at: "battle",
    offset: 0,
    length: 21,
    until: "won",
    tail: 0.8,
    caption: "Turn-based fights: spells, items, the gauges filling",
  },
  {
    clip: "bm-boss",
    at: "fight",
    offset: -3,
    length: 16,
    caption: "Bosses with phases, from the last acts of the story",
  },
  {
    clip: "bm-boss",
    at: "telegraph",
    offset: -1,
    length: 7,
    caption: "A foe that flashes !!! is winding up: DEFEND",
  },
  {
    clip: "bm-dream",
    at: "dream",
    offset: -6.5,
    length: 13,
    caption: "Late in the story, the hero lies down and goes under",
  },
  {
    clip: "bm-dream",
    at: "dream walk",
    offset: -4,
    length: 4,
    caption: "Eleven acts of story, saved as you go",
  },
  {
    card: "BLIGHTMARE",
    sub: "Runs on plain CC:Tweaked: monitors, a speaker, nothing else",
    seconds: 3.4,
  },
];

/** The sizzle reel: title cards and clips from the scenes, in order. */
const SIZZLE = [
  {
    card: "CraftOS emulator",
    sub: "Real games, running headless. Nothing here is mocked up.",
    seconds: 2.4,
  },
  {
    card: "Board arcade",
    sub: "Eight two-player games on touch monitors",
    seconds: 1.5,
  },
  { clip: "board-reversi" },
  { clip: "board-checkers" },
  { clip: "board-fourinarow" },
  {
    card: "Action arcade",
    sub: "Real-time games steered by taps",
    seconds: 1.5,
  },
  { clip: "action-blocks" },
  { clip: "action-bricks" },
  { clip: "action-mines" },
  { card: "Versus", sub: "Two computers, two walls, one match", seconds: 1.5 },
  { clip: "versus-paddle" },
  { clip: "versus-trails" },
  {
    card: "Plain CC:Tweaked",
    sub: "Run it, test it and record it from the emulator",
    seconds: 2.4,
  },
];

// ---------------------------------------------------------------------------------------------------------------
// ffmpeg

function findFfmpeg() {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  const probe = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  if (!probe.error && probe.status === 0) return "ffmpeg";
  const winget = join(
    process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
    "Microsoft",
    "WinGet",
    "Packages",
  );
  if (existsSync(winget))
    for (const dir of readdirSync(winget).filter((d) => d.includes("FFmpeg"))) {
      const base = join(winget, dir);
      for (const sub of readdirSync(base)) {
        const exe = join(base, sub, "bin", "ffmpeg.exe");
        if (existsSync(exe)) return exe;
      }
    }
  throw new Error("ffmpeg not found: set FFMPEG to its path");
}
const FFMPEG = findFfmpeg();

const FONT_DIR =
  process.platform === "win32"
    ? "C\\:/Windows/Fonts"
    : "/usr/share/fonts/truetype/dejavu";
const FONT = process.platform === "win32" ? "segoeui.ttf" : "DejaVuSans.ttf";
const FONT_BOLD =
  process.platform === "win32" ? "segoeuib.ttf" : "DejaVuSans-Bold.ttf";

function ffmpeg(argv, cwd) {
  return spawn(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...argv], {
    cwd,
    stdio: ["pipe", "ignore", "pipe"],
  });
}

async function run(argv, cwd) {
  const proc = ffmpeg(argv, cwd);
  let err = "";
  proc.stderr.on("data", (d) => (err += d));
  const code = await new Promise((r) => proc.on("close", r));
  if (code !== 0) throw new Error(`ffmpeg ${argv.join(" ")}\n${err}`);
}

/** A drawtext filter. The text goes through a file so nothing needs escaping. */
function drawtext(work, name, text, { size, bold, color, x, y }) {
  const file = `${name}.txt`;
  writeFileSync(join(work, file), text);
  const font = `${FONT_DIR}/${bold ? FONT_BOLD : FONT}`;
  return `drawtext=fontfile='${font}':textfile=${file}:fontcolor=${color}:fontsize=${size}:x=${x}:y=${y}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Picture layout: the monitors, a title bar above them, a caption below

const MONITOR_W = 121 * CELL_W + MARGIN * 2;
const MONITOR_H = 81 * CELL_H + MARGIN * 2;
const GAP = 28;
const TOP = 52;
const CANVAS_H = TOP + MONITOR_H + 95;
const SINGLE_W = 1000;
const VERSUS_W = MONITOR_W * 2 + GAP + 72;
const CANVAS_W = (scene) => (scene.kind === "versus" ? VERSUS_W : SINGLE_W);

function cardFilters(work, scene) {
  const id = scene.id;
  const filters = [];
  const cw = CANVAS_W(scene);
  const width = scene.kind === "versus" ? MONITOR_W * 2 + GAP : MONITOR_W;
  filters.push(`pad=${cw}:${CANVAS_H}:${(cw - width) / 2}:${TOP}:color=${BG}`);
  filters.push(
    drawtext(work, `${id}-title`, scene.title, {
      size: 30,
      bold: true,
      color: "white",
      x: "(w-text_w)/2",
      y: 8,
    }),
  );
  filters.push(
    drawtext(work, `${id}-caption`, scene.caption, {
      size: scene.kind === "versus" ? 26 : 22,
      color: "0xb8c0d0",
      x: "(w-text_w)/2",
      y: TOP + MONITOR_H + 30,
    }),
  );
  if (scene.kind === "versus") {
    const left = (cw - width) / 2;
    filters.push(
      drawtext(work, `${id}-labelA`, "COMPUTER A  (player 1)", {
        size: 18,
        color: "0x8fd0ff",
        x: left + 6,
        y: TOP + MONITOR_H + 6,
      }),
      drawtext(work, `${id}-labelB`, "COMPUTER B  (player 2)", {
        size: 18,
        color: "0xffb87a",
        x: left + MONITOR_W + GAP + 6,
        y: TOP + MONITOR_H + 6,
      }),
    );
  }
  filters.push("format=yuv420p");
  return filters;
}

// ---------------------------------------------------------------------------------------------------------------
// Recording one scene

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Draw a ring where a tap landed. age is milliseconds since the tap. */
function drawTap(rgba, width, height, cx, cy, age) {
  const t = Math.min(1, age / 450);
  const radius = 7 + t * 17;
  const thick = Math.max(1, Math.round(4 - t * 3));
  const reach = Math.ceil(radius + thick);
  for (
    let y = Math.max(0, cy - reach);
    y <= Math.min(height - 1, cy + reach);
    y++
  )
    for (
      let x = Math.max(0, cx - reach);
      x <= Math.min(width - 1, cx + reach);
      x++
    ) {
      const d = Math.hypot(x - cx, y - cy);
      const ring = Math.abs(d - radius) <= thick / 2 + 0.4;
      const dot = age < 160 && d <= 4;
      if (!ring && !dot) continue;
      const o = (y * width + x) * 4;
      rgba[o] = 255;
      rgba[o + 1] = 232;
      rgba[o + 2] = 64;
      rgba[o + 3] = 255;
    }
}

/** An image with every pixel made a k x k block. */
function upscale(img, k) {
  if (k === 1) return img;
  const width = img.width * k;
  const height = img.height * k;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const from = (Math.floor(y / k) * img.width + Math.floor(x / k)) * 4;
      rgba.set(img.rgba.subarray(from, from + 4), (y * width + x) * 4);
    }
  return { width, height, rgba };
}

function frameOf(computer, peripheral) {
  let found;
  for (const w of computer.handle.session.allWindows())
    if (w.peripheral === peripheral && w.frame) found = w;
  return found?.frame;
}

function terminalText(computer) {
  const lines = [];
  for (const w of computer.handle.session.allWindows()) {
    const f = w.frame;
    if (!f || w.peripheral) continue;
    for (let y = 0; y < f.height; y++)
      lines.push(
        Buffer.from(f.text.subarray(y * f.width, (y + 1) * f.width))
          .toString("latin1")
          .trimEnd(),
      );
  }
  return lines.filter(Boolean).slice(-12).join("\n");
}

async function recordScene(scene, config, scratch, work) {
  const folder = scene.kind;
  const sourceDir = join(GAMES, folder);
  const worldFile = {
    board: "arcade.world.json",
    action: "action.world.json",
    versus: "versus.world.json",
    blightmare: "blightmare.world.json",
  }[folder];
  const { monitors: worldMonitors, ...world } = JSON.parse(
    readFileSync(join(sourceDir, worldFile), "utf8"),
  );
  const monitors =
    folder === "board"
      ? [
          { name: "left", blocksWide: 6, blocksHigh: 6 },
          { name: "right", blocksWide: 6, blocksHigh: 6 },
        ]
      : worldMonitors;
  const screenName = folder === "board" ? "left" : "top";
  const names = folder === "versus" ? ["north", "south"] : ["north"];

  const cfg = JSON.stringify({ ...scene });
  const dirs = names.map((name) => {
    const dir = join(scratch, `${scene.id}-${name}`);
    rmSync(dir, { recursive: true, force: true }); // a fresh take
    const game = join(dir, "examples", "games", folder);
    cpSync(sourceDir, game, { recursive: true });
    copyFileSync(join(DRIVERS, "events.lua"), join(dir, "showcase-events.lua"));
    writeFileSync(join(dir, "showcase.json"), cfg);
    const driver =
      name === "south"
        ? `dofile("/showcase-events.lua")\nshell.run("examples/games/${folder}/peer.lua")\n`
        : `dofile("/showcase-events.lua")\nshell.run("examples/games/${folder}/showcase.lua")\n`;
    if (name !== "south")
      copyFileSync(join(DRIVERS, `${folder}.lua`), join(game, "showcase.lua"));
    writeFileSync(join(dir, "startup.lua"), driver);
    return dir;
  });

  const manager = new SessionManager(config);
  try {
    const { computers } = manager.createNetwork({
      timeScale: scene.timeScale ?? 1,
      computers: names.map((name, i) => ({
        name,
        world: {
          ...world,
          computerId: i + 1,
          seed: i + 1,
          position: { x: i * 10, y: 70, z: 0 },
        },
        monitors,
        workspaceDir: dirs[i],
      })),
    });
    const sides = names.map((name) => computers[name]);
    // the computer runs on a copy of its folder: its files are beside the results directory
    const logs = sides.map((s, i) =>
      join(
        dirname(s.handle.resultsDir),
        "computer",
        String(i + 1),
        "events.log",
      ),
    );
    const read = (i) =>
      existsSync(logs[i])
        ? readFileSync(logs[i], "utf8").split(/\r?\n/).filter(Boolean)
        : [];

    // wait for the driver's "go"
    const bootEnd = Date.now() + 120000;
    while (!read(0).includes("go")) {
      if (Date.now() > bootEnd)
        throw new Error(
          `${scene.id}: the driver never started\n${terminalText(sides[0])}`,
        );
      await sleep(50);
    }

    const sideW = MONITOR_W;
    const width = sides.length * sideW + (sides.length - 1) * GAP;
    const frameBytes = width * MONITOR_H * 4;
    const video = join(work, `${scene.id}.mp4`);
    // a bare scene is only the wall, its pixels doubled (each one a 2x2 block, so the text stays sharp): a reel adds
    // the bars
    const filters = scene.raw
      ? [
          `scale=iw*${scene.scale ?? 1}:ih*${scene.scale ?? 1}:flags=neighbor`,
          "format=yuv420p",
        ]
      : cardFilters(work, scene);
    writeFileSync(join(work, `${scene.id}.filter`), filters.join(",\n"));
    const proc = ffmpeg(
      [
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgba",
        "-s",
        `${width}x${MONITOR_H}`,
        "-r",
        String(FPS),
        "-i",
        "-",
        "-filter_script:v",
        `${scene.id}.filter`,
        "-c:v",
        "libx264",
        "-preset",
        "slow",
        "-crf",
        "21",
        "-r",
        String(FPS),
        "-movflags",
        "+faststart",
        video,
      ],
      work,
    );
    let ffErr = "";
    proc.stderr.on("data", (d) => (ffErr += d));
    const closed = new Promise((r) => proc.on("close", r));
    proc.stdin.on("error", () => {});
    let ffExited = false;
    closed.then(() => (ffExited = true));

    const frame = Buffer.alloc(frameBytes);
    const taps = []; // { side, x, y, at }
    const seen = names.map(() => 0);
    let stillSaved = 0;
    let finished = 0;
    const notes = [];
    const marks = {}; // the driver's "at <name>": seconds into the video
    let playAt = 0; // seconds into the video when the game itself starts
    let started = Date.now();
    let written = 0;
    const limit = started + (scene.seconds + 60) * 1000;
    const bg = [0x0d, 0x0f, 0x14];

    const compose = (withTaps) => {
      frame.fill(0);
      sides.forEach((computer, i) => {
        const f = frameOf(computer, screenName);
        if (!f) return;
        const img = renderFrame(f, { scale: 1, cursor: false });
        for (let y = 0; y < img.height && y < MONITOR_H; y++) {
          const from = y * img.width * 4;
          const to = (y * width + i * (sideW + GAP)) * 4;
          frame.set(
            img.rgba.subarray(from, from + Math.min(img.width, sideW) * 4),
            to,
          );
        }
      });
      if (withTaps) {
        const now = Date.now();
        for (const tap of taps) {
          const age = now - tap.at;
          if (age > 450) continue;
          drawTap(
            frame,
            width,
            MONITOR_H,
            tap.side * (sideW + GAP) +
              MARGIN +
              Math.round((tap.x - 0.5) * CELL_W),
            MARGIN + Math.round((tap.y - 0.5) * CELL_H),
            age,
          );
        }
      }
    };

    started = Date.now();
    while (true) {
      const now = Date.now();
      // new log lines
      for (let i = 0; i < sides.length; i++) {
        const lines = read(i);
        for (; seen[i] < lines.length; seen[i]++) {
          const line = lines[seen[i]];
          if (i === 0 && line === "still") {
            compose(false);
            const png = encodePng(
              upscale(
                { width, height: MONITOR_H, rgba: new Uint8Array(frame) },
                scene.raw ? (scene.scale ?? 1) : 1,
              ),
            );
            writeFileSync(join(work, `${scene.id}.png`), png);
            stillSaved++;
          } else if (i === 0 && line.startsWith("at ")) {
            marks[line.slice(3)] ??= written / FPS;
          } else if (i === 0 && line === "play") {
            playAt = written / FPS;
          } else if (i === 0 && line === "done" && !finished) {
            finished = now;
          } else if (line.startsWith("note ")) {
            notes.push(line.slice(5));
            if (process.env.SHOWCASE_DEBUG) console.log(scene.id, line);
          } else if (line.startsWith("tap ")) {
            const [, mon, x, y] = line.split(" ");
            // a board's second wall shows the same picture: only the first wall is on screen
            if (folder === "board" && mon !== "left") continue;
            // a paddle that is followed with a tap every few frames gets one ring a fifth of a second, not a smear
            const lastTap = taps.findLast((t) => t.side === i);
            if (lastTap && now - lastTap.at < 220) continue;
            taps.push({ side: i, x: Number(x), y: Number(y), at: now });
          }
        }
      }
      if (finished && now - finished > 1200) break;
      if (ffExited) throw new Error(`${scene.id}: ffmpeg stopped\n${ffErr}`);
      if (now > limit)
        throw new Error(`${scene.id}: ran too long\n${terminalText(sides[0])}`);
      // one frame for every 1/30 s of wall clock that has passed
      const due = Math.floor(((now - started) * FPS) / 1000) + 1;
      if (due > written) {
        compose(true);
        while (written < due) {
          if (!proc.stdin.write(frame)) {
            await Promise.race([
              new Promise((r) => proc.stdin.once("drain", r)),
              closed,
            ]);
            if (ffExited) break;
          }
          written++;
        }
      }
      await sleep(4);
    }
    proc.stdin.end();
    const code = await closed;
    if (code !== 0) throw new Error(`${scene.id}: ffmpeg failed\n${ffErr}`);
    if (!stillSaved) console.warn(`${scene.id}: no still was marked`);
    console.log(
      `recorded ${scene.id}: ${(written / FPS).toFixed(1)} s, ${taps.length} taps`,
    );
    if (Object.keys(marks).length)
      console.log(
        `  marks: ${Object.entries(marks)
          .map(([k, v]) => `${k} ${v.toFixed(1)}`)
          .join(", ")}`,
      );
    return { video, seconds: written / FPS, playAt, notes, marks };
  } finally {
    await manager.destroyAll();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// GIFs and the sizzle

const size = (file) => statSync(file).size;
const mb = (n) => (n / 1048576).toFixed(2) + " MB";

/** A GIF from a finished video: the widest and smoothest of a few settings that comes in under the limit. */
async function makeGif(scene, video, out, work, limit = 3 * 1048576) {
  const [start, length] = scene.gif ?? [0, 12];
  const tries = [
    [800, 20],
    [720, 15],
    [640, 15],
    [560, 15],
    [480, 15],
    [480, 12],
    [420, 12],
    [360, 10],
    [320, 10],
  ];
  for (const [w, fps] of tries) {
    const filter =
      `fps=${fps},scale=${w}:-1:flags=area,split[a][b];` +
      `[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`;
    await run(
      [
        "-ss",
        String(start),
        "-t",
        String(length),
        "-i",
        video,
        "-filter_complex",
        filter,
        out,
      ],
      work,
    );
    if (size(out) <= limit) {
      console.log(`gif ${scene.publish}: ${w}px, ${fps} fps, ${mb(size(out))}`);
      return;
    }
  }
  console.warn(`gif ${scene.publish} is still ${mb(size(out))}`);
}

async function makeSizzle(results, out, work) {
  const parts = [];
  const encode = [
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    "21",
    "-r",
    String(FPS),
    "-pix_fmt",
    "yuv420p",
  ];
  let n = 0;
  for (const item of SIZZLE) {
    const file = join(work, `sizzle-${String(n++).padStart(2, "0")}.mp4`);
    if (item.card) {
      writeFileSync(join(work, `card-${n}-a.txt`), item.card);
      writeFileSync(join(work, `card-${n}-b.txt`), item.sub);
      const font = (b) => `${FONT_DIR}/${b ? FONT_BOLD : FONT}`;
      const filter = [
        `drawtext=fontfile='${font(true)}':textfile=card-${n}-a.txt:fontcolor=white:fontsize=84:x=(w-text_w)/2:y=(h-text_h)/2-50`,
        `drawtext=fontfile='${font(false)}':textfile=card-${n}-b.txt:fontcolor=0xb8c0d0:fontsize=34:x=(w-text_w)/2:y=(h/2)+50`,
        `fade=t=in:st=0:d=0.3`,
        `fade=t=out:st=${item.seconds - 0.3}:d=0.3`,
        "format=yuv420p",
      ].join(",");
      await run(
        [
          "-f",
          "lavfi",
          "-i",
          `color=c=${BG}:s=${VERSUS_W}x${CANVAS_H}:r=${FPS}:d=${item.seconds}`,
          "-vf",
          filter,
          ...encode,
          file,
        ],
        work,
      );
    } else {
      const scene = SCENES.find((s) => s.id === item.clip);
      const result = results.get(scene.id);
      if (!result) continue;
      // clip starts count from the moment the game itself starts, so the menus are skipped
      const [offset, length] = scene.clip;
      const start = result.playAt + offset;
      const cw = CANVAS_W(scene);
      await run(
        [
          "-ss",
          String(start),
          "-t",
          String(length),
          "-i",
          result.video,
          "-vf",
          `pad=${VERSUS_W}:${CANVAS_H}:${(VERSUS_W - cw) / 2}:0:color=${BG},fps=${FPS},format=yuv420p`,
          ...encode,
          file,
        ],
        work,
      );
    }
    parts.push(file);
  }
  const list = join(work, "sizzle.txt");
  writeFileSync(
    list,
    parts.map((p) => `file '${p.replace(/\\/g, "/")}'`).join("\n"),
  );
  await run(
    [
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      list,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      out,
    ],
    work,
  );
  console.log(`sizzle: ${mb(size(out))}`);
}

/**
 * The BLIGHTMARE reel: each clip cut from its scene at a mark, set on a canvas with the game's name above and the
 * clip's caption below, a short fade at each end; title cards between. Returns [{ what, start, length }] for the log.
 */
async function makeReel(results, reel, out, work) {
  const sample = results.get(BLIGHTMARE[0].id) ?? [...results.values()][0];
  const probe = spawnSync(
    FFMPEG.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1"),
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "csv=p=0",
      sample.video,
    ],
    { encoding: "utf8" },
  );
  const [vw, vh] = probe.stdout.trim().split(",").map(Number);
  const W = vw + 140;
  const TOP_H = 92;
  const H = TOP_H + vh + 150 + ((TOP_H + vh + 150) % 2);
  const encode = [
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    "20",
    "-r",
    String(FPS),
    "-pix_fmt",
    "yuv420p",
  ];
  const font = (b) => `${FONT_DIR}/${b ? FONT_BOLD : FONT}`;
  const parts = [];
  const log = [];
  let at = 0;
  for (const [n, item] of reel.entries()) {
    const file = join(work, `reel-${String(n).padStart(2, "0")}.mp4`);
    if (item.card) {
      writeFileSync(join(work, `reel-${n}-a.txt`), item.card);
      writeFileSync(join(work, `reel-${n}-b.txt`), item.sub);
      const filter = [
        `drawtext=fontfile='${font(true)}':textfile=reel-${n}-a.txt:fontcolor=0xE5484D:fontsize=150:x=(w-text_w)/2:y=(h-text_h)/2-70`,
        `drawtext=fontfile='${font(false)}':textfile=reel-${n}-b.txt:fontcolor=0xb8c0d0:fontsize=50:x=(w-text_w)/2:y=(h/2)+70`,
        `fade=t=in:st=0:d=0.4`,
        `fade=t=out:st=${item.seconds - 0.4}:d=0.4`,
        "format=yuv420p",
      ].join(",");
      await run(
        [
          "-f",
          "lavfi",
          "-i",
          `color=c=${BG}:s=${W}x${H}:r=${FPS}:d=${item.seconds}`,
          "-vf",
          filter,
          ...encode,
          file,
        ],
        work,
      );
      log.push({
        what: `card: ${item.card} - ${item.sub}`,
        start: at,
        length: item.seconds,
      });
      at += item.seconds;
    } else {
      // a clip whose scene wasn't recorded (--only) or never reached its mark is left out, and said so
      const result = results.get(item.clip);
      if (!result) {
        console.warn(`reel: ${item.clip} wasn't recorded, left out`);
        continue;
      }
      const mark = result.marks[item.at];
      if (mark === undefined) {
        console.warn(
          `reel: ${item.clip} has no mark "${item.at}" (it has ${Object.keys(result.marks).join(", ")})`,
        );
        continue;
      }
      const start = Math.max(0, mark + (item.offset ?? 0));
      // until: a mark the clip may stop at sooner (plus tail seconds after it), so a fight won quickly isn't padded
      const stop = item.until && result.marks[item.until];
      const length = Math.min(
        item.length,
        result.seconds - start,
        stop ? stop + (item.tail ?? 0) - start : Infinity,
      );
      writeFileSync(join(work, `reel-${n}-t.txt`), "BLIGHTMARE");
      writeFileSync(join(work, `reel-${n}-c.txt`), item.caption);
      const filter = [
        `pad=${W}:${H}:${(W - vw) / 2}:${TOP_H}:color=${BG}`,
        `drawtext=fontfile='${font(true)}':textfile=reel-${n}-t.txt:fontcolor=0xE5484D:fontsize=54:x=(w-text_w)/2:y=18`,
        `drawtext=fontfile='${font(false)}':textfile=reel-${n}-c.txt:fontcolor=0xd8dde8:fontsize=44:x=(w-text_w)/2:y=${TOP_H + vh + 48}`,
        `fade=t=in:st=0:d=0.25`,
        `fade=t=out:st=${length - 0.25}:d=0.25`,
        `fps=${FPS}`,
        "format=yuv420p",
      ].join(",");
      await run(
        [
          "-ss",
          String(start),
          "-t",
          String(length),
          "-i",
          result.video,
          "-vf",
          filter,
          ...encode,
          file,
        ],
        work,
      );
      log.push({
        what: `${item.clip} from "${item.at}": ${item.caption}`,
        start: at,
        length,
      });
      at += length;
    }
    parts.push(file);
  }
  const list = join(work, "reel.txt");
  writeFileSync(
    list,
    parts.map((p) => `file '${p.replace(/\\/g, "/")}'`).join("\n"),
  );
  await run(
    [
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      list,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      out,
    ],
    work,
  );
  console.log(`${out}: ${at.toFixed(1)} s, ${W}x${H}, ${mb(size(out))}`);
  for (const l of log)
    console.log(
      `  ${l.start.toFixed(1).padStart(6)} s  +${l.length.toFixed(1)}  ${l.what}`,
    );
  return log;
}

// ---------------------------------------------------------------------------------------------------------------

const config = loadConfig();
const problems = checkConfig(config);
if (problems.length) {
  console.error("The emulator is not ready:\n  " + problems.join("\n  "));
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "showcase-"));
const work = join(scratch, "work");
mkdirSync(work);
const keep = flag("keep");
const previous = join(OUT, ".work");

try {
  const chosen = SCENES.filter(
    (s) =>
      !ONLY ||
      ONLY.includes(s.id) ||
      (s.publish && ONLY.includes(s.publish)) ||
      (s.kind === "blightmare" && ONLY.includes("blightmare")),
  );
  // every scene at once: each is its own emulator process, and each is paced by its own computer's clock
  const results = new Map();
  const outcomes = await Promise.allSettled(
    chosen.map(async (scene) => {
      // a scene can say what it must end with (the driver's "note final 3-2"): another take if the game went elsewhere
      let result;
      // --recut: no recording, the videos and marks a run with --keep left in <out>/.work are cut again
      const kept = join(previous, `${scene.id}.json`);
      if (flag("recut") && existsSync(kept)) {
        result = JSON.parse(readFileSync(kept, "utf8"));
        copyFileSync(
          join(previous, `${scene.id}.mp4`),
          join(work, `${scene.id}.mp4`),
        );
        const png = join(previous, `${scene.id}.png`);
        if (existsSync(png)) copyFileSync(png, join(work, `${scene.id}.png`));
        result.video = join(work, `${scene.id}.mp4`);
        results.set(scene.id, result);
        return;
      }
      for (let take = 1; take <= 5; take++) {
        result = await recordScene(scene, config, scratch, work);
        if (!scene.expect || result.notes.includes(scene.expect)) break;
        console.log(
          `${scene.id}: take ${take} ended ${result.notes.at(-1)}, again`,
        );
      }
      writeFileSync(join(work, `${scene.id}.json`), JSON.stringify(result));
      results.set(scene.id, result);
    }),
  );
  outcomes.forEach((o, i) => {
    if (o.status === "rejected")
      console.error(`FAILED ${chosen[i].id}:`, o.reason?.message ?? o.reason);
  });

  for (const scene of chosen) {
    const result = results.get(scene.id);
    if (!result) continue;
    const still = join(work, `${scene.id}.png`);
    const stillName = scene.kind === "blightmare" ? scene.still : scene.id;
    if (stillName && existsSync(still))
      copyFileSync(still, join(OUT, `${stillName}.png`));
    if (scene.publish) {
      const mp4 = join(OUT, `${scene.publish}.mp4`);
      copyFileSync(result.video, mp4);
      console.log(
        `${scene.publish}.mp4: ${result.seconds.toFixed(1)} s, ${mb(size(mp4))}`,
      );
      await makeGif(
        scene,
        result.video,
        join(OUT, `${scene.publish}.gif`),
        work,
      );
    }
  }
  if (chosen.some((s) => s.kind === "blightmare")) {
    const reel = join(OUT, "blightmare.mp4");
    const log = await makeReel(results, BLIGHTMARE_REEL, reel, work);
    // the GIF: the fight, from where the reel's battle clip starts
    const battle = log.find((l) => l.what.startsWith("bm-battle"));
    await makeGif(
      { publish: "blightmare", gif: [battle ? battle.start : 20, 12] },
      reel,
      join(OUT, "blightmare.gif"),
      work,
    );
  }
  if (!flag("no-sizzle") && !ONLY)
    await makeSizzle(results, join(OUT, "sizzle.mp4"), work);
  if (keep) cpSync(work, previous, { recursive: true });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
