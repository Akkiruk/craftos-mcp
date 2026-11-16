# Tom's Peripherals 1.18.2-1.2.1

Addon id `toms-peripherals`. Lua in `rom-overlay/rom/ccsim/addons/toms-peripherals/`. Tests in
`packages/runner/src/toms-peripherals.integration.test.ts`. Demo world: `worlds/toms-peripherals-demo.json`.

Written from the mod's source and checked against the release jar `toms-peripherals-1.18.2-1.2.1.jar` (Modrinth,
the last Forge 1.18.2 release, 2024-04-15). The repo has no tags; the code is:

- `1.18` branch, commit `3b609fa` ("1.2.1"): `Forge/src/platform-shared/java/com/tom/peripherals/` (block entities,
  menu, client, cc glue, `util/NativeImageIO`, `Config`).
- `api` branch, commit `5dbf6fc` (the API code built into 1.2.1): `src/shared/java/com/tom/peripherals/` (`gpu/*`,
  `util/*`, `api/*`, `math/*`).

Paths below are short: `GPUBlockEntity` is the 1.18 branch file, `BaseGPU` the api branch file.

The GPU's fonts (`fonts.lua`) are generated from the mod's jar, not shipped in the public copy:
`node scripts/build-toms-fonts.mjs` (pinned jar from Modrinth, sha512 checked; `--jar <path>` for a local one).
`scripts/build-rom.mjs` runs it when the file is missing. Without it every GPU call fails with
`Tom's Peripherals fonts missing: run node scripts/build-toms-fonts.mjs`; the other blocks still work.

## Peripherals

| type          | block                     | notes                                            |
| ------------- | ------------------------- | ------------------------------------------------ |
| `tm_gpu`      | GPU                       | draws on the monitor wall next to it             |
| `tm_keyboard` | Keyboard, Keyboard Dongle | one block entity for both (`Content.keyboardBE`) |
| `tm_rsPort`   | Redstone Port             | six sides of redstone                            |
| `tm_wdt`      | Watch Dog Timer           | restarts the computer it faces                   |

The Monitor block is not a peripheral. In a world it is the GPU's `monitor` field.

Every method is an `IDynamicPeripheral` method (`CCPeripheral.PeripheralWrapper`), so every one runs at once on
the computer thread; none waits for a tick. `peripheral.getMethods` order is CC's `HashMap(n)` filled in the mod's
own order, which is `ITMPeripheral.findLuaMethods`' `HashMap` (both worked out from `String.hashCode` with the
method lists read from the jar; `toms-peripherals-surface.json`). `listMethods` (a method every object has) returns
the mod's order.

## World fixture

```json
{
  "peripherals": [
    { "name": "gpu", "type": "tm_gpu", "monitor": { "width": 2, "height": 1 } },
    { "name": "kb", "type": "tm_keyboard", "dongle": false },
    {
      "name": "rs",
      "type": "tm_rsPort",
      "inputs": { "north": 15 },
      "bundledInputs": { "east": 3 }
    },
    {
      "name": "wdt",
      "type": "tm_wdt",
      "timeout": 200,
      "enabled": false,
      "target": true
    }
  ],
  "tomsPeripherals": { "maxScreenSize": 16 }
}
```

- `monitor`: the wall in blocks, as the GPU finds it: grown right and up from the monitor next to the GPU
  (`connectMonitors`, `getMonitorsRight`, `getMonitorsUp`). Leave it out for no monitor.
- `dongle`: the block is a Keyboard Dongle (portable keyboard events).
- `inputs`, `bundledInputs`: redstone coming in, by side (`down up north south west east`).
- `timeout`: the watchdog's stored time limit in ticks (NBT `timeLimit`); `enabled`: stored as on; `target: false`:
  the block faces no computer.
- `tomsPeripherals.maxScreenSize`: the server config (`Config.Server`, default 16).

The GPU's state, the port's outputs and the watchdog's settings survive a reboot, as blocks do.

## Sim commands

