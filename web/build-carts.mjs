// Build the carts the browser player runs (web/README.md, "Carts"), from the examples in workspace/examples:
//
//   node web/build-carts.mjs [--no-shots] [--only <id,id>]
//
// For each cart: web/dist/carts/<id>.json (its computers: files, world.json as packages/runner computes it, boot
// script, monitors and layout; title, kind, controls, world buttons, source link) and <id>.png, a screenshot made by
// running the cart on the native engine with the runner (so the site's library has thumbnails; skipped when the cart
// has not changed since the last one). Then web/dist/carts/index.json lists them all. Needs the runner built
// (npm run build) and, for screenshots, the native engine and ROM (npm run setup).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WEB = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(WEB, "..");
const OUT = join(WEB, "dist", "carts");
const EXAMPLES = "workspace/examples";
const SOURCE_BASE = "https://github.com/Akkiruk/craftos-mcp/tree/main/";

const runnerDist = join(REPO, "packages", "runner", "dist", "index.js");
const rawtermDist = join(REPO, "packages", "rawterm", "dist", "index.js");
if (!existsSync(runnerDist)) {
  console.error("packages/runner is not built: npm run build");
  process.exit(1);
}
const runner = await import(pathToFileURL(runnerDist).href);
const rawterm = await import(pathToFileURL(rawtermDist).href);
const {
  worldJson,
  linkedWorlds,
  monitorSetupLua,
  enginePeripheralLua,
  luaString,
} = runner;

const args = process.argv.slice(2);
const noShots = args.includes("--no-shots");
const onlyArg = args[args.indexOf("--only") + 1];
const only = args.includes("--only") ? new Set(onlyArg.split(",")) : null;

// ---------------------------------------------------------------------------------------------------------------
// The carts
// ---------------------------------------------------------------------------------------------------------------

const readJson = (path) => JSON.parse(readFileSync(join(REPO, path), "utf8"));
/** A world file without its "monitors" (the tests pass those separately, as the player does) and "$schema". */
const worldOf = (path) => {
  const { monitors: _m, $schema: _s, ...world } = readJson(path);
  return world;
};
const monitorsOf = (path) => readJson(path).monitors ?? [];

const BOARD = `${EXAMPLES}/games/board`;
const ACTION = `${EXAMPLES}/games/action`;
const VERSUS = `${EXAMPLES}/games/versus`;
const BLIGHTMARE = `${EXAMPLES}/games/blightmare`;
const WALL = { blocksWide: 6, blocksHigh: 6 };

const BOARD_GAMES = [
  [
    "uttt",
    "Ultimate Tic-Tac-Toe",
    "Nine small boards in one: the square you pick sends your opponent to the matching board.",
  ],
  [
    "fourinarow",
    "Four in a Row",
    "Drop discs into seven columns; four in a line wins.",
  ],
  [
    "reversi",
    "Reversi",
    "Trap a line of the other colour to flip it; most discs wins.",
  ],
  [
    "checkers",
    "Checkers",
    "English draughts: forced jumps, multi-jumps, kings.",
  ],
  ["dots", "Dots and Boxes", "Draw lines, close a box to score and go again."],
  [
    "mancala",
    "Mancala",
    "Kalah rules: sow seeds anticlockwise, extra turns from your store, captures.",
  ],
  [
    "fleet",
    "Fleet",
    "Hide five ships, then take turns firing at each other's water. Two walls, one per player.",
  ],
  [
    "codebreaker",
    "Codebreaker",
    "Each hides a four-colour code, then both race to crack the other's. Two walls, one per player.",
  ],
];
const ACTION_GAMES = [
  ["snake", "Snake", "Eat, grow, don't bite yourself."],
  ["blocks", "Blocks", "Falling blocks: fill whole rows to clear them."],
  [
    "bricks",
    "Bricks",
    "Bounce the ball with the paddle and break every brick.",
  ],
  [
    "lander",
    "Lander",
    "Set the lander down gently on the pad before the fuel runs out.",
  ],
  ["mines", "Mines", "Clear the field without touching a mine."],
];
const VERSUS_GAMES = [
  ["paddle", "Paddle", "Two paddles, one ball, first to eleven."],
  [
    "trails",
    "Trails",
    "Two riders leaving walls behind them; crash and the other takes the round.",
  ],
  [
    "artillery",
    "Artillery",
    "Two tanks taking turns to shell each other over ground that craters.",
  ],
];

