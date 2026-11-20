# Mekanism QIO and Quantum Entangloporter emulation

The pack runs **Mekanism 1.18.2-10.2.5.465** on CC:Tweaked 1.101.3. Every QIO block a computer can see, and the
Quantum Entangloporter, is emulated in Lua (`rom-overlay/rom/ccsim/mek/`): the full method surface in CC's own
order, Mekanism's argument checks and error strings, return shapes, and the machines themselves on the virtual clock.
This page is 1.18.2; what 1.20.1 (10.4.16) and 1.21.1 (10.7.19) change is in docs/mekanism-versions.md.

- `mek/java.lua`: the Java side of a call (argument conversion and its messages, `Double.toString`,
  `HashMap.toString`, the second `String.format`, typed NBT).
- `mek/qio.lua`: frequencies, drives, the five QIO peripherals, the importer and exporter.
- `mek/entangloporter.lua`: inventory frequencies, the entangloporter peripheral and its item ejection.

Source of truth: `github.com/mekanism/Mekanism`, branch `1.18.x` (10.2.5; the commits after the version bump touch
nothing here). Every method name, annotation and error string below was also checked
in the 10.2.5.465 jar with `javap`. CC:Tweaked behaviour comes from the 1.101.3 jar, decompiled.

## What "exactly like the real mod" means here

- **Surface: complete and ordered.** `packages/runner/src/mekanism-surface.json` lists every method of the six
  peripheral types in the order `peripheral.getMethods` returns them. CC:Tweaked puts the names in a
  `java.util.HashMap` (`PeripheralAPI.getMethods`), filled in Mekanism's binding order; the test re-derives the
  order from the source's method lists with Java's hashing, and the same calculation reproduces the measured
  wireless-modem order. QIO: 22 + 15 + 22 + 22 + 18 methods; entangloporter: 60.
- **Behaviour: written from source, not from memory.** The table below gives the file and line for each rule.
- **Data: a fixture world.** Drives, frequencies, buffers, chests and redstone come from the world; there is no
  recipe registry, item registry or tag registry beyond what the fixture says.

## Peripherals

| Type                    | Block                  | Methods (besides the common ones)                                                                                                                                                                                                                                |
| ----------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `qioDriveArray`         | QIO Drive Array        | getSlotCount, getDrive, getDriveStatus, getFrequencyItem{Count,Capacity,Percentage}, getFrequencyItemType{Count,Capacity,Percentage}                                                                                                                             |
| `qioDashboard`          | QIO Dashboard          | getCraftingInput(window, slot), getCraftingOutput(window)                                                                                                                                                                                                        |
| `qioImporter`           | QIO Importer           | getFilters, addFilter, removeFilter, get/setImport(s)WithoutFilter, get/setRedstoneMode, getInstalledUpgrades, getSupportedUpgrades                                                                                                                              |
| `qioExporter`           | QIO Exporter           | the same with get/setExport(s)WithoutFilter                                                                                                                                                                                                                      |
| `qioRedstoneAdapter`    | QIO Redstone Adapter   | getTargetItem, setTargetItem, clearTargetItem, getTriggerAmount, setTriggerAmount                                                                                                                                                                                |
| `quantumEntangloporter` | Quantum Entangloporter | hasFrequency, get/set/createFrequency, getFrequencies, getBufferItem, getBuffer{Fluid,Gas,InfuseType,Pigment,Slurry}{,Capacity,Needed,FilledPercentage}, getTemperature, getTransferLoss, getEnvironmentalLoss, energy, side config, ejector, upgrades, security |

Common to the QIO blocks: getFrequencies, hasFrequency, getFrequency, setFrequency, createFrequency,
get/set/increment/decrementFrequencyColor, getDirection, getOwnerUUID, getOwnerName, getSecurityMode.
There is no QIO method that lists, inserts or extracts items in 10.2.5: a program sees QIO contents only through
counts, the drives' NBT and what an exporter puts in a chest.

## Fixtures

