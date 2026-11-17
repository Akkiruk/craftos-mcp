# Plethora Peripherals emulation

Plethora Peripherals is **not in the pack**. The emulator follows Lemmmy and SwitchCraft's Fabric port of SquidDev's
Plethora, **1.20.1-1.13.0** (Modrinth `plethora-peripherals`), read from `github.com/SwitchCraftCC/Plethora-Fabric` at
`30c2b5d` ("feat: v1.13.0", the release commit). The Modrinth jar for 1.20.1-1.13.0 was checked: every error message
below is a string constant in it, and `core/executor/Task.class` keeps the local name `next` that the
`filterModules` NullPointerException quotes. Nothing here was measured in game.

| Minecraft | Release       | Loader |
| --------- | ------------- | ------ |
| 1.20.1    | 1.20.1-1.13.0 | Fabric |
| 1.18.2    | none          |        |
| 1.21.1    | none          |        |

The port's releases are all for 1.19.3, 1.19.4 and 1.20.1 (the original Plethora stops at 1.12.2), so a world needs
`"version": "1.20.1"`. CC:Tweaked is then 1.121.0; Plethora asks for at least 1.117.0, and its argument checks follow
`IArguments` as it is in both.

The addon id is `plethora`. The Lua is `rom-overlay/rom/ccsim/addons/plethora/` (`init.lua`, `canvas.lua` for the
glasses, `vanilla.lua` for vanilla block hardness, collision and entity sizes). Tests:
`packages/runner/src/plethora.integration.test.ts` and the examples in `workspace/examples/plethora/`:
`ore_hud.lua` (a neural interface HUD; `ore_hud.world.json`, `ore_hud.test.lua`) and `manipulator.test.lua`
(`manipulator.world.json`).

Paths below are relative to `src/main/java/io/sc3/plethora/`.

## Peripherals

| World type                                                                        | Block or item                        | `getType`             | Methods                                        |
| --------------------------------------------------------------------------------- | ------------------------------------ | --------------------- | ---------------------------------------------- |
| `neuralInterface`                                                                 | Neural interface, worn by a player   | `neuralInterface`     | from its modules (below), up to 21 + `getDocs` |
| `manipulator`                                                                     | Manipulator Mark I (`mark: 1`) or II | `manipulator`         | from its modules, no glasses canvas            |
| `plethora:scanner`, `plethora:sensor`, `plethora:introspection`, `plethora:laser` | a module as a turtle upgrade         | the same              | from that one module                           |
| `redstone_integrator`                                                             | Redstone integrator                  | `redstone_integrator` | 15                                             |

The neural interface's other slots (a wireless modem, a speaker) are ordinary peripherals on the other sides: list them
in `peripherals` as usual. A neural computer's terminal is 39x13 (`NeuralComputerHandler`): give the world
`"terminal": { "width": 39, "height": 13 }`.

### Methods, by module

The peripheral's methods are the ones whose modules are all fitted and whose target the peripheral has
(`ModuleContainerMethod.canApply`, `SubtargetedModuleMethod.canApply`). `peripheral.getMethods` lists them in
`MethodRegistry.getMethodsPaired` order: Vanilla's registrations (`integration/vanilla/registry/VanillaMethodRegistration`),
then Plethora's (`gameplay/registry/PlethoraMethodRegistration`), then CC's, then `getDocs`.

| Module                   | Methods                                                                    | Needs                                                                    |
| ------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| (any)                    | `listModules`, `hasModule(id)`, `filterModules(ids...)`, `getDocs([name])` |                                                                          |
| `plethora:introspection` | `getInventory`, `getEquipment`, `getEnder`                                 | a player: the wearer, or the player a manipulator's module is `bound` to |
| `plethora:introspection` | `getID`, `getName`                                                         | an entity (the same)                                                     |
| introspection and sensor | `getMetaOwner` (both modules must be fitted)                               | an entity                                                                |
| `plethora:kinetic`       | `look(yaw, pitch)`, `use`, `swing`, `launch(yaw, pitch, power)`            | a living entity                                                          |
| `plethora:laser`         | `fire(yaw, pitch, potency)`                                                |                                                                          |
| `plethora:sensor`        | `sense()`, `getMetaByID(uuid)`, `getMetaByName(name)`                      |                                                                          |
| `plethora:scanner`       | `scan()`, `getBlockMeta(x, y, z)`                                          |                                                                          |
| `plethora:glasses`       | `canvas()`, `canvas3d()`                                                   | a real player wearing it (`GlassesModuleItem`)                           |
| `plethora:keyboard`      | none                                                                       |                                                                          |

