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
  type TestRunResult,
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
  cleanStaleRuntime,
  measureWorkspace,
  MAX_COPY_BYTES,
  MAX_COPY_FILES,
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
  // the world clock and world snapshots (craftos_clock, craftos_world_snapshot)
  DAY_MS,
  deleteSnapshot,
  importSnapshot,
  listSnapshots,
  parseDuration,
  restoreSnapshot,
  saveSnapshot,
  snapshotFile,
  snapshotHooksFor,
  waitForClock,
  worldClockFor,
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
  WORLD_KEYS,
  checkProgram,
  checkTestPaths,
  checkWorld,
  type Project,
  checkProject,
  discoverTests,
  filterByGlobs,
  findProject,
  projectEnv,
  projectWorld,
  withoutEditorKeys,
} from "@craftos-mcp/runner";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ResourceTemplate,
  type RegisteredTool,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CCUNIT_GUIDE, GUIDE, INSTRUCTIONS } from "./guide.js";
import { startViewer } from "./viewer.js";
import {
  defaultBudgetMs,
  progressFor,
  ticker,
  withBudget,
} from "./progress.js";

/**
 * craftos.json (packages/runner/src/project.ts), from the workspace folder or the folder the server starts in: its
 * workspace, Minecraft version and mods stand in for CRAFTOS_WORKSPACE, CRAFTOS_VERSION and CRAFTOS_ADDONS where
 * those are unset; its world is the base world of craftos_run, craftos_test and craftos_session_create; its tests
 * globs pick the files of a craftos_test with no paths. A broken one is said on stderr and in craftos_info.
 */
let projectProblem: string | undefined;
const project = ((): Project | undefined => {
  try {
    const found = findProject(
      process.env["CRAFTOS_WORKSPACE"] ?? process.cwd(),
    );
    if (!found) return undefined;
    const errors = checkProject(found.data, found.dir);
    if (errors.length) {
      projectProblem = `${found.file}: ${errors.join("; ")} (ignored until fixed)`;
      return undefined;
    }
    Object.assign(process.env, projectEnv(found));
    return found;
  } catch (error) {
    projectProblem = `${(error as Error).message} (ignored until fixed)`;
    return undefined;
  }
})();
if (projectProblem) process.stderr.write(`craftos-mcp: ${projectProblem}\n`);

const config = loadConfig();
const sessions = new SessionManager(config);
// scratch folders of runs whose process died (a crash, a kill): in the background, never one a live process owns
void cleanStaleRuntime(config).catch(() => undefined);
/** The clone, or the installed package (it keeps the clone's layout): docs/, worlds/ and workspace/examples/. */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Every computer's copy of the workspace, said once in the tools that start one. */
const COPY_NOTE =
  " The computer gets a copy of the workspace (without .git, node_modules, .runtime and what .gitignore ignores); for a big workspace give world.deploy to copy only some folders.";

let lastRun: { label: string; screens: ScreenCapture[] } | undefined;
/** The live viewer's address once it listens (CRAFTOS_VIEWER_PORT, or a free port when that was taken). */
let viewerUrl: string | undefined;

const server = new McpServer(
  {
    name: "craftos-mcp",
    version: packageVersion() ?? "0.1.0",
  },
  { instructions: INSTRUCTIONS },
);

/**
 * Which tools the server offers (CRAFTOS_TOOLS): "all" (the default, every tool) or "core", the ones a normal
 * write-run-test loop and UI checks need, for clients that pay for every tool in every request. The rest stay
 * reachable by setting CRAFTOS_TOOLS=all; what they do is covered by the core ones (act covers type/key/touch, expect
 * covers wait_for_text, ui covers read_terminal, sim_command covers seed/advance).
 */
export const CORE_TOOLS = new Set([
  "craftos_info",
  "craftos_help",
  "craftos_write_file",
  "craftos_read_file",
  "craftos_run",
  "craftos_test",
  "craftos_session_create",
  "craftos_session_destroy",
  "craftos_session_list",
  "craftos_ui",
  "craftos_act",
  "craftos_expect",
  "craftos_script",
  "craftos_sim_command",
  "craftos_sim_state",
  "craftos_screenshot",
  "craftos_network_create",
]);
const toolSet = (process.env["CRAFTOS_TOOLS"] ?? "all").trim().toLowerCase();
if (!["all", "full", "core", ""].includes(toolSet))
  console.error(
    `craftos-mcp: CRAFTOS_TOOLS=${toolSet} is not "core" or "all"; offering all tools`,
  );
const registered: [string, RegisteredTool][] = [];
/** server.registerTool, remembering each tool so CRAFTOS_TOOLS=core can take the extra ones away again. */
/** Tools that only look (clients may skip asking before them), and the ones that change or remove what is there. */
const READ_ONLY = new Set([
  "craftos_info",
  "craftos_help",
  "craftos_read_file",
  "craftos_list_files",
  "craftos_session_list",
  "craftos_ui",
  "craftos_sim_state",
  "craftos_read_terminal",
  "craftos_screenshot",
  "craftos_trace",
]);
const DESTRUCTIVE = new Set(["craftos_write_file", "craftos_session_destroy"]);
const tool = ((name: string, toolConfig: object, cb: never) => {
  const annotations = READ_ONLY.has(name)
    ? { readOnlyHint: true }
    : name.startsWith("craftos_")
      ? { destructiveHint: DESTRUCTIVE.has(name), openWorldHint: false }
      : undefined;
  const made = server.registerTool(
    name,
    (annotations ? { ...toolConfig, annotations } : toolConfig) as never,
    cb,
  );
  registered.push([name, made]);
  return made;
}) as typeof server.registerTool;

type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

// compact JSON: results go into an agent's context, and indentation is a third of their size
const text = (value: unknown): Content => ({
  type: "text",
  text: typeof value === "string" ? value : JSON.stringify(value),
});

/** Screens as results show them: lines stop at the last non-blank one (height still says how many there are). */
function trimScreens<T extends { lines: string[] }>(
  screens: T[],
  full = false,
): T[] {
  if (full) return screens;
  return screens.map((s) => {
    let end = s.lines.length;
    while (end > 0 && s.lines[end - 1] === "") end--;
    return end === s.lines.length ? s : { ...s, lines: s.lines.slice(0, end) };
  });
}

const fullScreensSchema = z
  .boolean()
  .default(false)
  .describe(
    "Keep every line, trailing blank ones too (default: lines stop at the last non-blank one).",
  );

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

/** A key name the keyboard has not got, with the names that look like it (case and digits are the usual slips). */
export function unknownKey(key: string): string {
  const lower = key.toLowerCase();
  const digits = [
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
  ];
  const names = Object.keys(Keys);
  const near = names.filter(
    (n) =>
      n.toLowerCase() === lower ||
      (/^\d$/.test(key) && n === digits[Number(key)]) ||
      (lower.length > 1 && n.toLowerCase().includes(lower)),
  );
  return (
    `unknown key "${key}". ` +
    (near.length
      ? `Did you mean ${near
          .slice(0, 5)
          .map((n) => `"${n}"`)
          .join(" or ")}? `
      : "") +
    "Key names are CC's keys.* names: a..z, zero..nine, enter, space, backspace, tab, up, down, left, right, " +
    "escape, f1..f12, leftCtrl, leftShift, ... (text goes in with craftos_type, or craftos_act's text)."
  );
}

const VHCC_DEFAULT =
  'Default: off (false), or "2.2.36" when the world\'s addons (or CRAFTOS_ADDONS) name vhcctweaks: it is an opt-in addon, never part of "all"';

