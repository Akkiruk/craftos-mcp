# CC: LiftLink emulation

Addon id `cc-liftlink` (needs `create`). Lua in `rom-overlay/rom/ccsim/addons/cc-liftlink/init.lua`; it runs on the
`create` addon's virtual clock and kinetic networks.

Source of truth: `github.com/tiktop101/CC-LiftLink` at `18ab47b` (2 Oct 2026), `ElevatorMethods.java` and
`ElevatorHelpers.java`, checked with `javap` against both released jars: `ccliftlink-1.0.3.jar` (Forge 1.20.1) and
`ccliftlink-1.0.4-neoforge.jar` (NeoForge 1.21.1, whose code is not in the repository). Both have the same method
bodies and strings. Create's side comes from `Creators-of-Create/Create` tags `mc1.20.1-6.0.8` and `mc1.21.1-6.0.10`
(the elevator code is the same in both; 1.0.4-neoforge needs Create 6.0.10).

| Minecraft | LiftLink       | How CC sees it                                                        |
| --------- | -------------- | --------------------------------------------------------------------- |
| 1.18.2    | none           | the addon cannot be switched on                                       |
| 1.20.1    | 1.0.3          | a generic peripheral (`ElevatorMethods`) on Create's elevator contact |
| 1.21.1    | 1.0.4-neoforge | its own `IPeripheral` (`ElevatorContactPeripheral`), same methods     |

The README in the repository lists methods that do not exist (`getFloors`, `getCurrentLevel`, `hasFloor`,
`isAtFloor`, ...). Only the 11 below are in the code and the jars.

## The peripheral

Type `create_elevator`, no other types. All 11 methods are `@LuaFunction(mainThread = true)`: each call waits for
the next server tick, argument errors too.

| Method              | Returns                                                                                                                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getRole()`         | `"contact"`                                                                                                                                                                                        |
| `listFloors()`      | every contact on the column, lowest first: `y, shortName, longName, name, currentFloorName?, isTarget, isCurrent`                                                                                  |
| `getState()`        | `modName, role, active, targetAvailable, targetY?, currentTargetY?, speed, offset?, cabY?, moving, floorCount, blockX, blockY, blockZ, hasPulley, trackingMode, currentFloorName?, currentFloorY?` |
| `getCabY()`         | the cab's contact height (live from the pulley), else the reported floor's y, else nil                                                                                                             |
| `getSpeed()`        | the pulley's movement speed in blocks per tick (signed: negative while the cab rises), 0 without a pulley                                                                                          |
| `getOffset()`       | the pulley's rope length (a float), nil without a pulley                                                                                                                                           |
| `getTargetY()`      | the cab's reachable target, else the column's target, else nil                                                                                                                                     |
| `isMoving()`        | `abs(speed) > 1e-4` with a pulley; without one, target and reported floor differ                                                                                                                   |
| `callToY(y)`        | true; a contact at that height is called, else any reachable height (needs the assembled cab)                                                                                                      |
| `callToFloor(name)` | true; the first contact (lowest) whose short or long name matches, trimmed and ignoring case                                                                                                       |
| `getNearestFloor()` | `y, shortName, longName, name, distance` of the contact nearest the cab, else the reported floor, else nil                                                                                         |

`peripheral.getMethods` order: CC 1.121 fills a default `HashMap` in `Class.getMethods` order of the class it reads
(`ElevatorMethods` on 1.20.1, `ElevatorContactPeripheral` on 1.21.1). That order was measured on HotSpot 21 with the
jars' own classes, so the two versions list the methods differently.

Errors (exact text): `No floor named '<name>'` (the name as given, untrimmed); `Y=<y> is not a real floor and is
outside the elevator travel range`; `bad argument #1 (string expected, got number)` (CC 1.121 does not coerce
numbers to strings); `bad argument #1 (number expected, got nil|nan|inf|-inf)`. `callToY` takes CC 1.121's `getInt`,
which is `(int) getLong`: 5.9 is 5, 2^32 + 5 wraps to 5. A contact whose short and long names are both blank makes
`listFloors` / `getNearestFloor` throw `Java Exception Thrown: java.lang.NullPointerException: defaultObj`
(`Objects.requireNonNullElse`); Create renames blank contacts on their first tick, so that needs a later rename.

## Fixtures

The world must be on `"version": "1.20.1"` or `"1.21.1"`.

```jsonc
"liftlink": {
  "minBuildHeight": -64,            // for the pulley's extension range (default -64)
  "columns": {
    "shaft": {
      "x": 120, "z": -40,           // the column (getState blockX / blockZ)
      "facing": "north",
      "target": 70,                 // the column's target at boot (default: the assembled cab's floor, else none)
      "contacts": [                 // contacts without a computer
        { "y": 70, "shortName": "1", "longName": "Shops", "currentFloor": "1", "calling": false, "powered": false }
      ],
      "pulley": {
        "y": 80,                    // the elevator pulley block (default: highest contact + 3)
        "contactYOffset": 0,        // the cab's contact relative to the cab's top block (ElevatorContraption)
        "rpm": 64,                  // its input speed, or "network": "<world.create.networks id>"
        "cabY": 64,                 // where the cab's contact stands (default: target, else lowest contact)
        "assembled": true,          // the cab is a moving contraption (default true)
        "offset": -1,               // rope length while disassembled (default -1, what disassembly leaves)
        "distance": 1               // horizontal blocks from the contact column (see resolvePulley below)
      }
    }
  }
},
"peripherals": [
  { "name": "create_elevator_0", "type": "create_elevator", "column": "shaft", "y": 64,
    "shortName": "G", "longName": "Lobby", "currentFloor": "G" }
]
```

