# CC:C Bridge emulation

Addon id `cccbridge` (needs `create`). Lua in `rom-overlay/rom/ccsim/addons/cccbridge/init.lua`; it uses the
`create` addon's clock and helpers.

| Minecraft | CC:C Bridge   | Jar read with javap                      | Source                                                 |
| --------- | ------------- | ---------------------------------------- | ------------------------------------------------------ |
| 1.18.2    | 1.5.1-forge   | `cccbridge-mc1.18.2-forge-v1.5.1.jar`    | branch `archived/mc1.18.2` at `4a2d26a` (8 Jul 2023)   |
| 1.20.1    | 1.7.1 (forge) | `cccbridge-mc1.20.1-v1.7.1-forge.jar`    | branch `mc1.20.1`                                      |
| 1.21.1    | 1.7.3         | `cccbridge-mc1.21.1-v1.7.3-neoforge.jar` | branch `mc1.21.1` at `73f2efa` (11 Jun 2026), neoforge |

Source: [github.com/tweaked-programs/cccbridge](https://github.com/tweaked-programs/cccbridge). The world's
`version` picks the API: 1.5.1 on 1.18.2, 1.7.x on 1.20.1 and 1.21.1. Every method name, `@LuaFunction` alias,
`mainThread` flag and error string was checked in those jars. CC:Tweaked's own parts (argument checks, `Terminal`,
`TermMethods`, `Palette`) were read from the cc-tweaked 1.18.2-1.101.3 and 1.20.1-1.121.0 jars.

## Peripherals

| Type            | Block         | 1.5.1 methods                                                                                                                             | 1.7.x changes                                                         |
| --------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `animatronic`   | Animatronic   | setFace, push, set{Head,Body,LeftArm,RightArm}Rot, getStored...Rot, getApplied...Rot (14)                                                 | + setTransition (15); `push` is main thread on 1.21.1                 |
| `redrouter`     | RedRouter     | setOutput, getOutput, getInput, setAnalogOutput/setAnalogueOutput, getAnalogOutput/getAnalogueOutput, getAnalogInput/getAnalogueInput (9) | same methods; the `redstone` event works                              |
| `scroller`      | Scroller Pane | isLocked, setLock, getValue, setValue, getLimit, hasMinusSpectrum, toggleMinusSpectrum, setLimit (8)                                      | `setValue` sends no event                                             |
| `create_source` | Source Block  | setCursorPos, write, scroll, clear, clearLine, getLine, getCursorPos, getSize (8)                                                         | CC's whole `TermMethods` plus its own `write` and `getLine` (25)      |
| `create_target` | Target Block  | setWidth, clear, clearLine, getLine, getSize (5)                                                                                          | resize, getLine, dump, getSize (4); `resize` is main thread on 1.21.1 |

`peripheral.getMethods` gives them in CC's `HashMap` order (`packages/runner/src/cccbridge-surface.json`).
Every other method runs on the computer thread (none is `mainThread` in 1.5.1 or 1.7.1).

### Events

`TweakedPeripheral.sendEvent` calls `queueEvent(event, getAttachmentName(), arguments)`, so the varargs array arrives
as ONE argument: Lua gets the event, the peripheral's name, then a table of the arguments (an empty table when there
are none).

| Event              | From          | Arguments after the name | When                                                                                   |
| ------------------ | ------------- | ------------------------ | -------------------------------------------------------------------------------------- |
| `scroller_changed` | scroller      | `{ value }`              | the value changes: a player's turn, and in 1.5.1 also `setValue` from Lua              |
| `monitor_resize`   | create_source | `{}`                     | a display link gives the source a new size                                             |
| `redstone`         | redrouter     | `{}`                     | 1.7.x only: an input changed. In 1.5.1 `updateInputs` never sets `newInputs`, so never |

In 1.7.x `TweakedPeripheral` is an interface and its `computers` list is a field of it, which Java makes static: one
list shared by every CC:C Bridge peripheral. An event is sent once per attached CC:C Bridge peripheral, each time
under that peripheral's name (a computer with five of them gets five `redstone` events, named after each), and
detaching any of them removes every attachment of that computer. The sim does the same, in the world's order.

