# BLIGHTMARE

A dark first-person RPG for one ComputerCraft monitor wall: a continent, a plague, and a hero who has never dreamed.
Eleven acts of story, towns and dungeons walked a square at a time, an overworld map, people to talk to with answers to
choose, quests, turn-based fights with spells and items, bosses with phases, and an animated opening. The game saves as
you go. Plain CC:Tweaked: monitors and, if you like, a speaker. An Advanced Peripherals player detector is optional.

![BLIGHTMARE: the opening, a town, a fight and a boss, played by touch](../../../../docs/media/showcase/blightmare.gif)

The whole showcase is in [`docs/media/showcase/blightmare.mp4`](../../../../docs/media/showcase/blightmare.mp4).

## What to build

| Block                                   | Where                           | Needed?                                                                           |
| --------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------- |
| Advanced computer                       | anywhere                        | yes                                                                               |
| **6 x 6 advanced monitors** (36 blocks) | touching the computer, or wired | yes: the game sets text scale 0.5, which makes the wall 121 x 81 cells            |
| Speaker                                 | touching the computer, or wired | no: music and sounds (all vanilla Minecraft sounds) if it's there                 |
| Player detector (Advanced Peripherals)  | touching the computer, or wired | no: the hero takes the name of the player at the wall, and each player has a save |

- The wall has to be **advanced** monitors (colour and touch) and at least 120 x 78 cells at text scale 0.5. 6 wide by
  6 high is the size the game is drawn for. A smaller wall says how big it needs to be and waits until it's built.
- With more than one monitor attached, the game takes the biggest.
- **No detector:** the game asks the hero's name on its own keyboard the first time, and the computer keeps one saved
  game. **With a detector:** whoever stands closest (within 8 blocks) is the player. Their name is the hero's, each player
  gets a save of their own, and a player who walks away mid-game has the game saved and the wall freed after 20 seconds.

## Installing it

The game is about 2 MB of Lua, and a computer holds 1,000,000 bytes by default, so it goes onto the computer packed.
`build.mjs` makes the packed copy. It takes out comments and indents and squeezes the modules with DEFLATE into one file.
`pack.lua` unpacks them on the computer. Every string in the game is kept byte for byte, and every line keeps its line
number, so an error on the computer points at the same line as the source.

```sh
node workspace/examples/games/blightmare/build.mjs
# 44 modules: 2044.9 kB of source, 1785.2 kB without comments, 522.5 kB packed
# install/: 5 files, 537821 bytes (538321 as CC:Tweaked counts them) of 1000000
```

That leaves about 460 kB free for saves. A save is a few kilobytes, and a computer keeps two copies of each.

Copy everything in `install/` onto the computer: into `saves/<world>/computercraft/computer/<id>/` on a single-player
world or a server, or onto a floppy disk and from there with `cp`. Then run `blightmare`.

| File             | What it is                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `blightmare.lua` | the program                                                                                                   |
| `blightmare.pak` | every module of the game, packed                                                                              |
| `pack.lua`       | opens the pack for `require`                                                                                  |
| `lib/font`       | the pixel font                                                                                                |
| `startup.lua`    | starts the game when the computer boots, and again after a crash. Leave it out if the computer has other work |

Starting takes a few seconds while the modules are unpacked (around 8 on a busy server), with a bar on the wall. Hold **Ctrl+T** to stop:
the game in play is saved first. Saves go in `saves/` beside the program, and a log in `blightmare.log`.

A copy of this source folder runs as it is (`blightmare.lua` loads the plain files when there is no `blightmare.pak`),
on a computer whose disk is big enough: in the emulator, or on a server with a bigger `computer_space_limit`.

## Playing

The idle screen is the opening, playing on its own, silent. A touch carries it on from the same moment with music, a tap
turns the page, and SKIP goes past it. Then CONTINUE or NEW GAME (two taps, because it loses the save), or START, and
HOW TO PLAY. PLAYERS lists everyone's saved game on the computer and how far each has got.

| Where you are       | What a tap does                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| on foot             | the top of the wall steps forward, the bottom steps back, the sides turn                                                                                |
| the middle          | ACT: talk, open doors and chests, fight what's ahead; with nothing ahead it walks forward                                                               |
| the bar at the foot | the menu: items, gear, how everyone is doing                                                                                                            |
| on the map          | tap anywhere and the party finds its own way there, round mountains and water; tap a town or a dungeon to go in                                         |
| in a conversation   | anywhere goes on; a question waits for a tap on an answer                                                                                               |
| in a fight          | the gauges fill and a full one gives that character a turn. Top is ATTACK, left the character's special, right ITEM, bottom DEFEND, then tap the target |
| SAVE & QUIT         | two taps: saves and frees the wall                                                                                                                      |

