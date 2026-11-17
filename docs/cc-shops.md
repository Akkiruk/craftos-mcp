# CC Shops emulation

Addon id `cc-shops`. Lua in `rom-overlay/rom/ccsim/addons/cc-shops/init.lua`. CC Shops (TechTastic) puts
ComputerCraft on Simple Shops (wolforce): a `shop` peripheral on the shop block, more methods when a command computer
touches it, and a `shop` API on turtles.

Source of truth: the released jars, read with `javap`, and the source where it matches them.

| Minecraft | CC Shops                                  | Simple Shops                      | Turtle API |
| --------- | ----------------------------------------- | --------------------------------- | ---------- |
| 1.18.2    | `ccshops-0.0.1.jar` (Modrinth `mTCrg0Ga`) | 1.1.4 (CurseForge file `3806656`) | yes        |
| 1.20.1    | `0.0.1-fixed` (Modrinth `XSzJW3ls`)       | CurseForge file `4716851`         | none       |

Both CC Shops jars hold the code of `github.com/TechTastic/CC-Shops` branch `1.20.x/main` at `36f92f6`
(`common/src/main/java/io/github/techtastic/ccshops/`): the turtle API has `buy`, `buyUp` and `buyDown` only. The
`1.18.x/main` branch (`d3fa015`, July 2024) adds `restock`, `changePrice`, `profit` and `recall`, but no release
has them, so they are not here. Simple Shops' own GitHub branches (`wolforcept/simpleshops`) are older than both jars
(no stock viewer slot), so Simple Shops was read from the jars only.

## The peripheral

Type `shop`, no other types (the block entity has no item capability). No method is `mainThread`: every call
answers at once. Events go to every computer the shop is attached to, once per attachment.

`CCShopsForgePeripheralProvider` hands out `SimpleShopCommandPeripheral` when the block on the side being asked
about is a command computer, else `SimpleShopPeripheral`. A computer reaching the shop through a wired modem never
gets the command one (the neighbour is the modem).

| Method             | Returns                                                                                                                    |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `getStockItem()`   | the item one sale gives, `{ name, count, nbt? }` (`ItemData.fillBasic`); empty is `minecraft:air` x 0                      |
| `getStockAmount()` | sales left: `stored / stock.count`, integer division; 0 when nothing is for sale                                           |
| `getCostItem()`    | the price, same shape                                                                                                      |
| `getGainsAmount()` | payment items held for the owner                                                                                           |
| `getBarItem()`     | the stock viewer item in the shop, same shape                                                                              |
| `getOwner()`       | two values: the owner's name (an online player's profile name, else a loaded entity's display name, else nil) and the UUID |

Command computer only:

| Method               | Does                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| `setStockItem(item)` | the item a sale gives                                                                                |
| `setStockAmount(n)`  | sets the stored **item** total (`invNr`), not sales: `getStockAmount` then answers `n / stock.count` |
| `setCostItem(item)`  | the price                                                                                            |
| `setGainsAmount(n)`  | the owner's held payments                                                                            |
| `setBarItem(item)`   | sets the bar if the item is a stock viewer, then **always** throws `Not a Bar`                       |
| `setOwner(uuid)`     | sets the owner if a player or entity with that UUID is loaded, then **always** throws `Invalid UUID` |

The two "always throws" are the mod's bugs (a missing `return`/`else`), confirmed in both jars' bytecode.

`item` is a table `{ name, count? }` (`getItemStackFromData`), checked in this order:

1. no `name` key (or one CC cannot convert, such as a function): `Invalid Item Data, needs name`
2. `name` not a string: `Java Exception Thrown: java.lang.ClassCastException: class java.lang.Double cannot be cast to class java.lang.String (java.lang.Double and java.lang.String are in module java.base of loader 'bootstrap')` (Boolean, HashMap for the other types)
3. `new ResourceLocation(name)`: `Java Exception Thrown: net.minecraft.ResourceLocationException: Non [a-z0-9_.-] character in namespace of location: ...` (or `path`)
4. an id nothing registered reads as air; air from any spelling but the literal `"minecraft:air"`: `Invalid Item Name, use namespace:id format`
5. `count` (default 1) not a number: the same ClassCastException to `java.lang.Double`; a number is cast `(int)` (toward zero, saturating). A count of 0 or less is an empty stack.

