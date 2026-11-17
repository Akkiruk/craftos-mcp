# SwitchCraft Peripherals 1.10.5 emulation

Addon id `sc-peripherals`. Lua in `rom-overlay/rom/ccsim/addons/sc-peripherals/init.lua`.

Source of truth: [github.com/SwitchCraftCC/sc-peripherals](https://github.com/SwitchCraftCC/sc-peripherals) at commit
`50e801b` ("feat: 1.10.5"), built against CC:Tweaked 1.110.1. Paths below are under
`src/main/kotlin/io/sc3/peripherals/`; the config defaults are `resources/data/sc-peripherals/default-config.toml`.
MIT licence. The poster printer's default palette is Minecraft's `MapColor` table (see docs/lakes-cc-additions.md).

## Versions

| Minecraft | Mod release            |
| --------- | ---------------------- |
| 1.20.1    | 1.20.1-1.10.5 (Fabric) |
| 1.18.2    | none                   |
| 1.21.1    | none                   |

## Peripherals

| Type             | Block          | Methods                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `3d_printer`     | 3D Printer     | reset, getLabel, setLabel, getTooltip, setTooltip, getLightLevel, setLightLevel, getRedstoneLevel, setRedstoneLevel, getButtonMode, setButtonMode, isCollidable, setCollidable, getStateLighting, setStateLighting, getSeatPos, setSeatPos, getShapeCount, getMaxShapeCount, addShape, addShapes, commit, stop, status, getChameliumLevel, getInkLevel, and size, list, getItemDetail, getItemLimit, pushItems, pullItems |
| `poster_printer` | Poster Printer | reset, getLabel, setLabel, getTooltip, setTooltip, setPaletteColor, setPaletteColour, setPixel, blitPixels, blitPalette, commit, stop, status, getInkLevel, and the six inventory methods                                                                                                                                                                                                                                 |

All are `mainThread` except `getMaxShapeCount`. `peripheral.getMethods` is CC 1.121's `HashMap` order.

### 3D printer (`prints/printer/PrinterPeripheral`, `PrinterBlockEntity`, `prints/PrintData`, `prints/Shapes`)

- Shapes are a `HashSet`: an equal shape (same box, texture and tint) added twice is there once. Coordinates are
  clamped to 0..16 and the box takes the smaller corner first; "Empty block" for a flat box, "Too many shapes" past
  `max_shapes` (128). Textures are cut to 64 characters and made identifiers (`minecraft:` when no namespace); a bad one
  is Minecraft's `InvalidIdentifierException`. Tints lose their alpha. `addShapes` checks its table as `LuaTableExt`
  does ("Invalid shape table", "bad item #1 (table expected, got string)", "bad field 'texture' ...").
- Labels and tooltips are read as UTF-8 and kept only at 1..48 (256) chars, control characters dropped; they come
  back one byte per char (a char above 255 as "?").
- `setLightLevel` clamps to 0..`max_base_light_level` (7), `setRedstoneLevel` to 0..15. `setSeatPos(x, y, z)` needs
  all three in 0.1..0.9 ("Seat position must be between 0.1 and 0.9 on all axes"); fewer clears it.
  `getSeatPos()` returns three values (three nils when none). `isCollidable` and `getStateLighting` return two.
- `commit(n)`: "Model is invalid" with no off-state shapes; else true when n > 0 and printing starts. Each copy
  takes `(max(volume / 2, 1) + redstone) * noclip` chamelium and `max(surface / 6, 1)` ink (redstone 300 for a level
  of 1..14, noclip x2 when not collidable), when there is enough and the output slot takes it, and comes out
  `print_ticks` (100) ticks later. `status()` is `"busy", progress` or `"idle", canPrint`.
- The input slots work on the block's tick: a chamelium item (slot 1) adds 2000 while there is room for it
  (max 256000); an ink cartridge (slot 2) adds 50000 (max 100000) and leaves an empty cartridge.
- Events, to every computer attached: `3d_printer_state` `(status)` when printing starts or a model change stops it
  and after each copy, `3d_printer_complete` `(remaining)` after each copy. The one queued by `commit` itself is lost
  in game too: it arrives while the main-thread call waits for its `task_complete`.
- Changing the model while printing stops the job (`dataUpdated`).

### Poster printer (`posters/printer/*`, `posters/PosterPrintData`)

- `setPixel(x, y, colour)`, `blitPixels(x, y, list)` (indices from x, y onwards; numbers wrap to a signed byte first,
  as Kotlin's `toByte()`), `setPaletteColor(index, r, g, b)` (1..63; 0 is transparent), `blitPalette(list)` (from
  index 1, at most 63, each 0..0xFFFFFF).
- A copy takes one paper (slot 1) and `round(5000 * coloured pixels / 16384)` ink (at least 1 for any pixel) and comes
  out 100 ticks later. Events `poster_printer_state` and `poster_printer_complete`, as the 3D printer's.
- `getInkLevel()` returns the ink and 100000.

## Fixtures

```jsonc
"scPeripherals": { "printTicks": 100, "chameliumValue": 2000, "inkValue": 50000, "maxBaseLightLevel": 7, "maxShapes": 128,
  "customRedstoneCost": 300, "noclipCostMultiplier": 2, "posterPrintTicks": 100, "posterInkCost": 5000 },
"peripherals": [
  { "name": "left", "type": "3d_printer", "chamelium": 10000, "ink": 10000,
    "items": { "1": { "name": "sc-peripherals:chamelium", "count": 4 }, "2": { "name": "sc-peripherals:ink_cartridge" } } },
  { "name": "right", "type": "poster_printer", "ink": 20000, "items": { "1": { "name": "minecraft:paper", "count": 8 } } }
]
```

Slots: 1 chamelium (paper for the poster printer), 2 ink, 3 output.

## Sim commands

| Command     | Fields                                                   |
| ----------- | -------------------------------------------------------- |
| `scSetItem` | `peripheral, slot (1-3), item ({ name, count }) or null` |

`craftos_sim_state` `peripherals.<name>`: status, progress, printing, printCount, ink, chamelium, shape counts, items.

## Not emulated

- What a print or poster looks like, and the print as a block (light, redstone, buttons, seats).
- Recycling prints into chamelium (`recycle_value_multiplier`) and the slot restrictions for hoppers
  (`canInsert`): any item can be pushed into any slot here.
- The output item's NBT: prints stack when their models are equal, posters when they share a poster id.
