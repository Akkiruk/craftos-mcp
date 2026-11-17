# CC: VS emulation

Addon id `cc-vs`, world key `ccvs`. CC: VS (TechTastic) connects CC:Tweaked to Valkyrien Skies ships. It adds global
APIs, not peripherals, so the addon has no peripheral types: it loads at boot when the world has `ccvs`. Lua in
`rom-overlay/rom/ccsim/addons/cc-vs/`.

| Minecraft | CC: VS | Source                                                                                                       |
| --------- | ------ | ------------------------------------------------------------------------------------------------------------ |
| 1.18.2    | 0.5.1  | `github.com/TechTastic/CC-VS` branch `1.18.x/archived` at `7a65541` (later commits touch only the changelog) |
| 1.20.1    | 0.6.6  | branch `1.20.x/main` at `e0fd0de`                                                                            |
| 1.21.1    | none   | the mod has no 1.21.1 release: a 1.21.1 world cannot switch the addon on                                     |

Both checked against the Modrinth jars (`cc_vs-1.18.2-forge-0.5.1.jar`, `cc_vs-1.20.1-forge-0.6.6.jar`) with `javap`:
every method name and signature, the config defaults and the `verifyAdmin` branch. Valkyrien Skies constants come
from `valkyrienskies-120-2.4.9.jar` and its core api `1.1.0+f6a942e0e1`. Kotlin paths below are relative to
`common/src/main/kotlin/io/github/techtastic/cc_vs/`. Nothing here was measured in a game: the mod is not in the pack.

## The APIs

The jars put Lua files in the ROM (`data/computercraft/lua/rom/apis/`): the mod's wrappers `ship.lua`, `aero.lua`,
`drag.lua`, and CC: Advanced Math's `matrix.lua` and `quaternion.lua`. They are copied unchanged into
`rom-1.18.2/apis/` and `rom-1.20.1/apis/` (licences in `LICENSE-NOTICE.txt`) and loaded the way bios.lua's
`os.loadAPI` loads `rom/apis/*.lua`: in `fs.list` order, chunk name `@/rom/apis/<name>.lua`, each in its own
environment, the global replaced by the copied table. So `ship.getVelocity()` returns a `vector`, `getQuaternion` a
`quaternion`, `getTransformationMatrix` a `matrix`, as in game, and the wrappers' own checks and bugs come with them.

**1.18.2 (0.5.1).** `ship` exists only on a computer or turtle that is on a ship when it is created (a mixin on
`TileComputer`/`TileTurtle.createComputer`, `CCVSUtils.applyShipAPIsToComputer`). Native methods (27):
`getId getMass getMomentOfInertiaTensorToSave getMomentOfInertiaTensor getSlug getOmega getQuaternion getScale
getShipyardPosition getSize getVelocity getWorldspacePosition transformPositionToWorld isStatic setSlug
getTransformationMatrix getConstraints pullPhysicsTicks applyInvariantForce applyInvariantTorque
applyInvariantForceToPos applyRotDependentForce applyRotDependentTorque applyRotDependentForceToPos setStatic setScale
teleport`. `ship.lua` adds stubs that raise for the removed `getEulerAngles*`, `getRoll/Yaw/Pitch`, `getRotationMatrix`.

**1.20.1 (0.6.6).** `ComputerCraftAPI.registerAPIFactory` gives every computer, turtle and pocket computer `ship`,
`aerodynamics` (also `aero`) and `drag`; off a ship the ship-bound methods throw `This computer is not on a Ship!`.

