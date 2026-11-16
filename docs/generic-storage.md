# Generic storage peripherals

CC:Tweaked 1.101.3 gives any block with a Forge item, fluid or energy capability three generic peripheral types:
`inventory`, `fluid_storage` and `energy_storage`. They are always on in the emulator (they are not an addon).
This page says what is simulated and how to describe a block.

Source followed: `InventoryMethods`, `FluidMethods`, `EnergyMethods` and `GenericPeripheralProvider` in
cc-tweaked 1.101.3 (tag `v1.18.2-1.101.3`), checked against the jar's bytecode.

## The fixture

One block can be any mix of the three. Its `type` is the block's own name.

```json
{
  "name": "machine_0",
  "type": "thermal:machine_furnace",
  "size": 3,
  "items": { "1": { "name": "minecraft:iron_ore", "count": 5 } },
  "tanks": [
    { "name": "minecraft:lava", "amount": 2000, "capacity": 4000, "rate": -5 },
    { "capacity": 2000 }
  ],
  "energy": 12000,
  "energyCapacity": 50000,
  "energyRate": -20
}
```

| Field               | Gives the block  | Meaning                                                                                           |
| ------------------- | ---------------- | ------------------------------------------------------------------------------------------------- |
| `size`, `items`     | `inventory`      | Slots and what is in them (as for a chest).                                                       |
| `tanks`             | `fluid_storage`  | A list of tanks. `name` is the fluid, `amount` how much (mB), `capacity` (default 16000), `rate`. |
| `fluid`, `capacity` | `fluid_storage`  | The older form: one tank, `fluid: { name, amount }`.                                              |
| `energy`            | `energy_storage` | FE held.                                                                                          |
| `energyCapacity`    | `energy_storage` | FE it can hold. Default: the same as `energy`.                                                    |
| `energyRate`        | (with the above) | FE per tick added, or taken when negative.                                                        |

A block of type `fluid_storage` or `energy_storage` works without `tanks` or `energy`: the type alone is enough
(`{ "name": "t", "type": "fluid_storage", "capacity": 4000 }` is one empty tank). A tank with no `name` is empty.

## Types and method order

`peripheral.getType` gives the block's name, then the extra types. CC collects the extra types in a Java `HashSet`,
so their order is the hash order, not alphabetical. For every mix it is:

| Mix                | Types after the block's name                   |
| ------------------ | ---------------------------------------------- |
| all three          | `inventory`, `energy_storage`, `fluid_storage` |
| inventory + energy | `inventory`, `energy_storage`                  |
| inventory + fluid  | `inventory`, `fluid_storage`                   |
| energy + fluid     | `energy_storage`, `fluid_storage`              |
| one of them        | that one                                       |

