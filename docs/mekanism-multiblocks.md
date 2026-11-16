# Mekanism multiblocks: fission, turbine, boiler, induction matrix, fusion

The pack runs **Mekanism 1.18.2-10.2.5.465** and **Mekanism Generators 1.18.2-10.2.5.465**. The blocks that
reactor and power-monitor programs wrap are emulated in Lua, and the multiblocks behind them run on the virtual
clock, tick by tick, with the formulas from the source.

| Type                         | Block                         | Addon                 | Exposes the multiblock |
| ---------------------------- | ----------------------------- | --------------------- | ---------------------- |
| `fissionReactorLogicAdapter` | Fission Reactor Logic Adapter | `mekanism-generators` | yes                    |
| `fissionReactorPort`         | Fission Reactor Port          | `mekanism-generators` | no (modes only)        |
| `turbineValve`               | Turbine Valve                 | `mekanism-generators` | yes                    |
| `fusionReactorLogicAdapter`  | Fusion Reactor Logic Adapter  | `mekanism-generators` | yes                    |
| `fusionReactorPort`          | Fusion Reactor Port           | `mekanism-generators` | no (mode and energy)   |
| `boilerValve`                | Boiler Valve                  | `mekanism`            | yes                    |
| `inductionPort`              | Induction Port                | `mekanism`            | yes                    |

Code: `rom-overlay/rom/ccsim/addons/mekanism-machines/` (`engine.lua`: clock, tanks, heat, peripherals, sim
commands; `boiler.lua`, `matrix.lua`) and `addons/mekanism-generators/` (`fission.lua`, `turbine.lua`,
`fusion.lua`). Argument checks and their messages come from `mek/java.lua`, shared with the QIO emulation.

Source of truth: `github.com/mekanism/Mekanism`, branch `1.18.x` at commit `a395daf` ("Bump version to 10.2.5").
Line numbers below are from that commit. Every method name, annotation, restriction and error string was checked
in the two jars with `javap`.

## Method surface

`packages/runner/src/mekanism-multiblocks-surface.json` lists every type's methods in `peripheral.getMethods`
order, formed and unformed. How it is built (`ComputerMethodMapper`, `TileEntityMekanism.getComputerMethods`,
`TileEntityMultiblock.getComputerMethods` line 438):

- The tile class's annotated methods, with its parents', sorted by name (`ComputerMethodMapper` line 203).
  Restrictions decide which `TileEntityMekanism` methods a block gets: `getComparatorLevel` only with the
  Comparator attribute (turbine valve, boiler valve, induction port), `getRedstoneMode`/`setRedstoneMode` only
  with the Redstone attribute (the fission logic adapter), the four energy methods only when the tile has energy
  containers (turbine valve, induction port, fusion port), `isFormed` only when the tile exposes the multiblock.
  No block here is directional, so none has `getDirection`.
- Then, **only while the multiblock is formed**, the multiblock data's methods (with `MultiblockData`'s
  `getLength/Width/Height/MinPos/MaxPos`), sorted by name.
- CC:Tweaked puts the names in a `java.util.HashMap` sized to the count; the Lua computes that order with Java's
  string hash (`engine.lua` `hashOrder`), and the test re-derives it from the jar's lists.

Counts: fission logic adapter 43 (6 unformed), fission port 4, turbine valve 30 (6), boiler valve 33 (6),
induction port 20 (8), fusion logic adapter 41 (5), fusion port 6.

When a multiblock forms or unforms, Mekanism invalidates the computer capability of the blocks that expose it
(`isComputerCapabilityPersistent` is false for them), so CC detaches and attaches the peripheral again: the
program gets `peripheral_detach` and then `peripheral` with the same name, and the method list changes. Ports that
do not expose the multiblock keep their peripheral.

Every method is a main-thread method (no `threadSafe = true` anywhere in 10.2.5): arguments are checked at once on
the computer thread, then the call waits for the next server tick and events that arrive meanwhile are lost.
Void methods return nothing; the rest return one value.

## The fixture

A peripheral names its multiblock with `multiblock`; the multiblocks live in `world.mekanism.multiblocks` by id.
A peripheral without `multiblock` is its own multiblock, with its fixture fields on the peripheral itself.