- `ship` (28): `getId getMass getMomentOfInertiaTensor getSlug getAngularVelocity getQuaternion getScale
getShipyardPosition getSize getVelocity getWorldspacePosition transformPositionToWorld isStatic setSlug
getTransformationMatrix getJoints pullPhysicsTicks applyWorldForce applyWorldTorque applyModelForce
applyModelTorque applyWorldForceToModelPos applyBodyForce applyBodyTorque applyWorldForceToBodyPos setStatic setScale
teleport`, plus `ship.lua`'s stubs for the 0.5 names (`applyInvariant*`, `applyRotDependent*`, `getOmega`, ...).
- `aerodynamics` (10): `getDefaultMax getDefaultSeaLevel getDragCoefficient getGravitationalAcceleration
getUniversalGasConstant getAirMolarMass getAtmosphericParameters getAirDensity getAirPressure getAirTemperature`.
  `aero` is `aero.lua`'s copy of it.
- `drag` (11): `getDragForce getLiftForce enableDrag disableDrag enableLift disableLift enableRotDrag disableRotDrag
setWindDirection setWindSpeed applyWindImpulse`.

Every method runs on the computer thread (no `mainThread`): it answers at once.

## Fixtures

```jsonc
"version": "1.20.1",              // or 1.18.2
"position": { "x": 2, "y": 1, "z": 3 }, // the computer's block: shipyard coordinates when it is on a ship
"ccvs": {
  "family": "command",            // normal (default), advanced or command; a turtle world is a turtle
  "config": {                     // cc_vs-common.toml and Valkyrien Skies' server config
    "canTeleport": false, "commandOnly": true, "exposePhysTick": false, // CCVSConfig defaults
    "physicsTicksPerGameTick": 3, "dragCoefficient": 2.18                 // VSCoreConfig defaults (VS 2.4.9)
  },
  "ship": {                       // leave out: the computer is not on a ship
    "id": 42, "slug": "skylark",  // no slug: getSlug says "no-name"
    "mass": 2500,                 // default 1000
    "inertia": [[900,0,0],[0,1200,0],[0,0,700]], "inertiaToSave": [[...]], // 3x3 rows (ToSave: 1.18.2)
    "position": { "x": 100.5, "y": 100, "z": -40.5 },  // centre of mass in the world
    "shipyardPosition": { "x": 2, "y": 1, "z": 3 },    // centre of mass in the shipyard
    "rotation": { "x": 0, "y": 0.38268, "z": 0, "w": 0.92388 }, "scale": 1, // or {x,y,z}
    "velocity": { "x": 0, "y": -1.5, "z": 0 }, "omega": { "x": 0, "y": 0, "z": 0 },
    "aabb": { "minX": 0, "minY": 0, "minZ": 0, "maxX": 5, "maxY": 4, "maxZ": 11 }, // shipAABB, ints
    "static": false, "dimension": "minecraft:overworld",
    "constraints": [ ... ],       // 1.18.2 getConstraints: the maps VSConstraint.toLua makes, as given
    "joints": [ ... ],            // 1.20.1 getJoints: the maps VSJointAndId.toLua makes, as given
    "buoyantFactor": 1, "doFluidDrag": true,            // what physics-tick snapshots report
    "drag": { "dragForce": {"x":0,"y":120,"z":0}, "liftForce": {...} } // false: no drag controller
  },
  "aero": {                       // 1.20.1
    "atmospheres": { "minecraft:overworld": { "maxY": 962, "seaLevel": 62, "gravity": 10 } },
    "air": { "density": 1.1, "pressure": 95000, "temperature": 285 } // see Not emulated
  }
}
```

`transformPositionToWorld` and `getTransformationMatrix` use Valkyrien Skies' ship transform,
`translate(position) * rotate(rotation) * scale(scale) * translate(-shipyardPosition)` (`BodyTransformImpl`), with
JOML's quaternion-to-matrix formula; `getTransformationMatrix` returns its four rows.

## Sim commands

| Command         | Fields                                                                                                                      | Does                                                                       |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `ccvsSetShip`   | `ship` (a fixture ship, or null)                                                                                            | the computer is now on that ship, or on none                               |
| `ccvsSet`       | any of `position shipyardPosition rotation velocity omega scale mass inertia static slug dimension joints constraints drag` | changes the ship (a ship moving, turning, being frozen by someone else)    |
| `ccvsCollision` | `phase` (start, persist, end), `shipIdA?`, `shipIdB?`, `dimensionId?`, `contactPoints?`                                     | 1.20.1: a collision; `collisions_started/persisted/ended` at the next tick |