const TOUCH =
  "Tap the monitor wall to play: every button and board square is on the wall.";
const boardLauncher = (game, name) =>
  [
    "-- A cart of one game: the arcade cabinet (cabinet/main.lua) with only this game in its menu",
    "local dir = fs.getDir(shell.getRunningProgram())",
    `require("cabinet.main").run({ registry = { require("games.${game}.plugin") }, dir = dir, name = ${luaString(name)} })`,
  ].join("\n");
const listLauncher = (game, name) =>
  [
    "-- A cart of one game: the cabinet (lib/shell.lua) with only this game on it",
    "local root = fs.getDir(shell.getRunningProgram())",
    'package.path = "/" .. fs.combine(root, "?.lua") .. ";" .. package.path',
    `require("lib.shell").run({ root = root, name = ${luaString(name)}, games = { require("games.${game}.plugin") } })`,
  ].join("\n");

const versusComputers = (program, extraFiles) =>
  [
    ["North", 1, 0],
    ["South", 2, 10],
  ].map(([label, id, x]) => ({
    name: label.toLowerCase(),
    label,
    id,
    dir: VERSUS,
    files: extraFiles,
    world: {
      ...worldOf(`${VERSUS}/versus.world.json`),
      seed: id,
      position: { x, y: 70, z: 0 },
    },
    monitors: monitorsOf(`${VERSUS}/versus.world.json`),
    program,
    terminal: "hide",
    screens: ["monitor:top"],
  }));