| command                                                                                   | what                                                                                                                                |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `tmTouch {peripheral?, x, y, sneak?}`                                                     | a right-click on the wall at pixel x, y (1-based, top-left, at the GPU's current size)                                              |
| `tmMonitorEvent {peripheral?, event, x, y, param?}`                                       | a keyboard pointing at the wall: `mouse_click`, `mouse_up`, `mouse_scroll`, `mouse_drag`, `mouse_move`, `mouse_enter`, `mouse_exit` |
| `tmSetMonitors {peripheral?, width, height}`                                              | the wall is rebuilt (the GPU sees it after `refreshSize`)                                                                           |
| `tmReloadGpu {peripheral?}`                                                               | the chunk reloads: a fresh GPU, blank monitors                                                                                      |
| `tmKey {peripheral?, key, repeat?}`, `tmKeyUp {peripheral?, key}`                         | key code or a `keys` name                                                                                                           |
| `tmChar {peripheral?, char}`, `tmType {peripheral?, text}`, `tmPaste {peripheral?, text}` | `tmType` sends one char event per character                                                                                         |
| `tmKeyboardEvent {peripheral?, event}`                                                    | the keyboard screen's `terminate`, `shutdown`, `reboot`                                                                             |
| `tmPortable {peripheral?, connected, id?}`                                                | a portable keyboard opens or closes on a dongle                                                                                     |
| `tmSetRedstoneInput {peripheral, side, level?, bundled?}`                                 | input changes; `tm_redstone` comes on the next tick                                                                                 |

`peripheral?` defaults to the first GPU or keyboard. Time moves with `advance`.

## Screens

On every save the GPU writes what its monitors show to `/results/pixels/<name>.ppm` (binary P6, RGB). The runner
reads that folder (`pixelScreens` in `packages/runner/src/engine.ts`): screenshots (`craftos_screenshot`, `craftos_run`
with screenshots) get one PNG per GPU, `craftos_ui` lists `pixelScreens` with size and a hash. Nothing is written
before the first `sync`; that is when a real monitor first shows anything.

## tm_gpu

The GPU block (`GPUBlockEntity.GPUPeripheral`, `GPUExt`):

- `getSize` returns width, height, blocks wide, blocks high, pixels per block. Until the monitors are looked for
  (`refreshSize`, `sync`, or a touch) the size is 0 x 0 (`maxX = maxY = 0`), with a hidden 16 x 16 buffer.
- `refreshSize` looks for the wall (`getMonitors(true)`). A wall over `maxScreenSize` sets error 1: every later call,
  `refreshSize` included, fails with `Attached screen too big`. No VRAM for the screen: error 2,
  `Not enough VRAM for screen buffer`. Only a reload clears them.
- `setSize(16..64)`: `Bad Argument #1, (too small number (s) minimum value is 16 )` / `too big ... maximum value is
64 )`; reallocates (`Realloc failed: Out of VRAM`) and clears the screen.
- `set` stores `Integer.reverseBytes(c) >> 8 | 0xFF000000`: the colour's RGB, alpha always opaque. Out of the buffer
  it throws `ArrayIndexOutOfBoundsException`.
- `sync` hands the buffer to the monitors (`sync0`, via the server). Each monitor takes its square
  (`separateIntArray`) and remembers the size as its width.
- VRAM: 16 MiB fixed (`new VRAM(16 * 1024 * 1024)`; the config's `maxVRAMSize` is unused). The screen counts
  `w * h * 4`, images `w * h * 4`, buffers their capacity, GPU3D its depth buffer plus 1024, textures `w * h * 4`
  (1 when empty). Windows are never counted.

Drawing (`BaseGPU`), shared by the GPU, windows and images. Coordinates are 1-based, colours ARGB ints:

- Colours (`ParamCheck.toColor`): 3 numbers r, g, b (alpha 255); 4 numbers r, g, b, a; otherwise the first number,
  `(int) d.longValue()`.
- `fill([colour])`, `filledRectangle`, `rectangle`: start must be inside (or one past) or `Out of boundary`; the end
  is clipped. Default colour 0.
- `line`: Bresenham, both ends; a pixel off the screen gives its exception's message (`Index 16 out of bounds for
length 16`). `lineS`: the other walk (`lineF`), checks `Out of bounds: x` / `y`, and never draws the last point.
- `drawText(x, y, text, [colour], [bg], [size], [padding])`: the bitmap font, `Out of boundary x <x>:<x+len>` and
  `Out of boundary y` (the height check ignores the size). A space is 5 wide and draws no glyph. A glyph running off
  the bottom stops the text there (`IndexOutOfBoundsException` is caught). A number is drawn as Java prints it
  (`5.0`). `bg = -1` (default) draws no background; any colour `>= 0x80000000` saturates to `0x7FFFFFFF` (white).
- `drawTextSmart`: per character the ascii font at twice the size, or `unicode_page_00` with `force_unicode`.
- `getTextLength`, `setFont`, `getFont`, `drawChar`, `addNewChar`, `delChar`, `freeChars`, `clearChars`,
  `setFontDefaultCharID`, `getFontDefaultCharID`: as `BaseGPU` and `Font`. Fonts: `ascii`, `ascii_sga`,
  `unicode_page_XX`, editable `unicode_page_e0` to `e4` (one copy per GPU). A missing font fails once
  (`Font file not found`), then loads as the empty `MISSING` font, after which drawing text throws a
  `NullPointerException`, as in the mod.
- `drawBuffer(x, y, w, scale, colours...)`, `drawImage(x, y, ref)` (clipped).
- `createWindow(x, y, w, h)`: a `BaseGPU` over its own buffer; `sync` copies it to the parent. `getBounds` is its
  live rect: changing w or h makes the next `sync` reallocate and draw nothing (`Invalid window size` for 0).
- `createWindow3D`: GPU3D, below.

Images and buffers (`GPUImpl`, `LuaImage`, `LuaByteBuffer`):

- `newImage(w, h)`, `imageFromBuffer(w, colours...)` (a partial last row stays in the array), `decodeImage(ref or
bytes...)`, `newBuffer([size 32])`.
- `LuaImage.setRGB` and `getRGB` add 1 to x and y (the source has `+ 1`), so `setRGB(0, 0)` writes (1, 1) of a
  0-based image. They index `y * w + x`, so x past the row wraps to the next. Images keep alpha.
- `free` removes the object from VRAM and its reference; later calls give `Error: Use after free`
  (`setRGB`/`getRGB`: `NullPointerException`).
- Buffers: `write(bytes...)`, `read([n], -1 for all)` (`Index out of bounds`), `length`, `available`; capacity doubles.
- PNG: as Minecraft's `NativeImage` (LWJGL 3.2.2 stb). Read as RGBA (any colour type, depth, palette, tRNS,
  interlace), errors with stb's messages (`Could not load image: Corrupt PNG`, `Image not of any known type, or
corrupt`, ...). `saveImage` writes stb_image_write's exact bytes (its filter choice and fixed-Huffman deflate).
  Both are checked against LWJGL 3.2.2 itself (`toms-peripherals-stb.json`).

Errors: a LuaException gives its message. Any other Java exception from a peripheral method reaches CC as
`Java Exception Thrown: <exception>`; from a returned object (window, image, buffer, rect, GPU3D) TMLuaObject words
it `Java Exception: <exception>`.

Events: `tm_monitor_touch, name, x, y, sneak` (`monitorClick`); `tm_monitor_<event>, name, x, y, param`
(`monitorEvent`). x and y: the pixel in the block (`getMonitorPixel`: hit times the monitor's width, which is the
size at the last sync, 0 before) plus `size * block index`, plus 1. A monitor that the GPU never connected
(`gpuPos` null) sends nothing.

## GPU3D (createWindow3D)

A port of `GPU3D`, `Triangle`, `TriBuilder`, `TextureManager`, `Matrix4d` and the vectors, with Java's quirks kept
because the pixels depend on them: float arithmetic where Java has float (`glColor`'s `/ 255f`, the rasteriser's
`tstep`, the second half's `t`), shared vector objects (the vertex sort swaps values inside them; clipped triangles
share vertex arrays), the near plane clipping with the original positions, the interpolation `t` from the previous
intersection (`calcValue`), and a stable sort by mean depth. `getConstants` returns nothing: `@Const` has no
runtime retention, so `GLConstants.ALL_CONST` is empty. `glPopMatrix` on an empty stack throws
`java.util.EmptyStackException`. A failed `glEnd` (`Incomplete triangle`) leaves it building.

## tm_keyboard

`setFireNativeEvents(boolean)`, per computer, off at attach. Off: `tm_keyboard_<event>, name, args...`; on: the plain
CC event (`key, code, repeat`, `key_up`, `char`, `paste`, `terminate`...). `KeyboardMenu` sends `key`, `key_up`,
`char`, `paste` and the screen's `terminate`/`shutdown`/`reboot` buttons. A dongle queues `portable_connect` with
id 0 (`KeyboardMenu` passes `randomId` before it sets it) and `portable_disconnect` with the id.

## tm_rsPort

`getSides` (`down up north south west east`), `getInput`, `getAnalogInput`/`getAnalogueInput`, `getBundledInput`,
`getOutput`, `getAnalogOutput`/`getAnalogueOutput`, `getBundledOutput`, `setOutput`, `setAnalogOutput`/
`setAnalogueOutput`, `setBundledOutput`, `testBundledInput`. Side names are case-insensitive; the value is checked
before the side. Outputs read back at once and reach the world on the next tick (`updateOutput`); an input change
queues `tm_redstone, name` on the next tick (`updateServer`). Sim state: `outputs` is what the world sees.

## tm_wdt

`isEnabled`, `getTimeout`, `setEnabled(boolean)`, `setTimeout(ticks >= 20)` (refused while enabled: `Can't edit
timeout value while the timer is enabled`), `reset`. Each tick while enabled the timer counts up; the tick it is
above the time limit the watchdog switches off and restarts the computer it faces (`updateServer`). Here: the
restart comes `timeLimit + 1` ticks after the first tick that follows `setEnabled(true)` or `reset`. Sim state:
`enabled`, `timeout`, `fired`, `restartsInMs`.

## Not simulated / not confirmed

- Work the mod hands to the server thread (`refreshSize`, `sync`'s monitor update, the watchdog setters) runs at
  once. On an idle server it runs within a fraction of a millisecond; on a busy one it waits for the end of the tick.
- `sync` copies the buffer at the call. The real monitor copy runs on the server shortly after, so drawing right
  after a `sync` without yielding can tear there.
- Pixels never drawn since the screen was made are 0 (transparent black) in the mod; the screenshot shows black.
- Only PNG decodes. stb's other formats (JPEG, BMP, GIF, TGA, PSD, HDR, PIC, PNM) fail with
  `Image not of any known type, or corrupt`. Some rare stb error texts may differ (all corrupt files give
  `Corrupt PNG` as in stb, but stb's reasons were not each checked).
- Only `ascii`, `ascii_sga` and `unicode_page_00` ship whole. Other unicode pages ship only glyph 0, which is all a
  Lua string can draw with them (CC hands Java strings of chars 0-255, and none of those pages has them);
  `drawChar` with another index on those pages draws nothing.
- Images and buffers Lua no longer holds leave VRAM when Lua collects them (the mod: when Java's GC does).
- Object references (`ref()`) are `ref:` plus a fixed sequence, not random.
- Helpful `NullPointerException` texts are written by hand; a few uncommon ones may differ.
- `Math.sin`/`tan` in Java and C can differ in the last bit; GPU3D could then differ by a pixel in rare cases.
- `getMethods` order: four pairs of names share a HashMap bucket inside one signature group (`newBuffer`/`newImage`,
  `delChar`/`setFont`, and in objects `available`/`length`, `setH`/`setX`, `getH`/`getX`, `glFrustum`/`glVertex`,
  `glRotate`/`glTexImage`, `getAnalogueInput`/`getAnalogueOutput`); their order there follows `Class.getMethods`,
  taken here as the class file's order, not confirmed in game.
- Monitor walls are a size, not blocks: facing, a wall the GPU touches in the middle, mixed facings and the
  monitors' own block textures are not simulated. A touch is placed at the centre of the pixel asked for.
- The keyboard screen's keys (GLFW codes) are sent as given; `tmType` sends only char events.
- The watchdog restarts only this computer; with `target: false` it just switches off.
- The redstone port's outputs do not feed other simulated blocks.
