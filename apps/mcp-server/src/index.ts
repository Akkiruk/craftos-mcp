#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { protocolVersion } from "@craftos-mcp/protocol";
import { type KeyName, Keys } from "@craftos-mcp/rawterm";
import {
  type ComputerNetwork,
  type ScreenCapture,
  type SimCommand,
  type WiredNetworkSpec,
  type WorldConfig,
  SessionManager,
  waitForBoot,
  type Expectation,
  type Step,
  actAndSettle,
  holdKey,
  touchMonitorAs,
  checkConfig,
  ADDONS,
  DEFAULT_MC,
  VERSIONS,
  addonReport,
  resolveVersion,
  romDirFor,
  versionReport,
  clearLabels,
  compactScreen,
  compareSnapshot,
  describeAll,
  pixelScreens,
  expectSettled,
  getLabels,
  loadLabels,
  markUi,
  readTrace,
  readWaiting,
  runScript,
  saveLabels,
  sendAndWait,
  sendCommandResult,
  setLabels,
  settle,
  simState,
  uiDelta,
  listWorkspace,
  loadConfig,
  packageVersion,
  loadNamedWorld,
  readWorkspaceFile,
  resolveInWorkspace,
  runProgram,
  runTests,
  writeWorkspaceFile,
} from "@craftos-mcp/runner";
import { z } from "zod";
import { startViewer } from "./viewer.js";

const config = loadConfig();
const sessions = new SessionManager(config);

let lastRun: { label: string; screens: ScreenCapture[] } | undefined;

const server = new McpServer({
  name: "craftos-mcp",
  version: packageVersion() ?? "0.1.0",
});

type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

const text = (value: unknown): Content => ({
  type: "text",
  text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
});

/** Screens as text, with PNGs split out into image content blocks. */
function screensToContent(screens: ScreenCapture[]): Content[] {
  const content: Content[] = [];
  for (const screen of screens) {
    if (screen.png) {
      content.push({ type: "image", data: screen.png, mimeType: "image/png" });
    }
  }
  return content;
}

function stripPng(screens: ScreenCapture[]): Omit<ScreenCapture, "png">[] {
  return screens.map(({ png: _png, ...rest }) => rest);
}

function failure(error: unknown) {
  return {
    isError: true,
    content: [text(error instanceof Error ? error.message : String(error))],
  };
}

const playerSchema = z.object({
  name: z.string(),
  uuid: z.string().optional(),
  online: z.boolean().optional().describe("Default true."),
  x: z.number().optional(),
  y: z.number().optional(),
  z: z.number().optional(),
  yaw: z.number().optional(),
  pitch: z.number().optional(),
  dimension: z.string().optional(),
  health: z.number().optional(),
  maxHealth: z.number().optional(),
});

const peripheralSchema = z
  .object({
    name: z.string().describe('Peripheral name, e.g. "chest_0" or "right".'),
    type: z
      .string()
      .describe(
        'Virtual: inventories ("minecraft:chest", "minecraft:barrel"), "fluid_storage", "energy_storage", and any block of your own name with a mix of CC:Tweaked\'s generic peripherals (type e.g. "thermal:machine_furnace"; it gets the types inventory, energy_storage and fluid_storage as its fields ask, in CC\'s order, with every method of each): size/items (inventory), tanks [{name (the fluid), amount, capacity?, rate? (mB per tick, minus drains)}] or fluid {name, amount} with capacity (fluid_storage), energy, energyCapacity, energyRate (FE per tick, minus drains; energy_storage); rates run on the virtual clock; see docs/generic-storage.md. Also Advanced Peripherals types playerDetector, chatBox, energyDetector, redstoneIntegrator, nbtStorage, environmentDetector, meBridge, rsBridge, arController. "speaker" is a recording fake (headless has no audio): playSound/playNote calls land in sim state under peripherals.<name>.sounds, and notes are capped at 8 per tick like the real speaker. "modem" behaves like the real game: kind "wireless" (default), "ender" or "wired" (with network, block, on, localName); see craftos_network_create. Engine-emulated: "drive". Extra fixture fields (fluids, energy, cells, cpus, patterns, inputs, ...) are passed through; see docs/advanced-peripherals.md.',
      ),
    size: z.number().int().min(1).optional().describe("Inventory slot count."),
    items: z
      .union([
        z.record(
          z.string(),
          z
            .object({ name: z.string(), count: z.number().int().min(1) })
            .passthrough(),
        ),
        z.array(z.object({ name: z.string() }).passthrough()),
      ])
      .optional()
      .describe(
        "Inventories: slot (1-based) to item (extra fields such as vaultData or nbt reach getItemDetail). meBridge/rsBridge: a list of stacks {name, amount, displayName?, nbt?, tags?, craftable?}.",
      ),
    x: z.number().optional(),
    y: z.number().optional(),
    z: z.number().optional(),
    dimension: z.string().optional(),
  })
  .passthrough();