```jsonc
"mekanism": {
  "gameTime": 0, "seed": 1, "knownItems": ["minecraft:diamond"],   // all optional
  "qio": {
    "frequencies": [{ "name": "Vault", "owner": "Alice", "color": "RED" }, { "name": "Mine", "public": false, "owner": "Bob" }],
    "blocks": [{ "id": "far_array", "type": "qioDriveArray", "owner": "Alice", "frequency": "Vault", "drives": [...] }],
    "inventories": [{ "name": "hidden_chest", "type": "minecraft:chest", "size": 27, "items": {...} }]
  },
  "entangloporter": {
    "frequencies": [{ "name": "Shop", "owner": "Alice", "item": {...}, "fluid": { "name": "minecraft:water", "amount": 1000 }, "energy": 5000 }],
    "blocks": [{ "id": "far_qe", "owner": "Alice", "frequency": "Shop", "loaded": false }]
  }
}
```

A computer's own blocks are `peripherals` entries (`{ "name": "qioExporter_0", "type": "qioExporter", ... }`); blocks
it cannot see go in `blocks`. Fields: `owner`, `securityMode`, `facing`, `frequency` (a name, or
`{ name, public: false }`); drive arrays `drives: [{ slot?, tier, items }]` (tiers `base`, `hyper_dense`,
`time_dilating`, `supermassive`); importers and exporters `target` (the inventory behind them, by name), `filters`,
`importWithoutFilter`/`exportWithoutFilter`, `redstoneMode`, `powered`, `speedUpgrades`, `delay`; dashboards
`crafting: [{ inputs, output }]`; redstone adapters `targetItem`, `triggerAmount`; entangloporters `adjacent`
(direction or side to inventory name), `config` (`{ ITEM: { ejecting: true, sides: { BACK: "OUTPUT" } } }`),
`ejector`, `loaded`, `anchorUpgrade`.

Items: `{ name, count, nbt, maxCount, tags, modId, displayName, ... }`. `nbt` is the item's **full** NBT, as a JSON
object (whole numbers become ints, others doubles, booleans bytes) or a typed SNBT string
(`"{vaultGear:{id:\"7f3a\",level:62},Damage:0}"`). Every distinct name + NBT is its own type, so modded
gear with unique NBT and stack size 1 is one type per piece: give it `maxCount: 1`. Extra fields travel with the item
into chests. `worlds/mekanism-qio-demo.json` has one of everything.

Runtime commands (`craftos_sim_command`): `qioSetPowered {block, powered}`, `qioSetDrive {block, slot, drive|null}`,
`qioSetSecurity {block, mode}`, `qioSetUpgrades {block, speed}`, `qioInsert`/`qioExtract {frequency, item}`
(a player using a dashboard), `qeInsert {frequency, item, public?, owner?}` (a hopper or pipe feeding an
entangloporter), `qeExtract {frequency, count?}`, `qeSetLoaded {block, loaded}`. `craftos_sim_state` has
`qio.frequencies` (contents), `qio.blocks`, `qio.inventories`, `qio.entangloporter.frequencies` and `qio.gameTime`.

## Behaviours modelled, with their source

Paths are under `src/main/java/mekanism/common/` in the Mekanism clone.

### Calls