## Behaviour and its source

| Rule                                                                                                                                                                                                                                                                                                     | Source                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `setFace`: 1.5.1 takes exactly normal, happy, question, sad; 1.7.x ignores case (`Face.contains`) and its error lists `{ normal, happy, question, sad }`                                                                                                                                                 | `AnimatronicPeripheral`, `Face`                                   |
| `setTransition` (1.7.x): rusty, none, linear, ignoring case                                                                                                                                                                                                                                              | `Transition`                                                      |
| `set...Rot` clamps each angle to -180..180 (body X to -360..360) and stores floats; `push` applies them and zeroes what is stored                                                                                                                                                                        | `AnimatronicPeripheral`                                           |
| `getApplied...Rot` is the destination pose: a `Rotations`, each float taken modulo 360 (so 360 reads 0)                                                                                                                                                                                                  | `AnimatronicEntity.getDestination...Pose`, `Rotations`            |
| redrouter sides: front is the neighbour the block faces, back the one behind, left counter-clockwise of front, right clockwise, top above, bottom below                                                                                                                                                  | `getActualSide`, `RedRouterBlock.getSignal`, `updateInputs`       |
| `setAnalogOutput` outside 0-15: "Expected number in range 0-15"                                                                                                                                                                                                                                          | `RedRouterBlockPeripheral`                                        |
| side names are CC's `ComputerSide`, matched ignoring case; anything else is "bad argument #1 (unknown option x)"                                                                                                                                                                                         | `LuaValues.checkEnum`                                             |
| scroller starts at 0 with limits -15..15; `setValue` clamps to -limit..limit even with the minus spectrum off                                                                                                                                                                                            | `LuaScrollValueBehaviour`, `ScrollValueBehaviour`                 |
| `setLimit`: `clamp(abs(limit), 1, 200)` (abs of the smallest int stays negative, so 1); the value is not clamped again                                                                                                                                                                                   | `ScrollerBlockPeripheral.setLimit`                                |
| `setLock` reaches the block state (what `isLocked` reads) on the next server tick; a locked scroller ignores players                                                                                                                                                                                     | `ScrollerBlockEntity.tick`, `onlyActiveWhen`                      |
| the source is a 4x2 terminal until a display link sizes it; `write` writes at the cursor and moves it on; `getLine` out of range: "Expected number in range 1-h"                                                                                                                                         | `SourceBlockPeripheral`, `Terminal`                               |
| a display link refreshes the source every 20 ticks unless redstone holds the link; the size changing sends `monitor_resize`                                                                                                                                                                              | `SourceBlockDisplaySource`, `DisplayLinkBlockEntity`              |
| 1.5.1 target: 32x24; `setWidth` (1-164) always makes it 16 high; `clearLine` out of range does nothing                                                                                                                                                                                                   | `TargetBlockPeripheral`                                           |
| 1.7.x target: 32x8; `resize` needs both at least 1: "The width and height of the terminal must be bigger than zero."; `dump` is every line                                                                                                                                                               | `TargetBlockPeripheral`                                           |
| 1.21.1 keeps the target's size in the block entity, so a fixture may give it                                                                                                                                                                                                                             | `TargetBlockEntity.afterResize`                                   |
| a link into the target: each line is its text pieces each followed by a space, mapped to CC's charset (unknown characters are `?`); 1.5.1 replaces those lines, 1.7.x clears the target first                                                                                                            | `TargetBlockDisplayTarget`, `Misc.toCCTxt` / `CharsetManipulator` |
| the source's text to Create: each CC character as its Unicode counterpart (ß is U+1E9E)                                                                                                                                                                                                                  | `Misc.toMCTxt`                                                    |
| 1.7.x source `TermMethods`: colours are bits (0, negative or 65536 and up: "Colour out of range"), the highest bit counts; `blit` needs equal lengths ("Arguments must be the same length"); `setPaletteColour` with 2 arguments takes an RGB int, otherwise 3 finite numbers; palette defaults are CC's | `TermMethods`, `Palette`, `Colour`                                |

