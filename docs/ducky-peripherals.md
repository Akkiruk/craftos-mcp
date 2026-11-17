# Ducky Peripherals emulation

Ducky Peripherals (SamsTheNerd) is **not in the pack**. Nothing here was measured in game: every rule is read from
the source, `github.com/SamsTheNerd/ducky-periphs`. The repository has no tags, so the releases were matched to
commits:

| Minecraft | Release                                 | Commit                                      | Source root                                          |
| --------- | --------------------------------------- | ------------------------------------------- | ---------------------------------------------------- |
| 1.20.1    | 1.20.1-1.3.1 (Fabric and Forge)         | `f4fc865` "version bump", 17 Aug 2023       | `common/src/main/java/com/samsthenerd/duckyperiphs/` |
| 1.18.2    | 1.0.2 (Fabric only, for CC: Restitched) | `1699d8c` "pushing v1.0.2.jar", 20 Jan 2023 | `src/main/java/net/fabricmc/duckyperiphs/`           |
| 1.21.1    | none                                    |                                             |                                                      |

`gradle.properties` at those commits says `mod_version = 1.20.1-1.3.1` and `mod_version = 1.0.2`. There was no
Forge 1.18.2 build; the emulator's 1.18.2 is CC:Tweaked 1.101.3 on Forge, so a 1.18.2 world gets 1.0.2's behaviour
on CC:Tweaked. The jars were not checked with `javap`.

The addon id is `ducky-peripherals`. The Lua is `rom-overlay/rom/ccsim/addons/ducky-peripherals/init.lua`. Tests:
`packages/runner/src/ducky-peripherals.integration.test.ts` and the example
`workspace/examples/ducky-peripherals/porch.lua` (`porch.world.json`, `porch.test.lua`, Minecraft 1.20.1).

Paths below are relative to the source root, under `peripherals/`.

## Peripherals

| Type              | Block           | Methods | Events                                                       |
| ----------------- | --------------- | ------- | ------------------------------------------------------------ |
| `entity_detector` | Entity Detector | 1       | `new_entity`, `removed_entity`                               |
| `weather_machine` | Weather Machine | 7       | none                                                         |
| `keyboard`        | Keyboard        | 0       | `key`, `key_up`, `char`, `terminate` (and shutdown / reboot) |
| `sculkophone`     | Sculkophone     | 0       | `vibration` (1.20.1 only)                                    |

The type names are each `getType()`. None of the methods takes an argument, so there are no argument errors (extra
arguments are ignored, as for any `@LuaFunction`). None is `mainThread`: all run at once on the computer thread.
`peripheral.getMethods` lists them sorted.

### entity_detector (`EntityDetector/EntityDetectorPeripheral.java`, `EntityDetectorTile.java`)

`nearbyEntities()` returns a list of tables `{ uuid, name, isPlayer, type, x, y, z }`, one per **living** entity
whose bounding box intersects `new Box(pos).expand(8, 16, 8)` (`makeBox`, `DEFAULT_RANGE = 8`,
`DEFAULT_Y_RANGE = 16`): relative to the block, x and z from -8 to 9, y from -16 to 17. The test is strict, as in
`Box.intersects`: touching the edge is outside. `x`, `y`, `z` are the entity's position minus the block's
(`entity.getX() - edPos.getX()`), so feet position, not rounded. `type` is the entity type's display name
(`getType().getName().getString()`: "Zombie", "Player"), `name` the entity's name (a player's name, a custom name or
the type name). The list is in the fixture's order (the real one is the world's entity lookup order).

Every tick the tile compares the living entities in range with the last tick's (`checkEntityChange`). It first
queues `new_entity` for each one that was not there, then `removed_entity` for each one that is gone, each walk in
`HashMap<UUID, Entity>.keySet()` order. The emulator works that order out: `UUID.hashCode`, `HashMap.hash`, the
bucket in a table of 16 doubled while more than 0.75 full, insertion order within a bucket. The first tick only
fills the cache, so entities already there at boot raise no event. A `removed_entity` table is built from the cached
`Entity` object: where the entity is now (outside the box) or was last (when it is gone).

