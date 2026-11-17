# Create: CC Total Logistics emulation

Addon id `create-cc-logistics` (needs `create`). Lua in `rom-overlay/rom/ccsim/addons/create-cc-logistics/init.lua`.
Mod page: https://modrinth.com/mod/create-cc-total-logistics, source: https://gitlab.com/xeli-cloud/create-cc-logistics.

| Minecraft | Mod version       | Source read                                                                  |
| --------- | ----------------- | ---------------------------------------------------------------------------- |
| 1.18.2    | none (no release) | the addon is refused on 1.18.2 worlds                                        |
| 1.20.1    | 0.3.7 (Forge)     | branch `1.20.1-forge` at `f40f558` (mod_version 0.3.7)                       |
| 1.21.1    | 0.3.6 (NeoForge)  | `master` at `5f952d2` (only CI and README changes after `9efe133` "v 0.3.6") |

Both released jars (`createcclogistics-1.20.1-forge-0.3.7.jar`, `createcclogistics-1.21.1-0.3.6.jar`) were checked
with `javap`: method names, signatures and every error string match the source. Create's side was read at tag
`mc1.20.1-6.0.8`; `Item.toString` and the `ItemStack` codec were read in the official 1.20.1 and 1.21.1 server jars.
A world needs `"version": "1.20.1"` or `"1.21.1"`. Paths below are relative to the mod's
`src/main/kotlin/com/xeli/createcclogistics/` or Create's `src/main/java/com/simibubi/create/content/`.

## Peripherals

`LogisticsMod` attaches a peripheral to five Create blocks. None sends events.

