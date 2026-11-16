# Create Crafts & Additions 1.0.0 emulation

Addon id `create-additions`; it needs `create` (docs/create.md) for kinetic networks, gauges, speed controllers and
the clock. Lua in `rom-overlay/rom/ccsim/addons/create-additions/init.lua`.

Source of truth: `github.com/mrh0/createaddition`, branch `1.18.2` at commit `e1af3a8` (5 Aug 2023). The repository
has no 1.0.0 tag; the pack's `createaddition-1.18.2-1.0.0.jar` was built that day. Every method name, signature and
error string was checked in the jar with `javap`. Paths are relative to `src/main/java/com/mrh0/createaddition/`.

## Peripherals

| Type                        | Block                     | Methods                                                                                                                                                                                                                                                                                                                                       |
| --------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `electric_motor`            | Electric Motor            | getType, setSpeed, stop, getSpeed, getStressCapacity, getEnergyConsumption, rotate, translate, getMaxInsert, getMaxExtract                                                                                                                                                                                                                    |
| `modular_accumulator`       | Modular Accumulator       | getEnergy, getCapacity, getPercent, getMaxInsert, getMaxExtract, getHeight, getWidth                                                                                                                                                                                                                                                          |
| `portable_energy_interface` | Portable Energy Interface | getEnergy, getCapacity, isConnected, getMaxInsert, getMaxExtract                                                                                                                                                                                                                                                                              |
| `redstone_relay`            | Redstone Relay            | getMaxInsert, getMaxExtract, getThroughput, isPowered                                                                                                                                                                                                                                                                                         |
| `digital_adapter`           | Digital Adapter           | clearLine, clear, print, getLine, setLine, getMaxLines, setTargetSpeed, getTargetSpeed, getKineticStress, getKineticCapacity, getKineticSpeed, getKineticTopSpeed, getPulleyDistance, getPistonDistance, getBearingAngle, getElevatorFloor, getElevatorFloors, getElevatorFloorName, gotoElevatorFloor, getDurationAngle, getDurationDistance |

`compat/computercraft/Peripherals` names the types. Every method is main thread except the motor's `getType` (a
`@LuaFunction` too, so the motor has a Lua `getType()`). No events. Method order: see docs/create.md.

## Fixtures

```jsonc
"createAdditions": { "config": { "fe_at_max_rpm": 480, "max_stress": 16384, "motor_rpm_range": 256,
  "motor_min_consumption": 8, "motor_max_input": 5000, "motor_capacity": 5000, "accumulator_capacity": 2000000,
  "accumulator_max_input": 5000, "accumulator_max_output": 5000, "accumulator_max_width": 3, "accumulator_max_height": 5,
  "pei_max_input": 5000, "pei_max_output": 5000, "small_connector_max_input": 1024, "small_connector_max_output": 1024 } }
```

All optional; the defaults are the mod's (and the pack's `createaddition-common.toml`).

- `electric_motor`: `rpm` (default 32), `energy` (FE stored), `input` (FE/t something feeds it), `powered`
  (redstone), `active`. It drives the network whose `source` is its name (`world.create.networks`).
- `modular_accumulator`: `width` (1-3), `height` (1-5), `energy`, `input` (FE/t in), `output` (FE/t drawn).
- `portable_energy_interface`: `contraption: { energy, capacity }` (connected) or `connected: false`; `input`,
  `output` (FE/t while connected).
- `redstone_relay`: `powered`, `supply` (FE/t the input side has), `demand` (FE/t the output side wants).
- `digital_adapter`: `sides: { up: "<peripheral name>", east: { "kind": "piston", "offset": 3 }, ... }`. A name points
  at a Create block in the world (`Create_RotationSpeedController`, `Create_Speedometer`, `Create_Stressometer`); a
  table is a neighbour the computer does not see: `speed_controller`, `speedometer`, `stressometer` (Create fixture
  fields), `piston` / `pulley` / `hose_pulley` (`offset`), `bearing` (`angle`, `rpm`, `running`), `elevator_pulley`
  (`offset`, `floors: [{ y, name, reachable? }]`, `targetY`, `assembled`).

## Sim commands

| Command                   | Fields                                                                    |
| ------------------------- | ------------------------------------------------------------------------- |
| `caSetEnergy`             | `peripheral, energy` (motor, accumulator, interface)                      |
| `caSetEnergyInput`        | `peripheral, rate` (FE/t in: motor, accumulator, interface)               |
| `caSetEnergyOutput`       | `peripheral, rate` (FE/t out: accumulator, interface)                     |
| `caSetRedstone`           | `peripheral, powered` (motor, relay)                                      |
| `caSetRelayFlow`          | `peripheral, supply?, demand?`                                            |
| `caConnectContraption`    | `peripheral, energy?, capacity?` (a contraption docks at the interface)   |
| `caDisconnectContraption` | `peripheral`                                                              |
| `caSetContraption`        | `peripheral, side, offset?, angle?, rpm?, running?, targetY?, assembled?` |

