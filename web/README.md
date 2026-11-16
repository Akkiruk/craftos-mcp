# craftos in the browser

The emulator's engine compiled to WebAssembly, a player that runs ComputerCraft programs in a web page, and the
"carts" it plays: the example games and mod demos from `workspace/examples`. Built for a static site; nothing runs on
a server.

## Build

```sh
engine\build-web.cmd           # the engine: emsdk 7.0.0 (installed if missing), Poco 1.15.4 for wasm32, then craftos.js/.wasm
npm run build                  # the runner (build-carts uses it)
node web/build-runtime.mjs     # web/dist/runtime: engine, ROM, font, player.js, worker.js, manifest.json
node web/build-carts.mjs       # web/dist/carts: <id>.json, <id>.png, index.json (--no-shots skips the screenshots)
npm run test:web               # Playwright tests over web/serve.mjs (node web/test.mjs --shots <dir> keeps screenshots)
node web/serve.mjs             # http://127.0.0.1:8787/ - a local library page to try every cart
```

`node web/build-runtime.mjs --engine` runs `engine\build-web.cmd` first. Screenshots need the native engine and ROM
(`npm run setup`); a cart's screenshot is only redone when the cart changes (`web/dist/carts/shots.json`).

`web/dist` is gitignored and is never part of the public repository: the ROM (`rom-1.101.3.pack`) and the terminal
font (`cc-font.bin`) are CC:Tweaked's, hosted on the website with its author's permission, on condition that every
page running a computer links to <https://tweaked.cc>. The player always shows a "Uses CC:Tweaked" link in its
footer; keep it visible.

## Output

```
web/dist/runtime/
  manifest.json        file hashes (fetched with no-cache; everything else is fetched as <name>?v=<hash>)
  player.js            the ES module a page imports
  worker.js            one computer's Web Worker
  craftos.js           the engine's Emscripten glue (loaded by worker.js)
  craftos.wasm         the engine
  rom-1.101.3.pack     CC:Tweaked 1.101.3 ROM + ccsim, gzipped (the player unpacks it; a server may also gzip it)
  cc-font.bin          CC's font, 256 glyphs x 9 rows
web/dist/carts/
  index.json           { format: 1, carts: [{ id, title, kind, description, controls, source, screenshot, computers, keys? }] }
  <id>.json            a cart
  <id>.png             its screenshot, a few seconds in, for the library
```

Every file compresses well; serve `.js`, `.json` and `.wasm` with gzip or Brotli.

## Hosting

