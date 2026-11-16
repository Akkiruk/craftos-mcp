# Versus cabinet: two computers, one match

Two-player games played head to head across **two computers**, each with its own monitor wall, linked by wireless
modems over rednet. Each player stands at their own wall and sees the match from their own side. It is the example of
a multi-computer program in this emulator: the tests start both computers on one network and check that both walls show
the same match.

| Game          | What it is                                                                                              | Controls                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Paddle**    | Two paddles, one ball, first to eleven. Your paddle is on the left of your own wall                     | Tap anywhere at the height you want the paddle                                                                                                    |
| **Trails**    | Two riders, each leaving a solid wall behind. Crash and the other takes the round; first to five rounds | Tap the side of the wall you want to go (split corner to corner); arrow keys at the computer                                                      |
| **Artillery** | Two tanks taking turns to shell each other over ground that craters and falls; first to three rounds    | On your turn tap the sky to aim (further is harder), ANGLE and POWER - +, drive with the arrows, pick a weapon, FIRE. Crates bring better weapons |

With no other cabinet in range a wall plays the computer (Artillery has three levels). Each cabinet keeps its record
against every cabinet it has played in `records/`; games against the computer aren't counted.

## Run it

Each computer needs a 6x6 monitor wall (text scale 0.5, about 121 x 81 cells, set by the program), a wireless modem,
and, if you like, a speaker. Run `versus` on both. On one wall pick a game and tap **PLAY** with the other cabinet's
name; the other wall shows **TAP TO JOIN**. A computer's label is its name on the walls.

In the browser app, which can make a network of computers:

```sh
craftos-mcp app --dir workspace
```

Make a new computer with **2** computers (a network: each gets a wireless modem), a `top` monitor 6 x 6 and the program
`examples/games/versus/versus`. A desktop window
(`craftos-mcp window workspace/examples/games/versus/versus.world.json --dir workspace`, then
`examples/games/versus/versus`) is one computer, so there it plays the computer.

## Test it

```sh
npx vitest run packages/runner/src/games-versus.integration.test.ts
```

[`games-versus.integration.test.ts`](../../../../packages/runner/src/games-versus.integration.test.ts) starts two
computers ten blocks apart with wireless modems and 6x6 monitors. **North** runs the game's ccunit test as player 1;
**South** runs [`peer.lua`](peer.lua): the same cabinet with a stand-in player 2 that joins when asked, plays its side
by tapping its own wall the way the computer player would, and reports what its wall shows over rednet a few times a
second, so the test can check both screens.

- **paddle**: North finds South and asks for a game, South joins, a tap moves North's paddle and South's wall shows it,
  both paddles hit the ball, a miss scores for South on both walls, QUIT twice gives South the match on both walls, and
  North records the loss against South.
- **trails**: a tap turns North's rider up into the edge, the crash ends the round on both walls with South taking it,
  the next round counts in on both, and South steers from its own wall while both walls show the same trail.
- **artillery**: turns alternate across the computers: a tap in the sky aims North's barrel, + adds power, FIRE sends
  the shot, then it's South's turn on both walls with the same damage, and South fires from its own computer.
- **computer** (one computer alone): only the computer is offered, its paddle plays and scores, the match isn't
  counted, REMATCH and DONE.

Every network test also checks that the two computers never had to resynchronise.

## Two computers, one match

The cabinet that asks for a game is the **host** and player 1; the one that joins is the **guest**, player 2. Both run
the same rules from the same seed (`lib/rng.lua` gives the same numbers on any computer), so instead of sending the
whole game each step, the host sends only what changed it:

```
guest tap ──input──▶ host          the guest never changes its own game directly
                     host step n:  apply this step's taps (its own and the guest's), tick the rules
host ──frame n {taps, score}──▶ guest
                     guest step n: apply the same taps, tick the same rules, check the score agrees
```

A frame is a few bytes, ten times a second. The guest's taps land one step (100 ms) after the host's, which nobody
notices. If a guest ever misses a frame or its score disagrees, it asks for the host's whole state and carries on from
there (`sync` / `state`). The messages are in `lib/shell.lua` under "messages from the other cabinet":
`hello` (every two seconds, so each cabinet knows the other is there), `invite`, `join`, `cancel`, `start` (seed and
names), `input`, `frame`, `end` (someone gave up), `rematch`, `done`, `sync` and `state`. A match whose other cabinet
goes quiet for six seconds is called off with no result.

## How it's built

```
versus.lua          the program: loads the cabinet with the games in games/list.lua
lib/shell.lua       the cabinet: screens, taps, matches, the network protocol, wins and losses
lib/link.lua        finding the other cabinet and talking to it over rednet
lib/rng.lua         a seeded random number source both computers share
lib/display.lua     the monitor wall; lib/ui.lua drawing; lib/base.lua shared game helpers; lib/sound.lua sounds
lib/surface.lua     Surface 2 by CrazedProgrammer (MIT), the drawing library, and lib/font, its pixel font
games/<game>/       rules.lua (the game) and plugin.lua (how it looks from each side and what a tap means)
```

A two-player game's rules are like the action cabinet's (see its README), with a player on each call:
`new({ rng })`, `input(state, player, action)`, `tick(state, rng)` and `bot(state, rng, player, level)`, and a state
with `over`, `winner` (1, 2, or 0 for a draw) and `score = { p1, p2 }`. The view's `draw(L, state, player)` and
`actionAt(L, state, px, py, player)` get the player whose wall it is, so Paddle and Artillery mirror the field and
Trails swaps the colours. The rules must take chance only from `rng` and nothing from the clock, or the two computers
would drift apart.
