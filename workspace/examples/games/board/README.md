# Board game cabinet

Eight board games on one ComputerCraft monitor wall, for two people at the wall or one person against the computer.
Plain CC:Tweaked: monitors, a speaker if you have one, nothing else.

| Game                 | What it is                                                                               | Computer player                                  |
| -------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Ultimate Tic-Tac-Toe | Nine small boards in one; the square you pick sends your opponent to the matching board  | negamax search with its own evaluation           |
| Four in a Row        | Drop discs into seven columns; four in a line wins                                       | alpha-beta search (`games/search.lua`)           |
| Reversi              | Trap a line of the other colour to flip it; most discs wins                              | alpha-beta search with corner weights            |
| Checkers             | English draughts: forced jumps, multi-jumps, kings, and a draw after 40 quiet moves each | alpha-beta search                                |
| Dots and Boxes       | Draw lines, close a box to score and go again                                            | knows chains, and the double-cross on hard       |
| Mancala              | Kalah rules: sow seeds anticlockwise, extra turns from your store, captures              | alpha-beta search                                |
| Fleet                | Hide five ships, then take turns firing at each other's water (needs two walls)          | hard counts every way the ships afloat could lie |
| Codebreaker          | Each hides a four-colour code, then both race to crack the other's (needs two walls)     | hard only guesses codes that fit every answer    |

Every game has three computer levels (easy, medium, hard), a hint button on your turn (except the two hidden-piece
games), a two-tap resign, a pause box, animations and sounds, and a results screen with a rematch and a replay of the
game just played.

## Building it

- An advanced computer with a **6x6 wall of advanced monitors** next to it (the cabinet uses text scale 0.5, which is
  121x81 cells). Any monitor works, but the layouts are made for 6x6 and a game that does not fit is greyed out.
- Fleet and Codebreaker hide each player's pieces, so they need a **second 6x6 wall** on the other side of the
  computer, back to back with the first. Each player taps PLAYER in the lobby from their own wall; only the wall of
  the player whose turn it is takes moves, and each wall draws only its own player's ships or code. The other six
  games show the same picture on both walls and take touches from either.
- A **speaker** anywhere on the computer, if you want sound. Every sound is a vanilla Minecraft sound
  (`cabinet/audio.lua` lists them all in one table).

Copy the folder onto the computer and run `arcade` from it (or `shell.run("arcade")` from a startup file). Ctrl+T
stops it.

## Playing

The idle screen plays a game against itself on each wall. Touch it for the menu, pick a game, and the lobby asks who
is playing: each colour is PLAYER or one of the computer's levels. SWAP COLORS, who moves first, HOW TO PLAY and START
are under it. During a game:

| Control   | What it does                                                                                       |
| --------- | -------------------------------------------------------------------------------------------------- |
| the board | tap a square, column, pit or line; checkers is tap a piece, then where it goes                     |
| MENU      | pauses, with RESUME and END THIS GAME (no result)                                                  |
| HINT      | the computer's hard level suggests a move for you (marked in green)                                |
| RESIGN    | tap twice; on one wall it counts against the side to move, on two walls against that wall's player |
| SOUND     | turns the speaker on and off                                                                       |

A move the rules refuse says why at the foot of the wall ("That column is full", "You must jump", ...). After the
final board, a touch shows the results: REMATCH (colours swap and the loser moves first), PICK ANOTHER GAME, WATCH THE
REPLAY and DONE. Two minutes with no touch outside a game goes back to the idle screen; ten minutes with no move ends a
game with no result.

## Run it in the emulator

From the repository root:

```sh
craftos-mcp window workspace/examples/games/board/arcade.world.json --dir workspace --monitor left:6x6 --monitor right:6x6
# then, in the computer: examples/games/board/arcade
```

`craftos-mcp app` works the same way. Click the monitors to touch them. With an agent, pass the world file as `world`
and the two monitors (`left` and `right`, 6x6 blocks) to `craftos_session_create`.

## Tests

Each game has a `<game>.test.lua` that checks its rules on their own (move counts against the published tables for
Four in a Row, Reversi and Checkers, forced jumps and kings, passes, captures, the hidden-information views) and then
starts the real cabinet and plays through it with `monitor_touch` events, exactly what a player's touch sends: a
refused move, a whole short game, the results screen, and the computer answering. `fourinarow.test.lua` also covers
the cabinet's controls (rematch, resign, hint, pause, replay), and `fleet.test.lua` and `codebreaker.test.lua` play on
both walls. `testkit.lua` is the small harness they share.

```sh
craftos-mcp test examples/games/board/fleet.test.lua --dir workspace \
  --world workspace/examples/games/board/arcade.world.json --monitor left:6x6 --monitor right:6x6 --timescale 4

npx vitest run packages/runner/src/games-board.integration.test.ts   # all eight at once
```

## How it is put together

| Path                      | What it holds                                                                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `arcade.lua`              | starts the cabinet with the list of games                                                                                                       |
| `cabinet/main.lua`        | the event loop, the walls, touches and every screen's buttons                                                                                   |
| `cabinet/match.lua`       | a match from first move to result, the computer player's turn, replays                                                                          |
| `cabinet/play.lua`        | the match screen around the board: player cards, score, status line, controls                                                                   |
| `cabinet/screens.lua`     | idle, menu, lobby, how to play, results                                                                                                         |
| `cabinet/ui.lua`          | drawing helpers and the touch map (every button registers where it is)                                                                          |
| `cabinet/base.lua`        | board layouts, discs, animation, the idle demo, defaults for a game                                                                             |
| `cabinet/audio.lua`       | named sounds on the speaker                                                                                                                     |
| `cabinet/surface.lua`     | Surface 2 by CrazedProgrammer (MIT, its own licence inside), which draws off screen and blits a row at a time; `cabinet/font` is its pixel font |
| `games/<game>/rules.lua`  | the rules, pure: no screen, sound or files, so they test on their own                                                                           |
| `games/<game>/plugin.lua` | the board drawn on the wall, what a touch means, sounds, help text, and the computer player                                                     |
| `games/search.lua`        | an alpha-beta search any game with no hidden pieces can use for its computer player                                                             |

Everything is drawn into an off-screen surface and sent to the monitor only where a row changed, so a still screen
costs nothing and an animation stays smooth on a real server.

### Adding a game

A game is a folder under `games/` and one line in `games/registry.lua`. Its `plugin.lua` returns `base.fill(M)` with:

- `id`, `title` (and `short` for the menu if the title is long), `blurb`, `color`, `accent`, `minSize`, `help`;
- `rules`: `new({ first })`, `step(state, action, rng)` returning `state, events` or `nil, reason`,
  `checkAction(state, action)`, `legalActions(state)`. The state has `turn` (1 or 2) and `winner` (0 playing, 1, 2,
  or 3 for a draw), and `step` handles `{ kind = "forfeit", seat = n }`. Chance only ever comes from `rng`, so a
  replay of the seed and the actions gives back the same game;
- `view.layout(W, H)` (`base.grid` makes one for a board of square cells), `view.drawBoard(L, match, viewer)`,
  `view.actionAt(L, match, px, py, viewer)`, and optionally `view.onEvents` for sound and animation, `view.score`,
  `view.prompt`, `view.finalLine`, `view.howLine`, `view.drawSides`;
- `cpuLevels` and `chooseAction(state, level, opts)` for a computer player (`games/search.lua` does it for any game
  with no hidden pieces);
- for hidden pieces, `private = true`, `walls = 2`, and `rules.viewFor(state, seat)`, which is all a computer player
  or another wall is ever given.