const playerSchema = z.object({
  name: z.string(),
  uuid: z.string().optional(),
  balance: z.number().int().min(0).optional().describe("Vault token balance."),
  online: z.boolean().optional().describe("Default true."),
  x: z.number().optional(),
  y: z.number().optional(),
  z: z.number().optional(),
  yaw: z.number().optional(),
  pitch: z.number().optional(),
  dimension: z.string().optional(),
  health: z.number().optional(),
  maxHealth: z.number().optional(),
  vaultLevel: z
    .number()
    .int()
    .optional()
    .describe(
      "Vault Hunters level for 2.2.36's ccvault.getPlayerVaultLevel; omit for no vault data.",
    ),
  onOtherServer: z
    .boolean()
    .optional()
    .describe(
      "2.2.36: online on another server of the network; the economy knows them, this server treats them as offline.",
    ),
  equipment: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "What the player wears and holds, for 2.2.36's ccvault.getPlayerEquipment: head, chest, legs, feet, mainhand, offhand (items as in chests, vaultData and nbt included) and curios {slotType: {index: item}}. 2.2.37 adds hotbar {1-9: item}, selectedHotbarSlot (default 1; mainhand is that slot's item) and weaponHotbarSlot (overrides the counted weapon, otherwise the best Gear Score among identified main-hand gear on the hotbar).",
    ),
  gearPower: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "2.2.37, for ccvault.getPlayerGearPower: {slots: {head, chest, legs, feet, weapon, offhand} (scores 0-1500), slotDetails: {slot: {status, item, name, hotbarSlot, hotbarWeapons}} or false, peak}. The scores are the world's; gearScore, gearPower and temper are derived.",
    ),
  temper: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "2.2.37, for ccvault.getPlayerTemper: {dust, might, magic, vigor, tool: {level, multiplier, power}, bossesBeaten, trialsRecord, favorsUsed}. The multipliers are the world's (the Temper ladder is not modelled).",
    ),
  reputation: z
    .record(z.string(), z.number())
    .optional()
    .describe(
      "2.2.37, for ccvault.getPlayerReputation: {velara, tenos, wendarr, idona}, each default 0.",
    ),
  greedTier: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("2.2.37: the player's greed tier, default 0."),
  skills: z
    .union([z.record(z.string(), z.unknown()), z.literal(false)])
    .optional()
    .describe(
      '2.2.37, for ccvault.getPlayerSkills: {abilities, talents, expertises, prestige: [{id, name?, learned, level? (gear bonuses included), maxLevel?, specialization?, specializationName?, specializationIndex?, selected?}] or false (unreadable), selectedAbility?, spentPoints?}. Offline players get level = learned and no selected. false: "skills not available".',
    ),
  stats: z
    .union([z.record(z.string(), z.unknown()), z.literal(false)])
    .optional()
    .describe(
      '2.2.37, for ccvault.getPlayerStats: attribute id to a number or {value | uncapped, limit?, name?, display?, percent?, extra?}. Capped stats (cooldown reduction, block, resistance, area of effect, durability wear reduction, lucky hit) get limit (default the base cap), uncapped and hitLimit. false: "stats not available".',
    ),
});