The engine uses threads (SharedArrayBuffer), so the page that mounts a player must be **cross-origin isolated**:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp      (or: credentialless)
```

These go on the HTML page. The runtime files only need to be same-origin (or send
`Cross-Origin-Resource-Policy: cross-origin` if they live on another origin) and `.wasm` should be
`application/wasm` (the player falls back if it is not). `self.crossOriginIsolated` must be true in the page, or
`mountPlayer` reports an error.

What COEP means for the rest of the page:

- **require-corp**: every cross-origin subresource (images, scripts, fonts, iframes) must opt in with a
  `Cross-Origin-Resource-Policy: cross-origin` header or be loaded with CORS (`crossorigin` attribute and an
  `Access-Control-Allow-Origin` reply). Images from a third-party host that sends neither are blocked. Same-origin
  files are unaffected.
- **credentialless**: cross-origin no-CORS requests (a plain `<img src="https://other/...">`) are allowed but sent
  without cookies, so public images keep working. Supported by Chrome/Edge 96+ and Firefox 119+; Safari does not
  support it and is not cross-origin isolated with it (Safari needs require-corp).

Either way, links and navigation are unaffected, and COOP `same-origin` means windows the page opens cannot script
it (popup-based sign-in on that page would break). The simplest setup: send the two headers only on the player page
(for example `/craftos` and `/craftos/*`) and keep its images same-origin.

## Player API

```js
import {
  mountPlayer,
  loadRuntime,
  runtimeStats,
  KEY_NAMES,
} from "/craftos/runtime/player.js";

loadRuntime("/craftos/runtime/"); // optional: start fetching early (engine ~2.4 MB, ROM ~0.5 MB)
const player = mountPlayer(element, {
  cart: "/craftos/carts/reversi.json", // a URL or a cart object
  runtimeBase: "/craftos/runtime/", // default: the folder player.js was loaded from
  onEvent: (e) => {}, // see events below
  toolbar: true, // Reset, Ctrl+T/R/S, Pause, Terminal, keyboard, Fullscreen, world buttons
  keys: "auto", // on-screen keys bar: auto (touch screens, carts with keys) | true | false
  fit: "auto", // "fill": use the element's height; "auto": up to 85% of the window height
  pauseWhenHidden: true,
  autofocus: true,
});
await player.ready; // every computer has drawn
```

| Method                                                            | What it does                                                                                                                |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `reset()`                                                         | start the cart again from its files (returns the new `ready`)                                                               |
| `destroy()`                                                       | stop every computer (terminates their workers) and remove the player                                                        |
| `pause()` / `resume()`                                            | stop every computer at its next yield; timers queue up meanwhile                                                            |
| `fullscreen()`                                                    | toggle fullscreen on the player                                                                                             |
| `sim(command, computer?)`                                         | a world command, as `craftos_sim_command` takes it (`{ cmd: "advance", seconds: 60 }`), to one computer (default the first) |
| `event(name, params, computer?)`                                  | queue any CC event                                                                                                          |
| `key(name or code, computer?)`, `type(text, computer?)`           | press a key (`KEY_NAMES`: up, enter, a, ...), type characters                                                               |
| `touch(monitor, x, y, computer?)`                                 | a monitor_touch at a 1-based cell                                                                                           |
| `terminate()`, `reboot()`, `shutdown()`                           | what holding Ctrl+T, Ctrl+R, Ctrl+S does                                                                                    |
| `screens()`                                                       | `[{ computer, kind: "terminal" \| "monitor" \| "pixels", name, width, height, version }]`                                   |
| `screenText(name?, computer?)`, `screenCells(...)`, `canvas(...)` | a screen's text lines, its cells and colours, its canvas                                                                    |

`computer` is a computer's name from the cart, its label, or its index. `runtimeStats()` gives
`{ workers, players }` alive on the page.

Events (`onEvent`): `ready`, `started` (a computer's engine is up), `off` (a computer shut down; the player offers to
turn it on), `message`, `log`, `error`, `paused`, `resumed`, `reset`, `destroyed`, `sim` (a world command was sent),
`net` (modem traffic between computers).

Input: keys go to the computer last clicked or tapped (GLFW key codes and char events, as CC:Tweaked 1.101.3 has
them; held Ctrl+T/R/S work as in CC and are toolbar buttons too, since browsers keep Ctrl+T); Ctrl+V pastes; on
advanced computers the mouse gives mouse_click/drag/up/scroll at the right cell; a click or tap on a monitor is a
monitor_touch at the cell under it; a tap on a GPU pixel screen is the sim's `tmTouch`. Screens are drawn with CC's
font and palette at one scale for all, as large as fits, in whole device pixels when that costs little.

Styling: everything is under `.ccp`; colours are CSS variables on `.ccp` (`--ccp-bg`, `--ccp-fg`, `--ccp-accent`,
`--ccp-bezel-adv`, `--ccp-monitor`, ...).

## Cart format

```js
{
  format: 1,
  id: "reversi", title: "Reversi", kind: "board",   // kind: board | action | versus | demo | shell
  description: "...", controls: "...",               // one line each, for the library
  source: "https://github.com/Akkiruk/craftos-mcp/tree/main/workspace/examples/...",
  screenshot: "reversi.png",                         // next to the cart
  keys: ["left", "up", "down", "right"],             // optional: the on-screen keys bar (KEY_NAMES)
  keyboard: false,                                   // the program wants a keyboard
  actions: [{ label: "Drain coolant", command: { cmd: "mekAddTank", ... }, computer?: "name" }],  // world buttons
  computers: [{
    name: "north", label: "North", id: 1,            // id: the computer id (also its rednet id)
    advanced: true,
    files: { "arcade.lua": "text...", "img.bin": { base64: "..." } },   // the computer's own files
    world: "<world.json as packages/runner worldJson writes it>",
    boot: "<Lua run at boot: peripherals, monitors, then shell.run(program)>",
    monitors: [{ name: "top", blocksWide: 6, blocksHigh: 6 }],
    screens: ["monitor:top", "terminal"],            // what is shown, in order (also "pixels:<gpu>")
    terminal: "hide",                                // show | hide (the Terminal button toggles it)
  }],
}
```

A cart with two or more computers links their modems: the player routes `ccsim_net` / `ccsim_link` between them
exactly as the runner's network does (`packages/runner/src/network.ts`); range and channel rules are in
`ccsim/modem.lua`. Carts are made by `web/build-carts.mjs`; add one there (a folder, a world, the program, monitors,
layout, world buttons).

Computers start fresh from their cart every time: files they write live until the cart is reset or the computer is
turned off and on.