const CARTS = [
  {
    id: "arcade",
    title: "Board Game Arcade",
    kind: "board",
    description:
      "Eight board games on one cabinet, for two people at the wall or one against the computer.",
    controls: TOUCH + " Fleet and Codebreaker use both walls, one per player.",
    source: `${BOARD}/`,
    computers: [
      {
        dir: BOARD,
        world: worldOf(`${BOARD}/arcade.world.json`),
        monitors: [
          { name: "left", ...WALL },
          { name: "right", ...WALL },
        ],
        program: "arcade",
        terminal: "hide",
        screens: ["monitor:left", "monitor:right"],
      },
    ],
  },
  ...BOARD_GAMES.map(([game, title, description]) => {
    const twoWalls = game === "fleet" || game === "codebreaker";
    return {
      id: game,
      title,
      kind: "board",
      description,
      controls:
        TOUCH +
        (twoWalls
          ? " Each player taps PLAYER in the lobby on their own wall."
          : " Play a friend at the same wall, or the computer (three levels)."),
      source: `${BOARD}/games/${game}/`,
      computers: [
        {
          dir: BOARD,
          files: { "play.lua": boardLauncher(game, title.toUpperCase()) },
          world: worldOf(`${BOARD}/arcade.world.json`),
          monitors: twoWalls
            ? [
                { name: "left", ...WALL },
                { name: "right", ...WALL },
              ]
            : [{ name: "left", ...WALL }],
          program: "play",
          terminal: "hide",
          screens: twoWalls
            ? ["monitor:left", "monitor:right"]
            : ["monitor:left"],
        },
      ],
    };
  }),
  {
    id: "classics",
    title: "Classics Cabinet",
    kind: "action",
    description:
      "Snake, Blocks, Bricks, Lander and Mines on one cabinet, for the high score.",
    controls:
      "Tap the wall to play; the arrow keys steer too (on a phone, use the keys under the screen).",
    source: `${ACTION}/`,
    keys: ["left", "up", "down", "right", "enter", "space"],
    computers: [
      {
        dir: ACTION,
        world: worldOf(`${ACTION}/action.world.json`),
        monitors: monitorsOf(`${ACTION}/action.world.json`),
        program: "action",
        terminal: "hide",
        screens: ["monitor:top"],
      },
    ],
  },
  ...ACTION_GAMES.map(([game, title, description]) => ({
    id: game,
    title,
    kind: "action",
    description,
    controls:
      "Tap the wall to play; the arrow keys steer too (on a phone, use the keys under the screen).",
    source: `${ACTION}/games/${game}/`,
    keys: ["left", "up", "down", "right", "enter", "space"],
    computers: [
      {
        dir: ACTION,
        files: { "play.lua": listLauncher(game, title.toUpperCase()) },
        world: worldOf(`${ACTION}/action.world.json`),
        monitors: monitorsOf(`${ACTION}/action.world.json`),
        program: "play",
        terminal: "hide",
        screens: ["monitor:top"],
      },
    ],
  })),
  {
    id: "versus",
    title: "Versus Cabinet",
    kind: "versus",
    description:
      "Paddle, Trails and Artillery head to head across two computers linked by wireless modems.",
    controls:
      "Pick a game on one wall and tap PLAY; tap the other wall to join. Each wall is one player.",
    source: `${VERSUS}/`,
    keys: ["left", "up", "down", "right"],
    computers: versusComputers("versus"),
  },
  ...VERSUS_GAMES.map(([game, title, description]) => ({
    id: `versus-${game}`,
    title: `${title} (Versus)`,
    kind: "versus",
    description: description + " Two computers over rednet.",
    controls:
      "Tap PLAY on one wall, then tap the other wall to join. Each wall is one player.",
    source: `${VERSUS}/games/${game}/`,
    keys: ["left", "up", "down", "right"],
    computers: versusComputers("play", {
      "play.lua": listLauncher(game, title.toUpperCase()),
    }),
  })),
  {
    id: "blightmare",
    title: "BLIGHTMARE",
    kind: "rpg",
    description:
      "A dark first-person RPG: a whole continent, towns and dungeons a square at a time, people to talk to, quests and turn-based fights. Plays on a 6x6 monitor wall.",
    controls:
      "Tap the wall: the top steps forward, the bottom back, the sides turn, the middle talks, opens and fights. The bar at the foot is the menu. Saves last until the page is reloaded.",
    source: `${BLIGHTMARE}/`,
    // the packed copy (install/, made by build.mjs): about a third of the plain source to download
    build: `${BLIGHTMARE}/build.mjs`,
    // card art: a still from the showcase, at half size (the size the other carts' screenshots are)
    still: "docs/media/showcase/blightmare-town.png",
    computers: [
      {
        dir: `${BLIGHTMARE}/install`,
        // startup.lua restarts the game after a crash; the cart's boot script starts it instead
        exclude: ["startup.lua"],
        world: worldOf(`${BLIGHTMARE}/blightmare.world.json`),
        monitors: monitorsOf(`${BLIGHTMARE}/blightmare.world.json`),
        program: "blightmare",
        terminal: "hide",
        screens: ["monitor:top"],
      },
    ],
  },
  {
    id: "reactor",
    title: "Fission Reactor Dashboard",
    kind: "demo",
    description:
      "A Mekanism fission reactor dashboard with an automatic scram on temperature, damage or full waste.",
    controls:
      "Drain the coolant and watch it scram; RESET on the monitor works once the reactor is safe again.",
    source: `${EXAMPLES}/mekanism/reactor.lua`,
    actions: [
      {
        label: "Drain coolant",
        command: {
          cmd: "mekAddTank",
          multiblock: "reactor",
          tank: "coolant",
          amount: -2000000,
        },
      },
      {
        label: "Add coolant",
        command: {
          cmd: "mekAddTank",
          multiblock: "reactor",
          tank: "coolant",
          amount: 2000000,
        },
      },
    ],
    computers: [
      {
        dir: `${EXAMPLES}/mekanism`,
        world: worldOf(`${EXAMPLES}/mekanism/reactor.world.json`),
        monitors: [{ name: "top", blocksWide: 3, blocksHigh: 2 }],
        program: "reactor",
        terminal: "hide",
        screens: ["monitor:top", "terminal"],
      },
    ],
  },
  {
    id: "train-board",
    title: "Train Departure Board",
    kind: "demo",
    description:
      "A departure board for every Create train station on the computer: who is at the platform, who is coming.",
    controls: "Bring a train in and send it off with the world buttons.",
    source: `${EXAMPLES}/create/train_board.lua`,
    actions: [
      {
        label: "Harvest approaches Central",
        command: {
          cmd: "createTrainApproach",
          train: "Harvest",
          station: "Central",
          distance: 300,
        },
      },
      {
        label: "Harvest arrives at Central",
        command: {
          cmd: "createTrainArrive",
          train: "Harvest",
          station: "Central",
        },
      },
      {
        label: "Harvest leaves",
        command: { cmd: "createTrainLeave", train: "Harvest" },
      },
    ],
    computers: [
      {
        dir: `${EXAMPLES}/create`,
        world: worldOf(`${EXAMPLES}/create/train_board.world.json`),
        monitors: [{ name: "top", blocksWide: 6, blocksHigh: 2 }],
        program: "train_board",
        terminal: "hide",
        screens: ["monitor:top", "terminal"],
      },
    ],
  },
  {
    id: "power-monitor",
    title: "Power Monitor",
    kind: "demo",
    description:
      "Fill bars, FE/t and an empty/full estimate for any energy storage block, with a low-power alarm.",
    controls: "Drain or fill the battery with the world buttons.",
    source: `${EXAMPLES}/power/power_monitor.lua`,
    actions: [
      {
        label: "Drain battery",
        command: { cmd: "setEnergy", peripheral: "battery_0", energy: 4000 },
      },
      {
        label: "Fill battery",
        command: { cmd: "setEnergy", peripheral: "battery_0", energy: 100000 },
      },
      {
        label: "Heavy load",
        command: {
          cmd: "setEnergyTransferRate",
          peripheral: "battery_0",
          rate: -2000,
        },
      },
    ],
    computers: [
      {
        dir: `${EXAMPLES}/power`,
        world: worldOf(`${EXAMPLES}/power/power_monitor.world.json`),
        monitors: [{ name: "top", blocksWide: 4, blocksHigh: 3 }],
        program: "power_monitor",
        terminal: "hide",
        screens: ["monitor:top", "terminal"],
      },
    ],
  },
  {
    id: "gpu-demo",
    title: "GPU Demo",
    kind: "demo",
    description:
      "Pixel graphics on a Tom's Peripherals GPU: a spinning wireframe cube, a sine ribbon, and ripples.",
    controls: "Tap the screen to make ripples.",
    source: `${EXAMPLES}/toms-peripherals/gpu_demo.lua`,
    computers: [
      {
        dir: `${EXAMPLES}/toms-peripherals`,
        world: worldOf(`${EXAMPLES}/toms-peripherals/gpu_demo.world.json`),
        monitors: [],
        program: "gpu_demo",
        terminal: "hide",
        screens: ["pixels:tm_gpu_0", "terminal"],
      },
    ],
  },
  {
    id: "rod-controller",
    title: "Reactor Rod Controller",
    kind: "demo",
    description:
      "Control rods for an Extreme Reactors reactor that keep the energy buffer around the middle.",
    controls:
      "Change the load on the reactor with the world buttons and watch the rods follow.",
    source: `${EXAMPLES}/extreme-reactors/rod_controller.lua`,
    actions: [
      {
        label: "No load",
        command: {
          cmd: "erSetLoad",
          peripheral: "BigReactors-Reactor_0",
          rate: 0,
        },
      },
      {
        label: "Load 3000 FE/t",
        command: {
          cmd: "erSetLoad",
          peripheral: "BigReactors-Reactor_0",
          rate: 3000,
        },
      },
      {
        label: "Add fuel",
        command: {
          cmd: "erAddFuel",
          peripheral: "BigReactors-Reactor_0",
          amount: 4000,
        },
      },
    ],
    computers: [
      {
        dir: `${EXAMPLES}/extreme-reactors`,
        world: worldOf(
          `${EXAMPLES}/extreme-reactors/rod_controller.world.json`,
        ),
        monitors: [{ name: "top", blocksWide: 3, blocksHigh: 2 }],
        program: "rod_controller",
        terminal: "hide",
        screens: ["monitor:top", "terminal"],
      },
    ],
  },
  {
    id: "greeter",
    title: "Greeter",
    kind: "demo",
    description:
      "Greets players who walk up to a player detector through a chat box, and answers !players and !where.",
    controls:
      "Walk Bob up to the computer and have Alice chat with the world buttons.",
    source: `${EXAMPLES}/advanced-peripherals/greeter.lua`,
    actions: [
      {
        label: "Bob walks up",
        command: { cmd: "setPlayerPos", player: "Bob", x: 5, y: 64, z: 5 },
      },
      {
        label: "Bob walks away",
        command: { cmd: "setPlayerPos", player: "Bob", x: 90, y: 64, z: 0 },
      },
      {
        label: "Alice: !players",
        command: { cmd: "chat", player: "Alice", message: "!players" },
      },
      {
        label: "Alice: !where",
        command: { cmd: "chat", player: "Alice", message: "!where" },
      },
    ],
    computers: [
      {
        dir: `${EXAMPLES}/advanced-peripherals`,
        world: worldOf(`${EXAMPLES}/advanced-peripherals/greeter.world.json`),
        monitors: [],
        program: "greeter",
        screens: ["terminal"],
      },
    ],
  },
  {
    id: "rednet-chat",
    title: "Rednet Chat",
    kind: "demo",
    description: "Chat between two computers over rednet, with /who and /quit.",
    controls:
      "Click a computer and type; Enter sends. /who lists who is there.",
    source: `${EXAMPLES}/rednet/chat.lua`,
    keyboard: true,
    computers: [
      ["Alice", 1, 0],
      ["Bob", 2, 10],
    ].map(([name, id, x]) => ({
      name: name.toLowerCase(),
      label: name,
      id,
      dir: `${EXAMPLES}/rednet`,
      world: {
        seed: id,
        position: { x, y: 70, z: 0 },
        peripherals: [{ name: "top", type: "modem" }],
      },
      monitors: [],
      program: "chat",
      args: [name],
      screens: ["terminal"],
    })),
  },
  {
    id: "shell",
    title: "CraftOS Shell",
    kind: "shell",
    description:
      "A bare advanced computer: type lua, edit a file, run the programs in the ROM.",
    controls: "Type. Ctrl+T, Ctrl+R and Ctrl+S are buttons too.",
    source: "",
    keyboard: true,
    computers: [
      {
        files: {},
        world: {},
        monitors: [],
        program: null,
        screens: ["terminal"],
      },
    ],
  },
];

