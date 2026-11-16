# Addon modules

Each mod besides CC:Tweaked is an addon that a world can switch off (`world.addons`, or `CRAFTOS_ADDONS` for the
MCP server; see `packages/runner/src/addons.ts`). A module is a folder here, listed in `modules.lua`:

- `types.lua` returns `{ addon = "<addon id>", types = { "<peripheral type>", ... }, worldKeys = { "<key>" }? }`.
  It is read at every boot, so keep it to that table. An addon may have several modules (Mekanism's QIO lives in
  `../mek/`, its other machines in `mekanism-machines/`).
- `init.lua` returns `function(core, host) return module end`. It is loaded the first time the world builds one of
  its types, or at boot when the world has one of its `worldKeys`. Never when the addon is off.

The same types must be listed in `ADDONS` in `packages/runner/src/addons.ts`, which refuses a world that uses a
type of an addon that is off before the computer boots.

## The module

```lua
{
  peripheral = function(def) return p end, -- def: the world.peripherals entry (name, type, fixture fields)
  handlers = { cmdName = function(cmd) return ok, err end }, -- craftos_sim_command commands
  catchUp = function() end,  -- machines on the virtual clock: bring them up to os.epoch("utc") before anything looks
  state = function() return {} end, -- addon-wide state, in sim state under addons.<module>
}
```

`p`, one peripheral:

- `methods`: name to function. Errors are thrown as `error(message, 0)` (a Java LuaException).
- `methodOrder`: peripheral.getMethods order, when the mod's order is known (CC's HashMap order, see
  `../mek/qio.lua`). Otherwise names are sorted.
- `types`: what peripheral.getType returns, default `{ def.type }`. Add `"inventory"`, `"fluid_storage"` or
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
