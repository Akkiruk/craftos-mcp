# Bigger Reactors emulation

Bigger Reactors is **not in the pack**. The emulator follows the latest Forge 1.18.2 release on CurseForge,
**biggerreactors-1.18.2-0.6.0-beta.1.4**, and the library it needs, **phosphophyllite-1.18.2-0.6.0-beta.1.6**.
Source: `github.com/BiggerSeries/BiggerReactors` tag `0.6.0-beta.1.4` and `github.com/BiggerSeries/Phosphophyllite`
tag `0.6.0-beta.1.6`. The method names, return types and type names were checked in both jars with `javap`.
CC:Tweaked behaviour comes from the pack's 1.101.3 jar.

Nothing here could be measured in game, because the mod is not installed. Every number below is read from the
source and has not been compared with a running reactor.

The addon id is `bigger-reactors`. The Lua is `rom-overlay/rom/ccsim/addons/bigger-reactors/init.lua`. Tests:
`packages/runner/src/bigger-reactors.integration.test.ts` (with an independent TypeScript port of the Java for the
numbers). Method list: `packages/runner/src/bigger-reactors-surface.json`. Demo world: `worlds/bigger-reactors-demo.json`.

The addon can be switched on for Minecraft 1.18.2 and 1.20.1 (where it names `1.20.1-0.6.0-beta.10.5`, the release a
later round follows; the Lua is 1.18.2's). There is no Bigger Reactors for 1.21.1, so a 1.21.1 world cannot switch it
on; give such a world `"version": "1.18.2"`.

Paths below are relative to `src/main/java/net/roguelogix/biggerreactors/`. `R/` is `multiblocks/reactor/`, `T/` is
`multiblocks/turbine/`.

## Peripherals

| Type                     | Block                 | Methods on the peripheral |
| ------------------------ | --------------------- | ------------------------- |
| `BiggerReactors_Reactor` | Reactor Computer Port | 14                        |
| `BiggerReactors_Turbine` | Turbine Computer Port | 9                         |

Type names: `R/deps/ReactorPeripheral.java:390`, `T/deps/TurbinePeripheral.java:254`.

Bigger Reactors has an **object-style API**. A few methods return a table of functions instead of a value:

```lua
local r = peripheral.wrap("BiggerReactors_Reactor_0")
r.battery().stored()            -- passive reactors; nil on an actively cooled one
r.coolantTank().hotFluidAmount() -- active reactors; nil on a passive one
r.fuelTank().fuel()
r.getControlRod(0).setLevel(50)
local t = peripheral.wrap("BiggerReactors_Turbine_0")
t.rotor().RPM()
t.fluidTank().input().amount()
```

Reactor (`R/deps/ReactorPeripheral.java`):

| Method                                                                                                            | Returns                                                                                                                                         | Line                               |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `apiVersion()`                                                                                                    | `"0.6.0-beta.1.4"` (the mod file's version)                                                                                                     | 42-45; `BiggerReactors.java:51,95` |
| `connected()`                                                                                                     | assembled                                                                                                                                       | 47-57                              |
| `active()`, `setActive(bool)`                                                                                     |                                                                                                                                                 | 78-86                              |
| `battery()`                                                                                                       | table: `stored()`, `capacity()`, `producedLastTick()`; nil when actively cooled                                                                 | 88-128                             |
| `coolantTank()`                                                                                                   | table: `coldFluidAmount()`, `hotFluidAmount()`, `capacity()`, `transitionedLastTick()`, `maxTransitionedLastTick()`, `dump()`; nil when passive | 130-214                            |
| `fuelTank()`                                                                                                      | table: `capacity()`, `totalReactant()`, `fuel()`, `waste()`, `ejectWaste()`, `fuelReactivity()`, `burnedLastTick()`                             | 216-278                            |
| `controlRodCount()`                                                                                               |                                                                                                                                                 | 339-342                            |
| `getControlRod(index)`                                                                                            | table: `valid()`, `index()`, `level()`, `setLevel(level)`, `name()`, `setName(name)`; index from 0                                              | 280-347                            |
| `setAllControlRodLevels(level)`                                                                                   |                                                                                                                                                 | 349-352                            |
| `fuelTemperature()`, `stackTemperature()`, `casingTemperature()` (deprecated, same value), `ambientTemperature()` | kelvin                                                                                                                                          | 366-385                            |

Turbine (`T/deps/TurbinePeripheral.java`):

| Method                                                       | Returns                                                                                                                                                                | Line    |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `apiVersion()`, `connected()`, `active()`, `setActive(bool)` |                                                                                                                                                                        | 36-66   |
| `battery()`                                                  | table: `stored()`, `capacity()`, `producedLastTick()`                                                                                                                  | 69-98   |
| `rotor()`                                                    | table: `RPM()`, `efficiencyLastTick()`                                                                                                                                 | 101-124 |
| `fluidTank()`                                                | table: `input()`, `output()` (each a table: `name()`, `amount()`, `maxAmount()`), `flowLastTick()`, `nominalFlowRate()`, `setNominalFlowRate(rate)`, `flowRateLimit()` | 126-200 |
| `coilEngaged()`, `setCoilEngaged(bool)`                      |                                                                                                                                                                        | 241-249 |

The source also has a `Vent` class (`closed()`, `setOverflow()`, ...) at lines 202-238, but no method returns it, so a
program cannot reach it. The vent can only be set by the fixture.

## How a call behaves

| Rule                                                                                                                                                                                                                                                                                                  | Source                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Every method is a plain `@LuaFunction` (no `mainThread`), so every one runs at once on the computer thread. None waits for a tick, and no event is lost.                                                                                                                                              | `ReactorPeripheral.java`, `TurbinePeripheral.java`: no `mainThread = true` anywhere |
| A returned object becomes a table of its `@LuaFunction` methods, made fresh on every call (`r.battery() ~= r.battery()`). `b.stored()` and `b:stored()` both work; `rod:setLevel(5)` passes the table as the level and fails.                                                                         | CC `CobaltLuaMachine.toValue` / `wrapLuaObject`                                     |
| `peripheral.getMethods` order: CC's `HashMap` of the names, filled in declaration order. Two pairs share a bucket (`apiVersion`/`setActive`, `controlRodCount`/`getControlRod`); their order inside the bucket follows `Class.getMethods()`, assumed to be declaration order.                         | CC `PeripheralAPI`; `Generator.getMethods`; the surface test                        |
| Argument errors are CC's: `bad argument #1 (number expected, got string)`. A level is `getDouble` (NaN gets through); an index and a flow rate are `getLong`: truncated, and NaN or infinity is `bad argument #1 (number expected, got nan)` / `got inf`.                                             | CC `VarargArguments.getDouble/getLong`, `LuaValues.checkFinite`                     |
| `getControlRod(i)` out of range: `Java Exception Thrown: java.lang.IndexOutOfBoundsException: Index 4 out of bounds for length 4`.                                                                                                                                                                    | `ReactorPeripheral.java:345-347` (`ArrayList.get`); CC `ResultInterpreterFunction`  |
| Not assembled: `Invalid multiblock controller` from every method that reads the machine. `connected()` and `apiVersion()` still answer; `fuelTank()`, `controlRodCount()`, `getControlRod()`, and the turbine's `battery()`, `rotor()`, `fluidTank()` return their handle, whose functions then fail. | `ReactorPeripheral.java:59-76`, `TurbinePeripheral.java:49-56`                      |
| A rod handle from before the reactor was rebuilt: `valid()` is false and `level()` etc. fail with `Invalid control rod object`.                                                                                                                                                                       | `ReactorPeripheral.java:290-335,354-364`; `ReactorComputerPortTile.onAssembly`      |
| Rod levels are clamped to 0..100; NaN is ignored. Names default to `""`.                                                                                                                                                                                                                              | `R/tiles/ReactorControlRodTile.java:91-117`                                         |
| `setNominalFlowRate` is clamped to 0..`flowRateLimit()`.                                                                                                                                                                                                                                              | `T/simulation/modern/ModernTurbineSimulation.java:166-169`                          |
| Empty tanks are named `minecraft:empty`; once filled the turbine's input is the steam fluid (default `biggerreactors:steam`) and its output `minecraft:water`, and the name stays after the tank drains.                                                                                              | `util/FluidTransitionTank.java:57-65,121-145`                                       |

## The reactor simulation

The default simulation is `TimeSlicedReactorSimulation` (`Config.java:88`, `useFullPassSimulation = false`;
`R/simulation/SimulationDescription.java:137-139`). Each tick:

1. **Radiation** (`R/simulation/cpu/TimeSlicedReactorSimulation.java:24-156`), only when active and fuel > 0. One rod
   and one layer per tick: `currentRod++` (31), `yLevel = currentRod % height` (36), rod `(currentRod + rodOffset) % n`.
   The rods are shuffled once (`Collections.shuffle(..., new Random())`, 21); the emulator uses `java.util.Random`
   seeded from `world.biggerReactors.seed` (default 0), so a run is repeatable.
   - `radiationPenaltyBase = exp(-15 * exp(-0.0025 * (T - 273.15)))` (41), T the fuel temperature.
   - `baseFuelAmount = fuel + waste / 100` (integer division, 45); `rawRad = base * 0.1f` (48).
   - `scaled = ((rawRad ^ 1.05f) / n) ^ 1.05f * n` (52).
   - `initialHardness = min(1, 0.2f + 0.8 * penaltyBase)` (56).
   - `rawIntensity = 1 - 0.95f * exp(-10 * exp(-0.001f * 1.2f * (T - 273.15)))` (58).
   - `fuelAbsorptionTemperatureCoefficient = 1 - 0.95f * exp(-10 * exp(-0.001 * 2.2f * (T - 273.15)))` (59).
   - The rod's `(100 - insertion) / 100` scales the intensity (77-82). Fuel use this tick:
     `0.0007f * rawRad * rodModifier / fuelReactivity()` (85). Fuel heat gets `10 * intensity` FE (86).
   - 64 rays (`SimUtil.java:68-174`: a Fibonacci sphere, each traced through the grid for 4 blocks plus the half
     block inside the rod, with JOML's arithmetic) carry `intensity / 64` each (88-144). Through a moderator block:
     `absorbed = intensity * absorption * (1 - hardness) * length`, hardness `/ ((moderation - 1) * length + 1)`,
     stack heat `+= heatEfficiency * absorbed * 10` (105-110). Through a fuel rod: absorption
     `fatc * (1 - hardness) * 0.5 * length`, plus the rod bonus/penalty from `insertion * .001` (sic), into fuel
     heat and fertility (111-142). A ray stops at the casing (100-103).
   - Fertility `+=` what the fuel absorbed (147); `fuelReactivity()` is `1` up to fertility 1, then
     `log10(fertility) + 1` (`BaseReactorSimulation.java:237-243`).
2. **Fertility decay** (`R/simulation/base/BaseReactorSimulation.java:183-192`): `max(0, f - max(0.1f, f / 20))`;
   the divisor is 4000 while inactive.
3. **Heat** (194-196, Phosphophyllite `util/HeatBody.java:40-86`):
   - fuel to stack: `rfkt = fuelToCasingRFKT + manifoldFaces * conductivity` (`fuelToCasingRFKT`: 0.6 per rod face
     on the casing plus the neighbour block's conductivity, 96-118);
   - stack to output: `stackToCoolantSystemRFKT = 2 * (xy + xz + zy) * 0.6`, adjusted for manifold faces (120-150),
     times `0.2f` when passive (152-154);
   - stack to ambient (293.15 K, `ReactorMultiblockController.java:379`): `2 * (outer face area) * 0.001` (156).
   - Heat capacities: fuel `rods * height * 10` FE/K, stack `x * y * z * 10` FE/K (161-162).
   - Two finite bodies move toward their weighted mean by `exp(-rfkt (c1 + c2) / (c1 c2))`; against an infinite
     body only the finite one moves, by `exp(-rfkt / c)`.
4. **Passive output** (`R/simulation/base/Battery.java:26-42`): the battery is an infinite body at ambient; what the
   stack loses goes in as `(long)(rf * 1.0 * 0.5f)` FE, capped at capacity. Capacity
   `(outer volume - interior volume) * 100000` (`BaseReactorSimulation.java:67`).
5. **Active output** (`R/simulation/base/CoolantTank.java:36-90`): only above boiling (373.15 K, water). The rate is
   `rfkt * 0.6 * max(liquid / capacity, 0.01)`; each 4 FE boils 1 mB (`transitions/water_to_steam.json5`), limited
   by the water and the free steam space. `maxTransitionedLastTick` is what the heat could have boiled. Tank size per
   side `(rods * height + manifolds) * 10000` mB (70-72). Manifolds also act as moderators, mixing air and water by
   how full the tank is (166-212).
6. **Fuel** (`R/simulation/base/FuelTank.java:25-43`): the usage adds to a fraction; whole mB move from fuel to waste.
   Capacity `4000 * rods * height` (`BaseReactorSimulation.java:94`).
7. **The controller** (`R/ReactorMultiblockController.java:458-512`): auto-eject waste (whole 1000 mB ingots, only
   with an access port that has an inventory: `wasteOutlet`, 671-695, `R/tiles/ReactorAccessPortTile.java:223-240`),
   then the power taps (`load`), then the coolant ports push the steam out (`steamTo` or `steamDrain`).

Moderators (`data/biggerreactors/ebcr/moderators`): air (the default), water, glass, ice, snow, lava, iron, gold,
diamond, emerald, graphite, ludicrite, liquid obsidian, and the common metals. The fixture names them.

## The turbine simulation

`T/simulation/modern/ModernTurbineSimulation.java`, each tick (`tick`, 187-262):

- `rpm = rotorEnergy / rotorAxialMass` (146-148). Axial mass `shafts * 100 + bladeMetres * 100`, where each shaft
  block's four blade arms of length L add `L (L + 1) / 2` metres (63-90).
- Active: `flow = min(nominalFlowRate, steam)` (and the free water space when the vent is closed,
  `FluidTank.java:25-44`). Rotor capacity `bladeMetres * 20 / 1000 * 2 pi * max(100, rpm)`; flow above it counts
  at `capacity / flow` (195-201). The rotor gains `4 * effectiveFlow * 2.5` (210).
- Vent `ALL` empties the water (218-220); `OVERFLOW` (the default) caps it at the tank size.
- Inductor engaged: `torque = rpm * drag * coils`, energy `torque ^ bonus * efficiency`, times
  `0.25 cos(rpm / (45.5 pi)) + 0.75`, at most 0.5 below 450 RPM, `1 - rpm / 4490` above 2245 RPM (222-254). Whole FE
  go into the battery, capped. The rotor loses `torque`.
- Drag: `rotorMass * (rpm * 0.0001)^2 + bladeMetres * (rpm * 0.0001)^2` (256-260).
- Coils (`data/biggerreactors/ebest/coils`): efficiency, extraction rate and bonus per block, averaged; drag
  `* 10` and `* 2 / (distance + 1)` beyond the first ring (97-130). Battery `(coils + 1) * 300000` FE; tank per side
  `(interior volume - shafts - coils) * 10000` mB; `flowRateLimit = (x * z - 1) * 5000` (59, 119, 132).
- The default nominal flow is `(long)(capacityPerRPM * 1800)` (87-89).
- The controller (`T/TurbineMultiblockController.java:453-505`) then feeds the power taps (`load`) and pushes the
  water out: back to the reactor whose `steamTo` names this turbine, or into `waterDrain`.

## Fixtures

```jsonc
"biggerReactors": { "seed": 1, "gameTime": 0 },   // optional
"peripherals": [
  { "name": "BiggerReactors_Reactor_0", "type": "BiggerReactors_Reactor",
    "dimensions": [5, 7, 5],            // outer size, x y z (default 5 x 5 x 5)
    "layout": ["XMX", "MXM", "XMX"],    // interior columns: rows are x, characters z
    "legend": { "G": "graphite" },      // X = fuel rod, . = air, M = coolant manifold, others by name
    "cooling": "active",                // "passive" (default) or "active"
    "fuel": 30000, "waste": 0, "fertility": 1, "fuelHeat": 293.15, "stackHeat": 293.15, "energy": 0,
    "coolant": 40000, "steam": 0,       // water and steam, mB (active only)
    "rodLevel": 10, "controlRods": [{ "name": "centre", "level": 10 }],
    "active": true, "assembled": true,
    "load": 0,                          // FE/t a power tap takes (passive)
    "wasteOutlet": false,               // an access port with an inventory: waste leaves as ingots
    "coolantSupply": 500,               // mB/t of water pumped in, or "full"
    "steamTo": "BiggerReactors_Turbine_0", // the turbine its steam goes to; that turbine sends its water back
    "steamDrain": 0 },                  // mB/t of steam taken away when there is no turbine, or "full"
  { "name": "BiggerReactors_Turbine_0", "type": "BiggerReactors_Turbine",
    "dimensions": [7, 12, 7],           // outer size; y runs along the rotor (default 5 x 10 x 5)
    "shafts": 10, "bladeLength": 2, "bladedShafts": 8,   // or "rotor": [[a, b, c, d], ...] per shaft block
    "coils": { "minecraft:gold_block": 16 },             // first ring; or [{ "block": "gold", "distance": 2 }]
    "vent": "overflow",                 // "overflow", "closed", "all"
    "flowRate": 2000, "active": true, "coilEngaged": true, "rpm": 0, "energy": 0,
    "steam": 0, "water": 0, "steamFluid": "biggerreactors:steam",
    "load": 2000, "steamSupply": 0, "waterDrain": 0 }
]
```

Defaults: a reactor layout is a checkerboard of rods; a turbine has every interior layer as a shaft, one blade layer
less per 8 coils, arms as long as fit, and 8 gold coils. Without a layout no moderator is placed.

## Sim commands

`brAddFuel {peripheral, amount}`, `brAddWaste {peripheral, amount}` (into the fuel tank, up to capacity),
`brSetLoad {peripheral, rate}`, `brDrainEnergy {peripheral, amount}`, `brAddCoolant {peripheral, amount}` (water into
an active reactor), `brAddSteam {peripheral, amount}` (into a turbine), `brSetCoolantSupply {peripheral, rate|"full"}`,
`brSetSteamSupply {peripheral, rate|"full"}`, `brSetActive {peripheral, active}`, `brSetAssembled {peripheral, assembled}`
(taking a reactor apart turns it off; rebuilding it keeps fuel, heat and tanks, reshuffles the rods and makes old rod
handles invalid; rebuilding a turbine stops its rotor). `craftos_sim_state` has every machine under
`peripherals.<name>` and the tick count under `addons.bigger-reactors.gameTime`.

## Not simulated / not confirmed

- **Nothing was measured in game.** The mod is not in the pack. All numbers come from reading the source.
- The heat exchanger and its computer port (`BiggerReactors_HeatExchanger`) are not emulated.
- The rod shuffle uses a seeded `java.util.Random`; the mod seeds it from the clock, so its order differs every load.
- `Math.cos`/`Math.sin`/`Math.pow`/`Math.exp` may differ from C's by one unit in the last place, so the rays and the
  temperatures can differ in the last digits from a real server.
- The control rod index order is x then z. The mod uses its list of rod blocks, which follows block discovery order.
- Ports and pipes are fixture rates, not blocks: one power tap, one coolant port, unlimited sinks, no per-port split,
  no fluid port directions. A pipe's own transfer limit is not modelled.
- The coolant port's fluid wrapper is kept in step with the simulation's tank every tick. In the mod it can lag when
  no outlet port is connected.
- Turbine coils sit in the first ring unless the fixture gives distances; whether a coil layout is valid is not checked.
- The `getMethods` order inside the two shared buckets assumes `Class.getMethods()` returns declaration order.
- Reactor `wasteOutlet` takes every whole ingot; a real inventory can fill up.
- A very long `advance` with an active reactor catches up tick by tick; around 20 minutes of game time costs a few
  seconds.