const worldSchema = z
  .object({
    version: z
      .union([
        z.enum(VERSIONS.map((v) => v.mc) as [string, ...string[]]),
        z
          .object({
            mc: z.string(),
            cc: z.string().optional(),
            loader: z.string().optional(),
          })
          .strict(),
      ])
      .optional()
      .describe(
        `The Minecraft version the computer is on: ${VERSIONS.map((v) => `"${v.mc}" (CC:Tweaked ${v.cc})`).join(", ")}, or { mc, cc?, loader? }. ` +
          `Default: the server's CRAFTOS_VERSION, else ${DEFAULT_MC} (see craftos_info). It picks the ROM, CC:Tweaked's behaviour (file handles, messages) and the mod versions; an addon with no release for that Minecraft is refused.`,
      ),
    addons: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe(
        `Mods besides CC:Tweaked this world has: ${ADDONS.map((a) => a.id).join(", ")}, or "all" / "none". Default: the server's CRAFTOS_ADDONS setting (see craftos_info). Using a peripheral of an addon that is off is an error, so a program cannot lean on a mod the pack does not have.`,
      ),
    players: z.array(playerSchema).optional(),
    computerId: z.number().int().min(0).optional(),
    kind: z
      .enum(["block", "pocket"])
      .optional()
      .describe('"pocket" gives a 26x20 terminal.'),
    terminal: z
      .object({
        width: z.number().int().min(1).max(255),
        height: z.number().int().min(1).max(255),
      })
      .optional(),
    config: z
      .object({
        modemRange: z.number().optional(),
        modemHighAltitudeRange: z.number().optional(),
        modemRangeDuringStorm: z.number().optional(),
        modemHighAltitudeRangeDuringStorm: z.number().optional(),
        modemWorldTop: z.number().optional(),
      })
      .optional(),
    position: z
      .object({
        x: z.number().optional(),
        y: z.number().optional(),
        z: z.number().optional(),
        dimension: z.string().optional(),
      })
      .optional()
      .describe(
        "Where the computer stands; its modems use this position. Default 0, 64, 0 in the overworld.",
      ),
    label: z
      .string()
      .optional()
      .describe(
        "What this computer's computer_N peripheral answers to getLabel.",
      ),
    peripherals: z.array(peripheralSchema).optional(),
    environment: z
      .object({
        time: z.number().optional(),
        raining: z.boolean().optional(),
        thunder: z.boolean().optional(),
        biome: z.string().optional(),
        skyLight: z.number().optional(),
        blockLight: z.number().optional(),
        moonPhase: z.number().int().min(0).max(7).optional(),
        dimensions: z.array(z.string()).optional(),
        seed: z
          .number()
          .int()
          .optional()
          .describe("World seed for isSlimeChunk (default 0)."),
      })
      .optional()
      .describe("World facts for environmentDetector peripherals."),
    entities: z
      .array(
        z.object({ x: z.number(), y: z.number(), z: z.number() }).passthrough(),
      )
      .optional()
      .describe("Living entities visible to environmentDetector.scanEntities."),
    ap: z
      .object({ config: z.record(z.string(), z.unknown()).optional() })
      .optional()
      .describe("Overrides of the Advanced Peripherals server config."),
    turtle: z
      .object({
        x: z.number().optional(),
        y: z.number().optional(),
        z: z.number().optional(),
        facing: z.enum(["north", "south", "east", "west"]).optional(),
        advanced: z.boolean().optional(),
        fuel: z.number().optional(),
        selected: z.number().int().min(1).max(16).optional(),
        inventory: z
          .record(z.string(), z.object({ name: z.string() }).passthrough())
          .optional(),
        left: z.string().optional(),
        right: z.string().optional(),
      })
      .passthrough()
      .optional()
      .describe(
        "Make the computer a CC:Tweaked turtle in a block world (docs/turtle.md): position, facing, fuel, slots (1-16 to item), upgrades (item ids) on left/right.",
      ),
    blocks: z
      .array(
        z
          .object({
            x: z.number(),
            y: z.number(),
            z: z.number(),
            name: z.string().optional(),
          })
          .passthrough(),
      )
      .optional()
      .describe(
        "Blocks around a turtle: { x, y, z, name, state?, items?, size?, peripheral? }. Anything not given is air.",
      ),
    fills: z
      .array(z.object({}).passthrough())
      .optional()
      .describe("Boxes of one block: { from: [x,y,z], to: [x,y,z], name }."),
    ground: z
      .object({
        y: z.number().optional(),
        name: z.string().optional(),
        top: z.string().optional(),
      })
      .optional()
      .describe(
        "Everything at or below y is this block (default stone), its top layer `top`.",
      ),
    items: z
      .array(
        z
          .object({
            x: z.number(),
            y: z.number(),
            z: z.number(),
            name: z.string(),
          })
          .passthrough(),
      )
      .optional()
      .describe("Item stacks lying in a turtle's world."),
    turtleConfig: z
      .object({})
      .passthrough()
      .optional()
      .describe(
        "computercraft-server.toml [turtle]: needFuel, normalFuelLimit, advancedFuelLimit, canPush.",
      ),
    gameData: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Additions to the game data the turtle reads from the jars (names, loot, tags, recipes, maxCount, fuel, ...).",
      ),
    seed: z
      .number()
      .int()
      .optional()
      .describe(
        "Pin math.random to this seed (later math.randomseed calls by the program are ignored), so shuffles and dice are reproducible.",
      ),
  })
  .optional()
  .describe(
    "Simulated world around the computer: players, virtual inventories, Advanced Peripherals and Mekanism blocks, modems, environment, and a turtle's block world.",
  );

const worldFileSchema = z
  .string()
  .optional()
  .describe(
    'Name of a saved world in the worlds folder (for example "phoneos"). Fields in `world` override it.',
  );

function resolveWorld(
  world: unknown,
  worldFile: string | undefined,
): WorldConfig | undefined {
  const base = worldFile
    ? loadNamedWorld(config.worldsDir, worldFile)
    : undefined;
  if (!base && !world) return undefined;
  return { ...base, ...(world as WorldConfig | undefined) };
}