- 1.20.1: `os.pullEvent("new_entity")` gives `"new_entity", <peripheral name>, <table>`.
- 1.18.2 (1.0.2): `"new_entity", <table>`, without the name (`computer.queueEvent("new_entity", entityMap)`).

### weather_machine (`WeatherMachine/WeatherMachinePeripheral.java`)

| Method              | Returns                                                          |
| ------------------- | ---------------------------------------------------------------- |
| `isRaining()`       | the world is raining and the biome's precipitation is rain       |
| `isThundering()`    | `World.isThundering()`                                           |
| `getBiome()`        | the biome key, cut out of its `toString()`: `"minecraft:plains"` |
| `canSnow()`         | the biome's precipitation is snow                                |
| `isSnowing()`       | raining and the precipitation is snow                            |
| `getTemperature()`  | `Biome.getTemperature()`, a float (0.8 reads 0.800000011920929)  |
| `isPrecipitating()` | raining and the precipitation is not none                        |

1.20.1 asks `getPrecipitation(pos)`, 1.18.2 the biome-wide `getPrecipitation().asString()`; the emulator has one
value per block either way. Thunder is the thunder level scaled by the rain level, so without rain there is none.

### keyboard (`keyboards/KeyboardPeripheral.java`, `KeyboardTile.java`, `KeyboardUtils.java`)

A block with no methods. A player who opens its screen types into every computer it is attached to:

| What the player does  | 1.20.1-1.3.1 event                | 1.0.2 event                             |
| --------------------- | --------------------------------- | --------------------------------------- |
| a key goes down       | `key`, code, repeat, name         | `key`, code, repeat                     |
| a key comes up        | `key_up`, code, name              | `key`, code, `false` (a bug in `keyUp`) |
| a character is typed  | `char`, character, name           | `char`, character                       |
| holds Ctrl+T          | `terminate`, name                 | `terminate`                             |
| holds Ctrl+S / Ctrl+R | the computer shuts down / reboots | the same                                |

Codes are the GLFW codes the screen sees, the same as `keys`. 1.20.1-1.3.1 never sends `paste` (`sendPaste` has no
caller at that commit; it came back later). Shutdown and reboot call `ServerComputer.shutdown()` / `reboot()` and
then queue an event the stopped computer never gets; the emulator just shuts down or reboots.

### sculkophone (`sculkophone/SculkophonePeripheral.java`, `SculkophoneBlockEntity.java`, `SculkophoneBlock.java`)

1.20.1 only: it came in 1.1.0 (Minecraft 1.19.2). On 1.18.2 the block is refused at boot ("ccsim: the sculkophone is
not in Ducky Peripherals 1.0.2") and is not attached.

A vanilla vibration listener with range 8 (`getRange`). When one reaches it while it is inactive it queues
`vibration`, name, the game event's id (`GameEvent.getId()`, `"step"`, no namespace), the distance (a float widened
to double), and turns active (`setActive`: 20 ticks), then cooldown (1 tick), then inactive again. While active or
cooling down it hears nothing. Something stepping on it makes it active too, with no event.

## Fixture fields

```json
{
  "version": "1.20.1",
  "addons": ["ducky-peripherals"],
  "duckyPeripherals": { "raining": true, "thundering": false },
  "peripherals": [
    {
      "name": "entity_detector_0",
      "type": "entity_detector",
      "entities": [
        {
          "name": "Steve",
          "player": true,
          "uuid": "8667ba71-b85a-4004-af54-457a9734eed7",
          "x": 3.5,
          "y": 0,
          "z": -2
        },
        { "type": "Cow", "x": -4, "y": 0, "z": 1, "width": 0.9, "height": 1.4 }
      ]
    },
    {
      "name": "weather_machine_0",
      "type": "weather_machine",
      "biome": "minecraft:taiga",
      "temperature": 0.25
    },
    { "name": "keyboard_0", "type": "keyboard" },
    { "name": "sculkophone_0", "type": "sculkophone" }
  ]
}
```