(`fluid_storage` and `energy_storage` as the block's own type give just that one type.)

`peripheral.getMethods` lists the inventory methods, then the energy methods, then the fluid methods (CC adds them
in that order: item, energy, fluid capability). Inside one group the names are sorted. Real CC lists them in the
order Java reflection gives, which is not defined; the sim sorts.

## Methods

Every method of the three types waits for the server tick (`mainThread = true` in the jar).

### energy_storage

| Method                | Returns                                     |
| --------------------- | ------------------------------------------- |
| `getEnergy()`         | FE held now (an int; capped at 2147483647). |
| `getEnergyCapacity()` | FE it can hold.                             |

There is no way to set or move energy from Lua. That is how the real peripheral is.

### fluid_storage

| Method                                | Returns                                                                                                                                      |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `tanks()`                             | A table from tank number (1-based) to `{ name, amount }`. Empty tanks are left out, so the table can have gaps. Nothing else is in an entry. |
| `pushFluid(to, limit?, fluidName?)`   | mB moved from this block into `to`.                                                                                                          |
| `pullFluid(from, limit?, fluidName?)` | mB moved from `from` into this block.                                                                                                        |

Rules for `pushFluid` and `pullFluid`, in the order the mod checks them:

1. Argument types (`bad argument #1 (string expected, got nil)` and so on).
2. `fluidName`, if given, must be a registered fluid, else `Unknown fluid 'x'`. A name with no `:` means `minecraft:`.
3. The other block must be reachable by name, else `Target 'x' does not exist`.
4. The other block must have a fluid handler, else `Target 'x' is not an tank` (the typo is in the mod).
5. `limit` must be above 0, else `Limit must be > 0`. It defaults to the largest int. This is stricter than
   inventories: `pushItems` with a limit of 0 returns 0, `pushFluid` raises.

The move itself (`FluidMethods.moveFluid`): ask the source what it can give (up to `limit`, only `fluidName` if
given), ask the target how much of it fits, then take that much from the source and put it in the target. The amount
moved is the smallest of the limit, what the source has and the room the target has. It is 0 when nothing matches.

How a block with several tanks behaves (Forge handlers differ; the sim follows the common one):

- A drain without a fluid name uses the first non-empty tank to pick the fluid, then takes that fluid from every
  tank that holds it, in order, up to the limit. With a name, it picks the first tank holding that fluid.
- A fill goes into tanks that already hold that fluid first, then into empty ones, in order, up to each
  tank's capacity. A tank holding another fluid takes nothing.
- A fluid with no `amount` left leaves its tank empty. An empty tank takes the first fluid offered.

### inventory

As the chest: `size`, `list`, `getItemDetail`, `getItemLimit`, `pushItems` and `pullItems`. They can move into or
out of any block with an inventory part, including the mixed ones.

### On Minecraft 1.20.1 and 1.21.1 (CC:Tweaked 1.121.0)

The method lists and their arguments, messages and threads are the same (`AbstractInventoryMethods`,
`AbstractFluidMethods`, `AbstractEnergyMethods` and Forge's `InventoryMethods`, tag `v1.20.1-1.121.0`). What differs:

- `getItemDetail` gains `mapColour` and `mapColor` (the item's block's map colour, from the version's block data) and
  its `itemGroups` is always empty (`ItemDetails.fill`).
- `pushItems`/`pullItems` now ask the other block for its inventory on the side its peripheral is attached by
  (1.101.3 asked with no side). The sim's inventories are not sided, so nothing changes here; a sided block reached
  over a modem would see only that side's slots in the real game.
- Moving goes through `ForgeItemContainer.moveTo` (one source slot, into the target's slots in order), which moves what
  1.101.3's `moveItem` moved.

## Change over time

Rates run on the virtual clock, 50 ms per tick, and are caught up before anything looks at the block (a method call,
the state dump, a sim command). So a program that polls `getEnergy()` sees the number move, and `craftos_advance`
(`advance`) moves it too.

- `energyRate` FE per tick. Positive fills up to `energyCapacity`; negative drains down to 0.
- A tank's `rate` mB per tick. Positive fills with the tank's fluid up to its capacity (the tank needs a `name`, or to
  have held a fluid before: an emptied tank remembers what it held); negative drains until it is empty.

A rate is applied to the block's own buffer only. It does not move fluid between blocks.

## Sim commands

| Command                                 | Effect                                                                                                            |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `setEnergy { peripheral, energy }`      | What the block holds now. Kept between 0 and its capacity.                                                        |
| `setFluid { peripheral, tank?, fluid }` | What tank `tank` (1-based, default 1) holds: `{ name, amount }`, or `null` to empty it. Kept within its capacity. |
| `setItem { peripheral, slot, item }`    | Already there: one inventory slot.                                                                                |

A command that names something that is not there changes nothing.

The state dump (`state.json`) lists, for each block with tanks or energy, `fluid` (the first non-empty tank, kept for
the single-tank form), `tanks` (every tank: `fluid`, `capacity`, `rate`) and `energy` (`energy`, `capacity`, `rate`).
Inventories are under `inventories`, as before.

## Not simulated / not confirmed

- There is no fluid registry. `Unknown fluid` is raised for a bad name (not a valid `namespace:path`) and for a
  `minecraft:` name that is not water, flowing water, lava, flowing lava or empty. Any other namespace is taken as a
  real mod fluid, so a misspelled mod fluid returns 0 where the real game raises.
- Fluid NBT is not compared when fluids are matched.
- Real block entities decide for themselves which side or tank a fill goes to, how fast it can take it and whether a
  drain is allowed. The sim has one rule for all of them (above), and no per-tank filters or transfer limits.
- Energy has no transfer limit and nothing can push energy in or out except the rates and `setEnergy`.
- `peripheral.getMethods` order inside a group is sorted, not Java's reflection order.
- A rate keeps going even when the block's neighbours would stop it (no machine logic, no redstone).
