# Extreme Reactors emulation

Extreme Reactors is **not in the pack**. The emulator follows the latest Forge 1.18.2 release:
**ExtremeReactors2 1.18.2-2.0.71** and the library its computer code lives in, **ZeroCore2 1.18.2-2.1.39**
(Modrinth). Source: `github.com/ZeroNoRyouki/ExtremeReactors2` tag `1.18.2-2.0.71` and
`github.com/ZeroNoRyouki/ZeroCore2` tag `1.18.2-2.1.39`. Method names, type names and messages were checked in both
jars with `javap`. CC:Tweaked behaviour comes from the pack's 1.101.3 jar.

On Minecraft 1.20.1 the addon acts as **ExtremeReactors2 1.20.1-2.0.97** (ZeroCore2 1.20.1-2.1.48), on 1.21.1 as
**1.21.1-2.4.28** (ZeroCore2 1.21.1-2.4.21). Everything below is 2.0.71 unless [Versions](#versions) at the end says
otherwise; the Energizer (`BigReactors-Energizer`) exists only there.

Nothing here could be measured in game, because the mod is not installed. Every number below is read from the
source and has not been compared with a running reactor.

The addon id is `extreme-reactors`. The Lua is `rom-overlay/rom/ccsim/addons/extreme-reactors/init.lua`. Tests:
`packages/runner/src/extreme-reactors.integration.test.ts`. Demo world: `worlds/extreme-reactors-demo.json`.

Paths below are relative to `src/main/java/it/zerono/mods/`. `ER/` is `extremereactors/gamecontent/multiblock/`,
`ZC/` is `zerocore/lib/`.

## Peripherals

| Type                  | Block                 | Methods                |
| --------------------- | --------------------- | ---------------------- |
| `BigReactors-Reactor` | Reactor Computer Port | 37 own + 9 common = 46 |
| `BigReactors-Turbine` | Turbine Computer Port | 26 own + 9 common = 35 |

The type names come from `ER/reactor/part/ReactorComputerPortEntity.java:48` and
`ER/turbine/part/TurbineComputerPortEntity.java:48`. Extreme Reactors keeps the old Big Reactors flat API: every
method is on the peripheral itself and returns plain values or tables.

Common to both (`ZC/compat/computer/ComputerPeripheral.java:140-141`, `MultiblockComputerPeripheral.java:71-86`):
`help`, `isMethodAvailable(name)`, `mbIsConnected`, `mbIsAssembled`, `mbIsDisassembled`, `mbIsPaused`,
`mbGetMultiblockControllerTypeName`, `mbGetMinimumCoordinate`, `mbGetMaximumCoordinate`, and on both ports
`getVariant`, `getActive`, `setActive`, `getEnergyStored`, `getEnergyStoredAsText`, `getEnergyCapacity`,
`getEnergyStats`, `getEnergyProducedLastTick`.

Reactor (`ER/reactor/computer/ReactorComputerPeripheral.java:69-258`): `getNumberOfControlRods`,
`getFuelTemperature`, `getCasingTemperature`, `getFuelAmount`, `getWasteAmount`, `getFuelAmountMax`,
`getControlRodName(i)`, `getControlRodLevel(i)`, `getControlRodLocation(i)`, `getControlRodsLevels`,
`setControlRodsLevels(t)`, `setControlRodLevel(i, level)`, `setAllControlRodLevels(level)`,
`setControlRodName(i, name)`, `getHotFluidProducedLastTick`, `isActivelyCooled`, `getCoolantAmount`,
`getCoolantAmountMax`, `getCoolantType`, `getHotFluidAmount`, `getHotFluidAmountMax`, `getHotFluidType`,
`getFuelReactivity`, `getFuelConsumedLastTick`, `getFuelStats`, `getHotFluidStats`, `getCoolantFluidStats`,
`doEjectWaste`, `doEjectFuel`.

Turbine (`ER/turbine/computer/TurbineComputerPeripheral.java:67-136`): `getFluidAmountMax`, `getFluidFlowRate`,
`getFluidFlowRateMax`, `getFluidFlowRateMaxMax`, `setFluidFlowRateMax(rate)`, `getInputAmount`, `getInputType`,
`getOutputAmount`, `getOutputType`, `getRotorSpeed`, `getNumberOfBlades`, `getBladeEfficiency`, `getRotorMass`,
`getInductorEngaged`, `setInductorEngaged(on)`, `setVentNone`, `setVentOverflow`, `setVentAll`.

## How a call behaves

| Rule                                                                                                                                                                                                                              | Source                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| The port is a CC `IDynamicPeripheral`. Every method runs at once on the computer thread; none waits for a tick.                                                                                                                   | `ZC/compat/computer/ConnectorComputerCraft.java:48-55`                                                                     |
| `peripheral.getMethods` order: CC puts the names in a `HashMap` sized to the count, in ZeroCore's order (sorted by name). The test re-derives it with Java's string hash.                                                         | CC `PeripheralAPI.getMethods`; `ComputerPeripheral.java:147`; `extreme-reactors-surface.json`                              |
| Arguments reach ZeroCore as `getAll()`: numbers are Doubles, tables Maps. Any Java exception becomes a Lua error with its message.                                                                                                | `ConnectorComputerCraft.java:51-54`                                                                                        |
| Too few arguments: `Insufficient number of arguments, expected N`. Checked before anything else, also for setters.                                                                                                                | `ZC/compat/computer/LuaHelper.java:28-33,149-151`; `ComputerMethod.java:60`                                                |
| Wrong type: `Invalid argument N, expected Number` (or `Boolean`, `String`). N is 0-based.                                                                                                                                         | `LuaHelper.java:42-48,113-138,153-155`                                                                                     |
| A missing argument past the count: `Index N out of bounds for length M` (Java's array message), e.g. `isMethodAvailable()`.                                                                                                       | `ComputerPeripheral.java:141` (no minimum)                                                                                 |
| Whole numbers go through `Math.round` then `(int)`: `getControlRodLevel(1.4)` is rod 1, `2.5` is 3.                                                                                                                               | `LuaHelper.java:82-84`                                                                                                     |
| Setters (`setActive`, rod setters, `setControlRodsLevels`, `doEject*`, turbine setters) are queued for the next server tick and return nothing. Any error inside them (a bad type, a level of 150, a missing key) is only logged. | `ComputerMethod.java:62-74`                                                                                                |
| No controller (`connected: false`): every controller method returns an empty table (ZeroCore's `EMPTY_RESULT` array), setters do nothing. `mbIs*` and `mbGetMultiblockControllerTypeName` still answer.                           | `ZC/multiblock/AbstractMultiblockPart.java:149-151`; `MultiblockComputerPeripheral.java:53-55`                             |
| A controller that is not assembled still answers with its values, but does not tick.                                                                                                                                              | `AbstractMultiblockPart.java:111-123`                                                                                      |
| `getControlRodByIndex(i)`: below 0 or above the count is no rod (no values back); exactly the count throws `Index: N, Size: N` (LinkedList).                                                                                      | `ER/reactor/MultiblockReactor.java:143-150`                                                                                |
| `getControlRodLocation` returns a `BlockPos`, which CC cannot convert: always nil.                                                                                                                                                | `ReactorComputerPeripheral.java:122-126`                                                                                   |
| `getHotFluidStats`/`getCoolantFluidStats` put an `Optional` in `fluidType`; CC turns it into nil, so the key is never there.                                                                                                      | `ReactorComputerPeripheral.java:215-240`                                                                                   |
| `getControlRodsLevels` keys are 0-based. `setControlRodsLevels` needs exactly one entry per rod, keyed 0..n-1; a Lua list (1-based) silently does nothing.                                                                        | `ReactorComputerPeripheral.java:130-184`                                                                                   |
| `setControlRodName("")` is ignored. `setAllControlRodLevels` and the turbine's flow and inductor setters only act on an assembled machine.                                                                                        | `ER/reactor/part/ReactorControlRodEntity.java:279-289`; `MultiblockReactor.java:555-559`; `MultiblockTurbine.java:352-395` |
| `setFluidFlowRateMax` clamps to 0..variant max.                                                                                                                                                                                   | `ER/turbine/TurbineData.java:267-269`                                                                                      |
| `mbGetMultiblockControllerTypeName` is the Java class name, e.g. `it.zerono.mods.extremereactors.gamecontent.multiblock.reactor.MultiblockReactor`.                                                                               | `MultiblockComputerPeripheral.java:79`                                                                                     |
| `getEnergyStoredAsText`: divide by 1000 while above 1000, `%.2f` (half up), a space, SI prefix, `FE`.                                                                                                                             | `ZC/CodeHelper.java:978-1001`                                                                                              |
| `getFuelReactivity` is fertility × 100 (a float). `getBladeEfficiency` is the last tick's rotor efficiency × 100.                                                                                                                 | `ReactorComputerPeripheral.java:118`; `TurbineComputerPeripheral.java:104`                                                 |
| `getInputType`/`getOutputType` on the turbine are translated names (`Steam`, `Water`), the reactor's are registry names (`bigreactors:steam`, `minecraft:water`).                                                                 | `TurbineComputerPeripheral.java:144-146`; `ReactorComputerPeripheral.java:110-116`                                         |

## The simulation

Machines run on the virtual clock: every 50 ms is a server tick. Before anything looks (a call, a sim command, a
state dump) every machine is caught up tick by tick, in world order. Where the mod uses `float`, the Lua rounds
every step to a single the way Java does, so the numbers match the Java bit for bit (the tests run an independent
TypeScript port of the same source next to the emulator and compare). When a tick changes nothing at all, the rest
are skipped up to the next queued setter.

### Reactor tick (`ER/reactor/ReactorLogic.java:56-124`)

1. **Irradiation**, only when active (`:215-243`). The next fuel rod in order is the source (`FuelRodsMap.java:90-97`;
   bottom layer first). No fuel: nothing.
   - `radiationPenaltyBase = exp(-15 · exp(-0.0025 · fuelHeat))`, `baseFuel = fuel + waste/100`,
     `rawIntensity = baseFuel · fissionEventsPerFuelUnit`, `scaled = (rawIntensity^reactivity / rods)^reactivity · rods`,
     both times `(100 − insertion)/100` of the source's rod (`:337-369`).
   - `effective = scaled · (1 − 0.95 · exp(−10 · exp(−0.0012 · fuelHeat)))`, `hardness = 0.2 + 0.8 · penaltyBase`,
     `fuelUsage = 0.0007 · rawIntensity / fertilityModifier` (`:371-381`).
   - Fuel heat gains `10 · effective`, then a quarter of it goes out in each of the four directions in the rod's
     plane (SOUTH, WEST, NORTH, EAST: `FuelRodsLayout.java:101`), up to 4 blocks while intensity > 0.0001 (`:394-412`).
   - A moderator block absorbs `intensity · absorption · (1 − hardness)`, divides hardness by its moderation and
     heats the casing by `efficiency · absorbed · 10` (`MultiblockReactor.java:419-426`).
   - Another fuel rod absorbs by its own rod's insertion and the fuel heat, adds to fuel heat and fertility
     (`ER/reactor/part/ReactorFuelRodEntity.java:171-213`). A casing stops the ray (`AbstractReactorEntity.java:119-124`).
   - Fertility gains what the rods absorbed; `FuelContainer.onIrradiation` turns whole mB of fuel into waste
     (`FuelContainer.java:141-190`). Fuel heat changes by energy / (fuel rods · 10), casing by energy / (volume · 10)
     (`IrradiationData.java:48-54`, `EnergyConversion.java:27-38`).
2. **Fertility decay**: `fertility −= max(0.1, fertility/20)`, the 20 is 4000 when off (`:425-436`).
3. **Waste ejection** (automatic by default) to an output access port, in whole ingots (`MultiblockReactor.java:253-268`,
   `ReactantHelper.java:89-156`). **Coolant intake** when actively cooled (`:298-312`).
4. **Fuel → casing**: if `fuelHeat − casingHeat > 0.01`, move `diff · k` energy, `k` = Σ over fuel rods of the four
   neighbours' conductivity (casing 0.6, air or another rod 0.05, moderators their own) (`:249-264`,
   `ReactorFuelRodEntity.java:60-97`).
5. **Casing → coolant** (`:270-295`): coolant temperature is 20 when passive; when active it is
   `min(casing, 100)` with water, else the casing itself (no transfer). `energy = diff · 0.6 · internal surface`.
   Passive: × 0.2, and `× 0.5 × variant efficiency` becomes FE in the buffer. Active: boil water at 4 FE per mB; steam
   made is `(int)(mB · 0.85)` (`ER/common/FluidContainer.java:237-369`).
6. **Passive loss** to 20 °C: at least 1 FE a tick, `diff · 0.001 · external surface` (`:301-316`).
7. **Output**: passive pushes FE to the load; active pushes steam out (`MultiblockReactor.java:273-292,1289-1311`).

Sizes (`MultiblockReactor.java:799-858,1325-1386`): fuel capacity 4000 mB per fuel rod; energy capacity
`partEnergyCapacity ·` parts (shell + fuel rods); coolant and steam tanks each `shell · partFluidCapacity`, capped.
Variants (`ER/reactor/variant/ReactorVariant.java:37-62`): basic 10000 FE/part, efficiency 0.8, max extract 50000,
no coolant ports (passive only); reinforced 30000 FE/part, 0.85, 5000000, 1000 mB/part up to 200000, steam 0.85.
Heats start at 0 °C (`Heat.java:27-29`), fertility at 1.

Fuels (`gamecontent/ReactorGameData.java:45-92`): yellorium (default), blutonium, verderium, with their fuel
properties and reactivity (1.05, 1.0871, 1.0984). Moderators: the table at `ReactorGameData.java:94-165`, plus air and
water (`api/reactor/Moderator.java:29-30`).

### Turbine tick (`ER/turbine/MultiblockTurbine.java:506-557`, `TurbineLogic.java:39-142`)

1. Steam intake from the input ports, up to the free space.
2. When active: `vapor = min(flow rate max, steam)`; with the vent closed also no more than the free water space.
3. If there is vapor or the rotor turns: `speed = rotorEnergy / (blades · rotorMass)` (`MultiblockTurbine.java:312-322`).
   Lift is `min(blades · fluidPerBlade, vapor) · 10`; steam beyond what the blades take counts at
   `1 − missing/needed` blades, which sets the blade efficiency (`TurbineLogic.java:77-103`).
4. Inductor engaged: `torque = speed · dragCoefficient · coils`, `energy = torque^bonus · inductionEfficiency`, times
   `0.25 · cos(speed / (45.5π)) + 0.75`, at most 0.5 below 500 RPM (`:108-125`).
5. `rotorEnergy += lift − torque − speed · bladeDrag − frictionalDrag`, never below 0 (`:127-128`).
6. The vapor turns back into water one to one (dumped with vent all, extra voided with overflow)
   (`FluidContainer.java:261-274`). Then power and water go out (`MultiblockTurbine.java:176-190`).

Rotor parameters (`ER/turbine/TurbineData.java:105-173,381-384`): mass = blades · bladeMass + shafts · shaftMass;
blade drag `0.00025 · blades`; friction `mass · 0.01`; induction efficiency `Σeff · 0.33 / coils`; bonus
`max(1, Σbonus / coils)`; drag coefficient `Σextraction / coils · 0.1`. Coil materials: `TurbineGameData.java:32-69`.
Variants (`ER/turbine/variant/TurbineVariant.java:37-72`): basic 10000 FE/part, 1000 mB/t, 15 mB per blade, masses 8,
250 mB/part up to 10000; reinforced 20000 FE/part, 2000 mB/t, 25 mB per blade, masses 10, 500 mB/part up to 300000.
Defaults: inactive, vent overflow, inductor off, flow at the variant max (`TurbineData.java:37-61`).

The energy buffer keeps four decimal digits, like ZeroCore's `WideAmount` (`ZC/data/WideAmount.java:711-758`).

## Fixtures

```jsonc
"extremeReactors": { "gameTime": 0, "config": { "fuelUsageMultiplier": 1, "powerProductionMultiplier": 1,
  "reactorPowerProductionMultiplier": 1, "turbinePowerProductionMultiplier": 1, "turbineAeroDragMultiplier": 1,
  "turbineMassDragMultiplier": 1, "turbineFluidPerBladeMultiplier": 1 } },   // all optional
"peripherals": [
  { "name": "reactor", "type": "BigReactors-Reactor",
    "variant": "reinforced",            // basic (default) or reinforced
    "cooling": "active",                // passive (default) or active (reinforced only)
    "layout": ["X.X", ".G.", "X.X"],    // interior seen from above: X = control rod + fuel column
    "legend": { "G": "graphite" },      // . air, W water, G graphite, I iron, O gold, D diamond, E emerald, C copper, L lead, S glass
    "dimensions": [5, 6, 5],            // outside size; with a layout only y counts. No layout: 5x5x5, one rod in the middle
    "moderator": "air",                 // filler when there is no layout
    "controlRods": [{ "name": "a", "level": 10 }], "rodLevel": 0,
    "fuel": 10000, "waste": 0, "fuelType": "yellorium",
    "fuelHeat": 0, "casingHeat": 0, "fertility": 1, "energy": 0, "active": false,
    "coolant": 0, "steam": 0, "coolantSupply": "full", "steamDrain": "full", "steamTo": "turbine",
    "load": 0, "wasteEjection": "automatic", "wasteOutlet": false, "fuelInlet": false,
    "connected": true, "assembled": true, "position": [0, 0, 0] },
  { "name": "turbine", "type": "BigReactors-Turbine", "variant": "basic", "dimensions": [5, 7, 5],
    "shafts": 5, "blades": 8, "coils": { "gold": 8 }, "active": false, "inductor": false, "vent": "overflow",
    "flowRate": 1000, "rotorSpeed": 0, "steam": 0, "water": 0, "steamSupply": "full", "waterDrain": "full",
    "load": 0, "energy": 0, "connected": true, "assembled": true, "position": [0, 0, 0] }
]
```

- `coolantSupply`/`steamSupply`: mB a tick the input ports pull, or `"full"` (top up every tick).
  `steamDrain`/`waterDrain`: mB a tick the output ports push away, or `"full"` (everything).
- `steamTo`: the reactor pushes its steam into that turbine, and the turbine sends its water back. Then the
  reactor's `coolantSupply` and the turbine's `steamSupply` default to 0.
- `load`: FE a tick the power taps push to whatever is connected.
- `wasteOutlet`/`fuelInlet`: an output (input) access port that takes whole ingots, without limit.
- Coil and moderator names: `"gold"`, `"minecraft:gold_block"` or `"forge:storage_blocks/gold"`.

## Sim commands (`craftos_sim_command`)

`erAddFuel {peripheral, amount, fuelType?}`, `erAddWaste {peripheral, amount}` (both capped by free space),
`erSetLoad {peripheral, rate}`, `erDrainEnergy {peripheral, amount}` (a pulling consumer: at most the variant's max
extract), `erAddCoolant {peripheral, amount}`, `erAddSteam {peripheral, amount}`,
`erSetCoolantSupply {peripheral, rate|"full"}`, `erSetSteamSupply {peripheral, rate|"full"}`,
`erSetActive {peripheral, active}` (a player at the controller), `erSetAssembled {peripheral, assembled}` (breaking a
block deactivates it and stops a turbine's rotor: `TurbineData.java:93-99`), `erSetConnected {peripheral, connected}`.

`craftos_sim_state` has every machine under `peripherals.<name>` (fuel, waste, heats, fertility, energy, tanks, rods,
rotor speed and energy, flow, vent, inductor) and `addons["extreme-reactors"].gameTime`.

## Not simulated / not confirmed

- Nothing was measured in game: the mod is not in the pack.
- The fuel rod order the mod irradiates in depends on chunk loading; the emulator goes bottom layer first, rods in
  layout order. Over many ticks this averages out the same.
- Rods are always vertical (control rods on top). Every layer of the interior is the same layout.
- Access ports, power taps, fluid ports and coolant pumps are fixture numbers, not blocks: no item stacks, no slot
  limits, no per-port split (`distributeEnergyEqually` divides by port count).
- `getEnergyStoredAsText` below 0.001 FE uses `?` for the micro sign (CC's string encoding of `μ`), not confirmed.
- Turbine fluid names come from the client language file (`Steam`, `Water`); a server in another language would
  differ. The reactor's steam name assumes ER's own `bigreactors:steam` is first in `forge:steam`; set `steamFluid`
  in the fixture if another mod's steam comes first.
- Turbine coils are a material count. The mod counts only coil blocks that sit validly around the rotor (and where
  they sit does not change the numbers); the emulator trusts the count. Blades and shafts are counts too.
- Reactor overheating has no consequence in the mod either (`ReactorLogic.java:118-120` is a TODO).
- The heat exchanger, fluidizer and reprocessor have no computer ports in any of the three releases.
- A computer port only exists in the reinforced variant (`Content.Blocks` registers `reinforced_reactorcomputerport`
  and `reinforced_turbinecomputerport` only, in all three releases), but the fixture's default variant is `basic`.
  A basic machine with a port cannot be built in game; its numbers are still the basic variant's.

## Versions

| Minecraft | ExtremeReactors2 | ZeroCore2     | Jars                                                                                                                  |
| --------- | ---------------- | ------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1.18.2    | 1.18.2-2.0.71    | 1.18.2-2.1.39 | Modrinth; sha1 `f23a8a13…` and `2caa5870…` match Modrinth's                                                           |
| 1.20.1    | 1.20.1-2.0.97    | 1.20.1-2.1.48 | CurseForge files 7344727 (2578824 bytes) and 7344725 (1341342 bytes); `mods.toml` pins `[1.20.1-2.1.48,1.21-2.2.0)`   |
| 1.21.1    | 1.21.1-2.4.28    | 1.21.1-2.4.21 | CurseForge files 7344744 (2554779 bytes) and 7344742 (1551013 bytes); `mods.toml` pins `[1.21.1-2.4.21,1.21.1-2.5.0)` |

Method: every class of the three jars was decompiled with `javap -c -p -constants` and diffed with the constant-pool
numbers stripped; the sources were read at tags `1.18.2-2.0.71`, `1.20.1-2.0.96` and `1.21.1-2.4.27` (the last two
final releases are not tagged). The 2.0.96 → 2.0.97 and 2.4.27 → 2.4.28 jars were diffed too: only `MultiblockReactor`,
`MultiblockTurbine`, `MultiBlockEnergizer` and client classes changed, and only to read block states through
`WorldHelper.getLoadedBlockStateOrAir` (no unloaded chunks), so the tags' logic is the released logic.

Unchanged on all three, with the evidence:

- **ZeroCore's computer code** (`ZC/compat/computer/*`: argument checks, messages, `EMPTY_RESULT`, the server-thread
  queue, the sorted method collection): 0 differing instructions between the 1.18.2 and 1.20.1 jars; 1.21.1 only
  swaps `NonNullConsumer` for `Consumer`, NeoForge packages and Mojang names. `WideAmount` arithmetic is the same.
- **The method lists and type strings** of the reactor and turbine ports (`BigReactors-Reactor`,
  `BigReactors-Turbine`, the same 37 + 26 own methods: identical string constants in all three jars), so
  `extreme-reactors-surface.json` holds for both machines on every version.
- `ReactorLogic` (radiation, heat, fertility), `TurbineLogic`'s physics, `TurbineData`, `FuelRodsMap`'s order, `Heat`,
  `FluidContainer`'s boiling and condensing, the fuels and their reactions, the turbine variants (apart from the
  extraction rate below) and the coils.

What changed (simulated: `NEW` = 1.20.1 and 1.21.1, `V121` = 1.21.1 in `init.lua`):

| What                                      | 1.18.2 (2.0.71)                               | 1.20.1 (2.0.97)                                                                                                                                                                                                             | 1.21.1 (2.4.28)                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `getCoolantType()`, `getHotFluidType()`   | the registry name, `""` when empty            | the `Optional<String>` itself (the `.orElse("")` is gone); CC 1.121.0's `toValue` cannot convert it (`makeLuaObject` finds no methods) and logs "Received unknown type": always one `nil`                                   | same as 1.20.1                                                                                                                                                                                                                                                                                                     |
| `getControlRodLocation(i)`                | a `BlockPos`: `nil`                           | `{ x, y, z }`: the rod's position minus `getMinimumCoord()` (control rods sit in the top casing, so `y` is the outer height - 1)                                                                                            | same as 1.20.1                                                                                                                                                                                                                                                                                                     |
| Reactor energy buffer                     | `partEnergyCapacity * parts`                  | `* powerProductionMultiplier * reactorPowerProductionMultiplier * the variant's energy efficiency` (basic `0.8f`: 1300000 becomes 1040000.0155)                                                                             | same as 1.20.1                                                                                                                                                                                                                                                                                                     |
| Turbine energy buffer                     | `partEnergyCapacity * parts`                  | `* powerProductionMultiplier * turbinePowerProductionMultiplier`                                                                                                                                                            | same as 1.20.1                                                                                                                                                                                                                                                                                                     |
| Reinforced reactor                        | efficiency `0.85f`, extracts 5,000,000 FE/t   | efficiency `1`, 50,000,000 FE/t (charger 25,000); solid and fluid fuel conversion 1                                                                                                                                         | same as 1.20.1                                                                                                                                                                                                                                                                                                     |
| Reinforced turbine                        | extracts 5,000,000 FE/t                       | 50,000,000 FE/t (its efficiency 0.85 → 1 is not used by any formula)                                                                                                                                                        | same as 1.20.1                                                                                                                                                                                                                                                                                                     |
| Basic reactor fuel conversion             | solid 0.5                                     | solid 1 (ingots into an access port; the fixture has no such port, not simulated)                                                                                                                                           | same as 1.20.1                                                                                                                                                                                                                                                                                                     |
| Taking a machine apart (`erSetAssembled`) | switches it off                               | stays on (`onMachineDisassembled` has the lines commented out); a turbine's rotor still stops                                                                                                                               | same as 1.20.1                                                                                                                                                                                                                                                                                                     |
| Last-tick stats                           | zeroed at the start of each tick              | the same                                                                                                                                                                                                                    | set when they happen and never zeroed: `getEnergyProducedLastTick`, `getHotFluidProducedLastTick`, `getFuelConsumedLastTick` (an idle or empty reactor keeps its last value), the turbine's `getEnergyProducedLastTick`, `getFluidFlowRate` and `getBladeEfficiency` (which only moves when there is excess steam) |
| Moderators                                |                                               | adds Draconic `draconium`, `draconium_awakened`; Thermal Extra `dragonsteel`, `twinite`, `shellite`; Allthemodium `allthemodium`, `vibranium`, `unobtainium` and their `molten_` fluids; Thermal fluids `ender`, `redstone` | the same, under `c:` tags (`c:storage_blocks/gold`); both `forge:` and `c:` spellings are taken on every version                                                                                                                                                                                                   |
| `BigReactors-Energizer`                   | does not exist (refused: `byVersion` `added`) | new: see below                                                                                                                                                                                                              | same as 1.20.1                                                                                                                                                                                                                                                                                                     |
| Config ranges                             | power multipliers 0.5 to 100 / 10             | 0.005 to 100 (not checked by the emulator)                                                                                                                                                                                  | same                                                                                                                                                                                                                                                                                                               |

### The Energizer (1.20.1 and 1.21.1)

`ER/energizer/computer/EnergizerComputerPeripheral`, `MultiBlockEnergizer`, `variant/EnergizerVariant`, ZeroCore's
`MeteredWideEnergyBuffer`. Type `BigReactors-Energizer`; the 9 common methods plus `getActive`, `setActive(bool)`
(queued for the server tick), `getEnergyStored`, `getEnergyCapacity`, `getEnergyIoLastTick`,
`getEnergyInsertedLastTick`, `getEnergyExtractedLastTick` (each also as `...AsText`), `getEnergyStats` and
`getEnergyStatsAsText` (keys `energyStored`, `energyCapacity`, `energyIoLastTick`, `energyInsertedLastTick`,
`energyExtractedLastTick`, `energySystem`). No `getVariant`.

- Every interior block is a cell of `WideAmount.MAX_VALUE / 27000` = 683212743470724.1339 FE; the capacity is that
  times the interior volume, as an unsigned long turned into a double (`mathUnsignedLongToDouble`). Outer size 3 to
  32 a side.
- Inactive: `insertEnergy` and `extractEnergy` give 0 and nothing is pushed out. Active: the output ports get the
  stored energy (`distributeEnergyEqually`).
- The meter counts what went in and out since the last controller tick; `getEnergyIoLastTick` is in minus out,
  clamped at 0.

Fixture: `{ "type": "BigReactors-Energizer", "dimensions": [5, 5, 5], "active": false, "energy": 0, "input": 0,
"load": 0, "connected": true, "assembled": true, "position": [0, 0, 0] }` (`input`: FE a tick a generator pushes in;
`load`: FE a tick the output ports take). Sim commands: `erSetInput {peripheral, rate}`, `erSetLoad`,
`erDrainEnergy` (only while active, metered), `erSetActive`, `erSetAssembled`, `erSetConnected`. Not simulated: the
charging port (items), a reactor or turbine feeding it directly, merging two energizers.