- `duckyPeripherals.raining`, `.thundering`: the world's weather (default clear).
- `entity_detector.entities[]`: `x`, `y`, `z` (required, relative to the detector block, feet), `name` (default the
  type), `type` (the display name; default `"Player"` for players, else `"Pig"`), `player` (default false), `uuid`
  (default a made-up one), `living` (default true; false is never seen: items, arrows, boats), `width`, `height`
  (bounding box, default 0.6 and 1.8, a player's).
- `weather_machine.biome` (default `"minecraft:plains"`), `.temperature` (default 0.8), `.precipitation` (`"rain"`,
  `"snow"` or `"none"`; default snow below 0.15, else rain).

Sim state: `peripherals.<name>` has the detector's entities, the weather machine's biome, and the sculkophone's
phase; `addons.ducky-peripherals.weather` the weather.

## Sim commands

| Command              | Fields                                                                                 | Does                                                                  |
| -------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `duckyAddEntity`     | `peripheral?`, `entity` (as in the fixture)                                            | an entity appears; events on the next tick                            |
| `duckyMoveEntity`    | `peripheral?`, `entity` (uuid or name), `x?`, `y?`, `z?`                               | it is somewhere else from the next tick                               |
| `duckyRemoveEntity`  | `peripheral?`, `entity` (uuid or name)                                                 | it dies or despawns                                                   |
| `duckySetWeather`    | `raining?`, `thundering?`                                                              | the world's weather, at once                                          |
| `duckySetBiome`      | `peripheral?`, `biome?`, `temperature?`, `precipitation?` (false: back to the default) | the biome at a weather machine                                        |
| `duckyKey`           | `peripheral?`, `key` (code or `keys` name), `repeat?`                                  | a key goes down in the keyboard screen                                |
| `duckyKeyUp`         | `peripheral?`, `key`                                                                   | a key comes up                                                        |
| `duckyChar`          | `peripheral?`, `char`                                                                  | one character typed                                                   |
| `duckyType`          | `peripheral?`, `text`                                                                  | a `char` per character                                                |
| `duckyKeyboardEvent` | `peripheral?`, `event`: terminate, shutdown, reboot                                    | Ctrl+T / Ctrl+S / Ctrl+R held                                         |
| `duckyVibration`     | `peripheral?`, `event` (`"step"`), `distance`                                          | a vibration reaches the sculkophone on the next tick (ignored past 8) |
| `duckyStepOn`        | `peripheral?`                                                                          | something walks on the sculkophone: active, no event                  |

`peripheral` can be left out when the world has one block of that kind.

## Not emulated

- **The Hex Casting blocks**: the focal port, the focal link (Hexal), and the akashic record, akashic bookshelf,
  impetus and slate peripherals (`hexcasting/...`). They read and write Hex Casting iotas (patterns, entities,
  vectors, Hexal's links and mote items) through Hex Casting's own serialisation (`IotaLuaUtils`) and only exist
  with Hex Casting (and Hexal) installed. Faking iotas without that mod would be made-up behaviour.
- The rubber duck, the conjured ducky and the strong modem: not peripherals (the strong modem's code is commented
  out at both commits).
- Entities moving on their own: each one is where the fixture or the last command put it.
- Vibration travel time, the vanilla vibration selector (the closest of several in one tick wins) and which game
  events a sculk listener can hear: the command says what reached it and how far away.
- The weather's fade: vanilla's rain and thunder levels ramp up over about a second; here a weather change is seen
  at once. Height-dependent snow (`Biome.isCold` above y = 80) is up to the fixture's `precipitation`.
- The keyboard screen itself (its Ctrl shortcut timing, key caps, which keys it forwards): the commands are what it
  sends.
- The entity detector's list order (the world's entity lookup order) follows the fixture.
