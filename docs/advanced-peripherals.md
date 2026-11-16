# Advanced Peripherals emulation

Every Advanced Peripherals (AP) peripheral that is **enabled in your server's config** is
emulated in Lua (`rom-overlay/rom/ccsim/ap/`), with the full method surface, argument checking,
return values, error strings, cooldowns and config values of the real mod.

## What "100%" means here

- **Surface: complete.** A test (`ap.integration.test.ts`, "API surface") asserts that every
  `@LuaFunction` name, aliases included, of each enabled peripheral exists, plus the methods
  AP adds to all peripherals (`getName`, `getConfiguration`) and the operation/fuel plugin
  methods. That is 134 peripheral methods across 9 types. All of them were also confirmed to
  exist in the 0.7.31r jar your pack ships.
- **Behaviour: written from source, not from memory.** Semantics come from the 0.7.30r source
  (the newest 1.18.2 tag; there is no tag for 0.7.31r). Where I could not confirm 0.7.31r
  behaves the same I say so below.
- **Data: a fixture world, not a real Minecraft server.** Items, fluids, players, energy and
  the environment are whatever you put in the world. Nothing is simulated beyond moving
  items and fluids, so results are only as realistic as the fixture.

## Which peripherals exist

Decided by your instance's `peripherals.toml`:

| Peripheral                                                                                                               | Emulated             | Why                                                                        |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------- | -------------------------------------------------------------------------- |
| `playerDetector`, `chatBox`, `energyDetector`, `environmentDetector`, `redstoneIntegrator`, `nbtStorage`, `arController` | Yes                  | enabled                                                                    |
| `meBridge` (AE2 11.7.6 is installed), `rsBridge` (Refined Storage 1.10.6 is installed)                                   | Yes                  | enabled                                                                    |
| `blockReader`, `geoScanner`, `inventoryManager`                                                                          | **No, deliberately** | disabled in the config; a disabled peripheral does not exist on the server |
| `colonyIntegrator`                                                                                                       | No                   | enabled in config but MineColonies is not installed                        |
| turtle / pocket / automata cores, `compass`, chunky turtle                                                               | No                   | turtle and pocket peripherals                                              |
| `beacon`, `note_block` integrations (AP adds these to vanilla blocks)                                                    | No                   | not used by your scripts; not built                                        |

## Fixtures

Every peripheral is a `peripherals` entry in the world: `{ "name": ..., "type": ..., ... }`
with a position (`x`, `y`, `z`, `dimension`) and a `customName` for `getName()`.

- **playerDetector**: players come from `players` (position, dimension, online).
- **chatBox**: messages land in the chat log (`craftos_sim_state`).
- **energyDetector**: `transferRate`, `transferRateLimit`.
- **redstoneIntegrator**: `inputs: { south: 9 }`, `orientation: { front: "north" }`.
- **nbtStorage**: `stored`.
- **environmentDetector**: world-level `environment` (`time`, `raining`, `thunder`, `biome`,
  `skyLight`, `blockLight`, `moonPhase`, `dimensions`) and `entities`.
- **meBridge / rsBridge**: `items`, `fluids`, `craftableItems`, `craftableFluids`, `energy`,
  `adjacent` (side to inventory name), plus ME `cells` and `cpus`, RS `patterns` and `storage`.
- **inventories** (`minecraft:chest`, ...) and **`fluid_storage`** tanks are the targets of bridge transfers.
- **arController**: the canvas is recorded (`state.peripherals.<name>.canvas`).

Runtime commands (`craftos_sim_command`): `setEnergyTransferRate`, `setRedstoneInput`,
`completeCraft`, `setNetworkConnected`, `setEnvironment`, `addEntity`, `chat`, `playerClick`,

`setItem`.

`worlds/advanced-peripherals-demo.json` has one of every peripheral.

## Events

Only what the source fires: `chat` (`username, message, uuid, isHidden`) to chat boxes,
`playerClick` (`username`) to player detectors, and `crafting` (`success, message`) from

`meBridge.craftItem`. A message starting with `$` arrives with its `$` signs removed and `isHidden` true.
There are no `playerJoin` / `playerLeave` events in this AP version.

## Behaviours worth knowing (all from the source)

- Ranges are **boxes**, not spheres, centred on the detector block; the maximum edge is
  exclusive; players in another dimension never match. `getPlayersInCubic(x, y, z)` uses
  extents of `2x`, `2y`, `2z`.
- `getPlayerPos` returns `{}` for unknown, offline or out-of-dimension players, and reports
  `yaw`, `pitch`, `dimension` and `eyeHeight` as well as the floored coordinates.
    <!-- @public: - Chat: a 100 ms cooldown (`chatMessage is on cooldown`); unknown players give -->
    <!-- @public:   `nil, "incorrect player name/uuid"`; the two `sendFormatted*` methods take a JSON text component. -->

- `environmentDetector.scanEntities` has a 2 s cooldown, refuses radius > 16 with
  `Radius is exceed max value`, and costs no fuel because powered peripherals are off.
  <!-- @public:   `isSlimeChunk()` is vanilla's answer for the detector's chunk and `environment.seed` (default 0). -->

- ME bridge: `listCraftableItems` reproduces AE2/AP's odd behaviour (an unstocked craftable is
  only listed once a stored non-craftable key is seen). Unknown items from `getItem` return `{}`.
  Exporting to a side with no inventory raises a null-pointer error, as the real mod does.
  RS bridge: the same situation returns `0, "INVALID_TARGET"`.
- `getItem` on an ME bridge reports `nbt` as AE2's key tag (`{ id = <name>, tag = <nbt> }`); the
  RS bridge reports plain NBT, or `nil` when there is none, and `tags` is `nil` when empty.
- Fingerprints are `md5(nbt string + name + display name)` as in AP. That is exact for stacks
  without NBT (the MD5 matches Python's). With NBT the exact Minecraft tag formatting is not
  reproduced, so give such items an explicit `fingerprint`.

## Approximations and known gaps

- **Version:** source is 0.7.30r; the pack has 0.7.31r. All method names match. Behaviour changes
  between the two, if any, are not known.
- **Crafting:** `craftItem` records a job and fires the `crafting` event; nothing is produced
  until you send `completeCraft`. CPU progress, patterns' real resource checks and RS
  calculation results (only `craftResult` in the fixture) are not simulated.
- **Display names** default to a title-cased registry name (`minecraft:iron_ingot` becomes
  `Iron Ingot`); real names come from language files. Set `displayName` when it matters.
- **Tags** come from the fixture (`tags: ["minecraft:item/forge:ingots/gold"]`), not from a registry.
- **nbtStorage:** `writeJson` accepts stringified NBT (SNBT) with a simplified parser; error
  messages are approximate, and values round-trip as plain Lua numbers/strings/tables rather
  than typed NBT.
- **chatBox `range`** uses an inclusive box; the real code uses the same exclusive-edge box as
  the detector.
- **arController** records draw calls; nothing is rendered and there is no goggles player.
- **ME storage totals** use fixture cells (`usedBytes` or the AP formula over the fixture items).
- **On a wired network** (`wired[].peripherals`) one computer on the cable holds each peripheral and the others call it
  through a relay, so every computer sees the same chest, as in the real game.
