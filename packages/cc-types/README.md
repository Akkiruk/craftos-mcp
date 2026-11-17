# CC:Tweaked types for the Lua language server

Type definitions for [lua-language-server](https://luals.github.io/) (the `sumneko.lua` VS Code extension, and the
same server in Neovim, Zed, Helix and others). With them a ComputerCraft program gets autocomplete, hover docs and
type checking, and stops being a wall of "Undefined global `term`" warnings.

What is covered:

- every CC:Tweaked API: `term`, `fs`, `http`, `os`, `peripheral`, `rednet`, `redstone`, `colors`, `textutils`,
  `parallel`, `paintutils`, `window`, `vector`, `keys`, `settings`, `shell`, `multishell`, `turtle`, `pocket`,
  `commands`, `disk`, `gps`, `help`, `io`, the globals of `bios.lua`, and the `cc.*` modules for `require`
- the peripherals: monitor, speaker, modem, printer, drive, command block, computer, redstone relay, and the generic
  inventory, fluid_storage and energy_storage
- events: `os.pullEvent("key")` knows it returns a key code and a boolean
- CC:Tweaked 1.101.3 (Minecraft 1.18.2) and 1.121.0 (1.20.1, 1.21.1): what only one of them has says so in its hover,
  and what was removed is marked deprecated
- the mod peripherals craftos-mcp emulates: Advanced Peripherals, Mekanism, Mekanism Generators, Create, Create
  Crafts & Additions, Tom's Peripherals, Bigger Reactors and Extreme Reactors
- `ccunit`, the test helper of `craftos-mcp test`

## Use it

Point the language server at the `library` folder. In a `.luarc.json` at the top of your project:

```json
{
  "runtime.version": "Lua 5.2",
  "runtime.builtin": { "os": "disable", "io": "disable" },
  "workspace.library": ["/path/to/craftos-mcp/packages/cc-types/library"]
}
```

or the same in VS Code's `settings.json`, each key with `Lua.` in front. `os` and `io` are switched off because
CraftOS has its own: without that the language server also offers `os.execute`, `io.popen` and the rest, which a
computer does not have.

`INTEGRATION.md` says how the craftos-mcp VS Code extension is to do this for you.

This folder is also a lua-language-server addon (`config.json` plus `library/`). Copy it into a folder of addons,
name that folder in `Lua.workspace.userThirdParty`, and the language server offers to switch it on whenever it opens
a file that looks like a CC program.

Lua 5.2 is the closest of the versions the language server knows: CC:Tweaked 1.109 and newer run Lua 5.2 with parts
of 5.3, and 1.101.3 runs Lua 5.1 with most of 5.2 added. On 1.101.3 the one thing the language server will not tell
you is that `goto` does not exist yet.

### Peripherals

`peripheral.find` knows what it returns:

```lua
local monitor = peripheral.find("monitor") -- cc.Monitor
local reactor = peripheral.find("fissionReactorLogicAdapter") -- mekanism.FissionReactorLogicAdapter
```

`peripheral.wrap` takes a side or a network name, so it cannot know. Say what you expect:

```lua
local monitor = peripheral.wrap("left") --[[@as cc.Monitor]]

---@type ap.MeBridge
local bridge = peripheral.wrap("meBridge_0")
```

