# Finer Peripherals emulation

Finer Peripherals is **not in the pack**. The emulator follows **Finer Peripherals 1.20.1-0.6.1** for Fabric 1.20.1
(Modrinth `finer-peripherals`, `finerperipherals-1.20.1-0.6.1.jar`), the only Minecraft version it exists for.
Source: `github.com/minecraftbossdj/FinerPeripherals` at commit `b217ea8` (27 August 2025, the day 0.6.1 was
published; the repository has no tags). The string constants of every class were compared with the jar through
`javap` and match. CC:Tweaked's side follows `v1.20.1-1.117.0`.

Nothing here could be measured in game. Every rule below is read from the source.

The addon id is `finer-peripherals`, on Minecraft `1.20.1` only. The Lua is
`rom-overlay/rom/ccsim/addons/finer-peripherals/init.lua`. Tests:
`packages/runner/src/finer-peripherals.integration.test.ts` and the example
`workspace/examples/finer-peripherals/ore_scout.lua` (with `ore_scout.world.json` and `ore_scout.test.lua`).

Paths below are relative to `src/main/java/com/awesoft/finerperipherals/`.

## Peripherals

Several of the mod's type names are generic (`chatBox` is also Advanced Peripherals'), so the **world type** is the
mod's block or upgrade id, and the peripheral reports the mod's own type, the one `peripheral.find` and `getType`
see.

| World type                             | Block or upgrade                                      | getType                    | Methods |
| -------------------------------------- | ----------------------------------------------------- | -------------------------- | ------- |
| `finerperipherals:chatbox`             | Chat Box block                                        | `chatBox`                  | 4       |
| `finerperipherals:chatbox_turtle`      | turtle upgrade (item `finerperipherals:chatbox`)      | `chatBox`                  | 4       |
| `finerperipherals:chatbox_pocket`      | pocket upgrade                                        | `chatbox` (lower case)     | 4       |
| `finerperipherals:geoexplorer`         | Geo Explorer block                                    | `geoExplorer`              | 2       |
| `finerperipherals:geoexplorer_turtle`  | turtle upgrade (item `finerperipherals:geoexplorer`)  | `geoExplorer`              | 2       |
| `finerperipherals:geoexplorer_pocket`  | pocket upgrade                                        | `geoExplorer`              | 1       |
| `finerperipherals:player_finder`       | Player Finder block                                   | `playerFinder`             | 2       |
| `finerperipherals:eventrelayer`        | Event Relayer block                                   | `eventRelayer`             | 1       |
| `finerperipherals:eventrelayer_turtle` | turtle upgrade (item `finerperipherals:eventrelayer`) | `eventRelayer`             | 1       |
| `finerperipherals:eventrelayer_pocket` | pocket upgrade                                        | `eventRelayer`             | 1       |
| `finerperipherals:holoitemdisplay`     | Holographic Item Display block                        | `holographic_item_display` | 2       |
| `finerperipherals:compass_turtle`      | turtle upgrade (item `minecraft:compass`)             | `compass`                  | 2       |
| `finerperipherals:enderchest_turtle`   | turtle upgrade (item `minecraft:ender_chest`)         | `enderchest`               | 6       |
| `finerperipherals:debug_pocket`        | pocket upgrade (item `minecraft:command_block`)       | `debug`                    | 1       |

There is no compass block: the compass is a turtle upgrade only (`TurtleRegistry.java`).