// ---------------------------------------------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------------------------------------------

/** Files of an example folder that a player needs: no tests, test kits, worlds or READMEs. */
function exampleFiles(dir) {
  const files = {};
  if (!dir) return files;
  const root = join(REPO, dir);
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        if (
          /\.test\.lua$|^testkit\.lua$|\.world\.json$|\.md$|\.peer\.lua$/.test(
            name,
          )
        )
          continue;
        if (name === "peer.lua") continue;
        const rel = relative(root, full).split("\\").join("/");
        const data = readFileSync(full);
        // text as text (smaller, readable), anything that is not UTF-8 as base64
        const text = data.toString("utf8");
        files[rel] =
          Buffer.from(text, "utf8").equals(data) && !data.includes(0)
            ? text
            : { base64: data.toString("base64") };
      }
    }
  };
  walk(root);
  return files;
}

/** The boot script, without the engine peripherals (startEngine adds those itself; the cart gets both). */
function bootLua(c) {
  const parts = [monitorSetupLua(c.monitors ?? [])];
  if (c.label) parts.push(`os.setComputerLabel(${luaString(c.label)})`);
  if (c.program) {
    const a = (c.args ?? []).map(luaString).join(", ");
    parts.push(`shell.run(${luaString(c.program)}${a ? ", " + a : ""})`);
  }
  return parts.filter(Boolean).join("\n") + "\n";
}