| Type                 | Block              | Methods                                                                                                                                            |
| -------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stockcheckingblock` | Stock Ticker       | inventorySize, itemBasicDetails, itemDetails, getCountOf, countConnectedStockLinks, stockLinkDetails                                               |
| `redstonerequester`  | Redstone Requester | request, requestCraft                                                                                                                              |
| `packageport`        | Frogport, Postbox  | listPackages, capacity, getPackageContentDetails, renamePackageAddress, getAcceptsPackages, setAcceptsPackages, getAddressFilter, setAddressFilter |
| `clipboard`          | Clipboard (placed) | isClipboardAttached, getNumPages, readPage                                                                                                         |

19 methods. `packageport` also has the type `inventory` (`getAdditionalTypes`) but none of the inventory methods:
its `getTarget()` is the block, so other inventories' `pushItems`/`pullItems` reach it by name. Every method is
`mainThread` (waits for the next server tick) except the clipboard's three. `peripheral.getMethods` gives CC's
`HashMap` order. The 0.3.6 jar also has `InventoryPeripheral`, `RemotePackagePortPeripheral`, a Digital Stock Ticker
block entity and a clipboard peripheral block, but none of them is registered, so none exists in game.

## Fixtures

```jsonc
"version": "1.20.1",
"addons": ["create", "create-cc-logistics"],
"createLogistics": {
  "travelTicks": 40,            // ticks a package takes from its packager to a port (default 40)
  "items": ["mymod:widget"],    // extra item ids that exist (see "Items")
  "networks": {                 // a logistics network: the stock links on one frequency
    "main": {
      "travelTicks": 20,        // per network (optional)
      "links": [
        { "name": "vault", "inventory": "minecraft:chest_0" },      // a packager facing a world inventory
        { "name": "farm", "items": [{ "name": "minecraft:wheat", "count": 64 }], "size": 27,
          "block": "minecraft:barrel",          // what the packager faces, for stockLinkDetails().type
          "power": 0,                           // redstone on the link; 15 takes it off the network
          "packager": true,                     // false: a link with no packager behind it
          "frogport": "frogport_0",             // a packageport peripheral above the packager, or
          "frogportAddress": "Farm",            //   just the address it would report
          "travelTicks": 10 },
        { "name": "bare", "inventory": false }  // a packager facing no inventory
      ]
    }
  }
}
```

Peripheral fields:

- `stockcheckingblock`, `redstonerequester`: `network` (the id in `networks`; an unknown id is an empty frequency).
- `packageport`: `addressFilter` (default ""), `acceptsPackages` (default true), `packages: [{ slot?, address,
items: [...up to 9], final? }]` already in its 18 slots.
- `clipboard`: `pages: [[{ text, checked?, icon?: { name, count? }, amount? }]]`.

Items are the sim's usual `{ name, count, nbt?, displayName?, maxCount? }`. The item JSON the mod prints and reads
also needs the item's data: `tag` (1.20.1, the NBT as JSON) or `components` (1.21.1). Two stacks are the same when
name and tag/components (or, without them, `nbt`) match.

## Sim commands

| Command             | Fields                                 | Does                                                          |
| ------------------- | -------------------------------------- | ------------------------------------------------------------- |
| `cclAddItems`       | `network, link?, items` (or `item`)    | items into a link's inventory (the first link without `link`) |
| `cclRemoveItems`    | `network, link?, name, count?`         | items out of a link's inventory                               |
| `cclSetLinkPower`   | `network, link, power`                 | redstone on a stock link (15: off the network)                |
| `cclAddLink`        | `network, link: { ...fixture link }`   | a new stock link (a new network when the id is new)           |
| `cclDeliverPackage` | `port, slot?, address?, items, final?` | a package lands in a port                                     |
| `cclTakePackage`    | `port, slot`                           | a player takes a package out                                  |
| `cclSetClipboard`   | `peripheral, pages`                    | the clipboard's pages change                                  |

`craftos_sim_state`: `peripherals.<port>` (filter, accepting, packages per slot with address and items),
`peripherals.<ticker|requester>` (network and stock), `peripherals.<clipboard>` (pages), and
`addons["create-cc-logistics"]`: per network every link (items by slot, power, packages queued, one being sent, the
packager's animation) and the stock, packages on their way (`transit`), and a log of every request (`requests`:
peripheral, kind, address, ok, tick).

## Behaviour and its source

### Stock ticker

| Rule                                                                                                                                                                                                                                                                                                   | Source                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| the summary is the network's: every present link's packager, each inventory counted once; a link at redstone 15 is not present                                                                                                                                                                         | `LogisticsManager.createSummaryOfNetwork`, `LogisticallyLinkedBehaviour` |
| one entry per item and tag; counts add up (to 1 000 000 000); the entry keeps the first slot's stack                                                                                                                                                                                                   | `InventorySummary.add`                                                   |
| `itemBasicDetails`/`itemDetails`: `count`, `id`, `displayName` (+ `item`, the stack's JSON); 1-based, "Index out of range (between 1 and N)"                                                                                                                                                           | `DigitalStockTickerPeripheral`, `AssertBetween`                          |
| `id` is `Item.toString()`: the path on 1.20.1 (`iron_ingot`), the full id on 1.21.1                                                                                                                                                                                                                    | `ItemDetails.basicItemDetails`, `Item.toString` in the server jars       |
| `getCountOf` takes an item's **JSON**, not an id: `'{"id":"minecraft:iron_ingot","Count":1}'`; a plain id throws a Gson exception                                                                                                                                                                      | `DigitalStockTickerPeripheral.getCountOf`, `ReinterpretItemTag`          |
| `countConnectedStockLinks`/`stockLinkDetails`: links with a packager, not grouped by inventory; `capacity` and `occupiedSlots`, or `capacity = "unknown"` facing no inventory; `type` is the faced block as a language key (`minecraft.chest`); `frogportAddress` when a frogport sits on the packager | `DigitalStockTickerPeripheral.listPackagers`, `packagerInfo`             |

### Item JSON

| Rule                                                                                                                             | Source                                |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 1.20.1 prints `{"id":…,"Count":n}` and `"tag"`; 1.21.1 prints `{"id":…,"count":n}` and `"components"`                            | `encodeItemAsJson`, `ItemStack.CODEC` |
| Gson escapes `< > & = '`; NBT keys come out in `HashMap` order                                                                   | Gson defaults, `CompoundTag`          |
| reading: 1.20.1 needs `Count`; 1.21.1's `count` is optional and anything outside 1..99 reads as 1; 1.21.1 refuses air            | `ItemStack.CODEC` (both jars)         |
| an unknown id, a missing id, a non-object tag: "Item not parseable from "…" or non-existent"; broken JSON: `JsonSyntaxException` | `String.reinterpret`                  |
| an id entry is read as `{"id": id, "Count": 1}` (`"count"` on 1.21.1)                                                            | `String.reinterpretAsID`              |

### Redstone requester

