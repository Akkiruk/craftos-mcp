# Addon modules

Each mod besides CC:Tweaked is an addon that a world can switch off (`world.addons`, or `CRAFTOS_ADDONS` for the
MCP server; see `packages/runner/src/addons.ts`). A module is a folder here, listed in `modules.lua`:

- `types.lua` returns `{ addon = "<addon id>", types = { "<peripheral type>", ... }, worldKeys = { "<key>" }? }`.
  It is read at every boot, so keep it to that table. An addon may have several modules (Mekanism's QIO lives in
  `../mek/`, its other machines in `mekanism-machines/`).
- Optional in `types.lua`: `rom = true` (or a folder name) when the mod's jar puts files into CC's ROM
  (`data/computercraft/lua/rom/...`). Keep them, as the jar has them, in `<module>/rom/`; with the addon on they show
  at `/rom/...` from boot (APIs loaded, autorun run, programs on the shell path), with it off they do not exist
  (`../romfiles.lua`). `boot = true` loads `init.lua` at every boot, for a mod that adds an API to every computer.
- `init.lua` returns `function(core, host) return module end`. It is loaded the first time the world builds one of
  its types, or at boot when the world has one of its `worldKeys`. Never when the addon is off.

The same types must be listed in `ADDONS` in `packages/runner/src/addons.ts`, which refuses a world that uses a
type of an addon that is off before the computer boots.

## Types by Minecraft version (`byVersion`)

A mod can rename, drop or add peripheral types from one Minecraft version to the next (Advanced Peripherals reports
`player_detector` on 1.21.1 where 1.18.2 says `playerDetector`). `types.lua` says so with an optional `byVersion`,
and the addon's `ADDONS` entry has the same data as `byVersion` (`AddonInfo.byVersion`, `AddonTypeChanges`):

```lua
return {
  addon = "advanced-peripherals",
  types = { "playerDetector", "redstoneIntegrator", "newBlock" }, -- canonical (1.18.2) names, plus every `added` type
  byVersion = {
    ["1.21.1"] = {
      rename = { playerDetector = "player_detector" },        -- canonical -> what the mod reports there
      removed = { "redstoneIntegrator" },                     -- canonical types it does not have there
      added = { "newBlock" },                                 -- types only the versions listing them have
      note = { redstoneIntegrator = "replaced by CC:Tweaked's redstone_relay" }, -- why, for the refusal
    },
  },
}
```

- The canonical name is the one in `types`. Every name in `byVersion` is canonical except `rename`'s values (and
  `added`, which are listed in `types` too).
- `rename`: a world may name the block by either name. The sim maps it to the canonical name first, so the module is
  loaded and called with `def.type` canonical (`def.reportedType` is what the version reports). `peripheral.getType`,
  `hasType` and `find` then give the version's name: `p.types` unset is `{ reportedType }`; set, its canonical entry is
  replaced and the rest (`"inventory"`, ...) kept. A block on a cable with no name is called `<reported>_<n>`.
- `removed` / `added`: a world using a type where the version does not have it is refused before boot by the runner
  (naming the version and the `note`), and the Lua side refuses it too (`../typenames.lua`).
- An addon with several modules can put its `byVersion` in any of them: they are merged. Advanced Peripherals is not a
  module here; its `byVersion` goes in `../ap/types.lua`.
- `packages/runner/src/type-versions.integration.test.ts` checks that every `byVersion` here equals the one in
  `ADDONS`.

## A mod whose computer is a mob

An android or a drone is not a peripheral: the computer itself is the mob, the way a world's `turtle` makes it a
turtle. Such a module has a world key (`android`, `drone`, `dronePlus`, `acDrone`) and no types of its own. Its
`init.lua`, loaded at boot because the world has the key, makes the mob with `../mob.lua`:

```lua
local mob = dofile("/rom/ccsim/mob.lua")(core, { x = spec.x, y = spec.y, z = spec.z })
mob.onInstall = function(brain) _G.android = api end -- the block world is there: put the API in place
mob.onTick = function(age) end                       -- one game tick, 20 a second on the computer's clock
mob.busy = function() return false end               -- false: at rest, ticks are run a second at a time
mob.sideDir = function(side) return nil end          -- which way a side's block is ("down", "north", ...), or nil
```

`../init.lua` then loads the block world a turtle uses (`../turtle/brain.lua`) around it and calls `mob.install`.
`mob` has what such mods share: a position with fractions, CC's argument checks (`mob.args`), `mob.onMainThread`
for `mainThread = true` methods, entities, a ray cast, walking paths, and the sim commands `mobSpawn`, `mobMove`,
`mobRemove`, `mobDropItem` and `mobSetBlock` (`mob.handlers`; add them to the module's own). An API function calls
`mob.sync()` first (`mob.synced(api)` wraps a whole table), so the ticks a resting mob slept through are run before
anything changes. The screen of the mob's computer is in `packages/runner/src/mobs.ts`.

## The module

```lua
{
  peripheral = function(def) return p end, -- def: the world.peripherals entry (name, type, fixture fields)
  handlers = { cmdName = function(cmd) return ok, err end }, -- craftos_sim_command commands
  catchUp = function() end,  -- machines on the virtual clock: bring them up to os.epoch("utc") before anything looks
  state = function() return {} end, -- addon-wide state, in sim state under addons.<module>
  globals = { name = api }, -- Lua APIs the mod adds to every computer (ILuaAPI); set in _G when the module loads
}
```

A mod whose API is a global (`globals`) and not a block has no type to load it by, so it needs a `worldKey`: the
world switches it on with that key (`{}` is enough), and the module loads at boot, before the program runs.

`p`, one peripheral:

- `methods`: name to function. Errors are thrown as `error(message, 0)` (a Java LuaException).
- `methodOrder`: peripheral.getMethods order, when the mod's order is known (CC's HashMap order, see
  `../mek/qio.lua`). Otherwise names are sorted.
- `types`: what peripheral.getType returns, default `{ def.type }` (the sim then puts the version's name for the
  canonical one, `byVersion` above: list the canonical name here, never `def.reportedType`). Add `"inventory"`, `"fluid_storage"` or
  `"energy_storage"` when the block also has CC's generic peripherals, and set `p.inventory` / `p.tank` so
  pushItems/pullItems and pushFluid/pullFluid of other blocks can reach it.
- `computerThread`: methods that run at once on the computer thread. Every other method waits for the next server
  tick (50 ms), and every event that arrives meanwhile is lost, like a real `mainThread = true` method. Leave it out
  and every method waits.
- `validate(method, args)` and `run(method, args)`: instead of `methods`' own checks, Mekanism's way
  (`../mek/java.lua`): arguments checked on the computer thread, then run on the server tick.
- `exactReturns`: true to return exactly the values each method returns. Without it trailing nils are trimmed (the
  older fakes rely on that). Java's `MethodResult.of(null)` is one nil and an empty `Object[]` is none, so a module
  written from its source should set it and return accordingly.
- `state()`: this block's state, in sim state under `peripherals.<name>`.
- `detach()`: the block went away.

## The host

`host` gives what the peripheral layer already has: `newInventory(def)`, `newTank(def)`, `findInventory(name)`,
`find(name)` (any virtual peripheral entry), `md5`, `copy`, `fail(message)`, `checkString(i, v)`,
`checkInt(i, v)`, `itemDetail(item)`. `core` has the clock (`os.epoch`), `core.save()`, `core.touch()`,
`core.world`, `core.waitForServerTick` and `os.queueEvent` for events the mod sends.
