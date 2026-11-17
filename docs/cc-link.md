# CC: Link emulation

CC: Link is **not in the pack**. The emulator follows **CC: Link 6.2.1** for Forge 1.20.1 (Modrinth `cc-link`,
`cclink-6.2.1-1.20.1.jar`), the only Minecraft version it exists for. Source: `github.com/minecraftbossdj/CC-Link`
at commit `b24e027` (9 March 2026, the day before 6.2.1 was published; the repository has no tags). Every string
constant of the classes below was compared with the 6.2.1 jar through `javap` and matches. CC:Tweaked's side
(argument checks, main-thread tasks, how errors read) follows CC:Tweaked `v1.20.1-1.117.0`, the version the mod is
built against.

Nothing here could be measured in game. Every rule below is read from the source.

The addon id is `cc-link`, on Minecraft `1.20.1` only (`"version": "1.20.1"` in the world). The Lua is
`rom-overlay/rom/ccsim/addons/cc-link/init.lua`. Tests: `packages/runner/src/cc-link.integration.test.ts` and the
example `workspace/examples/cc-link/hud.lua` (`hud.test.lua` calls every function).

Paths below are relative to `src/main/java/com/awesoft/cclink/`.

## What a computer sees

CC: Link is mostly **global APIs**, not peripherals. `registration/APIRegistry.java` registers four API factories,
each for computers that carry one of the mod's components:

| Computer                                             | World setting                              | Global                            |
| ---------------------------------------------------- | ------------------------------------------ | --------------------------------- |
| Link Core (`cclink:link_core`), worn in Curios       | `ccLink.core: "link"`                      | `link` (13 functions)             |
| Command Link Core (`cclink:link_core_command`)       | `ccLink.core: "link_command"`              | `link`, the same 13               |
| Integrated Link Core (`cclink:integrated_link_core`) | `ccLink.core: "integrated"`                | `link` (10 functions)             |
| Link Turtle (`cclink:link_turtle_advanced`)          | `ccLink.core: "turtle"` and `world.turtle` | `link_turtle` (5)                 |
| Entity Link                                          | none                                       | `entity`: not emulated, see below |

and one peripheral, the `link_armor` pocket upgrade (`cclink:link_armor_pocket`, peripheral type `link_armor`, 5
methods), on the back of a pocket computer: `{ "name": "back", "type": "link_armor" }`.

`link.getUpgradeFunctions()` and `link_armor.getArmorFunctions()` hand out tables of functions, one per upgrade:
`scanner` (2), `sensor` (2), `introspection` (5), `world` (5), `overlay` (14), `kinetic` (1), `chatty` (2).

The Link cores are pocket computers to CC (`ComputerComponents.POCKET`), so they also have the `pocket` API, which
is not emulated. The Integrated core has a wireless modem on `top` and a speaker on `bottom`
(`IntegratedLinkBrain.java:43-44`): put them in `peripherals` if a program uses them.

### The link API (`item/linkCore/LinkAPI.java`, `integrated/IntegratedLinkAPI.java`)

Every function is `@LuaFunction(mainThread = true)`: it waits for the next server tick, events arriving meanwhile
are lost, and its arguments are read inside the task, so a bad argument comes back from the task, positioned at the
caller.

- `listUpgrades()` -> `true, { ids }`: the items in the core's upgrade slots, in slot order.
- `hasUpgrade(id)`: `new ResourceLocation(id)` then `BuiltInRegistries.ITEM.get`: no namespace means `minecraft:`
  (so `hasUpgrade("chatty_upgrade")` is false), a bad id throws
  `Java Exception Thrown: net.minecraft.ResourceLocationException: Non [a-z0-9_.-] character in namespace of location: Bad:thing`
  (or `... in path of location: ...`).
- `getUpgradeFunctions()`: a table with one entry per upgrade present. `kinetic` only while the config's
  `kineticLinkEnabled` is on (default). Each call makes new tables.