function buildCart(def) {
  if (def.build)
    execFileSync(process.execPath, [join(REPO, def.build)], {
      stdio: "ignore",
    });
  const many = def.computers.length > 1;
  const worlds = many
    ? linkedWorlds(
        def.computers.map((c, i) => ({
          name: c.name,
          world: { ...c.world, computerId: c.id ?? i },
        })),
      )
    : def.computers.map((c) => ({ ...c.world, computerId: c.id ?? 0 }));
  const native = [];
  const computers = def.computers.map((c, i) => {
    const world = worlds[i];
    const json = worldJson(world);
    native.push({ world, boot: bootLua(c) });
    return {
      name: c.name ?? (many ? `computer ${i}` : "computer"),
      ...(c.label && { label: c.label }),
      id: world.computerId ?? 0,
      advanced: c.advanced !== false,
      files: Object.fromEntries(
        Object.entries({ ...exampleFiles(c.dir), ...(c.files ?? {}) }).filter(
          ([path]) => !(c.exclude ?? []).includes(path),
        ),
      ),
      world: json,
      boot: [enginePeripheralLua(world), bootLua(c)].filter(Boolean).join("\n"),
      monitors: (c.monitors ?? []).map((m) => ({
        name: m.name,
        blocksWide: m.blocksWide ?? 1,
        blocksHigh: m.blocksHigh ?? 1,
        ...(m.textScale && { textScale: m.textScale }),
      })),
      screens: c.screens ?? ["terminal"],
      terminal: c.terminal ?? "show",
    };
  });
  const cart = {
    format: 1,
    id: def.id,
    title: def.title,
    kind: def.kind,
    description: def.description,
    controls: def.controls,
    source: def.source ? SOURCE_BASE + def.source : SOURCE_BASE,
    screenshot: `${def.id}.png`,
    ...(def.keys && { keys: def.keys }),
    keyboard: def.keyboard ?? def.kind === "action",
    actions: def.actions ?? [],
    computers,
  };
  return { cart, native };
}