On 1.18.2 the `ship` API is there only if the computer was on a ship at boot; `ccvsSetShip` later moves the ship it
reads, but never adds or removes the API (in game it is added once, when the computer is created).

`craftos_sim_state` has `addons["cc-vs"]`: `version`, `installed` (the ship API exists), `family`, `ship` (id, slug,
mass, position, shipyardPosition, rotation, scale, velocity, omega, static, dimension, drag), `forces` (every force,
torque, `setStatic`, `setScale` and `teleport` call: `method`, `call` as Valkyrien Skies received it, the vectors,
`applied` once a tick has passed), `windImpulses`, `physicsTicks` (snapshots sent).

## Behaviour and its source

| Rule                                                                                                                                                                                                 | Source                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| argument checks: CC's `getDouble` / `getBoolean` / `getString` / `getTable` for every declared parameter first, then the body                                                                        | CC's generated methods                                                    |
| 1.18.2 `verifyAdmin` throws `This method requires a Command Computer!` when `command_only` is on **and the computer is a command computer** (the check is inverted in 0.5.1; a turtle never fails)   | `apis/ShipAPI.kt` (1.18.x) `verifyAdmin`, confirmed in the jar's bytecode |
| 1.20.1 `verifyAdmin` throws the same unless the computer is a command computer (`ComputerComponents.ADMIN_COMPUTER`)                                                                                 | `util/CCVSUtils.kt` `verifyAdmin`                                         |
| 1.18.2: the six force methods check admin; `setStatic`, `setScale`, `teleport` do not. 1.20.1: every force, `setStatic`, `setScale`, `teleport` and the drag setters check admin                     | `apis/ShipAPI.kt`, `apis/DragAPI.kt`                                      |
| order: arguments, admin, then the ship (`This computer is not on a Ship!`); 1.20.1 optional positions are read after admin                                                                           | same                                                                      |
| `applyWorldForce` / `applyModelForce`: arguments 4-6 make the position only if all three are there; `applyBodyForce` defaults it to (0, 0, 0)                                                        | `ShipAPI.kt` 221-283 (1.20.x)                                             |
| `applyWorldForceToBodyPos` calls Valkyrien Skies' `applyWorldForceToModelPos`                                                                                                                        | `ShipAPI.kt` 294-297                                                      |
| `setStatic`, `setScale`, `teleport` take effect at the next tick (queued for the physics thread / ship world)                                                                                        | `ship/QueuedForcesApplier.kt`, `getOrCreateGTPA`, `teleportShip`          |
| `teleport`: `Teleporting is Disabled via CC: VS Config!` first (after admin on 1.20.1); `Malformed <key> key of <section>`; a value of the wrong type is a `ClassCastException`; `rot` is normalised | `ShipAPI.kt` `teleport`, `getVectorFromTable`, `getQuaternionFromTable`   |
| `transformPositionToWorld(table)` with one argument reads `x`, `y`, `z` (missing ones are 0); otherwise three numbers                                                                                | `ShipAPI.kt`, `CCVSUtils.toVector`                                        |
| `getSlug` is `no-name` when the ship has none; `getSize` is the shipyard AABB's size (all 0 without one)                                                                                             | `ShipAPI.kt`                                                              |
| `pullPhysicsTicks` fails with `Physics Tick is not exposed! This is a configuration option!` unless `expose_phys_tick`; it needs no ship and returns nothing                                         | `ShipAPI.kt`                                                              |
| `physics_ticks` every tick while exposed: 1.18.2 only on a ship, with the snapshots as **one** array argument; 1.20.1 on every computer, each snapshot its own argument (none off a ship)            | `ShipAPI.update` (1.18.x without, 1.20.x with the spread operator)        |
| a snapshot (`LuaPhysShip`): `getBuoyantFactor isStatic doFluidDrag getInertia getPoseVel getForcesInducers`; 1.20.1 `getInertia().momentOfInertia`, `pos` the shipyard centre, no force inducers     | `apis/LuaPhysShip.kt`                                                     |
| `aerodynamics` constants: max 962, sea level 62, gravity 10, gas constant 8.314, air molar mass 0.0289644; drag coefficient from the server config, 2.18                                             | `AerodynamicUtils` (core api), `VSCoreConfig$Server$DragSettings`         |
| the air methods take an optional Y (default the computer's centre in world space)                                                                                                                    | `AerodynamicsAPI.kt`                                                      |
| `drag.applyWindImpulse` reads arguments 1, 2, 3 and **5**, and caps the speed at 0 (`coerceAtMost(0.0)`): through `drag.lua`, which passes four, it always fails with `bad argument #5`              | `apis/DragAPI.kt`                                                         |
| `getDragForce` / `getLiftForce` return nil without a drag controller (`drag: false`)                                                                                                                 | `DragAPI.kt`                                                              |
| collision events: only for this computer's ship and dimension; all of a tick's collisions of one phase in one event                                                                                  | `ShipAPI.startup` / `update` (1.20.x)                                     |

Bugs of the mod's Lua that come with it unchanged: 1.18.2 `ship.getConstraints()` returns the transformation matrix's
rows (the wrapper calls `getTransformationMatrix`); 1.18.2 `ship.pullPhysicsTicks()` errors with "attempt to call"
(it treats the one array argument as a snapshot); on 1.18.2 (CC:Tweaked 1.101.3, whose vectors have no `__name`) the
force wrappers refuse vectors, so only numbers work.

## Not emulated

- **Physics.** Forces and torques are recorded (`forces` in the sim state), never integrated: the ship moves only by
  `ccvsSet`, `teleport` or `ccvsSetShip`. Drag and lift forces are the fixture's numbers and do not follow the wind,
  the ship's speed or `enable/disable*`.
- **The atmosphere model.** `getAirDensity`, `getAirPressure` and `getAirTemperature` are computed inside Valkyrien
  Skies' closed core; the formula is not in any jar's Java. They return `ccvs.aero.air.<density|pressure|temperature>`
  (a number, or a map from Y to number) and raise a `ccsim:` error naming the field when it is missing.
  `getAtmosphericParameters` for a dimension not in `atmospheres` returns the default constants (not confirmed).
- **1.18.2 off a ship.** In game bios.lua loads `rom/apis/ship.lua`, which raises `Cannot load Ship API on computer`,
  and 1.101.3's `os.loadAPI` rethrows it: the bios stops (what CC:Tweaked then shows was not seen). The sim boots
  normally, without `ship` but with `matrix` and `quaternion`.
- **The mod's other ROM files**: `rom/modules/main/ccvs/` (pidcontrollers, utilities), `rom/modules/main/advanced_math/`
  (mmath, pid, stats), `rom/programs/simple_altitude_pid.lua` and the help pages. The module carries only the
  `apis/` files and loads them itself; its `types.lua` has no `rom`, so nothing else of the mod is in `/rom` and
  `require("ccvs.pidcontrollers")` and `help ship` fail here.
- The `commands` API of a command computer: `family: "command"` only changes CC: VS's admin check.
- How many physics ticks a game tick's event carries depends on when Valkyrien Skies clears its queue relative to the
  computer's update; the sim sends `physicsTicksPerGameTick` (3) snapshots, all with the ship's current values.
- Joints and constraints are the fixture's; Valkyrien Skies' joint system is not modelled.
- The ship transform's last bit: JOML uses fused multiply-adds, the sim plain arithmetic.
- `ClassCastException` messages are written as Java 17 prints them for `java.base` classes; the class a Lua table
  becomes (`java.util.HashMap`) was not seen in game.