| Behaviour                                                                                                                                                                         | Source                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Peripheral type is the block's computer name (`qioDriveArray`, ..., `quantumEntangloporter`), one type only                                                                       | `registries/MekanismBlockTypes.java:564,572,581,590,599,452`; `integration/computer/computercraft/MekanismPeripheral.java:47` |
| Methods: the tile's (with superclasses) sorted by name, then each component's (upgrade, security, config, ejector)                                                                | `integration/computer/ComputerMethodMapper.java:203`; `tile/base/TileEntityMekanism.java:1306`                                |
| `getMethods` order is CC's `HashMap` sized to the method count                                                                                                                    | CC 1.101.3 `PeripheralAPI.getMethods` (decompiled)                                                                            |
| Argument count and types are checked on the computer thread, before any wait: a bad argument fails at once and loses no events                                                    | `integration/computer/computercraft/CCMethodCaller.java:49`                                                                   |
| Every QIO and entangloporter method then runs as a main-thread task: the call waits for a server tick and throws away every other event meanwhile (as the emulator's AP calls do) | `CCMethodCaller.java:55` (no method sets `threadSafe`)                                                                        |
| `Mismatched parameter count. %s expected: '%d' arguments, but received: '%d' arguments.` (extra arguments too)                                                                    | `integration/computer/BoundComputerMethod.java:66`                                                                            |
| `Invalid argument %d, %s expected %s but received null.` (index from 0)                                                                                                           | `BoundComputerMethod.java:83`                                                                                                 |
| `Invalid argument %d, %s expected %s but received type %s with value %s.` with Java's `Double.toString` / `HashMap.toString` for the value                                        | `BoundComputerMethod.java:120`                                                                                                |
| Numbers to `int`/`long` truncate toward zero (no "integer representation" check), out of range or NaN refused                                                                     | `integration/computer/computercraft/CCArgumentWrapper.java:124`                                                               |
| Enums take a name (any case) or an ordinal                                                                                                                                        | `CCArgumentWrapper.java:141,173`                                                                                              |
| Strings are not numbers here: `setFrequency(5)` is refused                                                                                                                        | `BoundComputerMethod.java:120`                                                                                                |
| A `ComputerException` message is formatted a second time, so a `%` from a name becomes `Java Exception Thrown: java.util....Exception: ...`                                       | `BoundComputerMethod.java:177`; CC `LuaContext.issueMainThreadTask`                                                           |
| `void` returns nothing; a `null` return is one `nil` value                                                                                                                        | `BoundComputerMethod.java` `run`; `CCArgumentWrapper.noResult`                                                                |
| Items come back as `{name, count, nbt?}` (`nbt` only when the tag is not empty); empty is `{name="minecraft:air", count=0}`                                                       | `CCArgumentWrapper.java:311`                                                                                                  |
| NBT lists and arrays come back keyed from 0                                                                                                                                       | `CCArgumentWrapper.java:336`                                                                                                  |
| Frequencies come back as `{key, public}`                                                                                                                                          | `CCArgumentWrapper.java:249`                                                                                                  |
| Setters need security mode PUBLIC: `Setter not available due to machine security not being public.`                                                                               | `tile/base/TileEntityMekanism.java:1296`                                                                                      |

### QIO

| Behaviour                                                                                                                                                      | Source                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `getFrequencies` lists every public QIO frequency in the world, in creation order                                                                              | `tile/qio/TileEntityQIOComponent.java:76`; `lib/frequency/FrequencyManager`                           |
| `No frequency is currently selected.`                                                                                                                          | `TileEntityQIOComponent.java:89`                                                                      |
| `setFrequency` finds public frequencies only; `No public QIO frequency with name '%s' found.`                                                                  | `TileEntityQIOComponent.java:99`                                                                      |
| `createFrequency` refuses an existing public name; both do nothing on a block with no owner                                                                    | `TileEntityQIOComponent.java:109`; `lib/frequency/TileComponentFrequency.java` `setFrequencyFromData` |
| Colour belongs to the frequency, default INDIGO, steps through all 18 EnumColors and wraps                                                                     | `content/qio/QIOFrequency.java:91`; `TileEntityQIOComponent.java:129`                                 |
| A drive array has 12 slots; `Slot: '%d' is out of bounds, as this QIO drive array only has '%d' drive slots (zero indexed).`                                   | `tile/qio/TileEntityQIODriveArray.java:34,147`                                                        |
| Drive LEDs update on game ticks divisible by 10: FULL at the count limit, NEAR_FULL at the type limit or 75 %, READY, OFFLINE, NONE                            | `TileEntityQIODriveArray.java:63,74,75`                                                               |
| Drive tiers: base 16,000 items / 128 types, hyper-dense 128,000 / 256, time-dilating 1,048,000 / 1,024, supermassive 16,000,000,000 / 8,192                    | `tier/QIODriveTier.java:7-10`                                                                         |
| Every distinct item + NBT is a type, counted per drive and per frequency                                                                                       | `lib/inventory/HashedItem.java`; `content/qio/QIODriveData.java:37`                                   |
| A frequency refuses a new type at its type capacity and anything at its count capacity                                                                         | `QIOFrequency.java:161`                                                                               |
| Items go to drives that already hold the type first, then other drives in order                                                                                | `QIOFrequency.java:650`                                                                               |
| A type every drive refuses stays as a 0-count type                                                                                                             | `QIOFrequency.java:165`                                                                               |
| Percentages are `count / capacity` as doubles (0/0 is NaN)                                                                                                     | `TileEntityQIODriveArray.java:176`                                                                    |
| `getDrive` returns the drive item; its `qioMetaCount`/`qioMetaTypes` are live, its `qioItemMap` only as of the last save                                       | `content/qio/IQIODriveItem.java:42,52`                                                                |
| Drives are written on a random tick (1 in 100) after a change, and at every autosave (every 6,000 ticks)                                                       | `QIOFrequency.java:469`; `TileEntityQIODriveArray.saveAdditional`                                     |
| Dashboard: 3 windows; `Window '%d' is out of bounds, must be between 0 and %d.`; `Slot '%d' is out of bounds, must be between 0 and 9.`                        | `tile/qio/TileEntityQIODashboard.java:92,100`                                                         |
| Importer and exporter act on a tick, then wait 10: every 11th tick, while they may run                                                                         | `tile/qio/TileEntityQIOExporter.java:45,67`; `TileEntityQIOImporter.java`                             |
| Per operation: 64 + 32 per speed upgrade items, `round(1 + speed / 2)` types                                                                                   | `tile/qio/TileEntityQIOFilterHandler.java:97,102`                                                     |
| Exporter needs a filter unless `exportWithoutFilter`; importer imports everything by default                                                                   | `TileEntityQIOExporter.java:78`; `TileEntityQIOImporter.java:36`                                      |
| Exporter offers each type to the chest's slots from the first, then removes what went in                                                                       | `TileEntityQIOExporter.java:193,203,224`                                                              |
| Over 100 types, the exporter tries each with probability 100/types                                                                                             | `TileEntityQIOExporter.java:168,197`                                                                  |
| Importer reads the chest from the last slot; a type that is refused still uses up one of the operation's types                                                 | `TileEntityQIOImporter.java:73,80,93`                                                                 |
| Exact item filter: same item and the same NBT, typed (a filter without NBT never matches gear)                                                                 | `lib/inventory/Finder.java:25`                                                                        |
| Fuzzy item filter: same item, NBT ignored                                                                                                                      | `Finder.java:22`; `TileEntityQIOExporter.java:92`                                                     |
| Tag and mod id filters use Mekanism's wildcards (`*`, `?`, `#` for a digit), case-insensitive                                                                  | `lib/WildcardMatcher.java:15`; `TileEntityQIOExporter.java:100,103`                                   |
| Filter equality ignores the item's NBT, so `addFilter` refuses it as a duplicate and `removeFilter` removes it                                                 | `content/qio/filter/QIOItemStackFilter.java:67`; `lib/collection/HashList.java:48`                    |
| Filter tables: `type` any case; item must exist; `tag` and `modId` validated and lowercased; anything else is the `expected QIOFilter` error                   | `CCArgumentWrapper.java:406,436`                                                                      |
| `itemNBT` from Lua: numbers become the smallest tag that fits (byte, short, int, long, else float); lists need keys from 0; `{[0]=v, typeHint=3}` makes an int | `CCArgumentWrapper.java:532,558,718`                                                                  |
| Redstone control (importer, exporter): DISABLED, HIGH, LOW, PULSE (a rising edge); a computer cannot set PULSE                                                 | `util/MekanismUtils.java:386`; `TileEntityMekanism.java:546,1355`                                     |
| Redstone adapter: 15 when the stored count of its exact item is above 0 and at least the trigger                                                               | `tile/qio/TileEntityQIORedstoneAdapter.java:51`                                                       |
| `setTargetItem` messages                                                                                                                                       | `TileEntityQIORedstoneAdapter.java:169,178`                                                           |

### Quantum Entangloporter

| Behaviour                                                                                                                                                                      | Source                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One item slot (one stack, up to 64, full NBT), one fluid tank, four chemical tanks, energy and heat per frequency, shared by every entangloporter on it                        | `content/entangloporter/InventoryFrequency.java:113`                                                                                                                                            |
| Buffers: 256,000 mB fluid, 8,192,000 mB chemicals, 256,000,000 J energy (the server's general.toml)                                                                            | `config/GeneralConfig.java` `entangloporter*Buffer`                                                                                                                                             |
| `No public inventory frequency with name '%s' found.` / `Unable to create public inventory frequency ...`; private frequencies only by fixture                                 | `tile/TileEntityQuantumEntangloporter.java:280,290`                                                                                                                                             |
| Buffer getters need a frequency; empty fluid `minecraft:empty`, empty chemical `mekanism:empty`                                                                                | `TileEntityQuantumEntangloporter.java:299`; `SpecialComputerMethodWrapper`                                                                                                                      |
| Energy methods read the frequency's buffer; with no frequency they are 0, and the percentage is 1                                                                              | `TileEntityMekanism.java:1315-1349`; `FloatingLong.divideToLevel`                                                                                                                               |
| Default side config: every side INPUT, the front OUTPUT; heat INPUT_OUTPUT everywhere and cannot eject                                                                         | `TileEntityQuantumEntangloporter.java:106,125,126`                                                                                                                                              |
| Modes NONE, INPUT, OUTPUT, INPUT_OUTPUT (heat: NONE, INPUT_OUTPUT); increment/decrement skip unsupported ones                                                                  | `tile/component/config/ConfigInfo.java:193`                                                                                                                                                     |
| Config errors                                                                                                                                                                  | `tile/component/TileComponentConfig.java:405,431`                                                                                                                                               |
| Ejector colours: the 12 transporter colours, nil means none, increment and decrement pass through nil                                                                          | `util/TransporterUtils.java:29`; `tile/component/TileComponentEjector.java:356`                                                                                                                 |
| Items eject only with a frequency and ejecting on: every 11th tick per entangloporter                                                                                          | `TileEntityQuantumEntangloporter.java:112`; `TileComponentEjector.java:120,227`                                                                                                                 |
| Each ejection offers the whole slot to the output sides (OUTPUT, then INPUT_OUTPUT), in direction order down, up, north, south, west, east, filling slots from the first       | `TileComponentEjector.java:200`; `lib/inventory/TransitRequest.java:90`                                                                                                                         |
| An unloaded entangloporter does not tick; the frequency and its contents stay                                                                                                  | `InventoryFrequency.java:242` (`activeQEs`)                                                                                                                                                     |
| CC's `pushItems`/`pullItems` naming an entangloporter: `getTarget()` is the tile, CC asks for the item handler with no side, Mekanism hands out a read-only proxy: both move 0 | CC `InventoryMethods.extractHandler`; `capabilities/resolver/BasicSidedCapabilityResolver.java:65`; `capabilities/proxy/ProxyHandler.java:22`; `capabilities/proxy/ProxyItemHandler.java:38,43` |
| The null side's handler has the frequency's one slot (`From slot out of range (between 1 and 1)`); without a frequency there is no handler: `is not an inventory`              | `capabilities/holder/ConfigHolder.java:78`; `capabilities/resolver/manager/CapabilityHandlerManager.java:58`; CC `ArgumentHelpers.assertBetween`                                                |

So a computer cannot put items into an entangloporter or take them out with CC's inventory methods. Items
reach a frequency through a hopper, pipe or machine on an input side (`qeInsert` in the sim), and leave through an
output side with ejecting on, into an inventory the computer can then read.

## Could not be confirmed from source

These are written down as Open rows in `docs/conformance/emulator-vs-real-deviations.md` (rows 48-57).

- **Orders that depend on Java object hashes.** Filtered exports walk an `Object2LongOpenHashMap` keyed by
  `HashedItem`, whose hash includes `Item.hashCode()` (an identity hash); drives that already hold a type are a
  `HashSet`; a drive's `qioItemMap` is written from a hash map. The emulator uses fixture/insertion order.
- **`HashMap.toString` of a table argument** when two keys share a bucket (e.g. `x`, `name`, `count`): their order is
  Cobalt's table order, which the emulator cannot see.
- **`Double.toString`** in messages: shortest round-trip digits (checked against a JDK 21). Minecraft 1.18 runs on
  Java 17, whose older algorithm differs for a few rare values.
- **Random tick saves of drives** use Mekanism's own `Random`; the emulator draws from its own seeded generator.
- **Game time and the autosave phase.** The emulator starts at `mekanism.gameTime` (default 0) and autosaves at
  multiples of 6,000 game ticks; the server counts autosaves from its own start.
- **Main-thread waits.** Like the AP methods, the emulator waits one timer tick; the real computer receives a
  `task_complete` event that other coroutines (in `parallel`) can see.
- **Item registry and tags.** Without `knownItems`, every valid name except `minecraft:air` exists. Tags and mod ids
  come from the fixture.
- **Entangloporter heat, losses and non-item buffers.** Temperature, `getTransferLoss`, `getEnvironmentalLoss` and
  the fluid/chemical/energy buffers are fixture values; their transfer to neighbouring tanks and cables is not
  simulated.
- **Dashboard crafting output** is the fixture's; the real one comes from the recipe in the grid.
- **Several computers.** Each computer has its own copy of the QIO world (as for every virtual peripheral on a
  wired network); a reboot restores the fixture.
