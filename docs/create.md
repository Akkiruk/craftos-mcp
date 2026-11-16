# Create 0.5.1.i emulation

Addon id `create`. Lua in `rom-overlay/rom/ccsim/addons/create/`: `init.lua` (kinetics, gauges, speed controller,
sequenced gearshift, display link, sim commands), `trains.lua` (stations, trains, schedules, the schedule runtime),
`common.lua` (CC argument checks, CC's method order, Java casts and exception text, a small NBT model).

Source of truth: `github.com/Creators-of-Create/Create`, branch `mc1.18/dev` at commit `2828c88` (8 Oct 2024). The
repository has no tag for 0.5.1.i; this is the last commit before the pack's `create-1.18.2-0.5.1.i.jar` was built
(the jar's files are dated 9 Oct 2024). Every method name, signature and error string below was checked in that jar
with `javap`. Paths below are relative to `src/main/java/com/simibubi/create/`.

## Peripherals

`peripheral.getType` gives the type. Create has no generic methods on these blocks and sends no events.

| Type                             | Block                     | Methods                                                                                                                                                                                                      |
| -------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Create_DisplayLink`             | Display Link              | setCursorPos, getCursorPos, getSize, isColor, isColour, write, clearLine, clear, update                                                                                                                      |
| `Create_Speedometer`             | Speedometer               | getSpeed                                                                                                                                                                                                     |
| `Create_Stressometer`            | Stressometer              | getStress, getStressCapacity                                                                                                                                                                                 |
| `Create_RotationSpeedController` | Rotation Speed Controller | setTargetSpeed, getTargetSpeed                                                                                                                                                                               |
| `Create_SequencedGearshift`      | Sequenced Gearshift       | rotate, move, isRunning                                                                                                                                                                                      |
| `Create_Station`                 | Train Station             | assemble, disassemble, setAssemblyMode, isInAssemblyMode, getStationName, setStationName, isTrainPresent, isTrainImminent, isTrainEnroute, getTrainName, setTrainName, hasSchedule, getSchedule, setSchedule |

The six classes are in `compat/computercraft/implementation/peripherals/`; `ComputerBehaviour.getPeripheralFor`
lists them. `packages/runner/src/create-surface.json` has each type's methods in declaration order;
`peripheral.getMethods` gives them in CC:Tweaked's `HashMap` order (`PeripheralAPI.getMethods` fills
`new HashMap<>(count)`), which the test works out with Java's string hash.

**Main thread** (the call waits for the next server tick and every event that arrives meanwhile is lost):
DisplayLink `getSize`, `update`; SequencedGearshift `rotate`, `move`; SpeedController `setTargetSpeed`; Station
`assemble`, `disassemble`, `setAssemblyMode`, `setStationName`, `setTrainName`, `setSchedule`. Everything else answers
at once. CC:Tweaked wraps the whole generated method in the main-thread task (`Generator`, the `wrap` function), so
argument errors of a main-thread method also come after the wait.

## Fixtures

```jsonc
"create": {
  "gameTime": 0,              // first tick, optional
  "dayTime": 1000,            // day time at boot for time-of-day waits (default world.environment.time, else 0)
  "config": { "maxRotationSpeed": 256, "trainTopSpeed": 28, "poweredTrainTopSpeed": 40,
              "trainAcceleration": 3, "poweredTrainAcceleration": 3 },   // CKinetics / CTrains defaults
  "networks": {               // kinetic networks
    "main":  { "speed": 64, "capacity": 4096, "stress": 0, "impact": 8 },
    "geared": { "source": "Create_SequencedGearshift_0" }            // driven by a block: its output speed
  },
  "stations": ["Mine", "Farm"],                                      // stations without a computer
  "distance": 300,                                                   // blocks between stations not listed below
  "distances": { "Central|Mine": 400 },                              // by the stations' first names
  "trains": [
    { "name": "Ore Express", "at": "Central", "route": [{ "station": "Mine", "wait": 10 }] },
    { "name": "Harvest", "at": "Farm", "schedule": { "cyclic": true, "entries": [ ... ] },   // as setSchedule takes it
      "items": [{ "name": "minecraft:wheat", "count": 32 }], "fluids": [], "players": 0,
      "conductor": true, "powered": false, "maxSpeed": 28, "canDisassemble": true },
    { "name": "Late", "heading": "Central", "distance": 500 }        // already on its way
  ]
}
```

Peripheral fields:

- `Create_Station`: `station` (its name, default "Track Station"), `track: false` (not on a track),
  `assembling`, `powered` (redstone), `pending: { name? }` (carriages on the track, ready to assemble). A station
  block whose name is also in `stations` is the same station.
- `Create_Speedometer`: `network`, or a fixed `speed`. `Create_Stressometer`: `network`, or fixed `stress`, `capacity`.
- `Create_RotationSpeedController`: `network` (its input), `targetSpeed` (default 16). A network with
  `source: "<controller>"` turns at the target speed while the input turns.
- `Create_SequencedGearshift`: `network` (its input). A network with `source: "<gearshift>"` turns at the input speed
  times the modifier while an instruction runs, and stands still otherwise.
- `Create_DisplayLink`: `target` (below), `line` (first line it writes to, 1-based, default 1), `source`
  (`"computer"`, the default; `"none"`; or the name of a Crafts & Additions `digital_adapter`), `powered`
  (redstone), `lines` (text already written), `restarted: true` (the server restarted since the link last sent, so
  it has no target until its first update).
- Display link targets: `{ "type": "display_board", "width": 3, "height": 2, "speed": 16 | "network": "id", "lines": [] }`,
  `"sign"`, `{ "type": "lectern", "book": "written" | "writable" | "none", "pages": [] }`,
  `{ "type": "nixie_tube", "tubes": 2 }`, or `"none"`.

## Sim commands

| Command                   | Fields                                                   | Does                                                                                      |
| ------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `createTrainArrive`       | `train, station`                                         | the train is at the station now (a new train if the name is new); a scheduled one arrives |
| `createTrainLeave`        | `train`                                                  | the train leaves its station by hand: on the network, going nowhere                       |
| `createTrainApproach`     | `train, station, distance?`                              | the train drives towards the station from `distance` blocks                               |
| `createAddTrain`          | `train: { ...fixture train }`                            | a new train                                                                               |
| `createRemoveTrain`       | `train`                                                  | the train is gone                                                                         |
| `createSetCargo`          | `train, items?, fluids?, players?`                       | cargo or passengers change (cargo waits look again, idle waits start over)                |
| `createSetStationPowered` | `station, powered`                                       | redstone on the station (for "station powered" waits)                                     |
| `createSetAssemblyReady`  | `station, name?, ready?`                                 | carriages stand on the station's track, ready for `assemble`                              |
| `createSetRedstoneLink`   | `first?, second?, powered`                               | a redstone link frequency (two item ids, air when left out) is on or off                  |
| `createSetSpeed`          | `network, speed` or `peripheral, speed`                  | a network's own speed, or a fixed speedometer                                             |
| `createSetStress`         | `network` or `peripheral`, `stress?, capacity?, impact?` | stress and capacity                                                                       |
| `createSetLinkPowered`    | `peripheral, powered`                                    | redstone on a display link; turning it off sends, as `onNoLongerPowered` does             |
| `createSetLinkTarget`     | `peripheral, target`                                     | a new block in front of the link                                                          |

`craftos_sim_state` has, per peripheral, `peripherals.<name>` (station: name, assembling, trainPresent,
trainImminent, trainEnroute, train; link: its lines, cursor, the target's rows, columns and text; gearshift: running,
timer, duration, output speed; gauges and controller: speed, stress, capacity), and `addons.create` with `gameTime`,
`dayTime`, every train (station, destination, distance left, speed in blocks per second, schedule entry, state,
status) and every network (speed, stress, capacity, overstressed).

## Behaviour and its source

### Kinetics

| Rule                                                                                                   | Source                                                          |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `getSpeed` is the gauge's signed speed as a float, 0 on an overstressed network                        | `SpeedGaugePeripheral` 17, `KineticBlockEntity.getSpeed`        |
| `getStress` / `getStressCapacity` are the network's stress and capacity as floats, overstressed or not | `StressGaugePeripheral` 17-24, `StressGaugeBlockEntity` 141-147 |
| `setTargetSpeed(int)` clamps to plus or minus `maxRotationSpeed` (256); `getTargetSpeed` returns it    | `SpeedControllerPeripheral` 21-28, `ScrollValueBehaviour` 107   |
| a new controller starts at 16 RPM                                                                      | `SpeedControllerBlockEntity` 33, 58                             |
| the controlled side turns at the target while the input turns, 0 when the target is 0                  | `SpeedControllerBlockEntity.getDesiredOutputSpeed`              |
| stress is load per RPM times the speed; capacity of a motor is its capacity per RPM times its speed    | `KineticNetwork` (shape kept, see below)                        |

### Sequenced gearshift

| Rule                                                                                                                                                         | Source                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `rotate(angle, modifier?)` / `move(distance, modifier?)`: the modifier (argument 2) is read first, then the instructions are cleared, then `abs(argument 1)` | `SequencedGearshiftPeripheral` 36-44                                          |
| a modifier other than 2, 1, -1, -2 is 1 (`getByModifier`); `count() > 1` sees a passed `nil`                                                                 | `InstructionSpeedModifiers`                                                   |
| duration: angle `ceil((value - progress) / (speed x 0.3)) + 2` ticks, distance `ceil((value - progress) / (speed / 512)) + 2`, speed = abs(input x modifier) | `Instruction.getDuration` 31-55, `KineticBlockEntity.convertToAngular/Linear` |
| no input speed: the division is infinite, the int overflows to -2147483647 and the gearshift stays running until the input turns                             | same, `SequencedGearshiftBlockEntity.tick` 83-96                              |
| each tick the timer counts up to the duration, then the next instruction (END) makes it idle; `isRunning` is `!isIdle()`                                     | `SequencedGearshiftBlockEntity.tick`, `run` 159                               |
| the input speed changes while running: the rest is worked out again from the progress so far; the input stops: idle                                          | `SequencedGearshiftBlockEntity.onSpeedChanged` 101                            |
| the output turns at input x modifier while running, 0 when idle                                                                                              | `SplitShaftBlockEntity`, `getModifier`                                        |

### Display link

| Rule                                                                                                                                   | Source                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| the cursor lives in the peripheral (0-based inside, 1-based to Lua), `isColor`/`isColour` are false                                    | `DisplayLinkPeripheral` 20-51                                                                                                         |
| `write` pads the list with empty lines down to the cursor, pads the line with spaces, overwrites at the cursor, moves the cursor right | `DisplayLinkPeripheral` 53-76                                                                                                         |
| before the first write the list is a new one: a failed write leaves nothing behind; after, padding stays even if the write fails       | `CompoundTag.getList`                                                                                                                 |
| a cursor left of column 1 or above row 1: `StringIndexOutOfBoundsException` / `IndexOutOfBoundsException` from Java                    | `StringBuilder.replace`, `ListTag.set`                                                                                                |
| `clearLine` empties the cursor's line if the list reaches it; `clear` empties the list                                                 | `DisplayLinkPeripheral` 78-95                                                                                                         |
| `getSize` returns rows, then columns; before the link first sent anything after a restart it throws a NullPointerException             | `DisplayLinkPeripheral` 37-41 (`activeTarget` is not saved)                                                                           |
| sizes: display board `height x 2` rows, `(width x 16 - 2) / 3.5` columns; sign 4 x 15; lectern 50 x 256; nixie tubes 1 x 2 per tube    | `DisplayBoardTarget` 73-77, `FlapDisplayBlockEntity` 198, `SignDisplayTarget` 35, `LecternDisplayTarget` 63, `NixieTubeDisplayTarget` |
| `update` does nothing while redstone powers the link; otherwise the lines go to the target from the link's line on                     | `DisplayLinkBlockEntity.tickSource` 83, `updateGatheredData` 100                                                                      |
| an empty list sends one empty line                                                                                                     | `DisplaySource.transferData` (`EMPTY`)                                                                                                |
| board: only while it turns; every row from the start line down gets a line or is cleared                                               | `DisplayBoardTarget.acceptFlapText`                                                                                                   |
| sign: at most to its 4th line; lectern: needs a book, signs a book and quill, pads earlier pages; nixie: the first line only           | `SignDisplayTarget`, `LecternDisplayTarget`, `SingleLineDisplayTarget`                                                                |
| the computer source never refreshes by itself; a digital adapter source refreshes every 100 ticks                                      | `ComputerDisplaySource.shouldPassiveReset`, `DisplayLinkBlockEntity.tick` 78                                                          |

### Stations and trains

| Rule                                                                                                                                      | Source                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| every error string and which check comes first                                                                                            | `StationPeripheral` 39-175                     |
| present: the station's nearest train is at this station; imminent: present, or navigating and within 30 blocks; en route: a nearest train | `GlobalStation` 96-117                         |
| a train reserves the station it heads for (the nearer train wins) and gives it up when it leaves                                          | `GlobalStation.reserveFor` 79, `trainDeparted` |
| `assemble` needs assembly mode, then carriages; a new train is "Unnamed Train" unless the station remembers a disassembled train's name   | `StationBlockEntity.assemble` 606, 801         |
| entering assembly mode disassembles the present train first (its schedule drops), then needs a track; trains heading there are re-routed  | `StationBlockEntity.enterAssemblyMode` 359     |
| `exitAssemblyMode` fails when not assembling or without a track                                                                           | `StationBlockEntity.exitAssemblyMode` 391      |
| `setStationName` fails only off a track; names are not checked                                                                            | `StationBlockEntity.updateName` 563            |

### Schedules

| Rule                                                                                                                                                                                                                                                                                                                                                         | Source                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `setSchedule`: the table must have exactly 2 keys ("Not a valid schedule"), `entries` must not be an empty table, then the train must be there                                                                                                                                                                                                               | `StationPeripheral` 152-165                                                  |
| Lua to NBT: booleans are bytes; a value under the key `count` is a byte; whole numbers ints, others doubles; a table with key 1 is a list (holes skipped, up to its key count)                                                                                                                                                                               | `StationPeripheral.toNBTTag` 228-269                                         |
| map keys must be strings; snake*case keys become CamelCase (`StringHelper.snakeCaseToCamelCase`: the part after the last `*`keeps its case), except`id`next to a`count`                                                                                                                                                                                      | `StationPeripheral` 251-262, `StringHelper` 7-26                             |
| NBT to Lua: CamelCase keys become snake_case, bytes are booleans except `Count`                                                                                                                                                                                                                                                                              | `StationPeripheral.fromNBTTag` 182-221                                       |
| a schedule is `Entries`, `Cyclic`, and `Progress` when above 0; an entry is an `Instruction` and, for destinations only, `Conditions`                                                                                                                                                                                                                        | `Schedule` 81-98, `ScheduleEntry`                                            |
| an unknown instruction id becomes a destination with the same data; an unknown condition id is a null that breaks `getSchedule`                                                                                                                                                                                                                              | `ScheduleInstruction` 35, `ScheduleWaitCondition` 42                         |
| ids are resource locations: `"destination"` is `minecraft:destination` (so unknown), a capital letter throws                                                                                                                                                                                                                                                 | `ResourceLocation`                                                           |
| item, fluid and redstone-link waits always write their item(s) back (an empty one is air, count 1)                                                                                                                                                                                                                                                           | `ItemThresholdCondition`, `FluidThresholdCondition`, `RedstoneLinkCondition` |
| `setSchedule` keeps auto-schedule only if the train had none or an auto one; the runtime starts at `Progress` clamped to the entries                                                                                                                                                                                                                         | `StationPeripheral` 162-164, `ScheduleRuntime.setSchedule` 227               |
| the runtime: past the last entry it wraps (or stops when not cyclic); a failed navigation waits 40 ticks; a destination is the nearest station whose name matches the filter (`*` is a wildcard, the whole name must match), the current station counting as reached at once; rename and throttle act and move on                                            | `ScheduleRuntime.tick` 99-142, `startCurrentInstruction` 173                 |
| waits: each column is a sequence, any finished column moves on; delay counts `Value x unit` ticks; idle waits for ticks since cargo last changed; time of day matches within 40 ticks of the hour; powered reads the station's redstone; cargo waits look every 20 ticks and only when the cargo changed; a bad threshold reads 0 and is written back as "0" | `ScheduleRuntime.tickConditions` 144, `condition/*`                          |

## Not simulated / not confirmed

- **Kinetic networks are fixtures.** Create works stress out over every block on a network; here a network is one
  record with a speed, a fixed load, a load per RPM and a fixed capacity. Gear ratios, shaft directions (a gauge's
  sign) and a speed controller sharing its input network are not modelled: the controlled side is its own network.
- **Train movement is an approximation.** Trains accelerate at `trainAcceleration`, cruise at `trainTopSpeed` x
  throttle and brake to stop at the station, on one straight track of the fixture distance. There are no signals,
  curves, turning speed, other trains in the way, derailing or fuel use. Arrival times are close, not exact.
- **Station graph:** every station reaches every other one; distances come from the fixture.
- **Not confirmed:** what an empty `ItemStack` writes (taken as air with count 1), and that a redstone link
  frequency stores its item with count 1.
- **Server crashes:** a schedule with no entries, or an unknown condition reached by the runtime, throws inside the
  train's tick in the real game (likely a server crash). The sim stops that train and shows the exception as
  `crashed` in its state.
- `getSize`'s NullPointerException text is Java 17's helpful message; the exact wording was not seen in game.
- `ClassCastException` messages are cut after the class names (the real ones go on about modules and loaders).
- The cursor is per peripheral object; Create makes a new one when the chunk reloads, which the sim never does.
- Display board text is kept as sent; how the flaps render it (character set, width) is not shown.
- Lectern pages are kept as plain text; the real book stores JSON text components.
- Disassembling a train whose blocks are in the way (`canDisassemble: false`) still enters assembly mode, as the
  source reads; this was not tried in game.
- Players opening the station or link screen while a computer is attached (Create locks those screens) is not
  modelled.