```json
{
  "peripherals": [
    {
      "name": "reactor",
      "type": "fissionReactorLogicAdapter",
      "multiblock": "r1",
      "logicMode": "TEMPERATURE"
    },
    {
      "name": "port",
      "type": "fissionReactorPort",
      "multiblock": "r1",
      "mode": "OUTPUT_COOLANT"
    }
  ],
  "mekanism": {
    "seed": 1,
    "config": { "fissionMeltdownsEnabled": true },
    "multiblocks": {
      "r1": {
        "kind": "fission",
        "fuel": 10000,
        "coolant": 2000000,
        "burnRate": 1,
        "heatedCoolantTo": "t1"
      },
      "t1": {
        "kind": "turbine",
        "length": 7,
        "width": 7,
        "height": 13,
        "blades": 12,
        "coils": 3,
        "vents": 24
      }
    }
  }
}
```

Common fields: `kind` (`fission`, `turbine`, `boiler`, `matrix`, `fusion`), `formed` (default true), `length`,
`width`, `height` (outer size), `minPos` `{x, y, z}` (default 0, 64, 0), `casings` (shell blocks, default computed
from the size), `ambientTemperature` (K, default 300, a plains biome). Tanks take a number (the usual fluid) or
`{ name, amount }`. Rates are per tick; `"max"` or a negative number is unlimited. Multiblocks tick in id order.

`world.mekanism.seed` seeds Mekanism's own randomness (meltdown chance, explosions). `world.mekanism.config`
overrides config values (defaults are the pack's toml, which are Mekanism's defaults): `maxEnergyPerSteam`,
`boilerWaterConductivity`, `superheatingHeatTransfer`, `dumpExcessKeepRatio`, `energyPerFissionFuel`,
`fissionCasingHeatCapacity`, `fissionSurfaceAreaTarget`, `fissionMeltdownsEnabled`, `fissionMeltdownChance`,
`fissionPostMeltdownDamage`, `defaultBurnRate`, `burnPerAssembly`, `turbineBladesPerCoil`, `turbineVentGasFlow`,
`turbineDisperserGasFlow`, `condenserRate`, `energyPerFusionFuel`, `fusionThermocoupleEfficiency`,
`fusionCasingThermalConductivity`, `fusionWaterHeatingRatio`, `hohlraumMaxGas`.