DEFEND halves every hit until your next turn. When a foe flashes `!!!` it's winding up something big: DEFEND before it
lands. If the whole party falls, you wake at the last safe place with your pack as it was before the fight, less a small
toll. Lost? The purple mark on the map is where the story goes next, and the bar says what to do there.

## Run it in the emulator

From the repository root:

```sh
craftos-mcp window workspace/examples/games/blightmare/blightmare.world.json --dir workspace
# then, in the computer: examples/games/blightmare/blightmare
```

Click the monitor to touch it. `detector.world.json` is the same with a player detector and two players beside it, Alex
and Steve, and the `sim` program moves them (`sim setPlayerPos player=Alex x=40 y=64 z=0`). In the browser app (`craftos-mcp app --dir
workspace`), make a computer with a `top` monitor 6 x 6.

## Tests

```sh
npx vitest run packages/runner/src/games-blightmare.integration.test.ts   # everything, each file on its own computer
craftos-mcp test examples/games/blightmare/play.test.lua --dir workspace \
  --world workspace/examples/games/blightmare/blightmare.world.json --monitor top:6x6 --timescale 4
```

| Test                                           | What it checks                                                                                                                                                                         |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `play.test.lua`                                | the whole cabinet by `monitor_touch`: the opening, SKIP, START, the name typed on the game's keyboard, the first scenes, the Dream Book, the first fight won, SAVE & QUIT and CONTINUE |
| `detector.test.lua`                            | with a player detector: the hero named after the closest player, a save each, a player walking away, PLAYERS                                                                           |
| `install.test.lua`                             | `install/` alone on a 1,000,000-byte disk: it fits, every packed module loads, and it plays by touch to a save                                                                         |
| `tests/engine.test.lua`                        | the script runner, walking, the map, the wipe rule, the menu and saves                                                                                                                 |
| `tests/battle.test.lua`                        | fights: gauges, spells, statuses, phases, wind-ups, the battle screen                                                                                                                  |
| `tests/world.test.lua`, `tests/tap.test.lua`   | the overworld and finding a way there by tapping                                                                                                                                       |
| `tests/art.test.lua`, `tests/content.test.lua` | the pictures and the first act's content                                                                                                                                               |
| `tests/region_<act>.test.lua`                  | each act's data, and a model of the engine that finishes it on every path                                                                                                              |
| `tests/playthrough_<act>.test.lua`             | the game's bot plays each act through with real fights                                                                                                                                 |
| `tests/bosses.test.lua`                        | every boss against a party of the level a player reaches it at                                                                                                                         |
| `tests/full.test.lua`                          | one whole game, from a new save to the ending (a few minutes)                                                                                                                          |

## How it is put together

| Path                            | What it holds                                                                                                        |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `blightmare.lua`                | the program: finds its modules and starts the shell                                                                  |
| `lib/shell.lua`                 | the cabinet around the game: the idle opening, the ready screen, saves, SAVE & QUIT, the clock (a step every 120 ms) |
| `lib/display.lua`, `lib/ui.lua` | the monitor wall, its palette, one off-screen surface sent a changed row at a time; drawing and the touch map        |
| `lib/sound.lua`                 | every sound and piece of music by name, each a vanilla Minecraft sound                                               |
| `lib/saves.lua`                 | a saved game for each player, written beside the file and swapped in                                                 |
| `lib/detector.lua`              | the optional player detector, asked in a coroutine of its own                                                        |
| `lib/base.lua`, `lib/rng.lua`   | steering by the whole wall, sounds for events; a seeded random number source, so a save carries on the same          |
| `lib/surface.lua`               | Surface 2 by CrazedProgrammer (MIT, its licence inside); `lib/font` is its pixel font                                |
| `games/blightmare/rules.lua`    | the game itself, pure: no screen, sound or files, so it tests on its own                                             |
| `games/blightmare/regions/`     | the acts, each plain data: maps, people, scripts, foes, goals                                                        |
| `games/blightmare/*.lua`        | the story, the party and its spells, foes, battles, the overworld, the first-person view, the art, the opening       |
| `build.mjs`, `pack.lua`         | the packed copy for a computer's disk                                                                                |