// ---------------------------------------------------------------------------------------------------------------
// Screenshots: run the cart on the native engine with the runner, a few seconds in
// ---------------------------------------------------------------------------------------------------------------

const SHOT_MS = {
  board: 5000,
  action: 4000,
  versus: 5000,
  demo: 5000,
  shell: 1500,
};

function blit(dst, dw, src, sw, sh, ox, oy) {
  for (let y = 0; y < sh; y++)
    dst.set(
      src.subarray(y * sw * 4, (y + 1) * sw * 4),
      ((oy + y) * dw + ox) * 4,
    );
}

/** The cart's first listed screen of each computer, side by side. */
function compose(images) {
  const GAP = 8;
  const width =
    images.reduce((s, im) => s + im.width, 0) + GAP * (images.length - 1);
  const height = Math.max(...images.map((im) => im.height));
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) rgba.set([24, 24, 28, 255], i);
  let x = 0;
  for (const im of images) {
    blit(
      rgba,
      width,
      im.rgba,
      im.width,
      im.height,
      x,
      Math.floor((height - im.height) / 2),
    );
    x += im.width + GAP;
  }
  return { width, height, rgba };
}

async function screenshot(cart, native) {
  const config = runner.loadConfig();
  const problems = runner.checkConfig(config);
  if (problems.length) throw new Error(problems.join("; "));
  const scratch = mkdtempSync(join(tmpdir(), "cart-shot-"));
  const handles = [];
  const network =
    cart.computers.length > 1 ? new runner.ComputerNetwork([]) : null;
  try {
    cart.computers.forEach((c, i) => {
      const dir = join(scratch, `files-${i}`);
      for (const [path, value] of Object.entries(c.files)) {
        const full = join(dir, path);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(
          full,
          typeof value === "string"
            ? value
            : Buffer.from(value.base64, "base64"),
        );
      }
      mkdirSync(dir, { recursive: true });
      const { world, boot } = native[i];
      const handle = runner.startEngine(
        { ...config, runtimeDir: scratch, workspaceDir: dir },
        boot,
        { label: `shot-${i}`, world },
      );
      handles.push(handle);
      network?.add(c.name, handle, world);
    });
    await new Promise((r) => setTimeout(r, SHOT_MS[cart.kind] ?? 4000));
    const images = cart.computers.map((c, i) => {
      const handle = handles[i];
      const first = c.screens[0] ?? "terminal";
      if (first.startsWith("pixels:")) {
        const p = runner.pixelScreens(handle.resultsDir)[0];
        if (p) return { width: p.width, height: p.height, rgba: p.rgba };
      }
      const wanted = first.startsWith("monitor:") ? first.slice(8) : undefined;
      const w =
        [...handle.session.windows.values()].find((w) =>
          wanted ? w.peripheral === wanted : !w.isMonitor,
        ) ?? [...handle.session.windows.values()].find((w) => w.frame);
      if (!w?.frame) throw new Error(`${cart.id}: no ${first} on ${c.name}`);
      return rawterm.renderFrame(w.frame, {
        scale: w.isMonitor ? 1 : 2,
        cursor: false,
      });
    });
    return rawterm.encodePng(compose(images));
  } finally {
    network?.close();
    for (const h of handles) await h.session.stop(500).catch(() => {});
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** A cart's card art from a showcase still (drawn at 2x): halved with ffmpeg when it is there, else as it is. */
function stillShot(path) {
  const from = join(REPO, path);
  try {
    return execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        from,
        "-vf",
        "scale=iw/2:ih/2:flags=neighbor",
        "-f",
        "image2pipe",
        "-c:v",
        "png",
        "-",
      ],
      { maxBuffer: 64 << 20 },
    );
  } catch {
    return readFileSync(from);
  }
}