const peripheralSchema = z
  .object({
    name: z.string().describe('Peripheral name, e.g. "chest_0" or "right".'),
    type: z
      .string()
      .describe(
        'Virtual: inventories ("minecraft:chest", "minecraft:barrel"), "fluid_storage", "energy_storage", and any block of your own name with a mix of CC:Tweaked\'s generic peripherals (type e.g. "thermal:machine_furnace"; it gets the types inventory, energy_storage and fluid_storage as its fields ask, in CC\'s order, with every method of each): size/items (inventory), tanks [{name (the fluid), amount, capacity?, rate? (mB per tick, minus drains)}] or fluid {name, amount} with capacity (fluid_storage), energy, energyCapacity, energyRate (FE per tick, minus drains; energy_storage); rates run on the virtual clock; see docs/generic-storage.md. Also Advanced Peripherals types playerDetector, chatBox, energyDetector, redstoneIntegrator, nbtStorage, environmentDetector, meBridge, rsBridge, arController. "speaker" is a recording fake (headless has no audio): playSound/playNote calls land in sim state under peripherals.<name>.sounds, and notes are capped at 8 per tick like the real speaker. "printer" is CC:Tweaked\'s printer: ink (black dye) and paper counts, or items in its 13 slots (1 a dye, 2-7 paper, 8-13 the printed pages); pages printed land in sim state under peripherals.<name>.printed. "modem" behaves like the real game: kind "wireless" (default), "ender" or "wired" (with network, block, on, localName); see craftos_network_create. Engine-emulated: "drive". Extra fixture fields (fluids, energy, cells, cpus, patterns, inputs, ...) are passed through; see docs/advanced-peripherals.md.',
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
    host: z
      .string()
      .optional()
      .describe(
        'Computer owner ("host" in ccvault). Omit for an unowned computer.',
      ),
    interacting: z
      .string()
      .optional()
      .describe('Player currently using the computer ("player" in ccvault).'),
    autoApprove: z
      .boolean()
      .optional()
      .describe(
        "Approve ccvault.requestAuth() at once, like clicking [APPROVE].",
      ),
    economyAvailable: z.boolean().optional(),
    computerId: z.number().int().min(0).optional(),
    kind: z
      .enum(["block", "pocket"])
      .optional()
      .describe('"pocket" gives a 26x20 terminal and no auto-ownership.'),
    holdInteraction: z
      .boolean()
      .optional()
      .describe(
        "Keep the player's interaction fresh like an open GUI (default true for pocket computers; block computers expire after 30 s without a click or monitor touch).",
      ),
    terminal: z
      .object({
        width: z.number().int().min(1).max(255),
        height: z.number().int().min(1).max(255),
      })
      .optional(),
    config: z
      .object({
        nonceExpirySeconds: z.number().optional(),
        authIdleTimeoutMinutes: z.number().optional(),
        maxTransferAmount: z.number().optional(),
        interactionStaleSeconds: z.number().optional(),
        maxHistoryResults: z.number().optional(),
        modemRange: z.number().optional(),
        modemHighAltitudeRange: z.number().optional(),
        modemRangeDuringStorm: z.number().optional(),
        modemHighAltitudeRangeDuringStorm: z.number().optional(),
        modemWorldTop: z.number().optional(),
        maxLinksPerComputer: z.number().optional(),
        maxBatchMoves: z.number().optional(),
        batchTimeBudgetMicros: z.number().optional(),
        maxWatchesPerComputer: z.number().optional(),
        maxAllowanceMinutes: z.number().optional(),
        batchMoveCostMicros: z
          .number()
          .optional()
          .describe(
            "Emulator only (2.2.36): what one moveMany move costs against batchTimeBudgetMicros, default 10.",
          ),
        gearScore: z
          .boolean()
          .optional()
          .describe(
            "2.2.37 vaultDetails.gearScore, default true: Gear Score fields on identified gear.",
          ),
        gearScoreLines: z
          .boolean()
          .optional()
          .describe(
            "2.2.37 vaultDetails.gearScoreLines, default true: score fields on each modifier.",
          ),
        containerItems: z
          .boolean()
          .optional()
          .describe(
            '2.2.37 inventory.containerItems, default true. false: listContents, pushContents, moveMany inner moves and identify with an inner slot give "container items are turned off".',
          ),
        identify: z
          .boolean()
          .optional()
          .describe(
            '2.2.37 inventory.identify, default true. false: an inventory\'s identify gives "identify is turned off".',
          ),
        maxBytesPerComputer: z
          .number()
          .optional()
          .describe(
            "vhccFiles.maxBytesPerComputer, default 16777216; 2.2.37's vhcc.getUsage reports it.",
          ),
        gearPowerMinLevel: z
          .number()
          .optional()
          .describe(
            "Emulator only (2.2.37): the vault level Gear Power starts at, default 100.",
          ),
      })
      .optional(),
    economyDelayTicks: z
      .number()
      .min(0)
      .optional()
      .describe(
        "2.2.36: server ticks the economy thread takes per money call (transfer, getPlayerBalance, getBalance of someone not online here); the caller waits for vhcc_economy_done. Default 0.",
      ),
    internalErrors: z
      .record(z.string(), z.number().int())
      .optional()
      .describe(
        '2.2.36 tests: ccvault function name to how many calls answer nil, "internal error" (-1: every call).',
      ),
    gearPowerAvailable: z
      .boolean()
      .optional()
      .describe(
        '2.2.37: false is a server whose Vault Hunters is older than 3.21.74: "gear power not available", "temper not available", no Gear Score fields on gear. Default true.',
      ),
    identifyAvailable: z
      .boolean()
      .optional()
      .describe(
        'Emulator only (2.2.37): false is a server whose Vault Hunters cannot identify from a computer: identify gives "identify not available" once every other check passed. Default true.',
      ),
    vhcctweaks: z
      .union([z.enum(["2.2.35", "2.2.36", "2.2.37"]), z.literal(false)])
      .optional()
      .describe(
        `Which vhcctweaks the server runs (Minecraft 1.18.2 only). ${VHCC_DEFAULT}. With it: linked ender modems (link/unlink/getLinks, remote peripherals as <id>:<name>), listDetailed/moveMany, inventory watch()/inventory_changed, allowances, getPlayerVaultLevel/getPlayerEquipment, money calls that wait for the economy thread; see docs/vhcctweaks.md. "2.2.35" opts out (only for comparing with old measurements). "2.2.37" is 2.2.36 plus the 2.2.37 API as the emulator models it from the mod's spec: getPlayerGearPower/getPlayerTemper/getPlayerReputation/getPlayerSkills/getPlayerStats, getPlayerEquipment hotbar and counted weapon, getLimits (statCaps too), vhcc.getUsage, moveMany expectName, Gear Score in item details, and on every inventory listContents(slot [, detailed]), pushContents(to, slot, innerSlot [, limit [, toSlot]]), moveMany moves with inner = n (items inside a backpack, shulker box or vault barrel in a slot: give the item contents = {innerSlot: item}, optional containerSlots, itemHandler, outputFilter {allow, deny}; a peripheral canChangeItems: false refuses changes) and identify(slot, player [, innerSlot]) for vaultData state UNIDENTIFIED pieces (needs the player online and approved on this computer; identifiesTo or vaultData.rollPool say what it rolls, otherwise a seeded plausible roll). false: no vhcctweaks at all, plain CC:Tweaked with Advanced Peripherals and Mekanism behaving as shipped.`,
      ),
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
          .union([z.number().int(), z.string()])
          .optional()
          .describe(
            "World seed for isSlimeChunk (default 0); a long past 2^53 as a decimal string.",
          ),
      })
      .passthrough()
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
      .passthrough()
      .optional()
      .describe("Overrides of the Advanced Peripherals server config."),
    vhccStore: z
      .string()
      .optional()
      .describe(
        "Persistent vhcc_data store shared between runs; omit for a fresh one.",
      ),
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
    deploy: z
      .array(
        z.object({
          from: z.string().describe("Workspace-relative folder or file."),
          to: z
            .string()
            .optional()
            .describe("Computer-relative target; default the root."),
        }),
      )
      .optional()
      .describe(
        'Put only these workspace folders or files on the computer, as an installer does, instead of a copy of the whole workspace. Use it when the workspace is big (a repo root): [{"from": "src"}] puts src\'s contents at the root. Later entries win; .gitignore does not apply to what is named here.',
      ),
  })
  // every other world field (mekanism, create, deploy, simProgram, ...: schemas/world.schema.json) goes through as it is
  .passthrough()
  .optional()
  .describe(
    "Simulated world around the computer: players, virtual inventories, Advanced Peripherals and Mekanism blocks, modems, environment, and a turtle's block world. With the opt-in vhcctweaks addon (Minecraft 1.18.2: world.vhcctweaks or addons naming vhcctweaks) also token balances, the computer's host, who is interacting, and the ccvault and vhcc APIs with that mod's behaviour (docs/vhcctweaks.md).",
  );

/** The world's JSON Schema with every field described: craftos_help {topic:"world"} and craftos://schema/world. */
function worldJsonSchema(): unknown {
  return z.toJSONSchema(worldSchema.unwrap(), { unrepresentable: "any" });
}

/**
 * What the tools that start a computer take as `world`: any object, checked by the server (resolveWorld) against the
 * full schema above. The full schema is about 8k characters; repeated in four tools it was half the tool list, so the
 * tools carry this one line and the schema is served once, on request.
 */
const worldArg = z
  .object({})
  .passthrough()
  .optional()
  .describe(
    `The world around the computer (an object). Fields: ${WORLD_KEYS.filter((k) => !["modemLink", "placed"].includes(k)).join(", ")}; e.g. {"peripherals":[{"name":"chest_0","type":"minecraft:chest","size":27}],"deploy":[{"from":"src"}]}. ` +
      'world.deploy picks which workspace folders or files go on the computer, and where ([{"from":"src","to":"lib"}]), instead of a copy of the whole workspace. ' +
      'Every field with its options: craftos_help {topic:"world"} (or the craftos://schema/world resource). Checked before boot: a wrong key or peripheral type comes back as an error with a suggestion.',
  );

const worldFileSchema = z
  .string()
  .optional()
  .describe(
    'A saved world: a name in the worlds folder (e.g. "advanced-peripherals-demo") or a workspace path to a .json file (e.g. "door.world.json"). Fields in `world` override it.',
  );

/** The saved worlds' names, for error messages and craftos_help. */
function worldNames(): string[] {
  try {
    return readdirSync(config.worldsDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5))
      .sort();
  } catch {
    return [];
  }
}

function loadWorldFile(worldFile: string): WorldConfig {
  if (/\.json$/i.test(worldFile)) {
    const path = resolveInWorkspace(config.workspaceDir, worldFile);
    if (!existsSync(path))
      throw new Error(
        `worldFile: no file ${worldFile} in the workspace ${config.workspaceDir}`,
      );
    try {
      return JSON.parse(readFileSync(path, "utf8")) as WorldConfig;
    } catch (error) {
      throw new Error(`worldFile ${worldFile}: ${(error as Error).message}`);
    }
  }
  try {
    return loadNamedWorld(config.worldsDir, worldFile);
  } catch (error) {
    const names = worldNames();
    throw new Error(
      `worldFile: no saved world named "${worldFile}". ` +
        (names.length
          ? `Saved worlds: ${names.join(", ")}.`
          : "There are no saved worlds.") +
        " A workspace file works too: give its path, ending in .json.",
      { cause: error },
    );
  }
}

/** craftos.json's world, read on every call so an edit to it counts without a restart. */
function projectBaseWorld(): WorldConfig | undefined {
  const world = project && projectWorld(project);
  if (!world) return undefined;
  try {
    return /\.json$/i.test(world)
      ? withoutEditorKeys(
          JSON.parse(readFileSync(world, "utf8")) as WorldConfig,
        )
      : loadNamedWorld(config.worldsDir, world);
  } catch (error) {
    throw new Error(`craftos.json world ${world}: ${(error as Error).message}`);
  }
}