A type the library does not know (another mod's block) comes back as `any`: no completion, no false warnings.

### Nil warnings

What can come back nil follows CC:Tweaked's own documentation. `fs.open`, `http.get`, `peripheral.wrap` and
`rednet.receive` with a timeout are documented as "or nil", so this is flagged, and rightly:

```lua
local file = fs.open("data.txt", "r")
print(file.readAll()) -- Need check nil
```

`peripheral.find` is documented as returning "0 or more" peripherals, not "or nil", so its result is not flagged,
though it is nothing at all when the block is not there. A warning on every line that uses the monitor helps nobody.

If the nil warnings are more than you want, switch that one check off (`.luarc.json`):

```json
{ "diagnostics.disable": ["need-check-nil"] }
```

## How it is made

| Part                                         | From                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------- |
| `library/generated/`                         | the doc comments in the CC:Tweaked ROM, by `scripts/generate.mjs`          |
| `library/mods/`                              | what the emulator answered (`data/emulator-peripherals.json`), same script |
| `library/*.lua`                              | written by hand from CC:Tweaked's Java source: the APIs that are not Lua   |
| `data/emulator-globals.json`, `-peripherals` | `scripts/probe-emulator.mjs`: asks the emulator itself                     |
| `data/cct-java-api.json`                     | `scripts/java-api.mjs`: the names of CC:Tweaked's Java functions           |

```sh
node scripts/build-rom.mjs --download 1.18.2         # the two ROMs the generator reads
node scripts/build-rom.mjs --download 1.20.1
node packages/cc-types/scripts/generate.mjs          # write library/generated and library/mods
node packages/cc-types/scripts/generate.mjs --check  # fail when they are out of date
node packages/cc-types/scripts/check.mjs --baseline  # the regression check, see below
```

`generate.mjs` reads both ROMs. A function only the newer one has gets "Not in CC:Tweaked 1.101.3" in its hover, one
only the older has is marked deprecated, and the versions after 1.101.3 that changed a function are listed. Where a
doc comment forgets that an argument is optional, the function's own `expect(...)` call decides.

**No CC:Tweaked text is in the library.** The ROM's doc comments are under CC:Tweaked's licence, and this repo ships
no CC:Tweaked file, so the generator takes only facts from them: names, parameter names, types, defaults, versions.
The one-line descriptions are our own, in `scripts/lib/summaries.mjs`, and every entry links to its page on
tweaked.cc, where the real documentation is. There is no option to copy the text. `generate.mjs` warns about a
name that has no line of ours yet.

The mod peripherals have no documentation to read, so `probe-emulator.mjs` runs a program in the emulator that calls
every method of every peripheral, first in the demo worlds and then on a bare block of each type. A wrong call says
what it wanted ("bad argument #2 (number expected)", Mekanism's "expected EnumColor"), which gives the parameters; a
call that goes through gives the shape of what comes back. Parameter names are read from the emulator's Lua source.
Run it again after changing an addon (it needs the engine and `npm run build`), then `generate.mjs`.

The types say what **the emulator** does, which follows the 1.18.2 version of each mod (a mod with no 1.18.2
release is probed on the oldest version it has). An addon missing from the table in `scripts/lib/mods.mjs` gets its
own file anyway, named from `packages/runner/src/addons.ts`. A method the emulator does
not have is not in the library. Those newer mods run one world each, so a block that hangs costs only its own mod
(the probe names it and goes on: CC: Drones' workbench does today); a block the sim refuses bare is dropped from its
run and named, or given the fields it needs in `BARE_FIXTURES`. The globals come from a computer with no mods, so a
mod's own globals (Advanced Math's `matrix`) are not in the library.

## The regression check

`scripts/check.mjs` needs lua-language-server: it finds the one in the VS Code Lua extension, one on `PATH` or in
`LUA_LANGUAGE_SERVER`, or downloads one with `--download`. It fails when:

1. a function CC:Tweaked defines in Java, or a method of one of its peripherals in the emulator, is missing
2. the definitions themselves have a problem (a type that does not exist, a duplicate)
3. a global, field or `cc.*` module the emulator has on either version is not defined
4. the example programs (`workspace/hello.lua`, `workspace/examples`) name an undefined CC global, or the library
   makes a call look like it has the wrong number of arguments

`--baseline` prints the diagnostics without and with the library, `--list` what is left.

## Credit

The APIs described here are CC:Tweaked's: [tweaked.cc](https://tweaked.cc),
[source](https://github.com/cc-tweaked/CC-Tweaked). The library describes them in its own words and links every entry
to the documentation there.
