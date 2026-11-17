# Example programs

Small, complete programs that each do something useful with a mod's peripherals, written the way you would write them
for a real server. Every one has a world next to it (`<name>.world.json`) and a test (`<name>.test.lua`) that runs the
program itself against that world and checks what it does.

| Example                                                                      | What it does                                                                                                                                                    | Addons                                                         | Monitor  |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------- |
| [`mekanism/reactor.lua`](mekanism/reactor.lua)                               | Fission reactor dashboard with an automatic scram on temperature, damage or full waste, and a RESET button that only works once the reactor is safe             | `mekanism`, `mekanism-generators`                              | 3x2      |
| [`create/train_board.lua`](create/train_board.lua)                           | Departure board for every Create train station on the computer: which train is at the platform, which is arriving, and its schedule                             | `create`                                                       | 6x2      |
| [`power/power_monitor.lua`](power/power_monitor.lua)                         | Energy dashboard for any block with CC's generic `energy_storage` (any mod): fill bars, FE/t, an empty/full estimate and a low-power redstone alarm             | none (CC's own)                                                | 4x3      |
| [`toms-peripherals/gpu_demo.lua`](toms-peripherals/gpu_demo.lua)             | Pixel graphics on a Tom's Peripherals GPU: a spinning wireframe cube, a sine ribbon, and ripples where you right-click                                          | `toms-peripherals`                                             | GPU wall |
| [`extreme-reactors/rod_controller.lua`](extreme-reactors/rod_controller.lua) | Control rods for a passively cooled Extreme Reactors reactor: keeps the energy buffer around the middle, with a monitor dashboard                               | `extreme-reactors`                                             | 3x2      |
| [`advanced-peripherals/greeter.lua`](advanced-peripherals/greeter.lua)       | Greets players who walk into range of a player detector through a chat box, and answers `!players` and `!where`                                                 | `advanced-peripherals`                                         | none     |
| [`rednet/chat.lua`](rednet/chat.lua)                                         | Chat between two or more computers over rednet, with `/who` and `/quit` (the test runs two computers)                                                           | none (vanilla rednet)                                          | none     |
| [`games/board/arcade.lua`](games/board/arcade.lua)                           | A touch-screen cabinet of eight board games for two players or one against the computer ([README](games/board/README.md))                                       | none (CC's own)                                                | 2 x 6x6  |
| [`games/action/action.lua`](games/action/action.lua)                         | A touch-screen cabinet of Snake, Blocks, Bricks, Lander and Mines, for the high score ([README](games/action/README.md))                                        | none (CC's own)                                                | 6x6      |
| [`games/versus/versus.lua`](games/versus/versus.lua)                         | Paddle, Trails and Artillery head to head across two computers, each with its own wall (the tests run both) ([README](games/versus/README.md))                  | none (vanilla rednet)                                          | 6x6 each |
| [`games/blightmare/blightmare.lua`](games/blightmare/blightmare.lua)         | BLIGHTMARE, a first-person RPG in eleven acts, played by touch and saved as you go, packed to fit a computer's 1 MB disk ([README](games/blightmare/README.md)) | none (an Advanced Peripherals player detector if you have one) | 6x6      |

Each folder also holds the world and test of its program. The test is the best documentation of what the program
promises: the reactor test lets the reactor heat on the emulator's clock and checks it is scrammed before any damage,
the train test brings a train in and watches the board follow it, the greeter test walks players in and out, and so
on.

## Run one

With the command line (from the repository root; `--dir workspace` makes the workspace the computer's files):

```sh
craftos-mcp test examples/mekanism/reactor.test.lua --dir workspace \
  --world workspace/examples/mekanism/reactor.world.json --monitor top:3x2 --timescale 20

craftos-mcp window workspace/examples/mekanism/reactor.world.json --dir workspace --monitor top:3x2
# then, in the computer: examples/mekanism/reactor
```

With an agent, pass the contents of the world file as `world` (and the monitor from the table) to `craftos_run`,
`craftos_test` or `craftos_session_create`. `--timescale 20` (`timeScale: 20`) runs the virtual clock twenty times
faster, so the reactor heats in seconds.

The monitor column is what the tests attach, as `name:WxH` in blocks wide by high; every program finds its monitor with
`peripheral.find("monitor")`, so any monitor works and the layouts adapt to its size.

## Run all of them

```sh
npx vitest run packages/runner/src/examples.integration.test.ts
```

[`examples.integration.test.ts`](../../packages/runner/src/examples.integration.test.ts) runs every test above with its
world and monitor. The chat test starts two computers with wireless modems: one runs the test, the other
`rednet/chat.peer.lua`, which answers the first hello. (The GPU test is skipped until the GPU fonts exist: run
`node scripts/build-toms-fonts.mjs`.) The `*.test.lua` files need their world, so they fail when run bare with
no `--world`; the chat test just reports that it needs a second computer.

## How the tests work

- The program is started with `shell.run` beside a scenario in `parallel.waitForAny`, exactly as it would run on a
  server; nothing is mocked except what the test must see. To read a monitor back, the test hands the program a
  `window` over it (a wrapper around `peripheral.find`), and to watch a GPU or chat box it hands over a recording
  proxy that passes every call on.
- The world changes with sim commands, as `craftos_sim_command` sends them. Inside a test they are `ccsim_cmd` events
  whose first argument is a token starting with `sim:` (`os.queueEvent("ccsim_cmd", "sim:1", textutils.serializeJSON({
cmd = "chat", player = "Alice", message = "hi" }))`), which the emulator only accepts from a computer whose world says
  `"simProgram": true` (these worlds do). On a real server that event is just an event.
- Waits are conditions with a time limit (`waitFor`), not fixed sleeps, so a slow machine does not make them flaky.