- `getInfo()`: `name, dimension, health, hunger, saturation, air, armor, speed, yaw, pitch, isInPowderedSnow,
isInWater, isHungry`. The Integrated core adds `x, y, z`, floored. Floats (`health`, `saturation`, `speed`,
  `yaw`, `pitch`) are Java floats: `speed` is `0.10000000149011612` for a walking player.
- `swingMainHand()` -> `true`.
- `raycastBlock(reach, hitFluids)`: the reach is clamped and then **not used**: `Player.pick(5.0, 0, hitFluids)`
  looks 5 blocks from the eyes along the view. Returns `{ id, name, x, y, z }`, where `name` is
  `new ItemStack(block).getDisplayName()`, with its square brackets: `"[Oak Log]"`. `{}` on a miss.
- `raycastEntity(reach)`: reach clamped to 1..5 (Link) or 1..10 (Integrated); `libs/RaycastingUtil.raycastEntity`:
  the ray stops at the first block, then the nearest pickable entity whose box, grown by 0.3, it crosses. Returns
  `id, uuid, dimension, x, y, z, yaw, pitch`, for a living entity `health, maxHealth, air, maxAir, armor, speed,
isInPowderedSnow`, for a player `hunger, saturation, isHungry, creative, spectator`, and `name`. The Link core
  floors `x, y, z`; the Integrated one does not.
- `consume(slot)`: `Item isnt edible!` / `Player isnt hungry!` as `false, message`; otherwise vanilla
  `FoodData.eat` (food `min(food + nutrition, 20)`, saturation `min(saturation + nutrition * modifier * 2, food)`,
  floats) and one item fewer unless in creative. Slot 0 or below throws
  `Java Exception Thrown: java.lang.ArrayIndexOutOfBoundsException: Index -1 out of bounds for length 36`
  (Inventory.getItem); past 41 is an empty slot.
- `lookAtBlock(x, y, z)`: `Entity.lookAt(EYES, ...)`, yaw and pitch from the eyes (1.62 above the feet).
- `lookAt(x, y)`: sets the pitch to `x` (ignored unless finite, `Entity.setXRot`) and the **head** yaw to `y`;
  `getInfo().yaw` reads the body yaw, which does not change.
- Link core only: `list()` (all 41 slots, `{}` for an empty one, others `LuaConverter.stackToObjectWithSlot`:
  `tags, count, displayName ("[Name]"), maxStackSize, nbt, name, slot`), `getSlot(slot)` (the same without `slot`),
  `moveItem(fromSlot, count, toSlot)`: `Count cant be below zero!` for `count <= 0` (thrown), false for an empty or
  too small source or a different item, `Cannot be above max stack size!` (thrown) when a merge would overflow;
  merging ignores NBT; a target past slot 41 swallows the items, as `Inventory.setItem` does.

Inventory slots are the player's `Inventory`: 0-35 the main inventory (0-8 the hotbar), 36-39 boots, leggings,
chestplate, helmet, 40 the off hand. Functions take them 1-based.

### The upgrade tables (`upgrades/luaFunctions/*.java`)

These are `ILuaFunction`s: they run at once on the computer thread. A Java exception inside one reads
`Java Exception Thrown: ...` with no position (`ResultInterpreterFunction`). Each starts with
`UpgradeFunctionsBase.checkUpgrade()`: is the upgrade still in **the Link core's** slots (the Integrated core's for
the Integrated family)? If not, `false, "Upgrade not equipped!"`. This is checked at each call, so taking the
upgrade out stops a table you already hold. The armor's tables check the Link core too, not the armor: with no Link
core worn, every armor function throws `Java Exception Thrown: java.lang.NullPointerException`.

