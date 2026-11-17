# Advanced Math 0.3.7 emulation

Addon id `advanced-math`. The datapack's files, unchanged, in `rom-overlay/rom/ccsim/addons/advanced-math/rom/`.

Source of truth: [github.com/TechTastic/Advanced-Math](https://github.com/TechTastic/Advanced-Math) at commit
`f656609` (tag `0.3.7`), `datapack/data/computercraft/lua/rom/`. MIT licence (`LICENSE` next to the files).

## Versions

Advanced Math is a datapack, not a mod: release 0.3.7 is listed for every Minecraft version from 1.13 to 1.21.4, so
it is 0.3.7 on 1.18.2, 1.20.1 and 1.21.1 alike.

## What it adds

No peripherals. The datapack overrides files in CC:Tweaked's ROM:

| Path                                             | What                                                    |
| ------------------------------------------------ | ------------------------------------------------------- |
| `rom/apis/quaternion.lua`                        | the `quaternion` API (bios loads it at boot)            |
| `rom/apis/matrix.lua`                            | the `matrix` API                                        |
| `rom/modules/main/advanced_math/pid.lua`         | `require "advanced_math.pid"`: PID controllers          |
| `rom/modules/main/advanced_math/mmath.lua`       | `require "advanced_math.mmath"`: linear algebra solvers |
| `rom/modules/main/advanced_math/stats.lua`       | `require "advanced_math.stats"`: statistics             |
| `rom/help/quaternion.txt`, `rom/help/matrix.txt` | `help quaternion`, `help matrix`                        |

With the addon on these files are in the ROM from boot (`rom-overlay/rom/ccsim/romfiles.lua`): `fs.list`, `fs.find`,
`fs.open`, `fs.complete`, `require`, `help` and the shell all see them, and `quaternion` and `matrix` are loaded as
bios loads every file in `rom/apis`. With it off they do not exist.

Being the datapack's own code, they behave exactly as in game, quirks included. One worth knowing: the quaternion and
PID constructors check a vector by its metatable's `__name`, which CC:Tweaked 1.101.3 (Minecraft 1.18.2) vectors do
not have, so `quaternion.fromAxisAngle(vector.new(0, 1, 0), a)` fails there with "expected vector, got table". On
1.20.1 and 1.21.1 (CC:Tweaked 1.121.0) it works.

## Fixtures and sim commands

None.

## Not emulated

Nothing is left out. `quaternion.fromShip` only raises its "no longer required" error, in game too; the Ship API it
was for belongs to CC: VS, which is not an addon here.