// ---------------------------------------------------------------------------------------------------------------

mkdirSync(OUT, { recursive: true });
const shotsFile = join(OUT, "shots.json");
const shotHashes = existsSync(shotsFile)
  ? JSON.parse(readFileSync(shotsFile, "utf8"))
  : {};
const index = [];
const sizes = [];
const pending = [];
for (const def of CARTS) {
  const { cart, native } = buildCart(def);
  const text = JSON.stringify(cart);
  index.push({
    id: cart.id,
    title: cart.title,
    kind: cart.kind,
    description: cart.description,
    controls: cart.controls,
    source: cart.source,
    screenshot: cart.screenshot,
    computers: cart.computers.length,
    ...(cart.keys && { keys: cart.keys }),
  });
  if (only && !only.has(cart.id)) continue;
  writeFileSync(join(OUT, `${cart.id}.json`), text);
  sizes.push(`${cart.id} ${(text.length / 1024).toFixed(0)} KB`);
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
  if (def.still) {
    writeFileSync(join(OUT, cart.screenshot), stillShot(def.still));
    continue;
  }
  if (
    !noShots &&
    (shotHashes[cart.id] !== hash || !existsSync(join(OUT, cart.screenshot)))
  )
    pending.push({ cart, native, hash });
}
// a few at a time: each is an engine (two for the versus carts) running for a few seconds
const PARALLEL = 6;
const failures = [];
for (let i = 0; i < pending.length; i += PARALLEL) {
  await Promise.all(
    pending.slice(i, i + PARALLEL).map(async ({ cart, native, hash }) => {
      try {
        writeFileSync(
          join(OUT, cart.screenshot),
          await screenshot(cart, native),
        );
        shotHashes[cart.id] = hash;
      } catch (e) {
        failures.push(`${cart.id}: ${e.message}`);
      }
    }),
  );
}
writeFileSync(shotsFile, JSON.stringify(shotHashes, null, 2) + "\n");
writeFileSync(
  join(OUT, "index.json"),
  JSON.stringify({ format: 1, carts: index }, null, 2) + "\n",
);
console.log(`${index.length} carts -> ${OUT}`);
console.log("  " + sizes.join(", "));
if (pending.length)
  console.log(`  ${pending.length - failures.length} screenshots made`);
if (failures.length) {
  console.error(`screenshots failed:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