| Rule                                                                                                                                                                                   | Source                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `request(contents, address?, allowPartial?, makeSound?)`: entries `{count, item}`, `{count, id}` or `{count, index}` (index into the stock list)                                       | `RedstoneRequesterPeripheral.request`, `reinterpret`          |
| the contents' values are taken in key order; with two or more keys a non-number key, or a non-table value, throws Java's `ClassCastException` text                                     | `coerceList`                                                  |
| a missing or non-number `count`, or a non-string `item`/`id`, gives "Expected table format: …"; `{}` gives "Contents list argument is empty"                                           | `reinterpret`, `request`                                      |
| refused (false) when the network lacks any item and `allowPartial` is not true; otherwise the broadcast's answer                                                                       | `makeRequest`                                                 |
| links sorted by redstone power, then grouped by inventory (one per inventory); each item is taken from the links in turn, up to what each has                                          | `LogisticsManager.findPackagersForRequest`                    |
| a packager with 20 or more packages queued makes the whole request false                                                                                                               | `PackagerBlockEntity.isTooBusyFor(REDSTONE)`                  |
| packages hold 9 stacks; requests with the same address and order share packages; up to 100 packages per packager at once                                                               | `PackagerBlockEntity.attemptToSend`, `performPackageRequests` |
| a packager sends one package per 20-tick animation, then the next from its queue                                                                                                       | `PackagerBlockEntity.tick`                                    |
| `requestCraft(crafts, address?, makeSound?)`: up to 9 ingredients (`{item}`, `{id}`, `{index}` or `"empty"`), one of each; false when any is short                                     | `requestCraft`, `enoughIngredientsForCrafting`                |
| `requestCraft` errors: a bad `{index}` entry says "Expected table format" (not the crafting one); a non-table, non-"empty" entry adds ", got <value>" (numbers as Java doubles: `5.0`) | `reinterpretAsCraft`                                          |
| an `{index}` entry repeated counts together; other entries are each checked alone                                                                                                      | `BigItemStack.equals` (the `ItemStack` object)                |

### Package ports

| Rule                                                                                                                                                                  | Source                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 18 slots; `listPackages` maps slot to `{address, orderIsComplete}`                                                                                                    | `PackagePortBlockEntity`, `listPackages`        |
| `orderIsComplete`: 1.20.1 reads `IsFinal` at the top of the tag, where it never is: always false; 1.21.1 reads the order data: true without any                       | `PackagePortPeripheral.listPackages` (both)     |
| `getPackageContentDetails(i)`: the package's stacks as `{count, id, displayName, item}`; "Targeted index is empty" / "… does not contain a package"                   | `getPackageContentDetails`, `getPackageAtIndex` |
| `renamePackageAddress` checks the index, then the slot                                                                                                                | `renamePackageAddress`                          |
| other inventories: only packages go in and not ones addressed to this port; only packages addressed to this port come out, and none while it does not accept packages | `PackagePortAutomationInventoryWrapper`         |
| addresses: blank matches blank only; `*` matches anything; otherwise equal, or either side as a glob                                                                  | `PackageItem.matchAddress`                      |

### Clipboard

| Rule                                                                                      | Source                             |
| ----------------------------------------------------------------------------------------- | ---------------------------------- |
| the peripheral is the clipboard itself, so `isClipboardAttached` is always true           | `LogisticsMod` (clipboard context) |
| `readPage(i)`: entries `{checked, text, icon?}`; the icon's `count` is the entry's amount | `ClipboardPeripheral.readPage`     |

## Not emulated / not confirmed

- **Create 6.0.7 and later shadow most of this mod.** From Create 6.0.7, Create has its own Frogport, Postbox,
  Redstone Requester and Stock Ticker peripherals. On Forge 1.20.1 their block entities answer the peripheral
  capability before any attached one, so with Create 6.0.7+ only this mod's clipboard is reachable; on NeoForge
  1.21.1 it depends on which mod registers first. This addon is the mod as it works with Create 6.0.4 to 6.0.6.
  The `create` addon does not simulate Create 6's own logistics peripherals.
- **Package travel is a timer.** A package leaves its packager when the 20-tick animation ends and arrives
  `travelTicks` later at the first port (in world order) that accepts packages, matches its address and has a free
  slot; without one it waits. Chain conveyors, frogports' own hops, trains, postbox schedules and packages put into a
  port being sent on are not simulated. Packages are never unpacked at a packager.
- **Orders that Create leaves to chance:** which link of an inventory group serves a request (random), the order of
  inventory groups (a `HashMap`), the order of requests at one packager (a `HashSet`), the order of the stock list
  (an `IdentityHashMap` of items) and the package style (random). The sim takes them in fixture order and cycles the
  four standard cardboard styles.
- **Items:** a `minecraft:` id exists when the version's item data has it or the world names it; any other
  well-formed id is taken as existing (the sim has no other mods' item lists). NBT types (byte vs int) are not kept: the
  fixture tag is printed as written, booleans as 1/0. 1.21.1 components are printed as written, not checked.
- `JsonSyntaxException`: the message after the class name is left out (Gson's wording depends on where it stops).
  Gson's lenient reader accepts things (single quotes, unquoted names) that the sim's JSON reader refuses.
- Globs: only `*` and `?` are wildcards here; Create's `Glob` may support more.
- Display names come from the item fixture or the sim's default, as for every other inventory.
- `makeSound`: Create's requester effect packet (a sound and particles on clients) is not simulated. 1.21.1 shows it
  for partial successes too; nothing else differs.
- 1.21.1 clipboard text is `tryCollapseToString()`: styled text reads as "" there; fixture text is plain.
- `ForgeCaps` (Forge's capability data in the 1.20.1 item JSON) is never printed.
