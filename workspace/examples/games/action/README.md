# Action games cabinet

A games cabinet for one monitor wall: five arcade-style games played by touching the monitor, one player at a time, for
the high score. It shows what a real-time touch game looks like in plain CC:Tweaked (no addons), and how to test one:
every game has a test that plays it through the cabinet with real `monitor_touch` events.

| Game       | What it is                                                                                         | Controls                                                                                                                |
| ---------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Snake**  | Eat the red food, grow, don't hit a wall or yourself. Every five foods it speeds up                | Tap the side of the wall you want to go (the wall is split corner to corner). At the computer, the arrow keys steer too |
| **Blocks** | Pieces of four squares fall into a 12 x 18 well; a full row clears. Every 10 rows, a level         | Tap a column in the well to send the piece there, tap left or right of the well to turn it, DROP to drop it             |
| **Bricks** | Keep the ball up with the paddle and knock out the wall of bricks. Three balls                     | Tap anywhere: the paddle slides across to that spot                                                                     |
| **Lander** | Bring the craft down on a pad, slowly and upright, before the fuel runs out. Smaller pads pay more | LEFT and RIGHT tilt a notch, THRUST burns for a second                                                                  |
| **Mines**  | Open every square that isn't a mine; numbers count the mines around. Boards grow                   | Tap a square to dig it; the big button switches between DIG and FLAG                                                    |

The cabinet itself: an idle screen where the games play themselves, a menu, each game's ready screen with its high
score table and HOW TO PLAY, the run with its score, level and a QUIT that needs two taps, the final board, three
letters for a new high score, and AGAIN or DONE. High scores are kept in `scores/` beside the program.

## Run it

The cabinet wants a 6x6 monitor wall (at text scale 0.5 that is about 121 x 81 cells, which it sets itself) and, if you
like, a speaker. All its sounds are vanilla Minecraft ones.

In a desktop window, from the repository root (click the monitor's window to touch it):

```sh
craftos-mcp window workspace/examples/games/action/action.world.json --dir workspace
# then, in the computer: examples/games/action/action
```

In the browser app (`craftos-mcp app --dir workspace`), make a computer with a `top` monitor 6 x 6, and run
`examples/games/action/action` in it. On a real server, copy this folder onto a computer next to a 6x6 advanced
monitor wall and run `action`. It finds the biggest monitor attached; it runs from any folder.

## Test it

```sh
npx vitest run packages/runner/src/games-action.integration.test.ts
# or one game:
craftos-mcp test examples/games/action/snake.test.lua --dir workspace \
  --world workspace/examples/games/action/action.world.json --monitor top:6x6
```

Each `<game>.test.lua` starts the cabinet beside a scenario (`testkit.lua`) and plays at the emulator's real speed:

- **snake**: the menu and HOW TO PLAY, steering by tapping the wall's sides until the snake has eaten three times and
  grown, a U-turn refused, a crash into the wall, the final board ignoring a tap that came too soon, a name typed for
  the high score table and saved, AGAIN, and QUIT.
- **blocks**: a column tap aims the piece and it never leaves the well, the side zones turn it, DROP drops it, and
  stacking pieces through taps clears a line for 100.
- **bricks**: a tap anywhere sets the paddle's goal, following the ball knocks out bricks for points, and letting it
  past costs a ball.
- **lander**: the three buttons, a notch of tilt each way, thrust burning fuel, and a safe landing on a pad for points.
- **mines**: the first dig is safe, FLAG mode flags a mine and a flagged square can't be dug, opening every safe square
  clears the board for a bonus and a 12 x 12 board, and digging a mine ends the run.

Every test also checks the sounds the game played (the speaker is wrapped to record them), and the fast ones that the
clock kept up: hardly a frame had to run more than one step. Snake and Bricks keep up at Cobalt's speed too
(`CRAFTOS_COBALT_SPEED=8`), which is about how fast a real server runs Lua.

## How it's built

```
action.lua          the program: loads the cabinet with the games in games/list.lua
lib/shell.lua       the cabinet: screens, taps, the clock, high scores
lib/display.lua     the monitor wall: palette, one off-screen surface, only changed rows sent
lib/ui.lua          drawing: text in a pixel font, panels, buttons and what a tap hit
lib/base.lua        what games share: layout, steering by the whole wall, sounds for events
lib/sound.lua       named sounds on the speaker
lib/scores.lua      a high score table on disk
lib/surface.lua     Surface 2 by CrazedProgrammer (MIT), the drawing library, and lib/font, its pixel font
games/<game>/       rules.lua (the game itself) and plugin.lua (how it looks and what a tap means)
```

### Writing a game

A game is a folder under `games/` and a line in `games/list.lua`. `rules.lua` is pure: no screen, sound, files or
clock, so it can be tested on its own, and its only source of chance is the `rng` it is given (`rng()` is 0 to 1,
`rng(n)` is 1 to n).

| Rules                  | Contract                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `new({ rng })`         | A fresh state: plain data with `score`, `level`, `over`, and `lives` if the game has them |
| `input(state, action)` | A player's action, taken on the next step                                                 |
| `tick(state, rng)`     | One step of the clock (every `tickMs`). Returns a list of events, for sound               |
| `bot(state, rng)`      | An action for the idle screen's demo, or nil                                              |

`plugin.lua` returns `base.fill({ id, title, blurb, color, accent, tickMs, split, rules, view, help })`, where the view
has `layout(W, H)` (`base.actionLayout` makes one), `draw(L, state)`, `controls(L, state)` for buttons as
`{ label, x, y, w, h, action }`, `actionAt(L, state, px, py)` for taps on the board, and `onEvents(app, state, events)`
for sound (`base.sfx` with a table of event to sound name). A game the whole wall steers sets `split = true` and returns
`base.splitAction(L, px, py)` from `actionAt`.

A monitor only ever sends separate taps, never a held button, so these games are built from taps that set something
that stays set: a direction, a column, a spot to slide to.
