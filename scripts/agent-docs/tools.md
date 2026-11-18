## Working with the tools

| Tool                                                                    | Use                                                                   |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `craftos_info`, `craftos_help`                                          | Call first: what is set up, the versions and addons; the world schema |
| `craftos_write_file`, `craftos_read_file`, `craftos_list_files`         | Workspace files (copied to the root of each computer)                 |
| `craftos_run`                                                           | Run a program in a fresh computer: terminal and monitor text, PNGs    |
| `craftos_test`                                                          | Run `*.test.lua` files with the `ccunit` harness                      |
| `craftos_session_create`, `craftos_ui`, `craftos_act`, `craftos_script` | Drive a running program: read screens as data, tap, type, assert      |
| `craftos_network_create`, `craftos_sim_command`, `craftos_sim_state`    | Several computers over rednet; change and read the world around them  |
| `craftos_seed`, `craftos_advance`, `craftos_trace`, `craftos_clock`     | Pin `math.random`, jump the clock, see what the program saw           |

1. Write the program with `craftos_write_file` and run it with `craftos_run`
   (`monitors: [{name:"top", blocksWide:3, blocksHigh:2}]` attaches a monitor wall; a `world` adds chests, players
   and modded blocks).
2. For a UI, open a session and use `craftos_ui` and `craftos_act` (they read buttons and text as data and wait
   until the program has reacted) rather than screenshots; `craftos_script` runs a whole scenario in one call.
3. Put tests in `*.test.lua` files and run them with `craftos_test`. Each file gets a fresh computer and the global
   `ccunit` (`test`, `eq`, `contains`, `run(program, {script = fn})`, `screen(monitor)`, `touch(monitor, x, y)`).
4. Pick the Minecraft version the user's server runs: 1.18.2 is Lua 5.1 (no `goto`), 1.20.1 and 1.21.1 are Lua 5.2.

The full guide, with the traps that bite real programs, is {{guide}}.