/** A world from `worldFile` (else craftos.json's) plus `world`, checked before anything boots: throws on errors, returns the warnings. */
function resolveWorld(
  world: unknown,
  worldFile: string | undefined,
  warnings: string[] = [],
  where = "world",
): WorldConfig | undefined {
  const base = worldFile
    ? loadWorldFile(worldFile)
    : where === "world"
      ? projectBaseWorld()
      : undefined;
  if (!base && !world) return undefined;
  const merged = { ...base, ...(world as WorldConfig | undefined) };
  const problems: string[] = [];
  const typed = worldSchema.safeParse(merged);
  if (!typed.success)
    for (const issue of typed.error.issues)
      problems.push(
        `${[where, ...issue.path].join(".").replace(/\.(\d+)(?=\.|$)/g, "[$1]")}: ${issue.message}`,
      );
  const check = checkWorld(merged);
  problems.push(
    ...check.errors.map((e) =>
      where === "world" ? e : e.replace(/^world\b/, where),
    ),
  );
  if (problems.length)
    throw new Error(
      problems.length === 1
        ? problems[0]!
        : `the world has ${problems.length} problems:\n- ${problems.join("\n- ")}`,
    );
  warnings.push(...check.warnings);
  return merged;
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

/** craftos_info's version part: the default version (CRAFTOS_VERSION, else DEFAULT_MC), its ROM and addons, and every version. */
function infoVersion(): Record<string, unknown> {
  const report = versionReport();
  let rom = config.romDir;
  let mc = DEFAULT_MC;
  let computercraft =
    "unknown: CRAFTOS_VERSION is invalid (see versions.source)";
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
    addons: compactAddons(addonReport(process.env, mc)),
  };
}

/**
 * The addon report as id -> version, split into the ones on and off: the ids are what world.addons takes, and the
 * display names were most of the size. "none" is a mod with no release on that Minecraft version.
 */
export function compactAddons(report: ReturnType<typeof addonReport>): {
  source: string;
  on: Record<string, string>;
  off: Record<string, string>;
} {
  const on: Record<string, string> = {};
  const off: Record<string, string> = {};
  for (const a of report.addons)
    (a.on ? on : off)[a.id] =
      a.actsAs !== a.version ? `${a.version} (acts as ${a.actsAs})` : a.version;
  return { source: report.source, on, off };
}

tool(
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
        ...(project && { project: project.file }),
        ...(viewerUrl && { viewer: viewerUrl }),
        problems: [
          ...checkConfig(config),
          ...(await workspaceProblems()),
          ...(projectProblem ? [projectProblem] : []),
        ],
        sessions: sessions.list(),
        tools:
          toolSet === "core"
            ? "core (CRAFTOS_TOOLS=all for every tool)"
            : "all",
      }),
    ],
  }),
);

/** craftos_info's warning when every computer would get a huge copy of the workspace (a repo root, a home folder). */
async function workspaceProblems(): Promise<string[]> {
  try {
    const size = await measureWorkspace(config.workspaceDir, {
      exclude: [config.runtimeDir],
    });
    const problems: string[] = [];
    const fix =
      'Set CRAFTOS_WORKSPACE (or the folder the server starts in) to the folder with your programs, or give each world a deploy list ({"deploy": [{"from": "src"}]}).';
    if (size.tooBig)
      problems.push(
        `the workspace ${config.workspaceDir} is too big to copy onto a computer (over ${MAX_COPY_FILES} files or ${MAX_COPY_BYTES / 1e6} MB, after skipping ${COPY_SKIP_NOTE}): runs without a deploy list fail. ${fix}`,
      );
    else if (size.bytes > 25_000_000)
      problems.push(
        `the workspace copies ${Math.round(size.bytes / 1e6)} MB onto every computer, more than a real computer's 25 MB disk. ${fix}`,
      );
    if (size.skippedHeavy.includes("node_modules"))
      problems.push(
        `the workspace ${config.workspaceDir} holds ${size.skippedHeavy.join(", ")}: it looks like a project root, not a folder of Lua programs. Those folders are skipped, but the rest of the project is still copied onto every computer. ${fix}`,
      );
    return problems;
  } catch (error) {
    return [`could not read the workspace: ${(error as Error).message}`];
  }
}
const COPY_SKIP_NOTE =
  ".git, node_modules, .runtime and what .gitignore ignores";

