# Coming from CraftOS-PC

craftos-mcp runs on a fork of CraftOS-PC 2, so a lot will feel familiar. The difference is the goal: CraftOS-PC is a
computer on your desk, craftos-mcp is a computer on a Minecraft server. Wherever the two disagree, craftos-mcp does
what the real game does, so a program that works here works in game too.

## Bring your computers over

```sh
craftos-mcp import craftos-pc            # finds your CraftOS-PC folder by itself
craftos-mcp import craftos-pc --list     # just show what would come over
craftos-mcp import craftos-pc D:\backup\CraftOS-PC --out my-computers --only 0,2
```

Or in the browser app (`craftos-mcp app`): **From CraftOS-PC** at the top, tick the computers, **Bring them over**, then
**Start** next to any of them.

CraftOS-PC keeps its data in `%APPDATA%\CraftOS-PC` on Windows, `~/Library/Application Support/CraftOS-PC` on macOS and
`~/.local/share/craftos-pc` on Linux. That folder is only read, never changed. What comes across:

| CraftOS-PC                           | craftos-mcp                                                         |
| ------------------------------------ | ------------------------------------------------------------------- |
| `computer/<id>`, every file          | `computer/<id>` in the new project                                  |
| the label (`config/<id>.json`)       | `"label"` in the computer's world: `os.getComputerLabel()` gives it |
| no colour, its own screen size       | `"advanced": false`, `"terminal"`                                   |
| `periphemu.create(...)` in `startup` | the same peripherals in its world, there from the moment it boots   |
| floppy disks (`computer/disk/<id>`)  | the world's `"disks"`, for a computer with a drive (text files)     |
| the computer CraftOS-PC opens first  | the one `craftos.json` picks                                        |

The project gets a `craftos.json`, a `computer-<id>.world.json` for each computer, and each computer's files in
`computer/<id>`. Then:

```sh
cd craftos-pc
craftos-mcp window                                        # the first computer, in a window
craftos-mcp window computer-2.world.json --dir computer/2  # another one
craftos-mcp window computer-0.world.json computer-2.world.json  # both at once, on one network
```

Each computer's files are its `computer/<id>` folder itself, live, as in CraftOS-PC: what it saves is there, and what
you change there it sees at once. Opened together, each window is one computer, with its own folder, and rednet works
between them (each gets a wireless modem unless its world has one).

A printer comes across with a stack of black dye and of paper, since a real one needs ink and paper; its pages show in
the browser app instead of a file. A second computer attached as a peripheral and the debugger peripheral do not come
across; the import says so for each one. Folders you mounted from your PC do not either: copy what a computer needs
into its folder.

## Where things are

| In CraftOS-PC you would...                      | Here                                                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| open CraftOS-PC                                 | `craftos-mcp window` in your project folder, or the CraftOS desktop app ([guide](guide/desktop-app.md))            |
| `attach left monitor`                           | the same in the shell, live; or `--monitor left:2x2`, or `"monitors"` in a world file                              |
| `attach left chest`, `periphemu.create(...)`    | `"peripherals"` in a world file ([guide](guide/worlds.md)), or the World panel in the browser app                  |
| `attach 1 computer` for a second computer       | `craftos-mcp window --computers 2`, or **Computers** 2 in the browser app; rednet works between them               |
| keep files in `%appdata%\CraftOS-PC\computer\0` | your project folder is the computer's disk, live ([guide](guide/getting-started.md))                               |
| run a script headless and read the output       | `craftos-mcp run program.lua`, which prints the terminal and every monitor as text                                 |
| test by hand                                    | `*.test.lua` files and `craftos-mcp test` ([guide](guide/testing.md))                                              |
| (no turtles, no mod blocks)                     | turtles in a block world, and blocks from Create, Mekanism, Advanced Peripherals and more ([guide](guide/mods.md)) |

## What is the same

- The keys: hold Ctrl+T, Ctrl+R or Ctrl+S. In the window, F12 copies a screenshot.
- The ROM is CC:Tweaked's own, built from the real jar, and the engine passes all but one of CC:Tweaked's own tests.
- `attach`, `detach`, `config` and `mount` still work when you type them, on a computer you drive yourself (the
  window and the browser app). Each one does the game's version of what you asked:

  ```text
  > attach top monitor
  Placed a monitor (5x3 blocks) on top.
  In the game you would put the block next to the computer; here it goes into the simulated world, live.
  To have it every time, add it to the world file's "monitors":
    { "name": "top", "blocksWide": 5, "blocksHigh": 3 }
  ```

  `attach <side> monitor 3 2` makes a wall 3 blocks wide and 2 high. `attach` also knows `drive` (`attach left drive 1`
  puts disk 1 in), `speaker`, `printer`, `modem`, `chest`, `tank`, `energy`, and any block the world knows, such as
  `minecraft:barrel` or `playerDetector`. Programs see the same `peripheral` and `peripheral_detach` events as when a
  block is placed or broken. `detach <side>` breaks it again.

  `config list` shows the settings that matter, and `config set` says where each one really lives (a real computer
  cannot change them from inside). `mount` lists the ROM and any disks. A program of your own called `config` or
  `mount` still wins over these.

## What is different, and why

| CraftOS-PC                                     | craftos-mcp, as in the game                                                                                |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `periphemu`, `config`, `mounter` APIs          | not there, as on a server (see below to turn them on)                                                      |
| a monitor is a window of any size              | a monitor is a wall of 1x1 to 8x6 blocks; 5x3 is about CraftOS-PC's 51x19                                  |
| `mount` a folder of your PC                    | a computer only has its own files: your project folder itself (`--dir`, or craftos.json's workspace), live |
| graphics mode (`term.setGraphicsMode`, pixels) | not there; CC:Tweaked has no pixel mode                                                                    |
| `_HOST` says CraftOS-PC                        | `_HOST` says `ComputerCraft <version> (Minecraft <version>)`, as on a server                               |
| `periphemu.create` in startup to set things up | the world file lists the peripherals; `attach` adds one live, and the world file keeps it                  |
| a random tip under "CraftOS" at boot           | off, so screens look the same every run; `"motd": true` in a world brings it back                          |
| one CraftOS-PC version                         | pick the Minecraft version, which picks the CC:Tweaked version (1.18.2 is CC:Tweaked 1.101.3)              |

The VS Code extension underlines CraftOS-PC-only calls in your code, so you see them before a server does.

### Programs that call periphemu

A program written for CraftOS-PC may make its own peripherals with `periphemu.create`. On a real computer that is an
error, so craftos-mcp leaves the API out. If you want such a program to keep running while you move it over, turn
the APIs on in its world:

```json
{ "craftosPcApis": true }
```

Then `periphemu.create(side, type)` places the block in the world, live (false when the side is taken; a printer
gets a stack of ink and of paper), `periphemu.remove(side)` breaks it, `config.get` answers, and `config.set` and
`mounter.mount` raise an error that says what to do instead. The import turns this on for each computer whose Lua uses
`periphemu` or `mounter`, and puts the same peripherals in its world, so once those calls are gone you can turn it off.

## Next

- [Getting started](guide/getting-started.md): a tour from a first program to turtles, rednet and snapshots.
- [The window](guide/window.md): every option and key of `craftos-mcp window`.
- [Troubleshooting](guide/troubleshooting.md): error messages and their fixes.