Argument checks are CC:Tweaked's, read from the jars: `int` arguments truncate toward zero and wrap to 32 bits
(`getLong` then `(int)`; NaN and infinities are "number expected, got nan/inf"), strings are not coerced from numbers,
and on 1.101.3 a function, coroutine or userdata passed where a string or boolean is expected reports "got nil"
(`VarargArguments.get` turns them into null); on 1.121.0 it names the real type.

## Fixtures

Peripheral fields (`world.peripherals[]`):

- `animatronic`: `face` (default "normal"), `transition` (1.7.x, default "rusty"), `pose: { head, body, leftArm,
rightArm }` each `[x, y, z]`: the pose already applied.
- `redrouter`: `facing` (north, east, south, west; default north), `inputs` and `outputs`: `{ <side>: level }` where a
  side is a neighbour's direction (up, down, north, east, south, west) or a side as the computer names it (front,
  back, left, right, top, bottom).
- `scroller`: `value`, `limit` (default 15), `minus` (minus spectrum, default false), `locked`.
- `create_source`: `link: { rows, columns, powered? }`: a display link reads the source, its target that many rows and
  columns (work them out from Create's display: `docs/create.md`, display link sizes).
- `create_target`: `width`, `height` (1.21.1 only; 32x8 by default).

`world.cccbridge` has no fields yet; it only loads the addon at boot.

## Sim commands

| Command          | Fields                                                  | Does                                                                                                                 |
| ---------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `cccbSetInput`   | `peripheral, side, level`                               | a neighbour's redstone into a redrouter (1.7.x sends `redstone` if it changed)                                       |
| `cccbScroll`     | `peripheral, value`                                     | a player turns the scroller (refused while locked, or below 0 with the minus spectrum off)                           |
| `cccbLinkSource` | `peripheral, rows?, columns?, powered?, linked?, read?` | the source's display link: its target size, redstone on the link, `linked: false` removes it, `read: true` reads now |
| `cccbLinkTarget` | `peripheral, lines, line?`                              | a display link writes `lines` into the target from its line `line` (1-based, default 1)                              |

`craftos_sim_state` has, per peripheral, under `peripherals.<name>`: animatronic `face`, `transition`, `stored`,
`applied`, `pushes`; redrouter `facing`, `outputs` and `inputs` by the neighbour's direction; scroller `value`,
`limit`, `minus`, `locked`, `lockPending`; source `width`, `height`, `cursor`, `lines`, `link`, `sent` (the text the
link last took, as Create text) and `reads`; target `width`, `height`, `lines`, `received`. `addons.cccbridge.version`
is the mod version being followed.

## Not emulated

- **No Create display link joins them to other blocks.** The `create` addon's `Create_DisplayLink` cannot target a
  Target Block or read a Source Block; `cccbLinkTarget` and the source's `link` stand in for a link, and what a real
  source (a stress gauge, a train station) would send is up to the test.
- **The RedRouter's outputs go nowhere.** They are in the sim state; no other block or computer reads them. Wrenching
  it (which rotates the outputs) and turning the block are not modelled.
- **The animatronic's movement** (the bouncing "rusty" or linear transition between poses) is client rendering; only
  the destination pose, which the methods return, is kept.
- **1.7.x `write`:** the Source Block declares its own `write(String)` next to `TermMethods.write(Coerced<String>)`.
  Which one CC binds depends on `Class.getMethods` order, which Java does not fix. The sim uses the block's own one:
  strings only, no coercion. If CC picks the other, numbers would be written as text instead of failing.
- **Event timing:** a redrouter's `redstone` event (1.7.x) and a player's scroll come at once with the sim command;
  the game sends them on the block's next tick (within 50 ms).
- A `scroller_changed` from a player's turn is checked against Create's value board only for the range; the board's
  rows and the click itself are not modelled.
- **Text through host commands:** a sim command sent by the MCP host or CLI reaches the computer through CC's file
  decoding, which turns characters above U+00FF into `?` before the charset mapping sees them (so `♥` arrives as `?`,
  where the game would map it to CC's character 3). Latin-1 text is exact.
- **Not confirmed in game:** nothing here; the mod is not in the pack.
