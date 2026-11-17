# Metaphysics

Addon id `metaphysics`. Metaphysics by fashaodesu (mod id `cryptography`), release 0.0.6, Forge for Minecraft 1.20.1
only: the addon exists on 1.20.1 and nowhere else.

Written from the released jar, `cryptography-0.0.6.jar` from [Modrinth](https://modrinth.com/mod/metaphysics),
decompiled with Vineflower 1.10.1. The source repository,
[KallenKas024/Metaphysics](https://github.com/KallenKas024/Metaphysics), does not match that release (its newest tag
is 0.0.5fix4 and its classes are laid out differently), so the jar is the reference. Classes, in
`com.example.cryptography`: `mixin/TileComputerMixin`, `CryptographyAPI`, `CoordinateAPI`, `Database`, `ModEvents`,
`mixin/TurtleMoveCommandMixin`, `Cryptography`. The crypto results were checked against the JDK 21 the mod runs on
(`MessageDigest`, `SecureRandom` "SHA1PRNG" of the SUN provider, `KeyGenerator` AES, `Cipher` AES_256/GCM/NoPadding).
The mod is not in the pack, so nothing here was measured in game. The module is
`rom-overlay/rom/ccsim/addons/metaphysics/`.

## How it works

The mod has no blocks or peripherals. A mixin on `ServerComputer`'s constructor adds three Lua APIs to every computer
(`ILuaAPI`), each under two global names: `crypto` / `cryptography`, `coord` / `coordinate`, and `db` / `database`.
The sim has no block to load the module by, so a world switches it on with a `metaphysics` key (`{}` is enough): the
module then loads at boot and sets the globals before the program runs (in a pack with the mod, every computer has
them). The functions run on the computer thread, as the mod's do (none is `mainThread`).

`CoordinateAPI` calls Valkyrien Skies 2 (`VSGameUtilsKt`) in nearly every function without declaring the dependency,
so it only works with VS2 installed. The sim is a VS2 world whose ships come from the fixture (none by default).

## What is emulated

`crypto`: 5 of its 9 functions. `coord`: all 23. `player_death` events.

| Function                                                                                                                       | Behaviour (from the jar)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crypto.SHA256HASH(s)`, `crypto.SHA512HASH(s)`                                                                                 | Despite the names, SHA3-256 and SHA3-512 (`MessageDigest` "SHA3-256"/"SHA3-512") of the string's UTF-8 bytes, as upper-case hex. A Lua string reaches Java one char per byte, so a byte above 127 is hashed as two UTF-8 bytes. `SHA512HASH` catches its own argument error and hashes nothing; `SHA256HASH` raises `bad argument #1 (string expected, got nil)`.                                                                                                                                                                                                                         |
| `crypto.AESGCMEncrypt(text, key)`                                                                                              | AES-256-GCM, 128-bit tag, a random 12-byte IV; the answer is hex of IV + ciphertext + tag. The key is `SHA1PRNG` seeded with the key string's UTF-8 bytes, then 32 bytes drawn by `KeyGenerator` (`generateKey`): the same key string gives the same AES key as in Java, so a message sealed by a real computer opens here and the other way round. The key (argument 2) is read before the text.                                                                                                                                                                                         |
| `crypto.AESGCMDecrypt(hex, key)`                                                                                               | The other way. The hex is upper-cased and read two chars a byte (an odd last char is dropped, a char that is not hex counts as -1, as `hexStringToBytes` does). A wrong key or a damaged message fails the tag check, which the mod catches: the answer is `""`. Fewer than 12 bytes is `Java Exception Thrown: java.lang.NegativeArraySizeException: -N`; an empty string a `NullPointerException`. The plaintext is decoded as UTF-8 and handed back one byte a char (`?` for anything above 255).                                                                                      |
| `crypto.Salt()`                                                                                                                | 128 random bytes as hex.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `coord.getCoord()`                                                                                                             | The computer's position as doubles; on a ship, its world position (`toWorldCoordinates`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `coord.getAbsoluteCoordinates()`                                                                                               | The block position as ints (shipyard coordinates on a ship).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `coord.getBlock(x, y, z)`                                                                                                      | The block's description id less `block.`, dots turned to colons (`minecraft:stone`; a path with dots or slashes gets colons).                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `coord.isBlockAir`, `getBlockIsSolid`, `getBlockIsReplaceable`, `isBlockLoaded`, `getBlockExplosionResistance` (all `x, y, z`) | `isAir`; `isSolid`; `canBeReplaced`; `Level.isLoaded` (false outside the build height or in an unloaded chunk); `floor(getExplosionResistance())`.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `coord.canSeeSky(x, y, z)`                                                                                                     | Doubles, rounded up (`ceil`) to a block, then `Level.canSeeSky`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `coord.getSelfDimensionType()`                                                                                                 | The path of the dimension id (`overworld`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `coord.getEntities(scope)`, `getEntitiesAll(scope)`                                                                            | Every entity of the level (mobs, item entities, players) in the box, keyed by uuid: `x`, `y`, `z`, `uuid`, `name` (display name), `isPlayer`, `playerInfo` (`isCreative`, `isSpectator`, or empty), `type` (`minecraft:zombie`), `direction` (from its yaw), `vector` (motion), `yaw`, `pitch`, `raw_euler_x/y/z` (the look vector, in floats with `Mth`'s sine table), `isLivingEntity`, and `maxHealth`, `health`, `armor` for living ones. `getEntities` keeps only those that can see the sky (rounded up, as above); `getEntitiesAll` all of them. A scope of -1 is the whole level. |
| `coord.getPlayers(scope)`, `getPlayersAll(scope)`                                                                              | Living players of the dimension in the box: `x`, `y`, `z`, `name`, `uuid`, `eyeHeight`, `health`, `maxHealth`, `armor`, `viewVector`, `pose` (`STANDING`), `isPassenger`. In the overworld `getPlayers` keeps those under the open sky; `getPlayersAll` does not filter.                                                                                                                                                                                                                                                                                                                  |
| `coord.getMonster(scope)`, `getMobs(scope)`                                                                                    | Living monsters (`Monster`, `FlyingMob` or the ender dragon) / every `Mob`, in the box, in the overworld only under the open sky: `uuid`, `name` (the mob category, `monster`), `displayName`, `x`, `y`, `z`, `health`, `maxHealth`, `armor`.                                                                                                                                                                                                                                                                                                                                             |
| `coord.getShips(scope)`, `getShipsAll(scope)`                                                                                  | VS2 ships whose box centre is in the box (`getShips`: and under the open sky), keyed by id: `id`, `slug`, `dimension`, the centre `x`, `y`, `z`, `min_x`...`max_z`. A scope above 2500 gives `{}`.                                                                                                                                                                                                                                                                                                                                                                                        |
| `coord.isOnShipEntity()`, `getSlug()`, `setSlug(name)`                                                                         | Whether the computer's block is on a ship; its slug or `NoSlug`; renames the ship (nothing off a ship).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `coord.getMapColor(x, z, x2, z2)`                                                                                              | For each column from x to x2 and z to z2: key `{ x, k, z }` (a table), value the map colour of the block at k, where k is the `WORLD_SURFACE` height: the first free block above the surface. That block is air, so every value is 0: that is the mod's own bug.                                                                                                                                                                                                                                                                                                                          |
| `coord.scanTopography(x, z, x2, z2)`                                                                                           | Returns nothing and queues `ComputerScanTopographyDone` with a list of `{ x, height, z }` (`MOTION_BLOCKING`, the top block's y). It walks from the low corner in steps of 16 and lists each chunk's columns below the high corner (the high side is left out, and columns past the last step are never reached). For a negative coordinate the corner it labels the columns with is a chunk too far, because Java's `%` keeps the sign. A box over 256 blocks wide queues the event with an empty list first, then scans anyway and queues it again.                                     |
| `player_death` event                                                                                                           | `{ name, source = "DamageSource (<type>)", killer?, tags }` (the killer's entity tags) to every computer, when a player dies.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Argument errors are CC's: `bad argument #N (number expected, got nil)`, `(number has no integer representation)`
for an int argument, `(string expected, got nil)`.

## The world

```json
{
  "version": "1.20.1",
  "addons": ["metaphysics"],
  "position": { "x": 0, "y": 70, "z": 0, "dimension": "minecraft:overworld" },
  "metaphysics": {
    "players": [
      {
        "name": "Alex",
        "uuid": "...",
        "x": 2.5,
        "y": 64,
        "z": 2.5,
        "health": 18,
        "armor": 7
      }
    ],
    "ships": [
      {
        "id": 7,
        "slug": "skyskipper",
        "min": { "x": 4, "y": 80, "z": 4 },
        "max": { "x": 12, "y": 86, "z": 10 }
      }
    ],
    "computerShip": 7,
    "explosionResistance": { "minecraft:stone": 6 },
    "unloadedChunks": ["5,-3"],
    "hasSkyLight": true
  },
  "ground": {
    "y": 63,
    "name": "minecraft:stone",
    "top": "minecraft:grass_block"
  },
  "fills": [
    { "from": [9, 70, -1], "to": [11, 70, 1], "name": "minecraft:stone" }
  ],
  "blocks": [{ "x": 1, "y": 64, "z": 0, "name": "minecraft:grass" }],
  "entities": [
    { "type": "minecraft:zombie", "x": 5.5, "y": 64, "z": 3.5, "health": 20 }
  ],
  "items": [
    { "x": -1.5, "y": 64, "z": 1.5, "name": "minecraft:diamond", "count": 1 }
  ]
}
```

- **The computer** stands at `position` (its dimension too).
- **The block world** is the one turtles use (docs/turtle.md): the top-level `blocks`, `fills`, `ground`, `items` and
  `entities`; with a turtle or a placed computer it is that same world. A block can carry `explosionResistance` and
  `solid`.
- **Entities**: `type`, `x`, `y`, `z`, and optionally `uuid`, `displayName`, `health` (20), `maxHealth` (20), `armor`,
  `xRot`, `yRot`, `yHeadRot` (the look direction of a living one; `yRot` when left out), `motion` `{x, y, z}`,
  `category` (a vanilla mob's own by default), `monster` and `mob` (override the class checks), `living` (false: not a
  living entity).
- **Players** (`metaphysics.players`): `name`, `uuid`, `x`, `y`, `z`, `dimension`, `health`, `maxHealth`, `armor`,
  `xRot`, `yRot`, `eyeHeight` (1.62), `pose`, `isPassenger`, `isCreative`, `isSpectator`.
- **Ships** (`metaphysics.ships`): `id`, `slug`, `min` and `max` (the world box), `dimension` (VS2's
  `minecraft:dimension:<id>` by default), and for the one the computer is on (`computerShip`: its id)
  `computerWorldPosition`, what `getCoord` reports there.
- **`explosionResistance`**: block id to resistance. The game data has none, so a block without one (other than air)
  raises a `ccsim:` error naming the block.
- **`unloadedChunks`** ("chunkX,chunkZ") are not loaded; everything else is. **`hasSkyLight`**: whether the
  dimension has sky light (the overworld has, the nether and the end have not).

## Sim commands

| Command                                                               | Does                                                                              |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `metaPlayerDeath {name, source?, killer?, killerTags?}`               | a player dies: `player_death` (`source` is the damage type, `generic` by default) |
| `metaSetPlayer {player, remove?}`                                     | adds, replaces (by name) or removes a player                                      |
| `metaSetBlock {x, y, z, name?, state?, explosionResistance?, solid?}` | puts a block in the world (no name: air)                                          |
| `metaAddEntity {entity}` / `metaRemoveEntity {uuid?, type?}`          | adds or removes an entity                                                         |
| `metaSetShips {ships, computerShip?, leaveShip?}`                     | replaces the ships; puts the computer on one, or off                              |

## Not emulated

- **`db` / `database`** (`establish`, `CustomLinker`, `prepareStatement`, `createStatement`, `executeUpdate`,
  `execute`, `executeQuery`, `close`): SQLite files in the world folder and any JDBC server. The emulator has no
  SQLite, so the API is left out (`db` is nil) rather than faked.
- **`crypto.GenECDHKeypair`, `GetECDHFinalKey`, `MakeECDSASign`, `CheckECDSASign`** (secp256r1 with X.509 / PKCS#8
  keys): elliptic-curve arithmetic is not written here; the functions are left out.
- **Sky visibility** is worked out from the blocks, not from light: below any block a position cannot see the sky
  (glass and leaves included), above every block it can. **Solid** is "has a collision shape" and **replaceable** the
  block's `minecraft:replaceable` tag or the turtle rules' list, not the game's per-state code.
- **The turtle-move mixin**: in game, after every move command (forward, back, up or down, done or not) the position
  the API reports becomes the block in front of the turtle. The sim keeps the boot position.
- **`coordPCA`** (`CoordinatePocketComputerAPI`) is in the jar but nothing registers it, so no computer has it, here
  or in game.
- **Ship transforms**: a ship's position comes from the fixture; the sim does not move ships or turn shipyard
  coordinates into world ones.
- **The `ban-series` command** is a server command, not a computer API.