No NBT can be given. Numbers go through CC's `getInt`: `getLong` then `(int)`, so 5.9 is 5 and 2^32 + 1 is 1;
`bad argument #1 (number expected, got nil|string|nan|inf|-inf)`. `setOwner` takes CC's `getString`, which refuses
numbers (`bad argument #1 (string expected, got number)`), then Java 17's `UUID.fromString`:
`IllegalArgumentException: UUID string too large` (over 36 characters), `Invalid UUID string: <s>` (not exactly four
dashes), and `NumberFormatException` from `Long.parseLong` for a bad group (`Error at index <i> in: "<group>"`,
`For input string: "" under radix 16`). Short groups, a sign and capitals are accepted: `"1-2-3-4-5"` is
`00000001-0002-0003-0004-000000000005`. A leading `-` is the first dash `indexOf` finds, so `"-1-0-0-0-0"` has five
dashes and is invalid; no group can be negative.

`peripheral.getMethods` order: CC's `HashMap` over the methods (the command class's own before the inherited ones).

### Events

`buy_attempt`, as `MixinSimpleShopTileEntity` sends it: `buyer, item, creative, success`.

- `buyer`: the player's name, or the buying turtle's label (nil without one).
- `item`: what the buyer offered, `{ name, count, nbt? }` (air x 0 for an empty hand or slot).
- `creative`: the block is a Creative Simple Shop (a turtle on a sold-out normal shop always sends false).
- `success`: the sale went through.

A player's buy sends it every time `tryBuy` runs (also when sold out or paying wrong). A turtle's buy sends it for
every outcome except "Not a Shop". There is no event for the owner restocking, setting the price or taking profits.

## The turtle API (1.18.2)

`MixinTileTurtle` adds the `shop` API to every turtle: `buy()`, `buyUp()`, `buyDown()`. Each is a turtle command: it
waits for the turtle's next command slot and returns `true`, or `false, message`. Events that arrive meanwhile are
lost, as with any turtle command (catch `buy_attempt` in `parallel`).

`ccshops$tryBuyWithTurtle`, with the selected slot as payment, in this order:

| Check                                                    | Result                            |
| -------------------------------------------------------- | --------------------------------- |
| no Simple Shop block there                               | `false, "Not a Shop"` (no event)  |
| normal shop with no whole sale stored                    | `false, "Out of Stock"`           |
| payment is not the cost's item (`sameItem`, NBT ignored) | `false, "Incorrect Payment Item"` |
| payment count below the cost's                           | `false, "Insufficient Funds"`     |
| no slot for the goods                                    | `false, "Not Enough Space"`       |
| otherwise                                                | `true`                            |

The goods slot (`ccshops$hasOpenSpace`) is the first slot that is empty (the selected one too), or holds the same
item (NBT ignored) with room for a whole sale and is not selected. The goods join that stack and keep its NBT. The
shop loses `stock.count` stored items (not a creative one) and gains `cost.count` payments; the payment slot keeps
the change.