const monitorSchema = z.object({
  name: z.string().describe('Peripheral name, e.g. "top" or "monitor_0".'),
  blocksWide: z
    .number()
    .int()
    .min(1)
    .max(8)
    .default(1)
    .describe("Monitor width in blocks (1 block = 7 chars at scale 1)."),
  blocksHigh: z
    .number()
    .int()
    .min(1)
    .max(6)
    .default(1)
    .describe("Monitor height in blocks (1 block = 5 chars at scale 1)."),
  textScale: z
    .number()
    .min(0.5)
    .max(5)
    .optional()
    .describe("Text scale, 0.5 to 5."),
});

const timeScaleSchema = z
  .number()
  .min(0.1)
  .max(1000)
  .default(1)
  .describe(
    "Virtual clock speed. 10 makes sleep(), os.clock() and os.epoch() run 10x faster than real time, so slow scripts finish quickly. timeoutMs stays in real time.",
  );

/** craftos_info's version part: the default version (CRAFTOS_VERSION, else 1.18.2), its ROM and addons, and every version. */
function infoVersion(): Record<string, unknown> {
  const report = versionReport();
  let rom = config.romDir;
  let mc = DEFAULT_MC;
  let computercraft = "CC:Tweaked 1.101.3 (Minecraft 1.18.2)";
  try {
    const v = resolveVersion(undefined);
    rom = romDirFor(config, v);
    mc = v.mc;
    computercraft = `CC:Tweaked ${v.cc} (Minecraft ${v.mc}, ${v.loader})`;
  } catch {
    // CRAFTOS_VERSION is invalid: report says so
  }
  return {
    computercraft,
    rom,
    versions: {
      ...report,
      note: "world.version picks another per computer; a version's ROM is built with node scripts/build-rom.mjs --download <mc>",
    },
    addons: addonReport(process.env, mc),
  };
}

server.registerTool(
  "craftos_info",
  {
    description:
      "Report engine, ROM and workspace status. Check this first; it lists anything missing (engine build, pinned ROM).",
  },
  async () => ({
    content: [
      text({
        protocolVersion,
        ...infoVersion(),
        engine: config.engineExe,
        workspace: config.workspaceDir,
        problems: checkConfig(config),
        sessions: sessions.list(),
      }),
    ],
  }),
);