### Modules and their order

- Modules are `"plethora:scanner"` or `{ "id": "plethora:scanner", "level": 2, "bound": "Alex" }`. A neural
  interface has five module slots (`NeuralHelpers.MODULE_SIZE`), a Mark I manipulator one and a Mark II five
  (`ManipulatorType`); extra modules are dropped.
- `listModules` on a neural interface walks a `java.util.HashSet<Identifier>`: the emulator works out Java's bucket
  order (`Identifier.hashCode`, 16 buckets), checked against a JVM. A manipulator uses a `LinkedHashSet` (slot order);
  a turtle upgrade has one module.
- `hasModule` and `filterModules` read each name as an `Identifier`: `"scanner"` is `minecraft:scanner`, and a name
  with capitals or spaces fails with `Java Exception Thrown: net.minecraft.class_151: Non [a-z0-9_.-] character in
namespace of location: ...` (`class_151` is `InvalidIdentifierException` on a Fabric server).
- `filterModules` returns an object with the methods of the named modules (a `LinkedHashSet`, argument order). With no
  fitted module named, the Kotlin method returns `null` and the task fails:
  `Java Exception Thrown: java.lang.NullPointerException: Cannot invoke "io.sc3.plethora.api.method.FutureMethodResult.isFinal()" because "next" is null`.
- A peripheral with no modules is no peripheral (`buildModules` returns `null`).

## Behaviour (all from the source)

### Threads and waits

- `BasicMethod.of` and `SubtargetedModuleMethod.of` default to `worldThread = true`: the call waits for the next
  tick, runs there, and comes back on a **`plethora_task`** event carrying a task id
  (`core/executor/ComputerAccessExecutor`). Events that arrive meanwhile are lost, as with a CC main-thread call, and
  other coroutines see the `plethora_task` event. Argument errors of these methods come after the tick.
- The canvas methods and every method of canvas objects are `worldThread = false`: they run at once.
- `getMetadata` on an item from `getMetaOwner` uses the `BasicExecutor` (a CC main-thread task, `task_complete`);
  from `getMetaByID` / `getMetaByName` / the inventories it uses `plethora_task` (`api/method/ContextHelpers.wrapStack`).
- Once the peripheral is detached (or rebuilt by a module change), its objects fail with
  `Peripheral '<name>' is no longer attached`; canvas objects first fail `safeGet` with `A module has changed`.

### Energy (`core/DefaultCostHandler`, `util/config/PlethoraConfig.CostSystem`)

Each owner (the wearer, the manipulator block, the turtle) has 250, gets 10 back a tick up to 250, and never goes
negative. A cost that is too large to ever be paid fails with
`Insufficient energy (requires <amount>, has <value>).` (the `fire` and `launch` overload leaves out the `)`);
otherwise the call waits until there is enough.

| Cost                        | Amount                        |
| --------------------------- | ----------------------------- |
| `scan()`                    | level x 50 (`scanLevelCost`)  |
| `sense()`                   | level x 40 (`senseLevelCost`) |
| `fire(yaw, pitch, potency)` | potency x 10                  |
| `launch(yaw, pitch, power)` | power x 10                    |

### Scanner (`gameplay/modules/scanner/ScannerMethods.java`)

- Range: 8 at level 0; each level adds half of what is left up to 16 (`LevelableModuleItem.getEffectiveRange`): 12,
  14, 15, 16.
- The centre is the block of the wearer's **eyes** (`EntityWorldLocation.getPos`), the manipulator's block or the
  turtle's.
- `scan()` returns every block of the cube, air included, x then y then z, each `{ x, y, z, name, state }` relative to
  the centre. `state` has each property as a boolean, number or string (`BlockStateMeta.fillBasicMeta`).
