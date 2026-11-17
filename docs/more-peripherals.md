# More Peripherals emulation

More Peripherals (mod id `peripherals`, Forge) is **not in the pack**. The emulator follows **1.20.1-1.13.0**, the last
release (16 Apr 2024). Source: `github.com/JheffersonMarques/MorePeripherals`, branch `1.20` at `48518f7` ("Added the
scanner", the commit the 1.20.1-1.13.0 jar was built from; the repository has no release tags). Method names,
signatures and the local variable names that show up in Java's NullPointerException messages were checked in that jar
(`MorePeripherals_1.20.1-1.13.0.jar`, Modrinth) with `javap`. Vanilla facts the mod leans on (the banner pattern
registry order, `Mth.atan2`, `Entity.lookAt`, `ItemStack.resetHoverName`) were read from the Minecraft 1.20.1 server
jar with `javap` against Mojang's mappings.

Nothing here could be measured in game. Every behaviour below is read from the source.

The addon id is `more-peripherals`. The Lua is `rom-overlay/rom/ccsim/addons/more-peripherals/init.lua`. Tests:
`packages/runner/src/more-peripherals.integration.test.ts`, which runs
`workspace/examples/more-peripherals/xp_station.test.lua` (the example program, then every emulated method).

## Versions

| Minecraft | More Peripherals | Emulated                                                                   |
| --------- | ---------------- | -------------------------------------------------------------------------- |
| 1.18.2    | 1.18.2-1.8       | No. An older, smaller API (no player or ender chest interface, no scanner) |
| 1.20.1    | 1.20.1-1.13.0    | Yes                                                                        |
| 1.21.1    | none             | The mod has no release                                                     |

A world must say `"version": "1.20.1"` to switch the addon on. Paths below are relative to
`src/main/java/com/hakimen/peripherals/`.

## Peripherals

| World type                  | `getType`                   | Block                                 | Methods |
| --------------------------- | --------------------------- | ------------------------------------- | ------- |
| `xp_collector`              | `xp_collector`              | Experience Collector                  | 2       |
| `xp_bottler`                | `xp_bottler`                | Experience Bottler                    | 1       |
| `crafter`                   | `crafter`                   | a vanilla crafting table              | 1       |
| `loom_interface`            | `loom_interface`            | a vanilla loom                        | 2       |
| `magnetic_card_manipulator` | `magnetic_card_manipulator` | Magnetic Card Manipulator             | 7       |
| `beehive_interface`         | `beehive_interface`         | Beehive Interface (next to a beehive) | 6       |
| `trading_interface`         | `trading_interface`         | Trading Interface (by a villager)     | 5       |
| `spawner_interface`         | `spawner_interface`         | Spawner Interface (next to a spawner) | 3       |
| `player_interface`          | `player_interface`          | Player Interface (a player card)      | 11      |
| `ender_chest_interface`     | `ender_chest_interface`     | Ender Chest Interface (a player card) | 6       |
| `moreperipherals:scanner`   | `scanner`                   | Scanner (a book or printout)          | 4       |
| `grinder`                   | `grinder`                   | Grinder (a sword)                     | 4       |

52 methods. The scanner's world type carries the mod's prefix because Classic Peripherals also has a `scanner`;
`peripheral.getType` still says `scanner`. Every method is `mainThread = true` (waits for the server tick, and events
that arrive meanwhile are lost) except the scanner's four, `lookAt` and `displayMessage`
(`peripherals/ScannerPeripheral.java`, `PlayerInterfacePeripheral.java`). `peripheral.getMethods` lists names sorted.

None of these peripherals overrides `getTarget`, so none of them is an inventory to CC: another chest's `pushItems`
cannot reach the card slot of a manipulator. The methods that take an inventory name find it with
`getAvailablePeripheral` and read its item handler (`extractHandler`); a named peripheral that is not an inventory
gives a null handler, and the method throws a `NullPointerException` the first time it touches it.

### Return values and errors

Methods return exactly what the Java returns (`exactReturns`): `MethodResult.of(false, "message")` is two values,
`MethodResult.of(true)` one, `MethodResult.of()` and `void` none. Messages are the mod's own, spelling included.
Uncaught Java exceptions read `Java Exception Thrown: <class>: <message>` (CC's `LuaContext`):

- a null handler: `java.lang.NullPointerException: Cannot invoke "net.minecraftforge.items.IItemHandler.getSlots()"
because "input" is null`, with the method and the local variable name that the jar has at that call;
- a slot one past the end (most checks are `slot > getSlots()`, so `slot == getSlots()` gets through): a vanilla
  container's `java.lang.ArrayIndexOutOfBoundsException: Index 27 out of bounds for length 27`. A modded inventory
  backed by Forge's `ItemStackHandler` would throw `java.lang.RuntimeException: Slot 27 not in valid range - [0,27)`
  instead; the emulator always gives the vanilla one;
- `ClassCastException` (an xp collector name that is not one): the message stops after the two class names; the real
  one goes on with the module and class loader of each.

CC's own argument errors (`bad argument #2 (number expected, got nil)`) come first, before any of these.

## Behaviour (all from the source)

**xp_collector** (`XPCollectorPeripheral`, `blocks/tile_entities/XPCollectorEntity`): `getCurrentXP()` is the stored
points, `dumpXP()` empties them (no return). The block takes every experience orb within a block each tick; the sim
command `mpAddXP` stands in for the orbs.

**xp_bottler** (`XPBottlerPeripheral.bottleXP(from, to, collector)`): checks the input, the collector and the output
exist (a missing output reads `the output null was not found`: the mod prints the null peripheral), then
`bottles = xp / 8` (`not enough experience in collector` at 0), then that the output has a slot that is empty or an
unfilled stack of bottles o' enchanting. Each bottle takes one glass bottle from the first slot that has one (`no
bottles found in input` when it runs out, keeping what was already bottled), puts one bottle o' enchanting in the
first output slot with room and takes 8 points. A bottle taken when no output slot has room is lost and costs no
points.

**crafter** (`CrafterPeripheral.craft(from, to, grid)`): `grid` maps a crafting grid position (1-9, reading order)
to a slot of `from`. Slots used more than once must hold that many items (`Not enough resources on slot %d to
craft`). The recipe is the version's crafting recipe data (as `turtle.craft`, vanilla first). The result goes into the
first slot of `to` that takes all of it, then one item leaves every slot named. Kept as in the mod:
**no matching recipe answers `true`**, a full output answers `true` and crafts nothing, a grid position outside 1-9
throws `ArrayIndexOutOfBoundsException: Index 9 out of bounds for length 9`, and the remainder loop (buckets, honey
and dragon's breath bottles) reads `remainders.get(k)` by inventory slot, so with a remainder and an input whose first
slot takes it, the call throws `IndexOutOfBoundsException: Index 1 out of bounds for length 1` after the result is
already in the output. Crafted results carry no NBT.

**loom_interface** (`LoomInterfacePeripheral`): `paintBanner(from, bannerSlot, dyeSlot, pattern)` needs a banner
(`minecraft:<colour>_banner`, or an item with `banner: true`), a dye (`minecraft:<colour>_dye`) at least as many as the
banners, and a pattern number 1-41 in `BuiltInRegistries.BANNER_PATTERN` order (`b`, `bl`, `br`, `tl`, `tr`, `bs`,
`ts`, `ls`, `rs`, `cs`, `ms`, `drs`, `dls`, `ss`, `cr`, `sc`, `bt`, `tt`, `bts`, `tts`, `ld`, `rd`, `lud`, `rud`, `mc`,
`mr`, `vh`, `hh`, `vhr`, `hhb`, `bo`, `cbo`, `gra`, `gru`, `bri`, `glb`, `cre`, `sku`, `flo`, `moj`, `pig`; 42 gets
through the check and throws). The "not a banner/dye" messages print the 0-based slot. The dye is used up, the
pattern goes onto the banner's `BlockEntityTag.Patterns` with no limit on how many, and the item's `nbt` changes.
`clearBanner(from, slot)` removes them all.

**magnetic_card_manipulator** (`MagneticCardManiputalorPeripheral`, `items/MagneticCardItem`): `readCard()` is the
card's `data` (`""` when none; reading gives a tagless card an empty tag, as `getOrCreateTag` does), `writeCard(text)`
sets it (`""` removes it), `hasCard()`, `setLabel(text)` (`""` resets it), `getLabel()` (the custom name, else
"Magnetic Card"), `setSecure(bool)` (the `sensible` flag). `ejectCard()` drops the card. Events: `card_insert` when a
player puts a card in through the GUI (`mpSetCard`), `card_remove` when one is taken out, `card_read` with the card's
data when a player uses a card on the block (`mpSwipeCard`). The data is the NBT string's `toString()` with its first
and last characters cut off, so `\` and the quote NBT chose come back escaped. The two `card_remove`s of `ejectCard`
are queued while the calling computer waits for its main-thread task, so that computer never sees them.

**beehive_interface** (`BeehiveInterfacePeripheral`, `BeehiveInterfaceEntity`): needs exactly one beehive next to it
(`more than one beehive connected`, `no beehive present`). `hasBees()`, `getBeeCount()`, `gotFireNear()`,
`getHoneyLevel()`, `getBees()` (`{ TicksInHive, MinOccupationTicks, EntityData = { HasStung, Health, HasNectar, Age,
AngerTime } }` per bee). `collectHoney(from, to, bottled)` at honey level 5: a missing inventory **throws** (`the input
x was not found`), a glass bottle becomes a honey bottle, or shears (one more point of damage, broken at 238) give 1-3
honeycomb; the item is taken before the output is checked, so a full output still costs it. The hive goes back to 0.

**trading_interface** (`TradingInterfacePeripheral`, `TradingInterfaceEntity`): a villager within a block.
`getProfession()` is the profession's name (`librarian`). `getTrades()` lists each offer as `{ costA, costB, result }`,
each `{ [item id] = { enchants = { [id] = level }, count } }`, a missing second cost as `minecraft:air` with count 0.
`trade(from, to, n)`: the first slot with enough of the first cost; **the second cost is never required** (it is
taken only if a slot has it); the result goes into `to` one slot at a time (what went in stays even when the rest
does not fit: `destination inventory full`), then the costs shrink. Uses are not counted, so offers never lock;
`restock()` answers `true`. A missing `to` reads `the input x was not found` (the mod's message). `cycleTrades()`
resets the villager to level 1 and its offers: the next list from the fixture's `rerolls`, if any; within 50 ms of the
last cycle it returns nothing.

**spawner_interface** (`SpawnerPeripheral`, `SpawnerInterfaceEntity`): exactly one spawner next to it.
`getCurrentlySpawningMob()` is the entity id. `changeSpawner(inv, slot, force?)` takes a spawner card
(`peripherals:spawner_card`) with a tag: the spawner takes the card's `mob`, and the card the spawner's old one, or
loses it with `force`; its custom name is reset, which drops a tag left empty. A card with a tag but no `mob` throws
`java.util.NoSuchElementException: No value present`. A missing `inv` throws a `NullPointerException` (the mod tests the
name, not the peripheral). `captureSpawner(inv?, slot?)`: with a card slot, writes the mob onto the card (named
"Spawner Card (id)") and breaks the spawner, dropping a spawner item; with no inventory, breaks a pig spawner; else
`false`. Twice within 50 ms answers `false`.

**player_interface** and **ender_chest_interface** (`PlayerInterfacePeripheral`, `EnderChestInterfacePeripheral`):
a player card in the block. `No card present`, `Card isn't bound`, `Player isn't present`: the player interface
reaches an online player anywhere (the server's player list), the ender chest interface only one in its own dimension
(`level.getPlayerByUUID`). Both have `list`, `size`, `getItemDetail` (`false` for an empty slot), `getItemLimit`,
`pushItems(to, slot, limit?, toSlot?)` and `pullItems(from, slot, limit?, toSlot?)`, over the player's 41 slots (1-36
main, 37-40 feet to head, 41 the off hand) or the 27-slot ender chest:

- the limit defaults to **1**, and transfers take from the player's stack first: what the target refuses goes back
  with `Inventory.add` (the held slot, the off hand, then the main slots) and anything that does not fit there is lost;
- without `toSlot`, `pushItems` offers **the whole stack to every target slot** until one takes all of it, so a
  partly filled first slot gets a share and the next slot all of it again (the mod duplicates items here); the
  answer is the count taken;
- `pushItems` on the player interface only reads from slots 1-36; `pullItems` checks there is any room
  (`Player inventory is full`, `Ender chest is full`) before taking, and with `toSlot` overwrites an empty slot or
  tops up a matching stack (`Couldn't move items to slot n` otherwise, with the items already gone).

The player interface also has `getPlayerInfo()` (`name`, `uuid`, `pos`, `hunger = { hunger, saturation }`, `yaw`,
`pitch`, `effects = { [id] = { duration (seconds), amplifier } }`, `dimension`), `getEquipment()` (details by
`mainhand`, `offhand`, `feet`, `legs`, `chest`, `head`), `consume(slot)` (an item with `food` in the fixture:
`FoodData.eat`, the stack shrinks; otherwise `Item isn't edible`), `lookAt(x, y, z)` (`Entity.lookAt` from the eyes,
1.62 above the feet, with Minecraft's table `Mth.atan2` and float rounding) and `displayMessage(text, actionBar?)`
(kept in the player's `messages` and the sim's chat log).

**scanner** (`ScannerPeripheral`): the item in its slot. `getPage(n)` is page `n` of a written book (its JSON text
flattened: `text` and `extra`; a `translate` key shows as the key), of a book and quill (as written), or, for a
printout, **line** `n` of the printout's text (the mod indexes `PrintoutItem.getText`, which is lines). Page checks
are `between 0 and pages` after taking 1 off, so `n = pages + 1` gets through and throws Guava's
`IndexOutOfBoundsException: index (2) must be less than size (2)` (books) or an `ArrayIndexOutOfBoundsException`.
A written book whose tag is not valid reads `* Invalid book tag *` on page 1. `getAuthor()`, `getTitle()` (written
books and printouts), `getCopyStatus()` (`ORIGINAL`, `COPY`, `COPY OF COPY`; generation 3 throws). The book methods
call `Minecraft.getInstance()`, a client class: the emulator answers as a single-player or LAN world does; on a
dedicated server they fail.

**grinder** (`GrinderPeripheral`): `hasSword()`; `pullSword(from, slot)` takes a sword from a **0-based** slot
(the mod does not take 1 off), `false` if it is not a sword, `there is a sword in the grinder already`; `pushSword(to)`
puts it in the first empty slot and answers `true` even when the grinder was empty; `attack()` swings at living
entities within 2 blocks (no return). A sword is an item tagged `minecraft:swords`, or one with `sword: true`.

## Fixture fields

Each block is an entry in `peripherals` with its world type and name. Items are as in chests; the NBT keys this mod
reads go in `tag` (moved out of `getItemDetail`'s way at boot), and when a method changes them the item's `nbt` hash
becomes a stand-in made from them, not the real NBT hash. Custom names (`displayName`) do not change it.

| Field       | Block                                   | Meaning                                                                                                                                                |
| ----------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `xp`        | xp_collector                            | stored points (default 0)                                                                                                                              |
| `card`      | magnetic_card_manipulator               | `{ data?, label?, sensible? }`, or leave it out for no card                                                                                            |
| `card`      | player_interface, ender_chest_interface | the bound player's name, `{ owner, uuid? }`, `{}` for an unbound card; leave it out for no card                                                        |
| `beehive`   | beehive_interface                       | `{ honeyLevel, fireNearby, bees = [{ ticksInHive, minOccupationTicks, hasStung, health, hasNectar, age, angerTime }] }`                                |
| `beehives`  | beehive_interface                       | how many hives touch it (default 1 with a `beehive`, else 0)                                                                                           |
| `villager`  | trading_interface                       | `{ profession, offers = [{ costA, costB?, result }], rerolls? = [offers, ...] }`, stacks `{ name, count, enchantments? }`                              |
| `spawner`   | spawner_interface                       | `{ mob }` (default `minecraft:pig`) or the id; `spawners` for how many touch it                                                                        |
| `item`      | moreperipherals:scanner                 | the item, with `book = { title, author, generation, pages }` (written books: pages a list of JSON text; printouts: `pages` a count and `lines` a list) |
| `sword`     | grinder                                 | the sword in it                                                                                                                                        |
| `dimension` | ender_chest_interface                   | its dimension (default the computer's)                                                                                                                 |

Players come from `players` (name, uuid, online, position, `yaw`, `pitch`, `dimension`). What they carry is under
`morePeripherals.players.<name>`: `inventory` and `enderChest` (1-based slot to item), `selected` (hotbar 0-8),
`food`, `saturation`, `effects` (`{ [id] = { duration (ticks), amplifier } }`). An item with
`food = { nutrition, saturation }` is edible. `morePeripherals.entities` lists entity ids a spawner card may carry
besides the vanilla ones with a spawn egg (any other namespace is taken as real).

## Sim commands

| Command            | Arguments                                                                                                                                    |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `mpAddXP`          | `peripheral`, `amount`: orbs reach a collector                                                                                               |
| `mpSetCard`        | `peripheral`, `card` (`{ data?, label?, sensible? }`) or `false`: `card_insert` / `card_remove`                                              |
| `mpSwipeCard`      | `peripheral`, `data?`: a player uses a card on the manipulator, `card_read` (none without data)                                              |
| `mpSetBeehive`     | `peripheral`, `beehive` (or `false`), `beehives?`                                                                                            |
| `mpSetVillager`    | `peripheral`, `villager` or `false` (walked away)                                                                                            |
| `mpSetSpawner`     | `peripheral`, `mob` or `false`, `spawners?`                                                                                                  |
| `mpSetPlayerCard`  | `peripheral`, `card` as in the fixture, or `false`                                                                                           |
| `mpSetPlayer`      | `player`, and any of `inventory`, `enderChest` (slot to item or `false`), `selected`, `food`, `saturation`, `effects`, `online`, `dimension` |
| `mpSetScannerItem` | `peripheral`, `item` or `false`                                                                                                              |

State: `state.peripherals.<name>` holds each block's own (stored XP, the card, the hive, the villager, the spawner,
the scanned item, the sword, and for the card interfaces the player's inventory, ender chest, food and messages), and
`state.addons["more-peripherals"].players` every player's.

## Not emulated

- **anvil_interface** (`combine`, `rename`), **enchanting_interface** (`getEnchantsFor`, `enchant`) and
  **grindstone_interface** (`combine`, `disenchant`): they run vanilla's anvil, grindstone and enchanting rules
  (enchantment categories, rarities, compatibility, repair materials, durability, random enchantments) on the
  item. The emulator has no enchantment registry or item durability data for 1.20.1 to run them on.
- **disk_raid** and **advanced_disk_raid**: they mount each floppy into the computer's file system as `disk`,
  `disk2`, ...; not built yet (`addons/mounts.lua`, which the hard drives of Cricket's Peripherals and Embedded
  Computer use, could carry them).
- The turtle upgrades **magnet**, **ender_bag** and **solar**, the **keyboard** item (it forwards a player's key
  presses from a client screen), the induction charger and the facade tool (no peripheral).
- Entities: the grinder's `attack()` reaches nothing, the collector only gets what `mpAddXP` gives, dropped items
  (ejected cards, captured spawners) are only counted in the state.
- Villager trade tables: `cycleTrades` takes the fixture's `rerolls`; without them the offers stay as they were.
- Food effects (a golden apple's absorption) and every food's nutrition: only items with `food` in the fixture are
  edible.
- Entity registry: an id counts as known when the fixture lists it, it is from another namespace, or vanilla has a
  spawn egg for it.
- The order of `peripheral.getMethods` (sorted here).
