# Troubleshooting

The messages you can meet, where you meet them, what they mean and how to fix each one. Every message here was copied
from a real run. The command line prints a `More help:` link to the matching entry under many of them.

When you are not sure what is wrong, start with:

```sh
npx craftos-mcp doctor
```

It checks Node.js, the engine, every ROM, the cache folder, `craftos.json` and your world files, then boots a hello
world. Each failed check says how to fix it, and the last line is `Everything is ready.` or how many checks failed.

- [Installing and the first start](#installing-and-the-first-start)
- [Starting a computer: worlds, mods, versions](#starting-a-computer-worlds-mods-versions)
- [Your program](#your-program)
- [Tests](#tests)
- [The browser app and the window](#the-browser-app-and-the-window)
- [The desktop app](#the-desktop-app)

## Installing and the first start

### Setup could not download

```text
craftos-mcp: setup failed: could not reach github.com: ENOTFOUND github.com
craftos-mcp: No network, or a proxy? Set HTTPS_PROXY (craftos-mcp then sets NODE_USE_ENV_PROXY=1 for the download), or set up offline: ...
craftos-mcp: cannot run without the engine and ROM (setup failed: could not reach github.com: ENOTFOUND github.com). craftos-mcp setup tries again; craftos-mcp info shows what is missing.
```

The first start downloads the engine and CC:Tweaked's own jar (to build the ROM from), once. It could not reach the
host it names. The end of the line says why: `ENOTFOUND` (no internet, or DNS), `ECONNREFUSED 127.0.0.1:9` (a
proxy that is not running), a certificate error (a proxy that rewrites HTTPS).

Fix: get online and run `npx craftos-mcp setup` again (add `--verbose` to see every step). Behind a proxy, set
`HTTPS_PROXY=http://your-proxy:port`. With no internet at all, download the engine zip for your system from the
[latest release](https://github.com/Akkiruk/craftos-mcp/releases/latest) on another machine, set
`CRAFTOS_ENGINE_URL` to the zip's path, put the CC:Tweaked jars in `<CRAFTOS_HOME>/jars`, then run
`npx craftos-mcp setup`.

A wrong `CRAFTOS_ENGINE_URL` says so instead:

```text
craftos-mcp: setup failed: CRAFTOS_ENGINE_URL is C:\Users\you\Downloads\engine.zip, which is not a file here and not an http(s) address
```

Check the path, or unset the variable to download from the release.

### Node.js is too old

```text
craftos-mcp needs Node.js 22 or newer (this is v20.11.0).
```

Install Node.js 22 or newer from [nodejs.org](https://nodejs.org), or use the [desktop app](desktop-app.md), which
needs no Node.js.

### Engine or ROM not found

```text
engine not found at C:\Users\you\AppData\Local\craftos-mcp\0.4.1\engine\build\craftos.exe (...)
ROM for Minecraft 1.20.1 not found at ... (craftos-mcp builds it when a world asks for it; craftos-mcp setup --all builds every version's now)
```

The setup did not finish, or something removed the files afterwards. Run `npx craftos-mcp setup` (or
`npx craftos-mcp setup --force` to redo it from scratch). If the engine keeps vanishing, see the next entry.

### The engine vanishes

The engine (`craftos.exe` on Windows) worked once and is now gone, or the computer never starts. Antivirus can
quarantine it. Allow it in your antivirus, then run `npx craftos-mcp setup --force`.

### macOS will not open it

The engine and the desktop app are not signed with a paid Apple developer id. The npm package downloads the engine
itself, so it runs. A zip you downloaded with a browser is quarantined: clear that once with
`xattr -dr com.apple.quarantine engine/build`. For the desktop app, the first time, right-click CraftOS in
Applications, choose **Open**, then **Open** again (on macOS 15 and newer: System Settings, Privacy & Security,
**Open Anyway**). `npx craftos-mcp doctor` checks for the quarantine mark.

## Starting a computer: worlds, mods, versions

These come up before the computer boots: on the command line, in the browser app's **New computer** form, or in the
desktop app when you press Run. The computer does not start until the world is right. More on world files in
[worlds.md](worlds.md), on mods in [mods.md](mods.md).

### Not a world field

```text
--world typo.world.json: world.monitor is not a world field. Did you mean "monitors"?
```

A key in your world file is misspelt. Use the name it suggests. A key that is nothing like a real one only gets a
warning and is ignored:

```text
warning: world.somethingElse is not a world field and does nothing (the world schema lists them: craftos://schema/world)
```

Keys starting with `_`, and `description`, `name`, `comment` and `notes`, are for your own notes and never warn.

### Not a peripheral the sim can build

```text
--world type.world.json: world.peripherals[0].type "playerDetecter" is not a peripheral the sim can build. Did you mean "playerDetector" (Advanced Peripherals (addon "advanced-peripherals"))? A block of your own name needs storage fields: size or items (inventory), tanks or fluid (fluid_storage), energy or energyCapacity (energy_storage).
```

The `type` is misspelt, or it is a block the emulator does not know. Use the suggested type. For a modded storage
block that is not in the list (a crate from some other mod, say), give it any name and storage fields, and it works
like a chest, tank or battery: `{ "name": "left", "type": "mymod:crate", "size": 27 }`.

A monitor in `peripherals` is refused too: monitors go in their own `"monitors"` list.

### Addon switched off

```text
--world off.world.json: peripheral "left" is a playerDetector from Advanced Peripherals (addon "advanced-peripherals"), which is switched off. Enabled addons: create. The mods come from world.addons: add it there, or leave the peripheral out.
```

Each mod is an addon you switch on only if your pack has it, so a program cannot come to need a block your server
does not have. Add the addon id to the world's `"addons"` list, to `--addons`, or tick the mod in the app. If your
pack does not have that mod, take the block out of the world.

### Unknown addon

```text
--world badaddon.world.json: unknown addon "mekanizm" in world.addons. Did you mean "mekanism"? Known: advanced-peripherals, mekanism, mekanism-generators, create, ...
```

An addon id is misspelt. The message says where the list is (`world.addons`, `--addons`, `"addons" in` your
`craftos.json`, or `CRAFTOS_ADDONS`) and the id it looks like you meant; the rest are in the list it prints. [mods.md](mods.md) has every id with its mod.

### No release for this Minecraft version

```text
--world norel.world.json: Bigger Reactors (addon "bigger-reactors") has no release for Minecraft 1.21.1; it has 1.18.2 (...), 1.20.1 (...). Run this world on one of those: world.version "1.20.1", --mc 1.20.1 on the command line, or CRAFTOS_VERSION=1.20.1 for every computer; or leave Bigger Reactors out. Addons on 1.21.1: ...
```

That mod never came out for the Minecraft version you picked. Pick the version your server runs (it says how), or
leave the mod out. The desktop app leaves such a mod out of the list for that version.

### Unknown Minecraft version

```text
--mc: unknown Minecraft version "1.16.5"; known: 1.18.2 (CC:Tweaked 1.101.3), 1.20.1 (CC:Tweaked 1.121.0), 1.21.1 (CC:Tweaked 1.121.0)
```

Only 1.18.2, 1.20.1 and 1.21.1 are emulated. Older versions (1.16.5, 1.12.2) are not supported. Pick the nearest
one your programs are written for.

### Monitor too big

```text
--monitor top:9x9: monitor "top" is 9x9 blocks; a monitor wall is at most 8x6 blocks (wide x high)
```

In the game a monitor wall is at most 8 blocks wide and 6 high. Make it smaller, or use more than one monitor. For a
bigger picture, a smaller text scale fits more on the same wall (`top:8x6@0.5`, or `setTextScale(0.5)`).

### World file not found or not JSON

```text
no world file nofile.world.json (looked in C:\Users\you\Documents\my-base; a world file's name ends in .json)
C:\Users\you\Documents\my-base\broken.world.json: Unexpected end of JSON input
no world named "nope" in C:\Users\you\...\worlds
```

The path is wrong, the file is not valid JSON (a missing `]` or `}`, a comma after the last item), or there is no
saved world of that name. A world file's path is from the folder you run in. Open the file in an editor that checks
JSON (VS Code marks the line), or start from one of the ready worlds in [worlds.md](worlds.md).

### craftos.json problems

```text
C:\Users\you\Documents\my-base\craftos.json: Expected double-quoted property name in JSON at position 24 (line 1 column 25)
C:\Users\you\Documents\my-base\craftos.json: minecraft: unknown version "1.16.5"; known: 1.18.2, 1.20.1, 1.21.1
C:\Users\you\Documents\my-base\craftos.json: unknown key "addon"; craftos.json takes workspace, minecraft, addons, tests, world, run
C:\Users\you\Documents\my-base\craftos.json: world: no file C:\Users\you\Documents\my-base\gone.world.json
```

Your project file has a mistake: the message says which line or key. Fix it, or write a new one with
`npx craftos-mcp init --force`. Every command, the browser app and the desktop app read the same file, so they all
stop on it until it is fixed.

### No program

```text
no program "missing.lua" in the workspace C:\Users\you\Documents\my-base.
```

The program is not in the folder the computer uses. Check the name (and that you are in the right folder, or give
`--dir`). In the browser app the computer still starts and its screen says `No such program`, as the shell would.

## Your program

These are CraftOS's own errors, the same as in the game. The command line prints them under the screen with the file
and line (`error (runtime): nomon.lua:1: ...`).

### attempt to index a nil value

```text
nomon.lua:1: attempt to index local 'm' (a nil value)
```

Most often `peripheral.find("monitor")` (or `peripheral.wrap`) found nothing, so `m` is `nil`. The world has no
such block. Put one there: `--monitor top:2x1`, a `"monitors"` list in the world file, or **Around this computer** in
the browser app ([worlds.md](worlds.md)). In your program, check for it:
`local m = peripheral.find("monitor") or error("no monitor attached", 0)`.

### No such modem

```text
nomodem.lua:1: No such modem: back
```

`rednet.open("back")` but no modem is on that side. Add one to the world
(`{ "name": "back", "type": "modem" }`), or in the browser app set **Computers** to 2 or more, which gives each
one a wireless modem.

### Bad argument, got nil

```text
pm.lua:1: bad argument #1 (table expected, got nil)
```

A function got `nil` where it wanted something: here `peripheral.getName(peripheral.find("modem"))` with no modem.
Same fix as above: the world lacks the block your program looks for.

### Rednet messages never arrive

There is no error for this one. `rednet.broadcast` and `rednet.send` on a computer with no open modem send nothing,
as in the game. Both computers need `rednet.open(side)` on a side with a modem, and must be in range of each other
(wireless) or on the same cable (wired). The browser app's **Network** view shows each message and who heard it.

### Too long without yielding

```text
spin.lua:1: Too long without yielding
```

A loop ran for about 7 seconds without stopping to wait for anything, so CraftOS stopped it, as the game does. Put a
`sleep(0)`, `os.pullEvent()` or `coroutine.yield()` inside long loops. Pausing the clock never causes this one: a
computer finishes what it is doing before it pauses.

### Timed out

```text
slow.lua: timed_out (no exit code, 3017 ms)
```

`craftos-mcp run` stops a program after `--timeout` seconds (the exit code is 124). A program that runs forever on
purpose (a door, a clock) always ends this way, which is fine: the screens printed under the line are what it showed.
For a program that should finish, raise `--timeout`, or use `--timescale 10` to run the clock faster.

### Syntax errors on Minecraft 1.18.2

```text
Unexpected symbol after name.
error (syntax): goto.lua:1: '=' expected near 'c'
```

Minecraft 1.18.2 runs CC:Tweaked 1.101.3, which is Lua 5.1: no `goto` and no `::labels::`. 1.20.1 and 1.21.1 have
them. Run on the version your server runs (`--mc 1.21.1`, or the version picker in the app), or write the loop
without `goto`.

### Out of fuel

```text
false	Out of fuel
```

`turtle.forward()` and the other moves return `false` and a reason instead of moving. A turtle in a world file starts
with the `"fuel"` it is given (0 if none). Give it some (`"fuel": 500` under `"turtle"`), or put coal in its
inventory and call `turtle.refuel()`. See [worlds.md](worlds.md) for a turtle world.

## Tests

More on tests in [testing.md](testing.md).

### No test files

```text
no *.test.lua files found under C:\Users\you\Documents\my-base
craftos.json's tests (spec/**/*.test.lua) match no *.test.lua files in C:\Users\you\Documents\my-base
```

A test file's name ends in `.test.lua` (`lamp.test.lua`). Make one, check you are in the right folder, or fix the
`tests` globs in `craftos.json`. Naming a file that is not there says so too:
`no file "nothere.test.lua" in the workspace ...`.

### A test failed

```text
FAIL sub/a.test.lua (1 test, 375 ms)
  FAIL fails
         /sub/a.test.lua:1: expected 2 but got 1
```

A check did not hold. The line says which file and line, and what it got. The screen under it is what the
computer showed at the time.

### A syntax error in a test file

```text
FAIL sub/b.test.lua (1 test, 236 ms)
  FAIL load sub/b.test.lua
         syntax error in sub/b.test.lua:3: unexpected symbol near 'end'
```

The test file could not be loaded, so none of its tests ran. The message gives the file and line: fix that line.

### The file produced no results

```text
FAIL sub/b.test.lua (0 tests, 386 ms)
  the file produced no results: the computer stopped before any test finished (the terminal below shows why)
```

The test file stopped before it reported anything: it shut the computer down, or the emulator stopped. The terminal
printed under it shows what the computer said last.

### A monitor is missing

```text
  FAIL reads the screen
         /lamp.test.lua:3: no monitor "top" is attached: give the test one (--monitor top:2x1 on the command line, or "monitors" in the world file)
```

The test reads a monitor its computer does not have. Give it one with `--monitor top:2x1`, or put it under
`"monitors"` in the world file ([testing.md](testing.md#monitors-and-the-world-in-a-test)).

### A test timed out

```text
  FAIL hangs
         timed out after 3 s
```

The test was still running when its `timeout` ran out. Usually it waits for an event that never comes (a touch, a
rednet message, a redstone change). Give `ccunit.run` a `script` that sends it, or wait with a time limit. Tests a
file finished before that one keep their results.

### A touch does nothing

`ccunit.touch` after `ccunit.run` has returned reaches nothing: the program has stopped by then. Tap inside the `script`
you give `run`, with a short `sleep` first so the program has drawn its screen. [testing.md](testing.md) has the
pattern.

## The browser app and the window

### Port is taken

```text
craftos app: listen EADDRINUSE: address already in use 127.0.0.1:7878
port 7878 is taken (the MCP server's viewer uses 7878): try --port 0 for a free one
```

Another program has that port, often a second `craftos-mcp app` or an MCP server's live viewer. Use another port
(`--port 7900`), or `--port 0` for any free one; the address is printed on start. Or close the other one.

### The World JSON box says no

```text
World JSON: the world must be a JSON object
```

The text pasted in **World JSON** in the New computer form is not a world: a typo in the JSON (then the message after
`World JSON:` is your browser's, with the position), or a list instead of `{ ... }`. Fix it in the box, or load the file with **Open a world file** under **Around this computer** after the
computer starts. The other world messages above show in the same place.

### Ctrl+T closes the browser tab

Your browser keeps Ctrl+T (new tab) for itself. Use the **Ctrl+T** button above the screen, which holds the keys as
CraftOS needs. Ctrl+R and Ctrl+S work from the keyboard.

### My file changes do not show

The computer's files are your project folder itself, live, unless you picked a scratch copy (`--copy`, or **Files**
in the New computer form). A program that is already running keeps the code it loaded: hold Ctrl+R (or press the
button) to reboot it, or run it again.

## The desktop app

The desktop app shows short messages in plain words. The same causes as above apply.

### The download did not work

```text
CraftOS needs the internet once, to download CC:Tweaked's files. Connect, then try again.
The download did not work: could not reach github.com.
```

The first Run of each Minecraft version downloads CC:Tweaked's own files, which cannot ship inside the app. Get
online and press Run again. Settings has **Get every version now**, so you can work offline later.

### Choice not saved

```text
C:\Users\you\Documents\my-base\craftos.json is not valid JSON, so the choice was not saved. Fix or delete the file. (...)
```

The app never writes over a `craftos.json` it cannot read, so your own edits are safe. Fix the file in an editor, or
delete it and pick your choices again. See [craftos.json problems](#craftosjson-problems).

### New project refused

```text
Pick a name without \ / : * ? " < > | and not ending in a dot or space.
C:\Users\you\Documents\my-base is there already and is not empty. Pick another name, or use Open a folder.
```

The name cannot be a folder name, or the folder exists and has files in it. Pick another name, or open the existing
folder with **Open a folder**.

### No test files yet

```text
This project has no test files yet. A test file ends in .test.lua, like hello.test.lua.
```

**Run tests** found nothing to run. Add a file ending in `.test.lua`; [testing.md](testing.md) shows how.

## Still stuck

Run `npx craftos-mcp doctor` and `npx craftos-mcp info`, and open an
[issue](https://github.com/Akkiruk/craftos-mcp/issues) with what they print, the command you ran and the whole
message.