Blocks and pocket upgrades go in `peripherals` (a pocket upgrade is the pocket computer's `back`). A turtle equips
the upgrades by item, as in game: `"turtle": { "left": "minecraft:compass" }`, or `turtle.equipLeft()` with the item
selected. The turtle upgrades are only known when the module loads at boot, so a turtle world that uses them needs
`"finerPeripherals": {}` (or any Finer block in `peripherals`).

### Chat box (`peripherals/chatbox/*`, `events/ChatEvent.java`)

Computer thread. `sendMessage(message, name, brackets)` to every online player as
`brackets[1] .. name .. brackets[2] .. " " .. message`; `sendMessageToPlayer(message, player, name, brackets)`;
`tellraw(message)`; `tellrawToPlayer(message, player)`. Each returns `true`. Player names match ignoring case
(`PlayerList.getPlayerByName`). An unknown player is not checked for:
`Java Exception Thrown: java.lang.NullPointerException`. Brackets shorter than two characters:
`Java Exception Thrown: java.lang.StringIndexOutOfBoundsException: String index out of range: 1`. Messages land in
the chat log (`state.chat`, `kind = "finerperipherals"`).

When a player chats, **every chat box attached** to the computer queues `chat, <name>, <message>, <uuid>` (three
arguments after the name: no `isHidden`, unlike Advanced Peripherals). Two chat boxes give two events. Sim command
`finerChat {player, message}`. The shared `chat` command is Advanced Peripherals' and sends AP's event shape, to
computers with any `chatBox`; use `finerChat` for this mod.

### Geo explorer (`peripherals/geoexplorer/*`)

Main thread. `scan(radius)`: the cube of side `2r+1` around the block, x then y then z, every non-air block as
`{ x, y, z, name, tags }` relative to the centre, with `direction` (a four-way `facing`), `direction_vertical`,
`half` (`top`/`bottom`), `axis`, `powered`, `powerlvl` where the block has them. **No radius limit.** The `name` is
read back from the block's translation key, so wall torches, wall signs, wall banners and wall heads read as their
standing form (`minecraft:wall_torch` is `minecraft:torch`). Tags are `minecraft:block/<tag>`. A 2000 ms cooldown per
computer, shared by every geo explorer block and turtle on it, started before the radius is read: `nil, "On
cooldown!"`. `getOperationCooldown()`: milliseconds left.

- The block scans around its own position (`x, y, z` on the peripheral, else the computer's).
- The **turtle** upgrade keeps the turtle's block entity from when it was equipped (or the turtle booted): it always
  scans around **that** position, even after the turtle moves away.
- The **pocket** upgrade scans around its holder's block position (`x, y, z` on the peripheral, else the computer's),
  keeps its own cooldown, answers `false, "On cooldown!"`, and has no `getOperationCooldown`.

### Player finder (`peripherals/playerfinder/playerFinderPeripheral.java`)

Computer thread. `getOnlinePlayers()` -> `true, { names }`. `getPlayerPos(name)` -> `true, { x, y, z, dimension,
respawnPos? }` (the position unrounded; `respawnPos = { x, y, z, dimension }` only for a player with a respawn
point, from `finerPeripherals.respawn`), or `false, "Player not online!"`.

### Event relayer (`peripherals/eventrelayer/*`)

Main thread. `relayEvent(computerId, message)` -> `true`: the first attached computer with that id gets
`secure_message, <sender id>, <message>`. Only this computer is emulated, so a message reaches it when it names its
own id; any other id is delivered nowhere.

### Holographic item display (`peripherals/holoitemdisplay/*`)

Main thread. `setItem(id)`: a 2000 ms cooldown per computer (`nil, "On cooldown!"`), started before the id is
checked; `new ResourceLocation(id)` (a bad id throws `Java Exception Thrown: net.minecraft.ResourceLocationException:
...`), `false, "Not a real item id!"` when no such item exists (the game data's items, plus `finerPeripherals.items`),
else `true` and the display shows it (the id as given, in `state.peripherals.<name>.item`). `getOperationCooldown()`.

### Compass turtle (`peripherals/compass/*`)

Computer thread. `getDirection()` and `getDirectionInHub()`. The compass keeps the turtle's block entity from when
it was equipped: while the turtle has not left that block it follows the turtle's facing; once it moves away,
`getDirection()` keeps answering the facing the turtle had when it left. `getDirectionInHub()` asks the block
entity now at that first position: the turtle's facing if it is back there, else that block's `facing`, a
`NullPointerException` if the block has no block entity (air), or
`Java Exception Thrown: java.lang.IllegalArgumentException: Cannot get property DirectionProperty{...} as it does not exist in Block{...}`
for a block entity without one.

### Ender chest turtle (`peripherals/enderChestTurtle/enderChestPeripheral.java`)

The turtle's owner's ender chest (`finerPeripherals.owner`, a player who must be online; `finerPeripherals.ender`,
slot 0-26 to item). Without the owner online, `false, "Player isn't present"` (after the arguments are read).

- `getInventory()` (computer thread): the turtle's 16 slots, `nil` for an empty one, others
  `{ tags, name, count, displayName ("[Name]"), maxStackSize, nbt }`. `name` comes from the translation key of the
  item's default stack, so potions read `minecraft:potion.effect.water` and tipped arrows
  `minecraft:tipped_arrow.effect.poison`.
- `list()`, `size()` (27), `getItemLimit(slot)`.
- `pushItems(fromSlot, limit, toSlot)` (ender chest to turtle): `From slot out of range (between 1 and 27)`,
  `To slot out of range (between 1 and 16)`, `Stack Size out of range (between 1 and <max>)` (thrown), then the move.
- `pullItems(fromSlot, limit, toSlot)` (turtle to ender chest): no range checks; a slot out of range is an empty
  stack, so a target past the end swallows the items.
- The move (`moveTo`): `From slot is empty!`, `From slot has too few items!` (into an empty slot the whole `limit`
  must be there), `To slot doesn't contain the same item!`, `Both items' NBT do not match.`, else `true, <moved>`.

### Debug pocket (`peripherals/debugPocket/DebugPeripheral.java`)

`periphList()` -> `false, "lil bro this shit dont exist anymore, lock in"`, word for word.

## Fixtures

```json
{
  "version": "1.20.1",
  "addons": ["finer-peripherals"],
  "players": [{ "name": "Alex", "x": 2.5, "y": 64, "z": -3.5 }],
  "finerPeripherals": {
    "owner": "Alex",
    "ender": { "0": { "name": "minecraft:diamond", "count": 10 } },
    "respawn": { "Alex": { "x": 0, "y": 65, "z": 0 } }
  },
  "ground": { "y": 63, "name": "minecraft:stone" },
  "peripherals": [
    { "name": "chatBox_0", "type": "finerperipherals:chatbox" },
    {
      "name": "geoExplorer_0",
      "type": "finerperipherals:geoexplorer",
      "x": 0,
      "y": 64,
      "z": 0
    },
    {
      "name": "holo_0",
      "type": "finerperipherals:holoitemdisplay",
      "item": "minecraft:apple"
    }
  ]
}
```

| Field                        | Meaning                                                                     |
| ---------------------------- | --------------------------------------------------------------------------- |
| `finerPeripherals.owner`     | the turtle's owner (name or uuid in `players`), for the ender chest upgrade |
| `finerPeripherals.ender`     | the owner's ender chest, slot 0-26 to item                                  |
| `finerPeripherals.respawn`   | player name to respawn point `{ x, y, z, dimension? }`                      |
| `finerPeripherals.items`     | extra item ids the holographic display accepts (`{ "mod:item": true }`)     |
| `x`, `y`, `z` (peripheral)   | a geo explorer's block position, a pocket upgrade's holder position         |
| `item` (holographic display) | the item it shows at the start                                              |

Blocks come from the world's block fixture (`blocks`, `fills`, `ground`, docs/turtle.md), or the turtle's world.
Tags come from the game data the emulator carries, which was extracted from Forge, so ores carry `forge:ores` where
the Fabric game would say `c:ores`.

## Sim commands

| Command         | Fields                                     |
| --------------- | ------------------------------------------ |
| `finerChat`     | `player`, `message`: that player chats     |
| `finerSetEnder` | `slot` (0-26), `item` (or null)            |
| `finerSetOwner` | `owner`: a player name, or null for nobody |

Sim state, `addons["finer-peripherals"]`: `ender` (the ender chest), `relayed` (relayEvent calls), `chatBoxes` (how
many are attached); `peripherals.<display>.item`.

## Not emulated

- **Relaying to another computer**: `relayEvent` reaches only this computer (its own id). Other computers of a
  network do not get `secure_message`.
- **The hologram itself** (client rendering); the display's stored item is kept.
- **Blocks in a turtle world**: a Finer block placed in the block world is not a peripheral by itself; list it in
  `peripherals`.
- **Error positions**: a Java exception in a computer-thread method carries no position in game; the emulator's
  peripheral layer puts the caller's position in front of every error.
- **The Java NullPointerException text**: the real one continues with the JVM's helpful message, which names
  obfuscated methods; the emulator stops at the class name.
- **Order**: tags come in the data's order (the game's is a hash set's).
- State (the ender chest, the display) does not survive a reboot.