| Kind      | Fields                                                                                                                                                                                                                                                                                                                                   |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fission` | `fuelAssemblies` (8), `surfaceArea` (5 per assembly: columns of two), `fuel`, `waste`, `coolant` (water, or `{name: "mekanism:sodium", amount}`), `heatedCoolant`, `temperature`, `damage`, `burnRate` (0.1), `active`, `forceDisabled`; rates `fuelInput`, `coolantInput`, `wasteOutput`, `heatedCoolantOutput`; link `heatedCoolantTo` |
| `turbine` | `blades` (6), `coils` (2), `vents` (12), `condensers` (0), `lowerVolume` (length × width × (blades / 2 + 1)), `steam`, `energy`, `dumpingMode`; rates `steamInput`, `energyOutput`; link `energyTo`                                                                                                                                      |
| `boiler`  | `waterVolume`, `steamVolume`, `superheaters` (0), `water`, `steam`, `heatedCoolant`, `cooledCoolant`, `temperature`; rates `heatInput` (J/t from heaters), `waterInput`, `steamOutput`, `cooledCoolantOutput`; links `steamTo`, `cooledCoolantTo`                                                                                        |
| `matrix`  | `cells`, `providers` (a count of basic ones, or `{ basic, advanced, elite, ultimate }`; default 1 basic each), `energy`, `inputItem`, `outputItem`; rates `input`, `output` (J/t); `inputPorts`, `outputPorts` (ports the computer cannot see)                                                                                           |
| `fusion`  | `injectionRate` (2), `deuterium`, `tritium`, `dtFuel`, `water`, `steam`, `energy`, `plasmaTemperature`, `caseTemperature`, `burning`, `hohlraum` (true: a filled one in the controller); rates `deuteriumInput`, `tritiumInput`, `waterInput`, `steamOutput`, `energyOutput`; links `steamTo`, `energyTo`                                |

Peripheral fields: fission logic adapter `logicMode`, `redstoneMode`, `powered`; fission port `mode`
(`INPUT`, `OUTPUT_WASTE`, `OUTPUT_COOLANT`); boiler valve `mode` (`INPUT`, `OUTPUT_STEAM`, `OUTPUT_COOLANT`);
induction port and fusion port `mode` (`"output"` or true for output); fusion logic adapter `logicMode`,
`activeCooled`.

**Links** stand for pipes and cables. A reactor's heated coolant goes to a turbine (steam) or a boiler
(superheated sodium); a boiler's steam to a turbine and its cooled sodium back to a reactor; a turbine's or fusion
reactor's energy to a matrix. A link moves everything the target takes each tick, or up to the rate when one is
set.

**Ports and outputs.** With no port peripheral on a multiblock, its fixture rates always flow. With port
peripherals, an output flows only while one of them is in the matching mode: fission waste needs a port on
`OUTPUT_WASTE`, heated coolant `OUTPUT_COOLANT`; boiler steam `OUTPUT_STEAM`, cooled coolant `OUTPUT_COOLANT`;
matrix output a port in output mode, matrix input a port in input mode (or the `outputPorts`/`inputPorts`
count); fusion steam and energy a port in eject mode.

## Sim commands

| Command                                                    | Effect                                                                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `mekSetFormed {multiblock\|peripheral, formed}`            | Break or rebuild the structure: blocks that expose it detach and attach again with the new method list       |
| `mekSet {multiblock\|peripheral, ...fields}`               | Set fixture fields while running: tanks, `temperature`, `damage`, `energy`, rates, links, modes              |
| `mekAddTank {multiblock\|peripheral, tank, amount, name?}` | Pipe some in (or, negative, out). Fission tanks: `fuel`, `waste`, `coolant`, `gasCoolant`, `heatedCoolant`   |
| `mekSetRedstone {peripheral, powered}`                     | Redstone into a fission logic adapter (Activation mode turns the reactor on and off)                         |
| `mekFusionLaser {multiblock\|peripheral, energy}`          | Laser joules into the plasma (`addTemperatureFromEnergyInput`, line 167: ten times as hot while not burning) |
| `mekInsertHohlraum {multiblock\|peripheral, filled?}`      | Put a hohlraum in the controller                                                                             |

Sim state: `addons["mekanism-machines"]` has `gameTime` (the last tick simulated) and `multiblocks` by id, with
`kind`, `formed`, `destroyed`, temperatures, tanks, energy and rates. Each peripheral's state has its multiblock
id, `formed` and its block's modes.

## Behaviour and its source

Fission (`FissionReactorMultiblockData`):

- Tick (line 162): burn fuel if active, else the actual burn rate is 0; then coolant; then the environment; then
  the queued heat is applied; then damage. Heat is queued (`BasicHeatCapacitor.handleHeat`) and applied once a
  tick, so the coolant and the environment see the temperature at the start of the tick.
- Burning (line 373): `min(burnRate, fuel + remainder, assemblies × burnPerAssembly)` mB, 1 MJ of heat per mB;
  fractions carry over; every whole mB burned is a mB of nuclear waste; waste that does not fit is radiated.
- Coolant (line 340): heat available is `boilEfficiency × (T − 373.15) × heatCapacity`. Water takes half of it:
  `(int)(0.2 × heat × 0.5 / 10)` mB boils to steam, each mB taking 50 J. Sodium takes all of it at 5 J per mB and
  comes out as superheated sodium. Steam that does not fit is dumped. `getHeatingRate` is the mB heated.
- Environment (line 198): `(T − ambient) / 20010` of the heat capacity per tick.
- Heat capacity (line 157): 1000 per shell block. Tanks (lines 59-61): coolant 100 000 per block of volume,
  heated coolant 1 000 000, fuel and waste 8000 per assembly.
- Damage (line 245): above 1200 K it rises by `min(T, 1800) / 12000` a tick, below it falls by
  `(1200 − T) / 120000`. At 100 % and still 1200 K or more, each tick has a `damage / 100 × 0.001` chance of a
  meltdown (or, with meltdowns off, a forced shutdown that holds until the damage is under 100 % and T under 1200).
- Meltdown (`lib/radiation/Meltdown.update` line 71, `meltdownHappened` line 280): one in ten ticks an explosion;
  the first one empties the waste and heated coolant, sets damage to 75, turns the reactor off, resets the heat to
  ambient and destroys the structure: its blocks detach from the computer (`peripheral_detach`).
- `activate` (line 484): "Reactor is already active." / "Reactor must reach safe damage and temperature levels
  before it can be reactivated."; `scram` (line 494): "Scram requires the reactor to be active.".
- `setBurnRate` (line 502): rounds down to two decimals; out of range it fails with **"d != java.lang.Double"**:
  the message passes a Double to `%d`, `String.format` throws, and `BoundComputerMethod.run` (line 167) passes
  that exception's message on. NaN rounds to 0 and is accepted.
- `getCoolant` and its three friends (line 514): the gas coolant tank when the water tank is empty and the gas one
  is not, else the water tank. `getDamagePercent`: `Math.round(damage)`. `getBoilEfficiency`: `min(1, surface
area per assembly / 4)`.
- Logic adapter (`TileEntityFissionReactorLogicAdapter` line 63): `getRedstoneLogicStatus` is `POWERED`
  (Activation, powered), `OUTPUTTING` (Temperature ≥ 1200 K, Excess Waste with a full waste tank, Damaged ≥ 100 %,
  Depleted with no fuel) or `IDLE`. In Activation mode a redstone change turns the reactor on or off (line 109).
  `setRedstoneMode("PULSE")`: "Unsupported redstone control mode: PULSE" (`TileEntityMekanism` line 1352).
- The comparator level (ports) is the fuel fill: `floor(f × 14) + (f > 0 ? 1 : 0)`.

Turbine (`TurbineMultiblockData`):

- Tick (line 104): with steam and room for energy, the flow is `min(stored, min(lowerVolume × dispersers × 1280,
vents × 32000), room / multiplier) × stored / capacity`, the multiplier `10 / 28 × min(blades, coils × 4)`
  J per mB in FloatingLong (0.3571 per blade). Then dumping: `DUMPING` takes `max(stored / 50, last input × 2)`;
  `DUMPING_EXCESS` only above 90 %.
- Steam capacity 64 000 per lower block (line 44); energy 16 MJ per block of volume (line 207); dispersers
  `(length − 2) × (width − 2) − 1` (line 191). `getLastSteamInputRate` is the steam that came in during the tick
  before. `getProductionRate` = multiplier × flow (line 216).

Boiler (`BoilerMultiblockData`):

- Tick (line 138): environment (`(T − ambient) / 110001`), heat applied, then superheated sodium gives up
  `round(0.4 × stored) × (1 − T / 100000)` mB at 5 J each (applied next tick), then if T ≥ 373.15 water boils:
  `0.2 × min((T − 373.15) × heatCapacity × 0.7, 16 MJ × superheaters) / 10` mB (line 226). With no superheating
  elements nothing boils.
- Heat capacity 50 per shell block; water 16 000 per block of water volume, steam 160 000 per block of steam
  volume, sodium 256 000 (lines 243, 254). `getBoilCapacity` (line 262): `16 MJ × superheaters / 10 × 0.2`.

Induction matrix (`MatrixEnergyContainer`):

- Energy in and out is queued during a tick and applied at the next matrix tick (line 95); `getLastInput` and
  `getLastOutput` are the last tick's totals. Input and output are each capped per tick by the providers' total.
  `getEnergy` is stored + queued in − queued out (line 156). Cells: 8 G, 64 G, 512 G, 4 T J; providers 256 k,
  2.048 M, 16.384 M, 131.072 M J/t.
- `getMode`/`setMode` on the port: true is output (`TileEntityInductionPort`).

Fusion (`FusionReactorMultiblockData`):

- Tick (line 193): at 100 MK or more a filled hohlraum ignites it; while burning, D and T are injected in pairs up
  to the injection rate (line 261) and `plasma T − 100 MK` mB of DT fuel burns, 10 MJ each into a plasma of heat
  capacity 100 (line 272). Heat moves plasma → casing (0.2 of the difference), casing → water (0.3, 50 J per mB of
  steam) and casing → air (0.1), 5 % of that last one becomes energy (line 279).
- The formula methods (lines 378-403) and `setInjectionRate` (line 428): "Injection Rate '%d' is out of range must
  be an even number between 0 and 98. (Inclusive)" / "Injection Rate '%d' must be an even number between 0 and 98.
  (Inclusive)". The water and steam tanks are 1 000 000 and 100 000 000 per point of injection rate.
- Logic adapter: Ready, Capacity, Depleted as in `checkMode` (line 53); `setActiveCooledLogic`.

All blocks: `getEnergyFilledPercentage` is 1 when the capacity is 0 (`FloatingLong.divideToLevel`); tank
percentages are `stored / capacity` (NaN for a zero capacity, as in Java); empty gas is `mekanism:empty`, empty
fluid `minecraft:empty`, an empty slot `{ name = "minecraft:air", count = 0 }`.

## Single blocks: energy cubes, tanks, machines, generators

Code: `addons/mekanism-machines/blocks.lua` (what they share), `cube.lua`, `tanks.lua`, `machines.lua`, and
`addons/mekanism-generators/generators.lua`. They run on the same clock as the multiblocks. Their sim state is
under `addons["mekanism-machines"].multiblocks` by peripheral name.

| Types                                                                                                               | Addon                 |
| ------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `basicEnergyCube`, `advancedEnergyCube`, `eliteEnergyCube`, `ultimateEnergyCube`, `creativeEnergyCube`              | `mekanism`            |
| `basicFluidTank` … `creativeFluidTank`, `basicChemicalTank` … `creativeChemicalTank`                                | `mekanism`            |
| `enrichmentChamber`, `crusher`, `energizedSmelter`, `metallurgicInfuser`, `electrolyticSeparator`                   | `mekanism`            |
| `solarGenerator`, `advancedSolarGenerator`, `windGenerator`, `heatGenerator`, `bioGenerator`, `gasBurningGenerator` | `mekanism-generators` |

**Method surface** (in `mekanism-multiblocks-surface.json`): the tile's methods plus the `TileEntityMekanism` ones its
block attributes allow (`getDirection` with facing, `get/setRedstoneMode` with Redstone, `getComparatorLevel`, the
four energy methods), sorted; then the components in constructor order, each sorted: upgrade
(`getInstalledUpgrades`, `getSupportedUpgrades`; machines and generators), security (`getOwnerUUID`, `getOwnerName`,
`getSecurityMode`; all), side config (9 methods; cubes, chemical tanks, machines) and ejector (12 methods; the same).
Fluid tanks have no facing, no redstone control and no side config; generators no side config; cubes and tanks no
upgrades.

**Shared rules.** Setters fail with "Setter not available due to machine security not being public." unless the
security mode is `PUBLIC`. Redstone control `HIGH`/`LOW` stops the block when the signal (`powered`,
`mekSetRedstone`) says so (`MekanismUtils.canFunction`). Upgrades: ticks `200 × 10^(−speed/8)`, energy per tick
`usage × 10^(2 × speed/8 − energy/8)`, capacity `storage × 10^(energy/8)`. Side config errors: "This machine does not
support configuring transmission type '%s'.", "...auto-ejecting for transmission type '%s'.", "...mode '%s' for
transmission type '%s'."; ejector colours: "Color '%s' is not a supported transporter color." (the twelve
transporter colours; increment from none gives `DARK_BLUE`, past `BLACK` gives none). Default side configs are the
constructors' (`TileComponentConfig.setupIOConfig`, `setupItemIOConfig` with `ConfigInfo.setDefaults`: input
everywhere, output right, extra bottom, energy back; cubes and tanks output at the front).

**Behaviour.**

- Energy cube (`TileEntityEnergyCube`, `EnergyCubeTier`): 4, 16, 64, 256 MJ and 4, 16, 64, 256 kJ/t out; ejects
  energy out of its output sides at the tier rate while ejecting and able to function; the creative cube never
  changes. Comparator: energy fill.
- Fluid tank (`TileEntityFluidTank`): 32 000 to 256 000 mB; out down at the tier rate only while active (`active`);
  container edit mode `BOTH`, `FILL`, `EMPTY`. Chemical tank (`TileEntityChemicalTank`): 64 000 to 8 192 000 mB;
  `DUMPING` empties storage / 400 a tick, `DUMPING_EXCESS` down to 90 % at the output rate.
- Electric machines (`TileEntityElectricMachine`): 50 J a tick while operating, 20 kJ storage, 200 ticks an operation;
  `getEnergyUsage` is 0 while idle. The infuser also needs `infusePerOperation` (default 10) of its infuse type.
  Recipes are not looked up: `recipeOutput` (default: the input's name) is what one input becomes.
- Electrolytic separator: `2^speed` operations a tick, each 2 mB water → 2 mB hydrogen (left) + 1 mB oxygen (right)
  for 400 J (times the upgrade factor, a FloatingLong); dumping `8 × 2^speed` or down to 90 % at 1024 mB/t.
- Solar (`TileEntitySolarGenerator`): sees the sun when the sky darkening (vanilla `updateSkyBrightness`) is under 4
  and `canSeeSky`; produces `50 × sun brightness × (1 + 0.3 × (0.8 − temperature) − 0.3 × downfall)`, 20 % of that in
  rain. The advanced one is 300 with nine positions alike. Fixture: `canSeeSky`, `biomeTemperature` (0.8), `downfall`
  (0.4), `precipitation`, `hasSkyLight`; world `mekanism.dayTime` (6000, noon), `raining`, `thundering`,
  `daylightCycle` and `mekSetWorld`.
- Wind (`TileEntityWindGenerator`): every 20 ticks the multiplier `(60 + 420 / 360 × (y + 4 − 24)) / 60` from the
  block's `y` (clamped to 24-384), 0 without sky; `60 × multiplier` J a tick.
- Heat (`TileEntityHeatGenerator`): 10 mB lava gives 200 J of heat; `lavaSides` × 30 and `nether` + 100 more; heat
  becomes energy at Carnot efficiency, at most 500 J/t, and leaks to the air.
- Bio: 1 mB bioethanol, 350 J. Gas-burning: hydrogen 200 J/mB over 1 tick, ethylene 28 200 J/mB over 40; up to
  `ceil(256 × fill)` burn ticks a tick (`getToUse`).
- Rates: `energyInput`, `energyOutput` (generators and cubes capped at their output), `fluidInput`/`fluidOutput`,
  `chemicalInput`/`chemicalOutput`, `waterInput`, `leftOutput`/`rightOutput`, `lavaInput`, `bioFuelInput`,
  `fuelInput`, `infuseInput`. Slots: `input`, `output`, `energyItem`, `fuelItem`, ... as `{ name, count }`.

## Not simulated / not confirmed

- **Not confirmed in game.** Everything comes from source and jar; nothing was measured on a live server.
- **Other blocks** (factories, the other machines, dynamic tank, SPS, evaporation plant, bins, digital miner) are
  not emulated.
- **Single blocks are simplified**: recipes are fixture-given, one item at a time; item ejection just removes the
  output; inventory comparator levels count 64 per slot; heat generators have no neighbour below; solar panels see
  the same sky at all nine positions; rain and thunder switch at once (vanilla fades them in); cube and machine
  inputs are not rate-limited by cables; generators emit to `energyOutput` only.
- **Formation is not validated.** The fixture says what the validator would have found (assemblies, surface area,
  blades, coils, vents, volumes); a structure is formed unless the fixture or a command says otherwise.
- **Pipes are rates.** Real pipes and cables have their own throughput, and real ports split output between
  neighbours; here a link moves what the target accepts. Inputs ignore port modes, except the matrix's (in game
  fission fuel goes in only through a port on `INPUT`). Tick order between structures is by id; in game it is the
  block entities' order, so a value can be a tick earlier or later.
- **Radiation** is only a total in the state (`radiated`); no entities, no radiation spread. The meltdown
  explosion destroys the whole structure at once; in game the explosions break blocks inside the bounds at random
  over up to 100 ticks.
- **Fusion port heat** (ports also lose a little heat to their surroundings through `simulateEnvironment`) and
  heat exchange with neighbouring blocks (fission ports, boiler valves next to heaters) are left out; boiler heat
  comes only from `heatInput` and superheated sodium.
- **FloatingLong** values are doubles rounded to four decimals at each step; above about 9 × 10^11 J the fourth
  decimal can differ.
- **The hohlraum** stack is returned without its NBT.
- **The comparator level** is computed from the contents when asked; in game it updates when the contents change,
  which can lag a tick.
- **Security** does not apply: none of these blocks has a security component.