- `getBlockMeta(x, y, z)` checks each coordinate against the range (`X coordinate out of bounds (between -8 and 8)`)
  and returns `name`, `displayName`, `translationKey`, `state`, `hardness` (a float), `color` / `colour` (the map
  colour) and, for a sign, `lines` (1-8, from the fixture's `blockEntity.lines`).
- Blocks come from the turtle block world (`blocks`, `fills`, `ground`, docs/turtle.md). Hardness comes from
  `vanilla.lua` (PrismarineJS minecraft-data for 1.20) or a block's own `hardness` or `world.gameData.hardness`.

### Sensor (`gameplay/modules/sensor/`, `integration/vanilla/meta/entity/`)

- Range 16 to 32 the same way. The box is the centre block +/- the range (`SensorHelpers.getBox`); an entity counts
  when its bounding box overlaps it, it is alive and it is not a spectator.
- `sense()` gives each entity's basic properties: `id`, `key`, `name` (a player's name, else the entity type's name),
  `displayName`, `motionX/Y/Z`, `deltaPosX/Y/Z`, `pitch`, `yaw` (normalised to -180..180) and `x`, `y`, `z`: the
  entity's eyes relative to the centre (the wearer's eyes for a neural interface, the block's centre otherwise). The
  wearer is in the list, at 0, 0, 0.
- `getMetaByID(uuid)` (`Invalid UUID` for a malformed one) and `getMetaByName(name)` (the name or the type key) give
  the whole meta, or nothing. `getMetaByName` turns every error, argument errors too, into
  `Unknown error in getMetaByName`.
- Whole meta: the basic properties, `withinBlock`; for living entities `armor` (`boots`, `leggings`, `chestplate`,
  `helmet`), `heldItem`, `offhandItem` (item objects with `getMetadata`), `potionEffects`, `absorption`, `health`,
  `maxHealth` (floats) and the `is...` flags; for players `food` (`hunger`, `saturation`, `hungry`), `heldItemSlot`
  and `trinkets` (`head.face` holds the neural interface); for sheep `woolColour` / `woolColor`; for dropped items
  `item`.
- Eye height: players 1.62 (1.27 sneaking); other entities 85% of their height (`Entity.getEyeHeight`'s default)
  unless the fixture gives `eyeHeight`. Sizes come from minecraft-data.

### Introspection (`gameplay/modules/introspection/`, `integration/vanilla/method/EntityIntrospectionMethods.kt`)

- `getID()` and `getName()` (nil unless the entity is a player); `getMetaOwner()` (needs the sensor too).
- `getInventory()` (36 slots), `getEnder()` (27) and `getEquipment()` (6: main hand, off hand, feet, legs, chest,
  head) return objects with `size`, `list`, `getItemDetail`, `getItemLimit`, `pushItems`, `pullItems` (CC's own
  inventory methods) and `getDocs`; the inventory and ender chest also have `consume(slot)` and
  `drop(slot, limit, [direction])` (`RangedInventoryWrapperMethods`): slot 1-36, `limit` required,
  `forward` / `backward` / a direction name, else `Invalid direction: <x>`. A dropped stack becomes an item entity
  the sensor sees.
- `consume` eats an item with `hunger` and `saturation` (the keys Plethora's `FoodItemMeta` gives) or
  `useAction: "drink"`, and fills the player like `HungerManager.eat`.
- A bound manipulator module talks about that player: `Player is not online` when they are not.

### Laser (`gameplay/modules/laser/LaserMethods.kt`, `LaserEntity.kt`)

- `fire(yaw, pitch, potency)`: potency 0.5 to 5 (`Potency out of range (between 0.5 and 5.0).`). The laser starts at
  the wearer's eyes pushed out by their width + 0.2, or 0.9 out from a manipulator's or turtle's centre (above or
  below it when the pitch is past 60), and flies at 1.5 blocks a tick for at most 100 ticks.
- Each tick it moves in up to five steps, the way `LaserEntity.tick` does: a ray cast through the blocks
  (`BlockGetter.traverseBlocks` and `AABB.clip`, full cubes; blocks without collision such as grass and fluids are
  passed through) and through living entities (their box grown by 0.3, near the end of the step), whichever is
  nearer. The hit block is `BlockPos.ofFloored(hit)`, so a laser hitting a top, south or east face lands on the block
  outside and breaks the solid one on its next step, as in game.
- A block with hardness at most the potency breaks (potency minus hardness) and drops its loot (`turtle/loot.lua`,
  no tool, nothing for a creative shooter or tall flowers); TNT is removed; obsidian costs 50 and lights a fire on
  the hit side; anything harder stops the laser.
- A living entity takes potency x 4 damage and the laser stops; blazes, magma cubes and zombified piglins
  (`plethora:lasers_provide_energy`) are healed instead. The shooter is safe for the laser's first 5 ticks.

### Kinetic (`gameplay/modules/kinetic/KineticMethods.java`, `integration/vanilla/method/EntityKineticMethods.kt`)

- `look(yaw, pitch)` turns the wearer (pitch clamped to -90..90); `getMetaOwner` and `sense` show it.
- `launch(yaw, pitch, power)`: power 0 to 4 (`Power out of range (between 0.0 and 4.0).`), MathHelper's float sine
  table, y scaled by 0.5. The velocity it adds is recorded in sim state (`addons.plethora.launches`); nobody moves.

### Overlay glasses (`gameplay/modules/glasses/`)

- `canvas()` is a 512x288 2D canvas (`CanvasHandler`): `getSize`, `clear`, `addRectangle`, `addLine`, `addDot`,
  `addText`, `addTriangle`, `addPolygon`, `addLines`, `addItem`, `addGroup`.
- `canvas3d()`: `create([offset])` makes a 3D root at the wearer's eyes plus the offset, with `addBox`, `addFrame`
  (a 2D canvas in the world), `addItem`, `recenter` and `clear`.
- Every object has the methods of its Java interfaces: `remove`; colour (`get/setColour`, `get/setColor`,
  `get/setAlpha`, colours `0xRRGGBBAA`); `get/setPosition`; `get/setScale` (`Scale must be > 0`); `get/setSize`;
  `getPoint`/`setPoint`; `getPointCount`/`insertPoint`/`removePoint`; text `get/setText` (512 characters),
  `setShadow`/`hasShadow`, `get/setLineHeight` (a short); `get/setItem`; `get/setRotation`; `is/setDepthTested`.
- Points are tables, `{ x, y }` or `{ x = , y = }` (`Expected number for key 2.0, got nil`, as Java prints a Double
  key). `insertPoint(x, y)` with two arguments always fails (the source reads the point from argument 3), as in game.
- A removed object fails with `This object has been removed`. Object ids count from 2 per canvas.
- Nothing is drawn. Sim state lists every object with its fields under `peripherals.<name>.canvas`.

### Redstone integrator (`gameplay/redstone/RedstoneIntegratorPeripheral.kt`)

- Sides are direction names (`down`, `up`, `north`, `south`, `west`, `east`), or `top` / `bottom`; anything else is
  `Bad name '<side>' for argument 1`. `getSides()` returns `DOWN` ... `EAST`, the enum names.
- `setOutput`, `getOutput`, `getInput`, `setBundledOutput`, `getBundledOutput`, `getBundledInput`,
  `testBundledInput`, `setAnalogOutput` / `setAnalogueOutput` (`Power out of range (between 0 and 15)`),
  `getAnalogOutput` / `getAnalogueOutput`, `getAnalogInput` / `getAnalogueInput`. All run on the computer thread.
- An input change queues `redstone` with the peripheral's name.

## Fixture fields

| Field                                            | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `version`                                        | must be `"1.20.1"`                                                                                                                                                                                                                                                                                                                                                                                                             |
| `players[]`                                      | the usual players (`name`, `uuid`, `x`, `y`, `z` at the feet, `yaw`, `pitch`, `health`, `maxHealth`, `dimension`), plus for Plethora `inventory` (slot 1-36 to item), `ender` (1-27), `armor` (`feet`, `legs`, `chest`, `head`), `offhand`, `heldItemSlot` (0-8), `food`, `saturation`, `gameMode`, `sneaking`, `sprinting`, `onGround`, `potionEffects` (names), `motion` / `deltaPos` (`{x, y, z}`), `trinkets`, `eyeHeight` |
| `plethora.entities[]`                            | other entities: `uuid`, `type` (`minecraft:zombie`), `x`, `y`, `z` (feet), `yaw`, `pitch`, `health`, `maxHealth`, `customName`, `width`, `height`, `eyeHeight`, `living`, `color` (sheep), `item` (a dropped item, type `minecraft:item`), `armor`, `heldItem`, `offhand`, `baby`, `burning`, ...                                                                                                                              |
| `plethora.config`                                | any `PlethoraConfig` value: `laser`, `kinetic`, `scanner`, `sensor`, `costSystem` sections                                                                                                                                                                                                                                                                                                                                     |
| `plethora.gameTime`                              | the starting game tick                                                                                                                                                                                                                                                                                                                                                                                                         |
| `neuralInterface`: `owner`, `modules`            | the wearer (a player's name or uuid; default the first player) and up to five modules                                                                                                                                                                                                                                                                                                                                          |
| `manipulator`: `mark`, `modules`, `x`, `y`, `z`  | Mark 1 or 2, its modules (`bound` to a player's name), where the block is                                                                                                                                                                                                                                                                                                                                                      |
| `plethora:<module>`: `level`                     | a turtle upgrade (the turtle's `left` / `right`: `plethora:module_scanner` and so on); a turtle world needs `"plethora": {}` so the upgrades are known at boot                                                                                                                                                                                                                                                                 |
| `redstone_integrator`: `inputs`, `bundledInputs` | side to level / bundled mask at boot                                                                                                                                                                                                                                                                                                                                                                                           |
| `blocks[].hardness`, `gameData.hardness`         | hardness for blocks `vanilla.lua` does not know (modded ones)                                                                                                                                                                                                                                                                                                                                                                  |

Items are as in chests. Plethora adds its item meta to CC's item details; give an item `hunger` and `saturation` to
make it food.

## Sim commands

| Command                                                                                                                       | Effect                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plethoraSetModules {peripheral, modules}`                                                                                    | change a neural interface's or manipulator's modules: the peripheral is detached and attached again (`peripheral_detach`, `peripheral`), old objects fail                                                               |
| `plethoraAddEntity {entity}` / `plethoraMoveEntity {uuid, x?, y?, z?, yaw?, pitch?, health?}` / `plethoraRemoveEntity {uuid}` | the entities                                                                                                                                                                                                            |
| `plethoraSetPlayer {player, ...}`                                                                                             | `food`, `saturation`, `heldItemSlot`, `health`, `slot` + `item` (+ `ender: true`), `feet`/`legs`/`chest`/`head`/`offhand` (item or `false`), `sneaking`, `sprinting`, `gameMode`, `potionEffects`, `motion`, `onGround` |
| `plethoraSetRedstoneInput {peripheral, side, level?, bundled?}`                                                               | an integrator's input; a change queues `redstone`                                                                                                                                                                       |
| `plethoraSetEnergy {peripheral, energy}`                                                                                      | the owner's energy                                                                                                                                                                                                      |
| `setPlayerPos {player, x?, y?, z?, yaw?, pitch?}` (core)                                                                      | moves the wearer, and so the scanner, sensor and laser                                                                                                                                                                  |

Sim state: `peripherals.<name>` has `modules`, `energy` and `canvas` (objects by id); a redstone integrator its
inputs and outputs by side; `addons.plethora` has `gameTime`, `lasers` in flight, `launches`, `entities` and each
player's `inventory`, `ender`, `armor`, `offhand`, `food`.

## Not emulated

- **Kinetic `use` and `swing`**: they need the game's item use and attack code (`PlayerInteractionHelpers`); they
  raise `ccsim: kinetic use/swing is not emulated`. The kinetic turtle upgrade (`KineticTurtleUpgrade`) is not built.
- **Movement**: `launch` records the velocity but nobody moves, and entities never move on their own.
- **Damage rules**: armour, resistance, invulnerability ticks and fire immunity are not modelled; a laser takes
  potency x 4 off the health, a dead mob leaves the sensor at once.
- **Block shapes**: every block with collision is a full cube to the laser; stairs, slabs and fences are not.
  Modded blocks need a `hardness`, or the laser stops at them.
- **TNT**: it is removed but no primed TNT or explosion follows.
- **Entity order**: `sense()` lists players, then fixture entities, in the fixture's order, not the world's section
  order. Mob eye heights the game overrides (a zombie's 1.74) need `eyeHeight`.
- **Item meta**: Plethora adds `rawName`, `material`, armour, potion and book keys to every CC item detail; the
  emulator's item details only have what the fixture gives (`hunger` and `saturation` included).
- **Keyboard module**: it captures the player's keys client-side; type into the computer instead (`craftos_key`).
- **Pocket computer upgrades**, the vehicle upgrades, the sensor and scanner overlays (client rendering), Plethora's
  generic peripherals on vanilla furnaces, brewing stands and signs, and the SwitchCraft integrations are not built.
- **Two of the same module**: the game picks one at random (a `HashSet` of `Pair`s); the emulator uses the later slot.
- **Timing under load**: energy comes back by the wall clock, so a slow `scan()` of a big range gets energy back that
  a busy server would not have given.