- **scanner** (`ScannerUpgradeFunctions`): `scan(radius)`: a cube of side `2r+1` around the block under the feet
  (`Entity.getOnPos`: 0.2 below them), x then y then z, every non-air block as `{ x, y, z, name, tags }` relative to
  it, plus `direction` (a `facing` that is the four horizontal directions), `direction_vertical`, `half`
  (`top`/`bottom`), `axis` (`x`/`y`/`z`), `powered` and `powerlvl` when the block has those states. A 2000 ms
  cooldown per computer (`nil, "On cooldown!"`), started **before** the radius check, so `scan(9)` both answers
  `false, "Cannot be bigger than 8 block radius!"` and starts the cooldown. A negative radius scans nothing.
  `getOperationCooldown()`: the milliseconds left.
- **sensor** (`SensorUpgradeFunctions`): `sense(radius)` (at most 16, same cooldown rules, its own cooldown): every
  entity whose box meets the box from `getOnPos() - r` to `+ r` (a negative radius works like a positive one, AABB
  sorts its corners), the wearer left out, each `{ id, uuid, name, tags }` and for animals `baby, inLove,
aggressive` (`LuaConverter.completeEntityToLua`; never `shareable`, the item in hand is air).
  `getOperationCooldown()`.
- **introspection** (`IntrospectionUpgradeFunctions`): `"inv"` or `"ender"` (any case): `list(inv)` (slot to
  `{ name, count, nbt? }`, CC's basic details, empty slots left out), `size(inv)` (41 / 27), `getItemDetail(slot,
inv)` and `getItemLimit(slot, inv)` (the inventory name is read first; the slot is clamped to 0..size, so a slot
  past the end is air: `{ name = "minecraft:air", count = 0 }`, limit 64), `moveItems(from, to, fromSlot, limit,
toSlot)`: moves like `moveItemTo`, then **returns nil**: the Java wraps its MethodResult in another one, which CC
  cannot convert. Invalid names: `false, 'Invalid Inventory type! Please use "inv" or "ender"!'`,
  `'Invalid Inventories! ...'`, and for `size` `"Invalid Inventory type! Please use 'inv', 'ender' or 'curios'!"`.
- **world** (`WorldUpgradeFunctions`): `getWeather()` (`"thundering"`, `"raining"` or `"clear"`; it rains only
  where `canSeeSky` is true at the block under the feet, see the fixture), `getDimension()`, `getBiome()`
  (`name, canSnow, canRain, fogColor, foliageColor`), `canSeeSky()`, `isDay()`.
- **overlay** (`OverlayUpgradeFunctions`): `addOrUpdateTextElement(id, text, x, y, color, scale)`,
  `addOrUpdateRightboundTextElement(...)`, `addOrUpdateRectElement(id, x1, y1, x2, y2, color, transparency)`,
  `addOrUpdateItemElement(id, item, x, y)`, `removeTextElement(id)`, `removeRightboundTextElement(id)`,
  `removeRectElement(id)`, `removeItemElement(id)`, `clearText()`, `clearRightboundText()`, `clearRect()`,
  `clearItem()`, `clearAll()`, each `true`, and `send()`. The table keeps every element ever given to it and
  `send()` sends them all again, in order; a fresh `getUpgradeFunctions()` starts an empty list. `send()` allows one
  packet per player every `packetCooldownTicks` ticks (default 1, so 50 ms; `false, "On cooldown!"`).
- **kinetic** (`KineticUpgradeFunctions`): `launch(yaw, pitch, power)`: `false, "Power cannot be above 4!"`. From a
  Link core it costs nothing. From the armor it needs `cclink:link_leggings` and takes `power * 5000` FE
  (`kineticEnergyMultiplier`) from them, **before** the power check, `false, "Not Enough Energy!"` without enough.
  The push follows the Java float for float (0.4 of it while flying with an elytra) and lands in the player's
  `motion` in sim state; nothing moves the player.
- **chatty** (`ChattyUpgradeFunctions`): `sendMessage(message, name, brackets)` to every online player, as
  `brackets[1] .. name .. brackets[2] .. " " .. message`; `sendMessageToPlayer(message, player, name, brackets)`
  (`false, "Player not online!"`; names match ignoring case). Brackets shorter than two characters throw
  `Java Exception Thrown: java.lang.StringIndexOutOfBoundsException: String index out of range: 1`. Messages land in
  the chat log (`state.chat`, `kind = "cclink"`).

### The chat_message event (`events/ChatEvent.java`)

When the wearer chats and the core has the chatty upgrade, the core gets `chat_message, <player name>, <message>`.
Sim command `ccLinkChat {message}`.

### link_turtle (`block/LinkTurtle/TurtleLinkAPI.java`)

All main-thread. `raycast(reach)`, `raycastUp(reach)`, `raycastDown(reach)`: the reach is clamped to 1..5, the ray
starts at the turtle's face, the first block returns `{ id, x, y, z, distance }` (`distance` from the turtle's
centre to the block's), `{}` for none. `list()`: the 16 slots, `{}` for an empty one. `getDirection()`: `"north"`,
`"east"`, ...

### link_armor (`peripherals/linkArmorManager/LinkArmorManagerPeripheral.java`)

All main-thread. The modules come from every piece of modular Link armor worn (`cclink:link_boots`,
`link_leggings`, `link_chestplate`, `link_helmet`), feet first (`ModularArmorLib.getCombinedArmorModules`).

- `listUpgrades()` -> `true, { ids }`; `hasUpgrade(id)`.
- `getArmorFunctions()`: `scanner`, `sensor`, `introspection`, `world`, `overlay`, `kinetic` for the modules present
  (no `chatty`; `kinetic` whatever the config says).
- `getEnergy(piece)`, `getMaxEnergy(piece)`: `"helmet"`, `"chestplate"`, `"leggings"`, `"boots"` (any case); 0 for
  anything else or a piece that is not modular. The capacity is 100 plus 10000 / 50000 / 100000 for each tier 1 / 2
  / 3 battery module (`modularArmor/ModularArmorEnergy.java`, `CCLinkConfig` defaults).

## Fixtures

```json
{
  "version": "1.20.1",
  "addons": ["cc-link"],
  "players": [
    { "name": "Alex" },
    { "name": "Steve", "x": 3.5, "y": 64, "z": 0.5 }
  ],
  "ccLink": {
    "core": "link",
    "upgrades": ["cclink:sensor_upgrade", "cclink:overlay_upgrade"],
    "player": {
      "name": "Alex",
      "x": 0.5,
      "y": 64,
      "z": 0.5,
      "food": 15,
      "inventory": { "0": { "name": "minecraft:bread", "count": 3 } }
    },
    "world": { "raining": true, "canSeeSky": true, "biome": "minecraft:plains" }
  },
  "entities": [
    {
      "type": "minecraft:cow",
      "name": "Daisy",
      "x": 1.5,
      "y": 64,
      "z": 2.5,
      "baby": true
    }
  ],
  "peripherals": [{ "name": "back", "type": "link_armor" }]
}
```

`ccLink`:

| Field          | Meaning                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| `core`         | `link` (default when there is a `player`), `link_command`, `integrated`, `turtle`, `none` (no Link core)      |
| `upgrades`     | the core's upgrade slots, in order: item ids or items                                                         |
| `upgradeSlots` | how many slots the core has (default 8, or more if `upgrades` lists more)                                     |
| `player`       | the wearer: a name in `players` (or a new player), and `x, y, z, yaw, pitch, dimension, health, maxHealth`    |
|                | `food` (20), `saturation` (5), `air` (300), `armorValue` (0), `speed` (0.1), `headYaw`, `inWater`,            |
|                | `inPowderSnow`, `creative`, `spectator`, `fallFlying`, `eyeHeight` (1.62), `fallDistance`                     |
|                | `inventory` (slot 0-40 to item), `ender` (slot 0-26 to item)                                                  |
| `world`        | `raining`, `thundering`, `day` (true), `canSeeSky` (false), `biome` (an id, or `{ name, canSnow, canRain,     |
|                | fogColor, foliageColor, precipitation }`; default plains: fog 12638463, foliage 0)                            |
| `config`       | `kineticLinkEnabled`, `kineticEnergyMultiplier`, `packetCooldownTicks`, `tier1MaxEnergy` ... `tier3MaxEnergy` |

Items are `{ name, count?, nbt? (a table), displayName?, damage?, food? ({ nutrition, saturation } or false), tags? }`.
Modular armor pieces in slots 36-39 carry `modules` (ids or items) and `energy`. Vanilla foods come with their own
nutrition (`Foods.java`).

Blocks for the scanner and the ray casts come from the world's block fixture (`blocks`, `fills`, `ground`,
docs/turtle.md), or the turtle's world. Other entities: online `players` in the same dimension, then
`world.entities` (`type`, `x, y, z`, `name`, `uuid`, `width`, `height`, `yaw`, `pitch`, `health`, `maxHealth`,
`air`, `armor`, `speed`, `tags`, `animal`, `baby`, `inLove`, `aggressive`, `living`, `pickable`, `dimension`).
Boxes default to the vanilla size of a few common mobs, else 0.6 by 1.8.

`canSeeSky` is the sky light at the block **under the feet** (`Level.canSeeSky(getOnPos())`): on solid ground that is
false in the real game, so `getWeather()` reads `"clear"` there even in rain. Set it to what the real block would
give.

## Sim commands

| Command             | Fields                                                                            |
| ------------------- | --------------------------------------------------------------------------------- |
| `ccLinkSetPlayer`   | any of the `player` fields above (not the inventories), and `motion: { x, y, z }` |
| `ccLinkSetItem`     | `inventory` (`"inv"`, default, or `"ender"`), `slot` (0-based), `item` (or null)  |
| `ccLinkSetUpgrades` | `upgrades`: the core's slots again                                                |
| `ccLinkSetWorld`    | `raining`, `thundering`, `day`, `canSeeSky`, `biome`, `dimension`                 |
| `ccLinkSetEntities` | `entities`: replaces `world.entities`                                             |
| `ccLinkChat`        | `message`: the wearer says it in chat                                             |

Sim state, `addons["cc-link"]`: `core`, `upgrades`, `player` (position, rotation, `headYaw`, `food`, `saturation`,
`swings`, `motion`, `fallDistance`, `inventory`, `ender`), `hud` (what the client would draw after every packet:
`text`, `rightbound`, `rect`, `item`, by element id), `packets` (the last 20 sends) and `packetCount`.

## Not emulated

- **The Entity Link** (`entity` API): its item is commented out of `registration/ItemRegistry.java`, so no computer
  can have it in 6.2.1.
- **A core that nobody wears** (dropped as an item, the player dead or offline): the Java then returns null from
  most functions, which CC turns into a NullPointerException. The emulated core is always worn.
- **`launch` from the armor without modular leggings**: the Java returns `null` from an `ILuaFunction`, which CC
  dereferences outside its error handling. The emulator raises a `ccsim: not emulated` error there instead.
- **The pocket API** on the cores, **curios slots** (`size` never accepts `"curios"`, as in the Java), the **laser**
  and **shield** upgrades (no Lua functions in 6.2.1), the **HUD** rendering itself (the element model is kept in
  sim state).
- **Shapes**: every block is a full cube to the ray casts, and water and lava a full block when fluids count. Slabs,
  torches, grass and the like are hit as whole blocks.
- **Mth.atan2**: `lookAtBlock` uses Lua's `math.atan2`, not Minecraft's table version; the angles can differ in the
  last float digit. `Mth.sin` / `Mth.cos` (for the view vector) are the game's table.
- **Effects of food** (golden apples, suspicious stew, ...), the eating sound and animation; physics after a launch.
- **Order**: block and item `tags` come in the data's order (the game's is a hash set's), entities in fixture order
  (players first) rather than the game's entity sections.
- **The Java NullPointerException text**: the real one continues with the JVM's helpful message, which names
  obfuscated methods; the emulator stops at the class name.
- State does not survive a reboot of the computer.