tool(
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

tool(
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

tool(
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

tool(
  "craftos_run",
  {
    description:
      "Run a workspace program in a fresh emulated CC:Tweaked computer, optionally with monitors attached, and return its exit status (completed, program_failed, timed_out) plus the final text of the terminal and every monitor; a failed program also gets error {kind, message, file, line}. Set screenshots to also get PNG images. Pass snapshot to compare the screens against a golden file. timeoutMs covers copying the workspace too; a run that outlasts it comes back with status timed_out (normal for a program that waits for input forever)." +
      COPY_NOTE,
    inputSchema: {
      program: z
        .string()
        .describe(
          'Workspace-relative path, e.g. "hello.lua" (as on the computer, so a deploy list\'s target path).',
        ),
      args: z
        .array(z.string())
        .default([])
        .describe("The program's arguments."),
      monitors: z
        .array(monitorSchema)
        .default([])
        .describe("Monitors attached before it starts."),
      timeoutMs: z
        .number()
        .int()
        .min(100)
        .default(30000)
        .describe("Real time before the run stops as timed_out."),
      timeScale: timeScaleSchema,
      world: worldArg,
      worldFile: worldFileSchema,
      screenshots: z
        .boolean()
        .default(false)
        .describe("Also return a PNG of every screen."),
      scale: z
        .number()
        .int()
        .min(1)
        .max(8)
        .default(2)
        .describe("PNG pixels per screen pixel."),
      snapshot: z
        .object({ name: z.string(), update: z.boolean().default(false) })
        .optional()
        .describe(
          "Compare final screens with __snapshots__/<name>.json (created on first use).",
        ),
      fullScreens: fullScreensSchema,
    },
  },
  async (
    {
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
      fullScreens,
    },
    extra,
  ) => {
    try {
      resolveInWorkspace(config.workspaceDir, program.trim().split(/\s+/)[0]!);
      const warnings: string[] = [];
      const resolved = resolveWorld(world, worldFile, warnings);
      // a program that is not there fails here, before a computer boots to say "No such program"
      const missing = checkProgram(config, program, resolved);
      if (missing)
        return failure(
          /Did you mean/.test(missing)
            ? missing
            : `${missing} Write it with craftos_write_file; craftos_list_files shows what is there.`,
        );
      // Always render PNGs so the web viewer can show the last run; only return them on request.
      // timeoutMs is the call's whole budget: on it the run stops and the reply has the screens as they were.
      const stopTicking = ticker(progressFor(extra), timeoutMs, program);
      const result = await runProgram(config, {
        program,
        args,
        monitors,
        timeoutMs,
        timeScale,
        world: resolved,
        screenshots: true,
        scale,
        signal: extra.signal,
      }).finally(stopTicking);
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
      // empty fields add nothing an agent can use
      const { stderr, messages, ...core } = rest;
      return {
        content: [
          text({
            ...core,
            ...(stderr ? { stderr } : {}),
            ...(messages.length ? { messages } : {}),
            ...(warnings.length ? { warnings } : {}),
            screens: trimScreens(stripPng(screens), fullScreens),
            ...(snapshotResult ? { snapshot: snapshotResult } : {}),
          }),
          ...(screenshots ? screensToContent(screens) : []),
        ],
      };
    } catch (error) {
      return failure(error);
    }
  },
);

tool(
  "craftos_test",
  {
    description:
      'Run *.test.lua files. Inside a test file use the global `ccunit`: test(name, fn [, {timeout}]), eq, neq, near, contains, truthy, raises(fn, pattern), skip, and run(program, {seconds|script, args}) / screen(monitor?) / touch(monitor, x, y) to drive a program and read its screens (craftos_help {topic:"ccunit"}). Each file runs in its own fresh computer; peripherals can be attached with "monitors". timeoutMs is per file and covers copying the workspace; a file that hangs keeps the tests it finished and names the one it was in. The reply gives each file its status, a count of passing tests (named too in runs of up to 50 tests), and every failing test with its error and line.' +
      COPY_NOTE,
    inputSchema: {
      paths: z
        .array(z.string())
        .default([])
        .describe("Files or directories; empty runs every *.test.lua."),
      monitors: z.array(monitorSchema).default([]),
      timeoutMs: z.number().int().min(100).default(30000),
      budgetMs: z
        .number()
        .int()
        .min(1000)
        .optional()
        .describe(
          "Real time for the whole call (default 10 min). When it runs out, running files stop keeping their finished tests, and notRun lists the rest.",
        ),
      timeScale: timeScaleSchema,
      world: worldArg,
      worldFile: worldFileSchema,
    },
  },
  async (
    { paths, monitors, timeoutMs, budgetMs, timeScale, world, worldFile },
    extra,
  ) => {
    try {
      const warnings: string[] = [];
      const resolved = resolveWorld(world, worldFile, warnings);
      const missing = checkTestPaths(config, paths);
      if (missing.length) return failure(missing.join("\n"));
      // no paths: craftos.json's tests globs, if it has some
      const globs = paths.length ? undefined : project?.data.tests;
      const files = globs
        ? filterByGlobs(discoverTests(config.workspaceDir), globs)
        : discoverTests(config.workspaceDir, paths);
      if (files.length === 0)
        return failure(
          globs
            ? `craftos.json's tests (${globs.join(", ")}) match no *.test.lua files in the workspace ${config.workspaceDir}`
            : `no *.test.lua files under ${paths.length ? paths.join(", ") : `the workspace ${config.workspaceDir}`}`,
        );
      const progress = progressFor(extra);
      const budget = withBudget(extra.signal, budgetMs ?? defaultBudgetMs());
      let done = 0;
      progress(0, files.length);
      const result = await runTests(config, {
        paths: files,
        monitors,
        timeoutMs,
        timeScale,
        world: resolved,
        signal: budget.signal,
        onFile: (f) => progress(++done, files.length, `${f.file} ${f.status}`),
      }).finally(budget.dispose);
      const reply = compactTests(result);
      const ran = new Set(result.files.map((f) => f.file));
      const notRun = files.filter((f) => !ran.has(f));
      const cut = budget.expired()
        ? {
            budget: `ran out after ${Math.round((budgetMs ?? defaultBudgetMs()) / 1000)} s: these are the files that finished or were stopped`,
            ...(notRun.length && { notRun }),
          }
        : {};
      return {
        isError: result.failed > 0 || budget.expired(),
        content: [
          text({ ...reply, ...cut, ...(warnings.length && { warnings }) }),
        ],
      };
    } catch (error) {
      return failure(error);
    }
  },
);

/** Up to this many tests in a run, craftos_test names the passing ones too; above it, only counts them. */
export const NAME_PASSING_UP_TO = 50;

/**
 * craftos_test's reply: per file how many passed, the failing tests in full ({name, error, line, and file when it
 * points into another file}) and the skipped ones by name, instead of an object per test. The passing ones are named
 * (passedTests) only in a run of up to NAME_PASSING_UP_TO tests: in a big suite their names were most of the reply
 * (27 of 42 KB for 455 tests). The computer's "CraftOS 1.8" banner leaves the terminal lines, since it says nothing.
 */
export function compactTests(result: TestRunResult) {
  const total = result.files.reduce((n, f) => n + f.tests.length, 0);
  const named = total <= NAME_PASSING_UP_TO;
  return {
    passed: result.passed,
    failed: result.failed,
    ...(result.skipped ? { skipped: result.skipped } : {}),
    ...(named
      ? {}
      : {
          note: `${total} tests: passing ones are counted, not named; run fewer files to see their names`,
        }),
    files: result.files.map((f) => {
      const passed = f.tests.filter((t) => t.passed && !t.skipped);
      const skipped = f.tests.filter((t) => t.skipped);
      const failed = f.tests
        .filter((t) => !t.passed)
        .map(({ passed: _passed, file, ...t }) =>
          file && file !== f.file ? { ...t, file } : t,
        );
      const terminal = f.terminal?.filter((l) => !/^CraftOS \d+\.\d+$/.test(l));
      return {
        file: f.file,
        status: f.status,
        passed: passed.length,
        ...(named && passed.length
          ? { passedTests: passed.map((t) => t.name) }
          : {}),
        ...(failed.length ? { failed } : {}),
        ...(skipped.length ? { skipped: skipped.map((t) => t.name) } : {}),
        ...(terminal?.length ? { terminal } : {}),
        durationMs: f.durationMs,
      };
    }),
  };
}

// ---- interactive sessions -------------------------------------------------

const sessionId = z.string().describe("Id returned by craftos_session_create.");

/**
 * Who owns the sessions this server's MCP client starts: the client by the name it gave (one client per stdio
 * server). Sessions a person starts in the viewer are VIEWER_OWNER's; craftos_session_list shows those apart, and
 * craftos_session_destroy leaves them running unless told force.
 */
function clientOwner(): string {
  const name = server.server.getClientVersion()?.name;
  return name ? `the agent (${name})` : "the agent";
}

tool(
  "craftos_session_create",
  {
    description:
      'Start a persistent emulated computer you can type into, click on and watch. Monitors are attached before the shell starts. Workspace files are at the computer\'s root. Returns once the computer has booted, with front: "shell" (the prompt is up) or "program" (startup.lua started a program that is in front, so there is no prompt).' +
      COPY_NOTE,
    inputSchema: {
      monitors: z.array(monitorSchema).default([]),
      timeScale: timeScaleSchema,
      world: worldArg,
      worldFile: worldFileSchema,
      liveFiles: z
        .boolean()
        .default(false)
        .describe(
          "Give the computer the workspace folder itself instead of a copy: what the program writes lands in the workspace, and files you change there are seen at once. Only when the person asks for it; default a copy.",
        ),
    },
  },
  async ({ monitors, timeScale, world, worldFile, liveFiles }, extra) => {
    try {
      const warnings: string[] = [];
      const session = await sessions.createAsync(
        monitors,
        timeScale,
        resolveWorld(world, worldFile, warnings),
        extra.signal,
        liveFiles ? config.workspaceDir : undefined,
      );
      sessions.setOwner(session.id, clientOwner());
      const front = await waitForBoot(session.handle.session);
      return {
        content: [
          text({
            ...sessions.summarize(session),
            front,
            ...(warnings.length ? { warnings } : {}),
          }),
        ],
      };
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

tool(
  "craftos_network_create",
  {
    description:
      "Start several computers on one network, each a normal session (every session tool works on the ids returned) with its own full world. Give each world a different computerId, a position and modem peripherals. Modems follow the real rules: 64 blocks low down, rising to 384 at the top of the world; ender modems reach everything; wired modems link through network, or through block plus the cables of `wired`. rednet from the unmodified ROM works over them." +
      COPY_NOTE,
    inputSchema: {
      computers: z
        .array(
          z.object({
            name: z
              .string()
              .optional()
              .describe("Name for this computer; default its id."),
            monitors: z.array(monitorSchema).default([]),
            world: worldArg.describe(
              "This computer's world, as craftos_run's `world`; its deploy lists the workspace folders this computer gets (each computer can have its own).",
            ),
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
  async ({ computers, wired, timeScale }, extra) => {
    try {
      const warnings: string[] = [];
      const linked = await sessions.createNetworkAsync(
        {
          computers: computers.map((c, i) => ({
            ...(c.name === undefined ? {} : { name: c.name }),
            monitors: c.monitors,
            world:
              resolveWorld(
                c.world,
                c.worldFile,
                warnings,
                `computers[${i}].world`,
              ) ?? {},
          })),
          ...(wired ? { wired: wired as WiredNetworkSpec[] } : {}),
          timeScale,
        },
        extra.signal,
      );
      const id = randomUUID().slice(0, 8);
      networks.set(id, linked.network);
      for (const c of Object.values(linked.computers))
        sessions.setOwner(c.id, clientOwner());
      await Promise.all(
        Object.values(linked.computers).map((c) =>
          settle(c.handle, { quietMs: 200, timeoutMs: 20000 }),
        ),
      );
      const ids = Object.fromEntries(
        Object.entries(linked.computers).map(([name, c]) => [name, c.id]),
      );
      return {
        content: [
          text({
            network: id,
            sessions: ids,
            ...(warnings.length ? { warnings } : {}),
          }),
        ],
      };
    } catch (error) {
      return failure(error);
    }
  },
);

tool(
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
      if (!linked)
        throw new Error(
          `no such network: ${network}. ` +
            (networks.size
              ? `Networks: ${[...networks.keys()].join(", ")}.`
              : "No network is running.") +
            " Networks end when the server restarts; craftos_network_create starts one.",
        );
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
  "interact",
  "approve",
  "revoke",
  "setBalance",
  "setVaultLevel",
  "setEquipment",
  "setOnOtherServer",
  "setGearPower",
  "setTemper",
  "setReputation",
  "setGreedTier",
  "setSkills",
  "setStats",
  "internalError",
  "setEconomyDelay",
  "addPlayer",
  "join",
  "leave",
  "setPlayerPos",
  "setComputerPos",
  "setHost",
  "setEconomy",
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
  "insertDisk",
  "ejectDisk",
] as const;

tool(
  "craftos_sim_command",
  {
    description: `Change the simulated world while a session runs. Commands: addPlayer {name}, join/leave {player}, setPlayerPos {player, x, y, z, dimension?}, setComputerPos {x?, y?, z?, dimension?} (move this computer, modems included; on a network use craftos_network_update), unload / load (the computer's chunk unloads and it stops; load boots it afresh), chat {player, message} (fires a chat event), playerClick {player}, setItem {peripheral, slot, item|null}, setEnergy {peripheral, energy} (what a generic energy_storage holds), setFluid {peripheral, tank? (1-based, default 1), fluid {name, amount}|null} (what one tank holds), setEnergyTransferRate {peripheral, rate}, setRedstoneInput {peripheral, side, level}, completeCraft {peripheral, name?} (finish an ME/RS crafting job), setNetworkConnected {peripheral, connected}, setEnvironment {values:{time, raining, thunder, ...}}, addEntity {entity}, attachPeripheral / detachPeripheral / resizeMonitor, insertDisk {peripheral, disk} / ejectDisk {peripheral} (a player puts a floppy into a drive or takes it out: disk / disk_eject), Mekanism QIO: qioSetPowered {block, powered}, qioSetDrive {block, slot, drive|null}, qioSetSecurity {block, mode}, qioSetUpgrades {block, speed}, qioInsert/qioExtract {frequency, item}, Quantum Entangloporter: qeInsert {frequency, item, public?, owner?}, qeExtract {frequency, count?}, qeSetLoaded {block, loaded} (see docs/mekanism-qio.md), seed {value} (pin math.random), advance {seconds} (jump the virtual clock and fire due timers). With the vhcctweaks addon also: interact {player} (right-click the computer), approve {player?, nonce?} (click [APPROVE]), revoke {player?}, setBalance {player, balance}, setHost {player?}, setEconomy {available}, rcExec {player, code}, setVaultLevel / setEquipment / setOnOtherServer (2.2.36), setGearPower / setTemper / setReputation / setGreedTier / setSkills / setStats (2.2.37), internalError {function, times?}, setEconomyDelay {ticks}, refuseTransfers {times?}; craftos_help {topic:"world"} has their shapes. Returns the sim state, or with delta:true only what changed. Commands are applied when the program next waits for an event; this call returns once they are.`,
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

tool(
  "craftos_sim_state",
  {
    description:
      "Read the simulated world state of a session: chat messages, the computer's own redstone (redstone.outputs per side, inputs, bundledOutputs), virtual inventory contents, peripheral state (speakers, detectors, ME/RS bridges, QIO), the turtle and its block world; with the vhcctweaks addon also token balances, the transaction ledger, the host and who is authenticated. delta:true returns only what changed since the previous sim call (changed values as {from,to}, new chat and ledger entries as `appended`), which is usually a few lines.",
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

tool(
  "craftos_session_list",
  {
    description:
      "List live sessions: `sessions` are yours; `others` (only when there are any) are computers someone else started, such as a person in the viewer, with who owns each. You can look at and drive those too, but craftos_session_destroy leaves them running unless you pass force.",
  },
  async () => {
    const me = clientOwner();
    const mine = [];
    const others = [];
    for (const s of sessions.list()) {
      const owner = sessions.ownerOf(s.id);
      if (!owner || owner === me) mine.push(s);
      else others.push({ id: s.id, owner, running: s.running });
    }
    return {
      content: [text({ sessions: mine, ...(others.length ? { others } : {}) })],
    };
  },
);

tool(
  "craftos_session_destroy",
  {
    description:
      "Stop a session and delete its scratch data. A session someone else started (craftos_session_list's `others`) is left running with an error naming its owner, unless force is true.",
    inputSchema: {
      id: sessionId,
      force: z
        .boolean()
        .default(false)
        .describe("Stop it even if someone else started it."),
    },
  },
  async ({ id, force }) => {
    try {
      await sessions.destroy(id, { by: clientOwner(), force });
      return { content: [text(`destroyed ${id}`)] };
    } catch (error) {
      return failure(error);
    }
  },
);

tool(
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

tool(
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
      if (!(key in Keys)) throw new Error(unknownKey(key));
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

tool(
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

tool(
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

tool(
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

tool(
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

tool(
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

tool(
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

tool(
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

tool(
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
      // paused (craftos_clock): the engine jumps its clock itself; the timers' events wait for the clock to run
      if (worldClockFor(sessions).current.paused && handle.clock) {
        await waitForClock(handle, handle.clock("advance", seconds * 1000));
        return {
          content: [
            text({
              applied: true,
              paused: true,
              note: "the world is paused: the timers that fell due fire when craftos_clock resumes or steps",
            }),
          ],
        };
      }
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

tool(
  "craftos_clock",
  {
    description:
      'The clock of every computer at once (the same controls as the browser app\'s bar): pause (every computer stops at its next yield, then the clock stands still; no \'too long without yielding\'), resume (timers go on where they were, nothing fires in a burst), step (pause and run `ticks` ticks of 1/20 s), speed (1-1000 times faster, or "max": skip idle time to the next timer), jump (`amount` ahead, e.g. "90s", "5m", "2h", "1d" = a Minecraft day; the timers on the way fire one at a time, in order, and the programs run between them, so a sleep loop runs every round that fits), time (set the time of day, "18:00"), status. Returns paused, speed and the world\'s time of day. For one computer\'s own jump use craftos_advance.',
    inputSchema: {
      action: z.enum([
        "status",
        "pause",
        "resume",
        "step",
        "speed",
        "jump",
        "time",
      ]),
      ticks: z.number().int().min(1).max(1200).optional(),
      speed: z
        .union([z.number().min(0.1).max(1000), z.literal("max")])
        .optional(),
      amount: z.string().optional(),
    },
  },
  async ({ action, ticks, speed, amount }) => {
    try {
      const clock = worldClockFor(sessions);
      if (action === "pause") await clock.pause();
      else if (action === "resume") await clock.resume();
      else if (action === "step") await clock.step(ticks ?? 1);
      else if (action === "speed") {
        if (speed === undefined)
          throw new Error('speed needs speed: a number or "max"');
        await clock.setSpeed(speed);
      } else if (action === "jump") {
        if (!amount) throw new Error('jump needs amount, e.g. "5m"');
        await clock.jump(parseDuration(amount));
      } else if (action === "time") {
        if (!amount) throw new Error('time needs amount, e.g. "18:00"');
        const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(amount);
        if (!m)
          throw new Error('time is a time of day such as "06:00" or "18:30"');
        const now = (await clock.status()).worldMs ?? 0;
        const into =
          (((((Number(m[1]) + Number(m[2]) / 60 - 6) % 24) + 24) % 24) / 24) *
          DAY_MS;
        let at = Math.floor(now / DAY_MS) * DAY_MS + into;
        if (at < now) at += DAY_MS;
        await clock.setWorldTime(at);
      }
      const status = await clock.status();
      return {
        content: [
          text({
            paused: status.paused,
            stopped: status.stopped,
            speed: status.speed,
            time: status.time,
            computers: status.computers.length,
          }),
        ],
      };
    } catch (error) {
      return failure(error);
    }
  },
);

tool(
  "craftos_world_snapshot",
  {
    description:
      "Save the whole world (every session's files and label, players, items, chat, peripherals, a turtle's blocks, the time of day) under a name, list the saved ones, restore one (each computer reboots into it; sessions that are gone are made again, the viewer's computers made after it are closed, other sessions are left alone; a computer on a person's folder, live, has that folder put back exactly: changed files written back, files made since removed, a copy of each in `folders[].backup`), delete one, or move one as a .craftos-world file: export writes it to `file`, import reads `file`. The browser app's Snapshots button uses the same ones.",
    inputSchema: {
      action: z.enum(["list", "save", "restore", "delete", "export", "import"]),
      name: z.string().optional(),
      file: z
        .string()
        .optional()
        .describe("export/import: a path, relative to the workspace"),
    },
  },
  async ({ action, name, file }) => {
    try {
      const hooks = snapshotHooksFor(sessions);
      const need = (v: string | undefined, what: string): string => {
        if (!v) throw new Error(`${action} needs ${what}`);
        return v;
      };
      const path = (f: string): string =>
        resolveInWorkspace(config.workspaceDir, f);
      let result: unknown;
      if (action === "list") result = listSnapshots(config);
      else if (action === "save")
        result = await saveSnapshot(
          sessions,
          config,
          need(name, "name"),
          hooks,
        );
      else if (action === "restore")
        result = await restoreSnapshot(
          sessions,
          config,
          need(name, "name"),
          hooks,
        );
      else if (action === "delete") {
        deleteSnapshot(config, need(name, "name"));
        result = { deleted: name };
      } else if (action === "export") {
        const to = path(need(file, "file"));
        writeFileSync(to, snapshotFile(config, need(name, "name")));
        result = { file: to };
      } else {
        result = importSnapshot(
          config,
          readFileSync(path(need(file, "file"))),
          name,
        );
      }
      return { content: [text(result)] };
    } catch (error) {
      return failure(error);
    }
  },
);

tool(
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

tool(
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
        if (!(key in Keys)) throw new Error(unknownKey(key));
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

tool(
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

tool(
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

/** What each session's screens looked like at its last craftos_read_terminal, by window: for delta reads. */
const lastRead = new Map<string, Map<number, string>>();

/** Screens with the ones unchanged since the last read (when delta) cut down to a marker; remembers these. */
function terminalDelta<
  T extends { window: number; peripheral?: string | undefined },
>(
  id: string,
  screens: T[],
  delta: boolean,
): (T | { window: number; peripheral?: string; unchanged: true })[] {
  // a session id is never reused, so entries of destroyed sessions only cost their few strings; drop them anyway
  for (const known of lastRead.keys())
    if (!sessions.list().some((s) => s.id === known)) lastRead.delete(known);
  const before = lastRead.get(id);
  const now = new Map<number, string>();
  const out = screens.map((s) => {
    const key = JSON.stringify(s);
    now.set(s.window, key);
    if (!delta || before?.get(s.window) !== key) return s;
    return {
      window: s.window,
      ...(s.peripheral !== undefined && { peripheral: s.peripheral }),
      unchanged: true as const,
    };
  });
  lastRead.set(id, now);
  return out;
}

tool(
  "craftos_read_terminal",
  {
    description:
      "Read the current text of the terminal and every monitor. delta:true gives a screen that has not changed since the previous read_terminal of this session as just {window, peripheral?, unchanged: true}.",
    inputSchema: {
      id: sessionId,
      fullScreens: fullScreensSchema,
      delta: deltaSchema,
    },
  },
  async ({ id, fullScreens, delta }) => {
    try {
      const screens = trimScreens(stripPng(sessions.screens(id)), fullScreens);
      return { content: [text(terminalDelta(id, screens, delta))] };
    } catch (error) {
      return failure(error);
    }
  },
);

tool(
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
        content: [
          text(trimScreens(stripPng(screens))),
          ...screensToContent(screens),
        ],
      };
    } catch (error) {
      return failure(error);
    }
  },
);

// ---- help, resources and prompts ------------------------------------------

/** Public docs that ship with the package (docs/*.md), by name without .md. */
function docNames(): string[] {
  try {
    return readdirSync(join(REPO_ROOT, "docs"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

const EXAMPLES_DIR = join(REPO_ROOT, "workspace", "examples");
/** Example programs that ship with the package, as paths under workspace/examples. */
function exampleFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(lua|md|json)$/.test(name))
        out.push(relative(EXAMPLES_DIR, full).split("\\").join("/"));
    }
  };
  walk(EXAMPLES_DIR);
  return out.sort();
}

const HELP_TOPICS = ["guide", "world", "ccunit", "worlds", "docs"] as const;

function helpText(topic: (typeof HELP_TOPICS)[number]): string {
  switch (topic) {
    case "guide":
      return GUIDE;
    case "world":
      return JSON.stringify(worldJsonSchema());
    case "ccunit":
      return CCUNIT_GUIDE;
    case "worlds":
      return `Saved worlds (worldFile: "<name>"): ${worldNames().join(", ") || "none"}. A workspace .json file works too (worldFile: "door.world.json").`;
    case "docs":
      return `Docs (resource craftos://docs/<name>): ${docNames().join(", ") || "none"}. Examples (craftos://examples/<path>): ${exampleFiles().slice(0, 80).join(", ") || "none"}.`;
  }
}

tool(
  "craftos_help",
  {
    description:
      'How to use this server, on request: topic "guide" (the workflow and the facts that bite), "world" (the full JSON Schema of `world`, every field described), "ccunit" (the test API), "worlds" (saved worlds for worldFile), "docs" (docs and examples to read).',
    inputSchema: { topic: z.enum(HELP_TOPICS).default("guide") },
  },
  async ({ topic }) => ({ content: [text(helpText(topic))] }),
);

server.registerResource(
  "guide",
  "craftos://guide",
  {
    title: "How to use craftos-mcp",
    description: "The workflow, ccunit and the facts that bite.",
    mimeType: "text/markdown",
  },
  async (uri) => ({ contents: [{ uri: uri.href, text: GUIDE }] }),
);

server.registerResource(
  "world-schema",
  "craftos://schema/world",
  {
    title: "World schema",
    description:
      "JSON Schema of the `world` argument of craftos_run, craftos_test, craftos_session_create and craftos_network_create.",
    mimeType: "application/schema+json",
  },
  async (uri) => ({
    contents: [{ uri: uri.href, text: JSON.stringify(worldJsonSchema()) }],
  }),
);

server.registerResource(
  "world",
  new ResourceTemplate("craftos://worlds/{name}", {
    list: async () => ({
      resources: worldNames().map((name) => ({
        uri: `craftos://worlds/${name}`,
        name,
        mimeType: "application/json",
      })),
    }),
  }),
  {
    title: "Saved world",
    description: "A world in the worlds folder, for worldFile.",
  },
  async (uri, { name }) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(loadNamedWorld(config.worldsDir, String(name))),
      },
    ],
  }),
);

server.registerResource(
  "doc",
  new ResourceTemplate("craftos://docs/{name}", {
    list: async () => ({
      resources: docNames().map((name) => ({
        uri: `craftos://docs/${name}`,
        name,
        mimeType: "text/markdown",
      })),
    }),
  }),
  {
    title: "Doc",
    description: "A craftos-mcp doc (peripherals, turtles, addons).",
  },
  async (uri, { name }) => {
    if (!docNames().includes(String(name)))
      throw new Error(
        `no doc ${String(name)}; there are: ${docNames().join(", ")}`,
      );
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: readFileSync(
            join(REPO_ROOT, "docs", `${String(name)}.md`),
            "utf8",
          ),
        },
      ],
    };
  },
);

server.registerResource(
  "example",
  new ResourceTemplate("craftos://examples/{+path}", {
    list: async () => ({
      resources: exampleFiles().map((path) => ({
        uri: `craftos://examples/${path}`,
        name: path,
      })),
    }),
  }),
  { title: "Example", description: "An example program or test." },
  async (uri, { path }) => {
    const rel = String(path);
    if (!exampleFiles().includes(rel)) throw new Error(`no example ${rel}`);
    return {
      contents: [
        { uri: uri.href, text: readFileSync(join(EXAMPLES_DIR, rel), "utf8") },
      ],
    };
  },
);

server.registerPrompt(
  "new-program",
  {
    title: "Write and test a CC program",
    description:
      "Write a CC:Tweaked program, run it in the emulator and lock it in with a test.",
    argsSchema: {
      what: z.string().describe("What the program should do."),
      file: z.string().optional().describe('Its file, e.g. "door.lua".'),
    },
  },
  ({ what, file }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Write a CC:Tweaked Lua program${file ? ` in ${file}` : ""} that does this: ${what}\n\n` +
            "Then, with the craftos tools:\n" +
            '1. Check craftos_info for the version and addons, and pick a world if it needs peripherals (craftos_help {topic:"world"}).\n' +
            "2. craftos_run it and read the screens and any error {file, line}; fix and run again until it works.\n" +
            `3. Write ${file ? file.replace(/\.lua$/, "") : "<name>"}.test.lua with ccunit (craftos_help {topic:"ccunit"}): pure logic with ccunit.eq, the screen with ccunit.run + ccunit.contains.\n` +
            "4. craftos_test it until every test passes, and say what you checked.",
        },
      },
    ],
  }),
);

server.registerPrompt(
  "add-tests",
  {
    title: "Add tests to a CC program",
    description: "Write ccunit tests for an existing program and run them.",
    argsSchema: { file: z.string().describe("The program to test.") },
  },
  ({ file }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Add ccunit tests for ${file}. Read it first (craftos_read_file), then write ${file.replace(/\.lua$/, "")}.test.lua ` +
            '(craftos_help {topic:"ccunit"}): cover its logic with ccunit.eq and its screens with ccunit.run and ccunit.screen. ' +
            "Run them with craftos_test; a failing test is either a bug in the program (say so) or in the test (fix it).",
        },
      },
    ],
  }),
);

server.registerPrompt(
  "debug-ui",
  {
    title: "Debug a CC program's screen",
    description:
      "Drive a program in a session and find out why its screen or touches misbehave.",
    argsSchema: {
      program: z.string().describe("The program, e.g. startup.lua."),
      problem: z.string().optional().describe("What goes wrong."),
    },
  },
  ({ program, problem }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Debug ${program}${problem ? `: ${problem}` : ""}.\n` +
            "Start it in craftos_session_create (with the monitors and world it needs) and run it. Read the screen as data with " +
            "craftos_ui, drive it with craftos_act or craftos_script, check with craftos_expect, and use craftos_trace for events " +
            "and errors. Only take a craftos_screenshot to see how something looks. Fix the cause, then add a test.",
        },
      },
    ],
  }),
);

// CRAFTOS_TOOLS=core: the lean set (CORE_TOOLS); everything else goes before a client ever lists the tools
if (toolSet === "core")
  for (const [name, made] of registered)
    if (!CORE_TOOLS.has(name)) made.remove();

/**
 * A tool list without what the SDK adds that tells a client nothing: the JSON Schema `$schema` line on every input
 * schema, the ±2^53 bounds zod puts on every integer, and `execution: {taskSupport: "forbidden"}`, which is the
 * default. Together about a tenth of tools/list, which a client sends along with every request.
 */
export function leanToolList<T>(result: T): T {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (!value || typeof value !== "object") return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "$schema") continue;
      if (k === "maximum" && v === Number.MAX_SAFE_INTEGER) continue;
      if (k === "minimum" && v === Number.MIN_SAFE_INTEGER) continue;
      out[k] = strip(v);
    }
    return out;
  };
  const r = result as { tools?: Record<string, unknown>[] };
  if (!Array.isArray(r.tools)) return result;
  return {
    ...r,
    tools: r.tools.map(({ execution, ...t }) => {
      const lean = strip(t) as Record<string, unknown>;
      const support = (execution as { taskSupport?: string } | undefined)
        ?.taskSupport;
      return execution && support !== "forbidden"
        ? { ...lean, execution }
        : lean;
    }),
  } as T;
}
{
  // the SDK's own tools/list handler, wrapped: Protocol keeps its handlers in _requestHandlers (SDK 1.32)
  const handlers = (
    server.server as unknown as {
      _requestHandlers?: Map<
        string,
        (request: unknown, extra: unknown) => Promise<unknown>
      >;
    }
  )._requestHandlers;
  const list = handlers?.get("tools/list");
  if (handlers && list)
    handlers.set("tools/list", async (request, extra) =>
      leanToolList(await list(request, extra)),
    );
}

const viewerPort = process.env["CRAFTOS_VIEWER_PORT"] ?? "7878";
if (viewerPort !== "off") {
  startViewer({
    port: Number(viewerPort),
    sessions,
    lastRun: () => lastRun,
    onUrl: (url) => (viewerUrl = url),
  });
}

const shutdown = (): void => {
  void sessions.destroyAll().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("close", shutdown);

await server.connect(new StdioServerTransport());
