# CC: DirectGPU 1.0.25 emulation

Addon id `directgpu`. Lua in `rom-overlay/rom/ccsim/addons/directgpu/` (`init.lua`; `methods.lua` lists the
peripheral's methods).

Source of truth: the release jar `directgpu-1.0.25-neoforge-1.21.1.jar` from
[github.com/tiktop101/CC-DirectGPU-Mod](https://github.com/tiktop101/CC-DirectGPU-Mod/releases/tag/1.0.25),
decompiled with Vineflower 1.10.1: the repository holds only examples and a README. Classes below are under
`com/tom/directgpu/`: `DirectGPUPeripheral`, `DirectGPUDisplay`, `DirectGPUBlockScopedManager`, `DirectGPUConfig`.

## Versions

| Minecraft | Mod release                                                                      |
| --------- | -------------------------------------------------------------------------------- |
| 1.21.1    | 1.0.25 (NeoForge)                                                                |
| 1.20.1    | left out: 1.0.19 and older are Forge 1.20.1 builds of an older API, not emulated |
| 1.18.2    | none                                                                             |

## Peripheral: `directgpu`

149 methods (all `@LuaFunction`, none `mainThread`: every one answers at once). `peripheral.getMethods` lists all of
them in CC 1.121's `HashMap` order. A display is a picture of `164 x blocks` pixels a side times its resolution,
drawn on a monitor or anywhere in the world; up to 10 per GPU, ids from 0 (freed ids come back).

Emulated, with the mod's argument handling and error texts:

| Methods                                                                                                                                                | What                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `autoDetectAndCreateDisplay([monitor], [resolution])`, `autoDetectAndCreateDisplay([monitor], resX, resY)`, `autoDetectAndCreateDisplayWithResolution` | a display on a monitor (the named one, or the first): resolution 0.1..4 (1 = 164 px a block), or an exact pixel size 1..4096; the same monitor and size reuse the display |
| `createDisplay(x, y, z, facing, width, height, [resolution] or [resX, resY])`, `createDisplayAt`, `createDisplayWithResolution`                        | a display anywhere: facing north/south/east/west/up/down or `cc:<front>:<right>:<down>`, 1..16 blocks a side                                                              |
| `removeDisplay`, `listDisplays`, `clearAllDisplays`, `getDisplayInfo`                                                                                  |                                                                                                                                                                           |
| `setPixel`, `getPixel`, `clear`, `fillRect`, `drawLine`, `drawPolylines`, `drawPolygon`, `drawCircle`, `drawEllipse`, `fillEllipse`                    | drawing; colours clamp to 0..255                                                                                                                                          |
| `clipRect`, `clearClip`                                                                                                                                | a clip rectangle every drawing call keeps to (`clear` with a clip fills just the clip)                                                                                    |
| `updateDisplay`                                                                                                                                        | sends the frame                                                                                                                                                           |
| `enableMouseEvents(display, on, [hover])`, `pollEvent`, `hasEvents`, `clearEvents`                                                                     | mouse input: a queue of up to 100 `{ type, x, y, button, timestamp }`, and with events on, `directgpu_mouse (display, type, x, y, button)` (hover only when asked)        |

The pixels are the server's copy (the back buffer), drawn the way the default config draws them
(`clientAcceleratedRendering`: every call becomes a command, which `applyCommandStreamToBackBuffer` rasterises; a
filled circle is rows of `2 * floor(sqrt(r^2 - y^2))` pixels, an outline the midpoint circle), so `getPixel` reads
back what it would in game.

## Screenshots

`updateDisplay(id)` writes the display to `/results/pixels/<gpu name>.<id>.ppm`, the generic pixel-screen file
(`packages/runner/src/engine.ts` `pixelScreens`), so `craftos_screenshot` and the web app show it like a Tom's
Peripherals GPU screen. Drawing without `updateDisplay` changes nothing on screen, as in game; `removeDisplay`
removes it.

## Fixtures

```jsonc
{
  "name": "directgpu_0",
  "type": "directgpu",
  "monitors": {
    "monitor_0": {
      "x": 10,
      "y": 64,
      "z": -3,
      "facing": "north",
      "width": 2,
      "height": 1,
    },
  },
}
```

`monitors`: what `autoDetectAndCreateDisplay` can find, by peripheral name, with the monitor's position, facing and
size in blocks. They need not be monitor peripherals of the world.

## Sim commands

| Command   | Fields                                                                                                     |
| --------- | ---------------------------------------------------------------------------------------------------------- |
| `dgMouse` | `peripheral, display, x, y, type? (mouse_click, mouse_drag, mouse_up, mouse_scroll, mouse_hover), button?` |

`craftos_sim_state` `peripherals.<name>`: `{ displays = { [id] = { pixelWidth, pixelHeight, width, height, facing, x, y, z } } }`.

## Not emulated

Each of these is a method that raises "ccsim: DirectGPU's <name> is not emulated":

- text (`drawText`, `measureText`, `drawTextWithBg`, `drawTextWrapped`, fonts): Java AWT font rendering.
- images: JPEG, PNG, GIF and blurred/cover image loading and decoding, textures, `getDisplayFrameJpeg`, the
  compression dictionary (`compressWithDict` ...).
- 3D: camera, models, lights, primitives, z-buffer; metaballs; Bezier curves, SVG paths, rounded rectangles, stars.
- the world: `getWorldInfo`, `getWeather`, `getTimeInfo`, `getMoonInfo`, `getDimension`, `getBiomeAt`, calibration.
- `createDisplay("gui"|"map", ...)` (screens inside the computer's GUI and on maps), display movement, rotation and
  opacity, delta mode, `termRedirect` / `termRender`, `mirrorDisplay`, `autoDetectMonitor(s)` and its info calls,
  `getResourceStats`, `getRecommendedJPEGSettings`, `stopGIF`.
- The distance check between the GPU block and a display it creates, and server-side bandwidth limits.