**The ghost stack.** Paying with exactly the whole stack leaves Java a 0-count stack of the payment item in that
slot (`setItem(slot, change)` with count 0: CC's turtle inventory keeps it, it reads as empty). When a later sale
picks that slot for its goods, the mod grows the stack (`current.grow`) because it is not `ItemStack.EMPTY` itself,
and the old item comes back: the turtle gets that many **payment items** instead of the goods. The sim keeps such a
slot's item until anything is put in the slot (any real item replaces the stack in Java too); `craftos_sim_state`
lists them under `addons.cc-shops.ghosts`.

### 1.20.1: no turtle API

`0.0.1-fixed`'s `MixinTileTurtle` reaches CC 1.121's `Computer` by reflection and asks for
`getDeclaredMethod("addApi")` with no parameter types. `Computer` has only `addApi(ILuaAPI)` and
`addApi(ILuaAPI, ApiLifecycle)`, so the lookup throws `NoSuchMethodException`, which the mixin catches and ignores
(and its `invoke` would have had the wrong receiver anyway). No 1.20.1 turtle has `shop`; the peripheral works.

## Item matching, 1.18.2 and 1.20.1

Simple Shops 1.18.2 compares with `ItemStack.sameItem` (false when the cost is empty); 1.20.1 with
`ItemStack.is(cost.getItem())`, so an empty hand matches an empty cost there and buys for free. Only the player buy
reaches that on 1.20.1.

## Fixtures

```jsonc
"ccShops": {                                  // optional; loads the addon at boot
  "players": [{ "name": "Alex", "uuid": "..." }],        // online players (getOwner, setOwner)
  "entities": [{ "name": "Golem", "uuid": "..." }],      // other loaded entities, by display name
  "commandComputer": false,                   // default for peripherals that do not say
  "items": ["somemod:widget"]                 // item ids to accept besides the game data's and Simple Shops' own
},
"peripherals": [
  { "name": "shop_0", "type": "shop",
    "stock": { "name": "minecraft:diamond", "count": 2 },   // what one sale gives
    "stored": 7,                              // items held for sale (invNr): 3 sales here
    "cost": { "name": "minecraft:emerald", "count": 3 },
    "gains": 0,                               // payments held for the owner
    "bar": { "name": "simpleshops:wooden_stockbar" },       // stock viewer, optional
    "owner": "uuid",                          // default 00000000-0000-0000-0000-000000000000
    "creative": false,                        // a Creative Simple Shop
    "commandComputer": false }                // the computer touching it is a command computer
]
```

Items are `{ name, count?, nbt? }` (`nbt` a hash string, as `getItemDetail` shows it).

In a block world (a turtle, or a `placed` computer), a shop is a block: `{ "x", "y", "z", "name":
"simpleshops:simple_shop" | "simpleshops:creative_simple_shop", "shop": { ...the fields above } }`. A shop block next
to the turtle or computer is its `shop` peripheral on that side; a `placed` command computer
(`"block": "computercraft:computer_command"`) gets the command methods. The turtle API reaches shop blocks in front,
above and below.

The addon's `types.lua` also loads it at boot for worlds with `turtle` or `placed` (every turtle has the API), but only
`ccShops` counts as configuring it in `addons.ts`: a turtle world with the addon off just has no shops.

## Sim commands

| Command          | Fields                                                                                     | Does                                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shopPlayerBuy`  | `shop` (peripheral name or `"x,y,z"`) or `pos`, `player`, `item`, `uuid?`, `creativeMode?` | a player right-clicks holding `item`: `tryBuy` and its `buy_attempt`. Refused for the owner (who would restock instead) and for a shop selling nothing (no buy, no event) |
| `shopSet`        | `shop` or `pos`, `stock?`, `cost?`, `bar?`, `stored?`, `gains?`, `owner?`                  | change the shop as its owner or an admin would; no events                                                                                                                 |
| `shopSetPlayers` | `players?`, `entities?`                                                                    | who is online, by UUID                                                                                                                                                    |

`craftos_sim_state`: `peripherals.<name>` has the shop (`stock`, `stored`, `stockAmount`, `cost`, `gains`, `bar`,
`owner`, `ownerName`, `creative`); `addons.cc-shops.shops` lists every shop with its last player sale, and `ghosts`
the turtle's ghost stacks.

## Not emulated

- **The owner's own use of the block**: setting the price by right-clicking, stocking it, taking profits (left
  click) and clearing it (shift-left click) are Simple Shops actions with no ComputerCraft side; `shopSet` stands
  in for their result. What a player receives from a sale is not put anywhere (it is in `lastSale`).
- **Breaking or moving the shop block** with a turtle: the drops (the shop, its stock and gains) are not simulated.
- **Item ids**: an id is known when the game data lists it, it is one of Simple Shops' own six, or it is in
  `ccShops.items`; the real registry may know more (modded items).
- **Unicode in UUID strings**: Java counts UTF-16 characters and accepts non-ASCII digits in `Character.digit`; the
  sim counts bytes and takes ASCII hex only.
- **Shop state across a reboot** is not kept: a rebooted computer sees the world's fixture again.
- **1.20.1 Lua-to-Java conversion** is taken to be 1.101.3's (numbers as `Double`, tables as `HashMap`); the
  ClassCastException texts there were not checked separately.
- Nothing was measured in a real game: the mod is not in the pack.