A peripheral without `column` is a column of its own. `currentFloor` is the contact's `lastReportedCurrentFloor`.
Contacts with a blank short name get Create's generated names at boot (`ElevatorColumn.initNames`, which can also
renumber numeric names that are out of order, as the Java does). An assembled cab at boot has reported its floor
to every contact that has no `currentFloor`.

## Sim commands

| Command                 | Fields                             | Does                                                                                                                         |
| ----------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `liftlinkAssemble`      | `column`                           | the pulley assembles the cab where it stands (needs input speed; the column turns active, targets that floor and reports it) |
| `liftlinkDisassemble`   | `column`                           | the cab becomes blocks at its nearest whole height; offset -1; the column turns inactive                                     |
| `liftlinkSetSpeed`      | `column, rpm`                      | the pulley's input speed (a `network` pulley follows `createSetSpeed` instead)                                               |
| `liftlinkPower`         | `column, y, powered?`              | redstone into a contact: on the rising edge, a contact that is not already calling calls the cab                             |
| `liftlinkRename`        | `column, y, shortName?, longName?` | a player edits a contact's names                                                                                             |
| `liftlinkAddContact`    | `column, y, shortName?, longName?` | a contact is placed; blank names are generated                                                                               |
| `liftlinkRemoveContact` | `column, y`                        | a contact without a computer is broken                                                                                       |

`craftos_sim_state` has `addons.cc-liftlink.columns.<id>` (contacts with names, reports, calling and powered;
target; active; the pulley's offset, cab y, speed, arrived, rpm, travel range) and `peripherals.<name>`.

## Behaviour and its source

| Rule                                                                                                                                                                                                                | Source                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| contacts sorted by height; one per height                                                                                                                                                                           | `ElevatorColumn.add`                                                                                                 |
| calling a contact: it is the only one calling, the column targets its y                                                                                                                                             | `ElevatorContactBlock.callToContactAndUpdate`                                                                        |
| redstone calls only on the rising edge, and not when that contact already calls                                                                                                                                     | `ElevatorContactBlock.neighborChanged`                                                                               |
| the cab moves only to a target within `[maxContactY - maxRopeLength, pulleyY + contactYOffset - 1]`                                                                                                                 | `ElevatorPulleyBlockEntity.assemble`, `ElevatorContraption.isTargetUnreachable`                                      |
| speed each tick: diff to the target offset, clamped to `convertToLinear(rpm x 2)` (at most 1.99), then to the last speed plus or minus `lerp(limit, 0.0075, 0.0175)`, then to `sqrt(2 x diff x acc)`; all in floats | `ElevatorPulleyBlockEntity.getMovementSpeed`                                                                         |
| every `getMovementSpeed` call keeps its result as the last speed, so LiftLink's `getSpeed`, `isMoving` and `getState` take part in the acceleration, as in the game                                                 | same, `ElevatorMethods`                                                                                              |
| the offset moves by that speed each tick, clamped to the pulley's extension range                                                                                                                                   | `LinearActuatorBlockEntity.tick`, `PulleyBlockEntity.getExtensionRange`                                              |
| the cab's contact height is `pulleyY + contactYOffset - 1 - offset`                                                                                                                                                 | `ElevatorHelpers.getCurrentCabY`                                                                                     |
| passing a contact makes every contact report that contact's short name; assembly reports the floor it starts on                                                                                                     | `ContactMovementBehaviour.visitNewPosition`, `ElevatorContraption.broadcastFloorData`, `ElevatorColumn.floorReached` |
| the current floor is the first contact whose own name matches its report                                                                                                                                            | `ElevatorHelpers.findCurrentFloorContact`                                                                            |
| nearest floor: the smallest distance, the lower contact on a tie                                                                                                                                                    | `ElevatorHelpers.findBestContactForCabY`                                                                             |

## Not emulated

- **Finding the pulley** (`ElevatorHelpers.resolvePulley`): the game searches for the cab's contraption entity in a
  box around the column and for an elevator pulley block within 3 blocks. Here a pulley belongs to its column and is
  found when assembled and `distance` is at most 4, or at any time when `distance` is at most 3. Mirrored pulleys
  (several pulleys on one cab) and a pulley belonging to another column are not modelled.
- **Floor reports while moving** follow the rope offset; in the game they follow the contraption entity, which
  near its target is nudged a quarter of the way each tick, and the first movement after assembly reports nothing.
- **Redstone output**: the contact the cab arrives at pulses (`triggerContact`, `POWERING`); not observable from
  LiftLink, so not modelled. Doors (`DoorControlBehaviour`) and the cab's floor buttons are not modelled.
- **Assembly**: the cab's blocks, `no_contacts` / `too_many_contacts` errors and the rope scan are not modelled;
  `liftlinkAssemble` uses the cab position from the fixture.
- `No elevator column found for this contact` cannot happen here: a contact is always on its own column.
- The `getMethods` order depends on the JVM's `Class.getMethods` order (measured on HotSpot 21, not in game).
- Display links reading the contact (`DisplayLinkBlock.notifyGatherers`) are not wired to the create addon.
- Nothing here was measured in a real game: the mod is not in the pack.