`craftos_sim_state` `peripherals.<name>`: motor (rpm, the requested rpm, active, energy, consumption, anti-spam
count, output speed), accumulator (energy, capacity, size), interface, relay (throughput), adapter (its 16 lines,
current line, sides).

## Behaviour and its source

| Rule                                                                                                                                                                                                                                             | Source                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `setSpeed(rpm)`: the same as `getSpeed()` returns at once; otherwise clamped to plus or minus 256 and kept; it fails with "Speed is set too many times per second (Anti Spam)." when the anti-spam count is 0, but the value still applies later | `ElectricMotorPeripheral` 55-62, `ElectricMotorBlockEntity.setRPM` 242              |
| the anti-spam count is 5 after every lazy tick (every 20 ticks after the first, so 21 apart) and drops by one for each change the motor applies                                                                                                  | `ElectricMotorBlockEntity` 54, 170, 198-202, `SmartBlockEntity.tick`                |
| `getSpeed` is the last requested RPM, applied or not; `stop()` is `setSpeed(0)`                                                                                                                                                                  | `ElectricMotorPeripheral` 65-75, `getRPM`                                           |
| `getStressCapacity` is `(int)(max_stress / 256)`, the SU per RPM                                                                                                                                                                                 | `ElectricMotorBlockEntity` 91, 254                                                  |
| `getEnergyConsumption`: 0 at 0 RPM, else `max(fe_at_max_rpm x RPM / 256, motor_min_consumption)` FE/t, at the applied RPM                                                                                                                        | `ElectricMotorBlockEntity.getEnergyConsumptionRate` 174                             |
| each tick a stopped motor starts when it holds more than twice its use and has no redstone; a running one uses its FE/t and stops when it runs short or gets redstone                                                                            | `ElectricMotorBlockEntity.tick` 205-220                                             |
| `rotate(deg, rpm?)` / `translate(blocks, rpm?)` set the speed only when `rpm` is given (negative for a negative distance) and return seconds: `(int)(deg / (rpm x 6 / 20) + 1) / 20`, `(int)(blocks / (rpm / 512)) / 20`; below 0.1 RPM, 0       | `ElectricMotorPeripheral` 91-111, `getDurationAngle` 224, `getDurationDistance` 233 |
| `getMaxInsert` is `motor_max_input`, `getMaxExtract` 0                                                                                                                                                                                           | `ElectricMotorPeripheral` 113-120                                                   |
| accumulator capacity `width x width x height x accumulator_capacity`; `getPercent` is the fill as a float x 100                                                                                                                                  | `ModularAccumulatorBlockEntity` 389, 413, 588                                       |
| interface: energy and capacity of the docked contraption, 0 when none; `isConnected` while it transfers                                                                                                                                          | `PortableEnergyInterfaceBlockEntity` 70, 93-99                                      |
| relay: throughput 0 unless powered; it moves what was asked the tick before                                                                                                                                                                      | `RedstoneRelayBlockEntity` 316-323                                                  |
| adapter: 16 lines, the current line starts at 1; `print` writes up to 128 characters and moves down, staying on 16; `setLine` ignores a line outside 1-16 and returns the line                                                                   | `DigitalAdapterBlockEntity` 30, 46-80, `DigitalAdapterPeripheral` 60-64             |
| adapter directions: "down"/"bottom", "up"/"top", "south", "east", "west"; anything else, "north" included, is north                                                                                                                              | `Helpers.nameToDir`                                                                 |
| adapter neighbours: a missing or wrong block answers 0 (or the index as text for floor names); speeds and stress are cut to ints                                                                                                                 | `DigitalAdapterPeripheral` 82-210                                                   |
| `gotoElevatorFloor` returns the change in target height, and calls the floor if it is reachable                                                                                                                                                  | `DigitalAdapterPeripheral.gotoElevatorFloor`                                        |
| a display link on the adapter shows its 16 lines and refreshes every 100 ticks                                                                                                                                                                   | `DigitalAdapterDisplaySource`                                                       |

## Not simulated / not confirmed

- **Energy flow is a fixture rate.** Wires, connectors and other machines are not modelled: a block gets `input`
  FE/t (up to its limit) and gives `output`. The accumulator's output is one limit of 5000 FE/t, not one per top and
  bottom face. The relay's throughput is `min(supply, last demand)`, without the energy network's own limits.
- **Interface connection timing:** `isConnected` is true from docking to undocking; the real one is true only once
  the contraption's transfer timer has started (a few ticks after docking).
- **Motor phase:** the sim's first lazy tick is at boot; in game the phase depends on when the chunk loaded.
- **Motor direction:** the motor's facing (which flips the shaft's sign) is ignored.
- **Contraptions** (pistons, pulleys, elevators) do not move by themselves; their offsets change only by sim
  command. Bearings turn at `rpm x 0.3` degrees per tick while running, and the angle is read half a tick ahead as the
  source does. `getHeight`/`getWidth` answer the whole multiblock's size from any block of it (not confirmed for
  non-controller blocks).