server.registerTool(
  "craftos_write_file",
  {
    description:
      "Write a Lua/text file in the workspace (copied to the root of every emulated computer, so paths match a real deployment). Paths are workspace-relative.",
    inputSchema: { path: z.string(), content: z.string() },
  },
  async ({ path, content }) => {
    try {
      writeWorkspaceFile(config.workspaceDir, path, content);
      return {
        content: [text(`wrote ${path} (${Buffer.byteLength(content)} bytes)`)],
      };
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "craftos_read_file",
  { description: "Read a workspace file.", inputSchema: { path: z.string() } },
  async ({ path }) => {
    try {
      return { content: [text(readWorkspaceFile(config.workspaceDir, path))] };
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "craftos_list_files",
  {
    description: "List files in the workspace recursively.",
    inputSchema: { path: z.string().default(".") },
  },
  async ({ path }) => {
    try {
      return { content: [text(listWorkspace(config.workspaceDir, path))] };
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "craftos_run",
  {
    description:
      "Run a workspace program in a fresh emulated CC:Tweaked computer, optionally with monitors attached, and return its exit status plus the final text of the terminal and every monitor. Set screenshots to also get PNG images. Pass snapshot to compare the screens against a golden file.",
    inputSchema: {
      program: z
        .string()
        .describe('Workspace-relative path, e.g. "hello.lua".'),
      args: z.array(z.string()).default([]),
      monitors: z.array(monitorSchema).default([]),
      timeoutMs: z.number().int().min(100).default(30000),
      timeScale: timeScaleSchema,
      world: worldSchema,
      worldFile: worldFileSchema,
      screenshots: z.boolean().default(false),
      scale: z.number().int().min(1).max(8).default(2),
      snapshot: z
        .object({ name: z.string(), update: z.boolean().default(false) })
        .optional()
        .describe(
          "Compare final screens with __snapshots__/<name>.json (created on first use).",
        ),
    },
  },
  async ({
    program,
    args,
    monitors,
    timeoutMs,
    timeScale,
    world,
    worldFile,
    screenshots,
    scale,
    snapshot,
  }) => {
    try {
      resolveInWorkspace(config.workspaceDir, program);
      // Always render PNGs so the web viewer can show the last run; only return them on request.
      const result = await runProgram(config, {
        program,
        args,
        monitors,
        timeoutMs,
        timeScale,
        world: resolveWorld(world, worldFile),
        screenshots: true,
        scale,
      });
      const snapshotResult = snapshot
        ? compareSnapshot(
            config.workspaceDir,
            (rel) => resolveInWorkspace(config.workspaceDir, rel),
            snapshot.name,
            result.screens,
            snapshot.update,
          )
        : undefined;
      const { screens, ...rest } = result;
      lastRun = {
        label: `${program} (${result.status})`,
        screens: result.screens,
      };
      return {
        content: [
          text({
            ...rest,
            screens: stripPng(screens),
            snapshot: snapshotResult,
          }),
          ...(screenshots ? screensToContent(screens) : []),
        ],
      };
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "craftos_test",
  {
    description:
      'Run *.test.lua files. Inside a test file use the global `ccunit`: ccunit.test(name, fn), ccunit.eq(actual, expected), ccunit.truthy(v), ccunit.raises(fn, pattern). Each file runs in its own fresh computer; peripherals can be attached with "monitors".',
    inputSchema: {
      paths: z
        .array(z.string())
        .default([])
        .describe("Files or directories; empty runs every *.test.lua."),
      monitors: z.array(monitorSchema).default([]),
      timeoutMs: z.number().int().min(100).default(30000),
      timeScale: timeScaleSchema,
      world: worldSchema,
      worldFile: worldFileSchema,
    },
  },
  async ({ paths, monitors, timeoutMs, timeScale, world, worldFile }) => {
    try {
      const result = await runTests(config, {
        paths,
        monitors,
        timeoutMs,
        timeScale,
        world: resolveWorld(world, worldFile),
      });
      return { isError: result.failed > 0, content: [text(result)] };
    } catch (error) {
      return failure(error);
    }
  },
);

// ---- interactive sessions -------------------------------------------------

const sessionId = z.string().describe("Id returned by craftos_session_create.");

server.registerTool(
  "craftos_session_create",
  {
    description:
      'Start a persistent emulated computer you can type into, click on and watch. Monitors are attached before the shell starts. Workspace files are at the computer\'s root. Returns once the computer has booted, with front: "shell" (the prompt is up) or "program" (startup.lua started a program that is in front, so there is no prompt).',
    inputSchema: {
      monitors: z.array(monitorSchema).default([]),
      timeScale: timeScaleSchema,
      world: worldSchema,
      worldFile: worldFileSchema,
    },
  },
  async ({ monitors, timeScale, world, worldFile }) => {
    try {
      const session = sessions.create(
        monitors,
        timeScale,
        resolveWorld(world, worldFile),
      );
      const front = await waitForBoot(session.handle.session);
      return { content: [text({ ...sessions.summarize(session), front })] };
    } catch (error) {
      return failure(error);
    }
  },
);

const blockSchema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
  dimension: z.string().optional(),
});

const networks = new Map<string, ComputerNetwork>();

server.registerTool(
  "craftos_network_create",
  {
    description:
      "Start several computers on one network, each a normal session (every session tool works on the ids returned) with its own full world. Give each world a different computerId, a position and modem peripherals. Modems follow the real rules: 64 blocks low down, rising to 384 at the top of the world; ender modems reach everything; wired modems link through network, or through block plus the cables of `wired`. rednet from the unmodified ROM works over them.",
    inputSchema: {
      computers: z
        .array(
          z.object({
            name: z
              .string()
              .optional()
              .describe("Name for this computer; default its id."),
            monitors: z.array(monitorSchema).default([]),
            world: worldSchema,
            worldFile: worldFileSchema,
          }),
        )
        .min(1),
      wired: z
        .array(
          z.object({
            id: z
              .string()
              .optional()
              .describe("Modems with this `network` join. Default none."),
            cables: z
              .array(blockSchema)
              .optional()
              .describe("Cable and full modem blocks; blocks that touch join."),
            peripherals: z
              .array(z.object({ type: z.string() }).passthrough())
              .optional()
              .describe("Peripherals every computer on the network reaches."),
          }),
        )
        .optional(),
      timeScale: timeScaleSchema,
    },
  },
  async ({ computers, wired, timeScale }) => {
    try {
      const linked = sessions.createNetwork({
        computers: computers.map((c) => ({
          ...(c.name === undefined ? {} : { name: c.name }),
          monitors: c.monitors,
          world: resolveWorld(c.world, c.worldFile) ?? {},
        })),
        ...(wired ? { wired: wired as WiredNetworkSpec[] } : {}),
        timeScale,
      });
      const id = randomUUID().slice(0, 8);
      networks.set(id, linked.network);
      await Promise.all(
        Object.values(linked.computers).map((c) =>
          settle(c.handle, { quietMs: 200, timeoutMs: 20000 }),
        ),
      );
      const ids = Object.fromEntries(
        Object.entries(linked.computers).map(([name, c]) => [name, c.id]),
      );
      return { content: [text({ network: id, sessions: ids })] };
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "craftos_network_update",
  {
    description:
      "Change a network from craftos_network_create while it runs: move a computer, right-click a wired modem to switch its computer on or off the network, or unload/load a computer's chunk (loaded).",
    inputSchema: {
      network: z.string().describe("Id from craftos_network_create."),
      computer: z.string().describe("The computer's name."),
      position: z
        .object({
          x: z.number().optional(),
          y: z.number().optional(),
          z: z.number().optional(),
          dimension: z.string().optional(),
        })
        .optional(),
      modem: z.string().optional().describe("Wired modem's peripheral name."),
      on: z.boolean().optional(),
      loaded: z
        .boolean()
        .optional()
        .describe(
          "false unloads the computer's chunk (it stops; on 2.2.36 linked computers get peripheral_detach for its peripherals), true loads it again (it boots afresh).",
        ),
    },
  },
  async ({ network, computer, position, modem, on, loaded }) => {
    try {
      const linked = networks.get(network);
      if (!linked) throw new Error(`no such network: ${network}`);
      if (position) linked.move(computer, position);
      if (modem !== undefined && on !== undefined)
        linked.setModemOn(computer, modem, on);
      if (loaded === false) linked.unload(computer);
      if (loaded === true) linked.load(computer);
      return { content: [text("updated")] };
    } catch (error) {
      return failure(error);
    }
  },
);

const deltaSchema = z
  .boolean()
  .default(false)
  .describe("Return only what changed since the previous call.");

const SIM_COMMANDS = [
  "addPlayer",
  "join",
  "leave",
  "setPlayerPos",
  "setComputerPos",
  "chat",
  "playerClick",
  "setItem",
  "setEnergy",
  "setFluid",
  "setEnergyTransferRate",
  "setRedstoneInput",
  "completeCraft",
  "setNetworkConnected",
  "setEnvironment",
  "addEntity",
  "qioSetPowered",
  "qioSetDrive",
  "qioSetSecurity",
  "qioSetUpgrades",
  "qioInsert",
  "qioExtract",
  "qeInsert",
  "qeExtract",
  "qeSetLoaded",
  "seed",
  "advance",
  "unload",
  "load",
  "attachPeripheral",
  "detachPeripheral",
  "resizeMonitor",
] as const;

server.registerTool(
  "craftos_sim_command",
  {
    description: `Change the simulated world while a session runs. Commands: addPlayer {name}, join/leave {player}, setPlayerPos {player, x, y, z, dimension?}, setComputerPos {x?, y?, z?, dimension?} (move this computer, modems included; on a network use craftos_network_update), unload / load (the computer's chunk unloads and it stops; load boots it afresh), chat {player, message} (fires a chat event), playerClick {player}, setItem {peripheral, slot, item|null}, setEnergy {peripheral, energy} (what a generic energy_storage holds), setFluid {peripheral, tank? (1-based, default 1), fluid {name, amount}|null} (what one tank holds), setEnergyTransferRate {peripheral, rate}, setRedstoneInput {peripheral, side, level}, completeCraft {peripheral, name?} (finish an ME/RS crafting job), setNetworkConnected {peripheral, connected}, setEnvironment {values:{time, raining, thunder, ...}}, addEntity {entity}, attachPeripheral / detachPeripheral / resizeMonitor, Mekanism QIO: qioSetPowered {block, powered}, qioSetDrive {block, slot, drive|null}, qioSetSecurity {block, mode}, qioSetUpgrades {block, speed}, qioInsert/qioExtract {frequency, item}, Quantum Entangloporter: qeInsert {frequency, item, public?, owner?}, qeExtract {frequency, count?}, qeSetLoaded {block, loaded} (see docs/mekanism-qio.md), seed {value} (pin math.random), advance {seconds} (jump the virtual clock and fire due timers). Returns the sim state, or with delta:true only what changed. Commands are applied when the program next waits for an event; this call returns once they are.`,
    inputSchema: {
      id: sessionId,
      command: z
        .object({ cmd: z.enum(SIM_COMMANDS) })
        .passthrough()
        .describe("A command object, e.g. {cmd:'interact', player:'Alice'}."),
      delta: deltaSchema,
    },
  },
  async ({ id, command, delta }) => {
    try {
      const handle = sessions.get(id).handle;
      const { applied, error } = await sendCommandResult(
        handle,
        command as SimCommand,
      );
      await settle(handle, { quietMs: 100, timeoutMs: 5000 });
      const state = simState(handle, delta);
      return {
        content: [
          text(
            !applied
              ? {
                  warning:
                    "the program has not applied the command yet (it is not waiting for an event)",
                  state,
                }
              : error !== undefined
                ? { error: `the command failed: ${error}`, state }
                : state,
          ),
        ],
      };
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "craftos_sim_state",
  {
    description:
      "Read the simulated world state of a session: chat messages, the computer's own redstone (redstone.outputs per side, inputs, bundledOutputs), virtual inventory contents, peripheral state (speakers, detectors, ME/RS bridges, QIO), the turtle and its block world. delta:true returns only what changed since the previous sim call (changed values as {from,to}, new chat entries as `appended`), which is usually a few lines.",
    inputSchema: { id: sessionId, delta: deltaSchema },
  },
  async ({ id, delta }) => {
    try {
      return {
        content: [text(simState(sessions.get(id).handle, delta))],
      };
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "craftos_session_list",
  { description: "List live sessions." },
  async () => ({ content: [text(sessions.list())] }),
);

server.registerTool(
  "craftos_session_destroy",
  {
    description: "Stop a session and delete its scratch data.",
    inputSchema: { id: sessionId },
  },
  async ({ id }) => {
    try {
      await sessions.destroy(id);
      return { content: [text(`destroyed ${id}`)] };
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "craftos_type",
  {
    description:
      "Type text into the computer, like a player at the keyboard. enter presses Enter afterwards.",
    inputSchema: {
      id: sessionId,
      text: z.string(),
      enter: z.boolean().default(true),
    },
  },
  async ({ id, text: input, enter }) => {
    try {
      const raw = sessions.get(id).handle.session;
      raw.char(input);
      if (enter) raw.tap(Keys.enter);
      return { content: [text("ok")] };
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "craftos_key",
  {
    description:
      "Press a key by name (enter, backspace, up, down, left, right, tab, escape, f1..f12, a..z, ...), with ctrl:true or shift:true held around it. A tap of ctrl+t does not terminate, as in the game: pass holdMs to hold the key down instead (key repeats every tick), and holding ctrl+t for 1000 ms or more sends `terminate`.",
    inputSchema: {
      id: sessionId,
      key: z.string(),
      ctrl: z.boolean().default(false),
      shift: z.boolean().default(false),
      holdMs: z
        .number()
        .int()
        .min(1)
        .max(10000)
        .optional()
        .describe("Hold the key this long instead of tapping it."),
    },
  },
  async ({ id, key, ctrl, shift, holdMs }) => {
    try {
      if (!(key in Keys)) throw new Error(`unknown key "${key}"`);
      const handle = sessions.get(id).handle;
      if (holdMs !== undefined) {
        await holdKey(handle, key, { ms: holdMs, ctrl, shift });
        return { content: [text("ok")] };
      }
      const raw = handle.session;
      if (ctrl) raw.key("leftCtrl");
      if (shift) raw.key("leftShift");
      raw.tap(key as KeyName);
      if (shift) raw.key("leftShift", { up: true });
      if (ctrl) raw.key("leftCtrl", { up: true });
      return { content: [text("ok")] };
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "craftos_touch_monitor",
  {
    description:
      "Click a monitor cell (1-based x,y), producing a monitor_touch event like a player right-clicking it. player names who touches (default: the interacting player); an unknown name is an error.",
    inputSchema: {
      id: sessionId,
      monitor: z.string(),
      x: z.number().int().min(1),
      y: z.number().int().min(1),
      player: z.string().optional(),
    },
  },
  async ({ id, monitor, x, y, player }) => {
    try {
      touchMonitorAs(sessions.get(id).handle, monitor, x, y, player);
      return { content: [text("ok")] };
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "craftos_ui",
  {
    description:
      'Describe every screen as data instead of a picture: solid rectangles (buttons, cards, panels) and, for text-mode screens, text runs with colours, plus what the program is waiting for. Works for any script. Default format is compact: each rectangle is one string "NAME #colour x,y WxH @cx,cy" where NAME is a label you set with craftos_labels and @cx,cy is the cell to touch. delta:true returns only what changed since the previous craftos_ui / craftos_script view (use it after every action). format:"full" gives the raw objects. Use instead of craftos_screenshot to find and verify things.',
    inputSchema: {
      id: sessionId,
      delta: deltaSchema,
      format: z.enum(["compact", "full"]).default("compact"),
      minArea: z
        .number()
        .int()
        .min(1)
        .default(40)
        .describe("Smallest rectangle area (cells) to report."),
    },
  },
  async ({ id, delta, format, minArea }) => {
    try {
      const handle = sessions.get(id).handle;
      const waiting = readWaiting(handle);
      const snaps = describeAll(handle, { minArea });
      const wait = waiting
        ? { blocked: waiting.blocked, filter: waiting.filter }
        : null;
      if (format === "full") {
        markUi(handle, snaps);
        return {
          content: [text({ waiting: waiting ?? null, screens: snaps })],
        };
      }
      const screens = delta
        ? uiDelta(handle, snaps)
        : (markUi(handle, snaps), snaps.map((s) => compactScreen(handle, s)));
      // screens a mod draws in pixels (GPU monitors): no rectangles, just size and a hash; craftos_screenshot shows them
      const pixels = pixelScreens(handle.resultsDir).map((p) => ({
        screen: p.peripheral,
        size: `${p.width}x${p.height} px`,
        hash: p.hash,
      }));
      return {
        content: [
          text({
            waiting: wait,
            screens,
            ...(pixels.length ? { pixelScreens: pixels } : {}),
          }),
        ],
      };
    } catch (error) {
      return failure(error);
    }
  },
);

const expectationSchema = z
  .object({
    rect: z
      .object({
        color: z.string().optional().describe("Hex colour, e.g. #f15c5c."),
        name: z.string().optional().describe("A label from craftos_labels."),
        peripheral: z.string().optional(),
        min: z.number().int().min(0).optional(),
        max: z.number().int().min(0).optional(),
        absent: z.boolean().optional(),
      })
      .optional()
      .describe("Elements on screen (default: at least one)."),
    text: z
      .object({
        contains: z.string().optional(),
        regex: z.string().optional(),
        peripheral: z.string().optional(),
        absent: z.boolean().optional(),
      })
      .optional()
      .describe("Text on text-mode screens."),
    waiting: z
      .object({
        blocked: z.boolean().optional(),
        filter: z.string().optional(),
      })
      .optional()
      .describe("What the program is blocked on."),
    sim: z
      .object({
        path: z
          .string()
          .describe(
            'Dotted path into the sim state, e.g. "inventories.chest_0".',
          ),
        equals: z.unknown().optional(),
        gte: z.number().optional(),
        lte: z.number().optional(),
        contains: z.unknown().optional(),
        exists: z.boolean().optional(),
      })
      .optional(),
    changed: z
      .boolean()
      .optional()
      .describe("Whether any screen differs from the last view."),
  })
  .describe(
    "One check; give exactly one of rect, text, waiting, sim or changed.",
  );

server.registerTool(
  "craftos_expect",
  {
    description:
      "Assert instead of look. Waits for the program to settle, checks the expectations and returns only {pass, failures}. A failure carries the reason and the closest things that do exist (nearest rectangles by colour, nearby text, the actual sim value), and the session saves PNGs plus a JSON dump to disk (`evidence`) that you open only if the text is not enough. Costs a few lines; prefer it over craftos_ui when you know what you expect.",
    inputSchema: {
      id: sessionId,
      expect: z.array(expectationSchema).min(1),
      settle: z.boolean().default(true),
      evidence: z.boolean().default(true),
      timeoutMs: z.number().int().min(100).default(15000),
      waitMs: z
        .number()
        .int()
        .min(0)
        .default(2000)
        .describe(
          "Keep re-checking for this long before failing: games animate with timers, so a screen can be still between frames.",
        ),
    },
  },
  async ({ id, expect, settle: doSettle, evidence, timeoutMs, waitMs }) => {
    try {
      const handle = sessions.get(id).handle;
      return {
        content: [
          text(
            await expectSettled(handle, expect as Expectation[], {
              settle: doSettle,
              evidence,
              timeoutMs,
              waitMs,
            }),
          ),
        ],
      };
    } catch (error) {
      return failure(error);
    }
  },
);

const stepSchema = z
  .object({
    touch: z
      .object({
        name: z.string().optional().describe("A label from craftos_labels."),
        index: z.number().int().min(0).optional(),
        monitor: z.string().optional(),
        x: z.number().int().min(1).optional(),
        y: z.number().int().min(1).optional(),
        player: z
          .string()
          .optional()
          .describe("Who touches (default: the interacting player)."),
      })
      .optional()
      .describe("Touch a named element, or monitor + x,y."),
    key: z.string().optional(),
    ctrl: z.boolean().optional(),
    shift: z.boolean().optional(),
    hold: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .optional()
      .describe(
        "With key: hold it this many ms. ctrl+t held 1000 ms or more terminates.",
      ),
    text: z.string().optional(),
    enter: z.boolean().optional().describe("With text: press Enter after."),
    expect: z.array(expectationSchema).optional(),
    waitMs: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("With expect: re-check for this long (default 2000)."),
    advance: z
      .number()
      .positive()
      .optional()
      .describe("Jump the virtual clock forward (seconds)."),
    sim: z
      .object({ cmd: z.enum(SIM_COMMANDS) })
      .passthrough()
      .optional(),
    seed: z.number().int().optional(),
    settle: z.boolean().optional(),
    lenient: z
      .boolean()
      .optional()
      .describe("Do not fail when the program ignored the input."),
    note: z.string().optional(),
  })
  .describe(
    "One step: exactly one of touch, key, text, expect, advance, sim, seed or settle.",
  );

server.registerTool(
  "craftos_script",
  {
    description:
      'Run many steps in one call and get one compact result: [{touch:{name:"HIT"}}, {expect:[{text:"You win"}]}, {advance:30}, ...]. Every touch/key/text waits until the program consumed it and the screen settled; a step fails if the program ignored the input (unless lenient). Stops at the first failure (stopOnFail:false to continue), returns only the failing steps with reasons and nearest matches, saves evidence files, and ends with a compact delta of the screens (ui:"none"|"delta"|"full"). One call replaces dozens of act/ui round trips.',
    inputSchema: {
      id: sessionId,
      steps: z.array(stepSchema).min(1).max(500),
      stopOnFail: z.boolean().default(true),
      ui: z.enum(["none", "delta", "full"]).default("delta"),
      evidence: z.boolean().default(true),
      quietMs: z.number().int().min(0).default(250),
      timeoutMs: z.number().int().min(100).default(15000),
    },
  },
  async ({ id, steps, stopOnFail, ui, evidence, quietMs, timeoutMs }) => {
    try {
      const handle = sessions.get(id).handle;
      const result = await runScript(handle, steps as Step[], {
        stopOnFail,
        ui,
        evidence,
        quietMs,
        timeoutMs,
      });
      return { content: [text(result)] };
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "craftos_labels",
  {
    description:
      'Name UI elements by colour (and optionally monitor and region) so every later call can say touch {name:"DOUBLE"} or expect {rect:{name:"HIT"}} instead of coordinates. Pixel-font text cannot be read, so read a label off one screenshot once, then label it. set: {NAME: {color:"#f15c5c", peripheral?, region?:{x1,y1,x2,y2}}}. save/load persist them in worlds/labels/<file>.json so they survive sessions. craftos_ui shows the names inline. Call with nothing to list.',
    inputSchema: {
      id: sessionId,
      set: z
        .record(
          z.string(),
          z.object({
            color: z.string(),
            peripheral: z.string().optional(),
            region: z
              .object({
                x1: z.number().int(),
                y1: z.number().int(),
                x2: z.number().int(),
                y2: z.number().int(),
              })
              .optional(),
          }),
        )
        .optional(),
      remove: z.array(z.string()).optional(),
      clear: z.boolean().optional(),
      save: z.string().optional().describe("Save the labels as this name."),
      load: z.string().optional().describe("Load labels saved earlier."),
    },
  },
  async ({ id, set, remove, clear, save, load }) => {
    try {
      const handle = sessions.get(id).handle;
      const notes: string[] = [];
      if (clear) clearLabels(handle);
      if (remove) clearLabels(handle, remove);
      if (load)
        notes.push(
          `loaded ${loadLabels(handle, config.worldsDir, load).length}`,
        );
      if (set) setLabels(handle, set);
      if (save)
        notes.push(`saved ${saveLabels(handle, config.worldsDir, save)}`);
      return { content: [text({ notes, labels: getLabels(handle) })] };
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "craftos_trace",
  {
    description:
      "What happened since the last call, without screenshots: events the program was handed (keys, touches, chat, ...), everything it printed, errors (uncaught Lua errors and printError), how many screen updates occurred, engine stderr, and whether it is still running. Call it right after something unexpected to see why. Output is capped to the newest lines.",
    inputSchema: {
      id: sessionId,
      maxLines: z.number().int().min(1).max(500).default(60),
      reset: z
        .boolean()
        .default(false)
        .describe("Discard what has accumulated and return nothing."),
    },
  },
  async ({ id, maxLines, reset }) => {
    try {
      return {
        content: [
          text(readTrace(sessions.get(id).handle, { maxLines, reset })),
        ],
      };
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "craftos_seed",
  {
    description:
      "Pin math.random to a seed on a running session, and make the program's own math.randomseed calls no-ops, so shuffles, dice and loot are reproducible. For a fixed seed from boot pass world.seed to craftos_session_create / craftos_run.",
    inputSchema: { id: sessionId, value: z.number().int() },
  },
  async ({ id, value }) => {
    try {
      const applied = await sendAndWait(sessions.get(id).handle, {
        cmd: "seed",
        value,
      });
      return {
        content: [
          text(
            applied
              ? `seeded ${value}`
              : "not applied yet: the program is not waiting for an event",
          ),
        ],
      };
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "craftos_advance",
  {
    description:
      "Jump the virtual clock forward by N seconds and fire every timer that falls due in that window (earliest first), so sleep(), timeouts, countdowns and inactivity logic pass instantly and deterministically. os.clock()/os.epoch() move too. Timers due later keep their real deadline. Then waits for the program to settle.",
    inputSchema: {
      id: sessionId,
      seconds: z.number().positive().max(86400),
      timeoutMs: z.number().int().min(100).default(15000),
    },
  },
  async ({ id, seconds, timeoutMs }) => {
    try {
      const handle = sessions.get(id).handle;
      const applied = await sendAndWait(handle, { cmd: "advance", seconds });
      const result = await settle(handle, { timeoutMs });
      return {
        content: [
          text({
            applied,
            settled: result.settled,
            waiting: result.waiting
              ? {
                  blocked: result.waiting.blocked,
                  filter: result.waiting.filter,
                }
              : null,
          }),
        ],
      };
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "craftos_settle",
  {
    description:
      "Wait until the program is blocked waiting for input and nothing on screen has changed for quietMs. Replaces fixed sleeps after any action.",
    inputSchema: {
      id: sessionId,
      quietMs: z.number().int().min(0).default(250),
      timeoutMs: z.number().int().min(100).default(15000),
    },
  },
  async ({ id, quietMs, timeoutMs }) => {
    try {
      const result = await settle(sessions.get(id).handle, {
        quietMs,
        timeoutMs,
      });
      return { content: [text(result)] };
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "craftos_act",
  {
    description:
      "Send one input (touch a monitor cell, press a key, or type text), wait until the program actually consumed it, then wait for the screen to settle. Returns `consumed` (false = the program was not listening for that input) and the new waiting state; follow with craftos_ui to read the result.",
    inputSchema: {
      id: sessionId,
      touch: z
        .object({
          monitor: z.string(),
          x: z.number().int().min(1),
          y: z.number().int().min(1),
        })
        .optional(),
      key: z.string().optional(),
      text: z.string().optional(),
      quietMs: z.number().int().min(0).default(250),
      timeoutMs: z.number().int().min(100).default(15000),
    },
  },
  async ({ id, touch, key, text: typed, quietMs, timeoutMs }) => {
    try {
      const given = [touch, key, typed].filter((v) => v !== undefined).length;
      if (given !== 1)
        throw new Error("pass exactly one of touch, key or text");
      const handle = sessions.get(id).handle;
      const raw = handle.session;
      let expect = "monitor_touch";
      let act = (): void => undefined;
      if (touch) {
        act = () => raw.touchMonitor(touch.monitor, touch.x, touch.y);
      } else if (key !== undefined) {
        if (!(key in Keys)) throw new Error(`unknown key "${key}"`);
        expect = "key";
        act = () => raw.tap(key as KeyName);
      } else if (typed !== undefined) {
        expect = "char";
        act = () => raw.char(typed);
      }
      const result = await actAndSettle(handle, act, {
        expect,
        quietMs,
        timeoutMs,
      });
      return { content: [text(result)] };
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "craftos_send_event",
  {
    description:
      "Queue an arbitrary Lua event, e.g. name 'timer' with params [3], or 'redstone'.",
    inputSchema: {
      id: sessionId,
      name: z.string(),
      params: z
        .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
        .default([]),
    },
  },
  async ({ id, name, params }) => {
    try {
      sessions.get(id).handle.session.event(name, ...params);
      return { content: [text("ok")] };
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "craftos_wait_for_text",
  {
    description:
      "Wait until text appears on the terminal (window 0) or a monitor window.",
    inputSchema: {
      id: sessionId,
      text: z.string(),
      window: z
        .number()
        .int()
        .default(0)
        .describe(
          "0 = terminal; see craftos_session_list for monitor windows.",
        ),
      timeoutMs: z.number().int().min(100).default(10000),
    },
  },
  async ({ id, text: needle, window, timeoutMs }) => {
    try {
      await sessions
        .get(id)
        .handle.session.waitForText(needle, window, timeoutMs);
      return { content: [text("found")] };
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "craftos_read_terminal",
  {
    description: "Read the current text of the terminal and every monitor.",
    inputSchema: { id: sessionId },
  },
  async ({ id }) => {
    try {
      return { content: [text(stripPng(sessions.screens(id)))] };
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "craftos_screenshot",
  {
    description:
      "Take PNG screenshots of the terminal and every monitor of a session.",
    inputSchema: {
      id: sessionId,
      scale: z.number().int().min(1).max(8).default(3),
    },
  },
  async ({ id, scale }) => {
    try {
      const screens = sessions.screens(id, { png: true, scale });
      return {
        content: [text(stripPng(screens)), ...screensToContent(screens)],
      };
    } catch (error) {
      return failure(error);
    }
  },
);

const viewerPort = process.env["CRAFTOS_VIEWER_PORT"] ?? "7878";
if (viewerPort !== "off") {
  startViewer({ port: Number(viewerPort), sessions, lastRun: () => lastRun });
}

const shutdown = (): void => {
  void sessions.destroyAll().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("close", shutdown);

await server.connect(new StdioServerTransport());
