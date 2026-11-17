# Lake's CC Additions 1.7.0 emulation

Addon id `lakes-cc-additions`. Lua in `rom-overlay/rom/ccsim/addons/lakes-cc-additions/` (`init.lua`; `nbt.lua`
reads and writes Minecraft's SNBT).

Source of truth: [github.com/lakehouse445/lakes-cc-additions](https://github.com/lakehouse445/lakes-cc-additions) at
commit `6ecd001` ("release: 1.7.0"), `src/main/java/gg/lakehouse/scanner/`. MIT licence. Map colours are Minecraft's
`MapColor` table, read from the 1.18.2 client jar's `MaterialColor` (ids 0-61; 1.20.1 renamed the class, not the
colours).

## Versions

| Minecraft | Mod release   |
| --------- | ------------- |
| 1.20.1    | 1.7.0 (Forge) |
| 1.18.2    | none          |
| 1.21.1    | none          |

## Peripheral: `scanner` (`ScannerPeripheral`, `ScannerBlockEntity`)

19 methods. All are `mainThread` (they wait for the next tick) except `sha256`. `peripheral.getMethods` is CC 1.121's
`HashMap` order. Errors are the mod's own text ("Nothing to scan", "Item is not a folder", ...).

| Method                                                  | What                                                                              |
| ------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------- |
| `hasItem()`, `getItem()`                                | the slot; `{ name, count, displayName, damage?, maxDamage? }` or nil              |
| `scanNBT()`                                             | `{ name, count, nbt? }`: compounds and lists as tables, whole numbers as integers |
| `fingerprint()`                                         | SHA-256 hex of `"<id>                                                             | <Tag.toString()>"` (UTF-8) |
| `scanContainer()`                                       | the items in `BlockEntityTag.Items` (an empty shulker box gives `{}`)             |
| `sha256(text)`                                          | SHA-256 hex of the text's UTF-8 bytes                                             |
| `scanFolder()`                                          | what is filed in a folder: slot, name, count, type, title, fingerprint            |
| `countInk(x, y, w, h, page?, folderSlot?)`              | pen ink in a rectangle: `{ total, dark, red, blue }`                              |
| `scanStamp()`                                           | a stamp's 32x32 emblem as rows of `0`-`3`                                         |
| `scanPrintout(folderSlot?)`                             | a printout's pages (21 lines of 25, text and colour, pen drawing rows)            |
| `createPrintout(pages, title?)`                         | prints a page or pages into the empty slot, or files it into a folder             |
| `scanBook()`                                            | a book and quill or written book (JSON pages as plain text)                       |
| `scanMap()`                                             | a filled map's centre, scale, lock, dimension, decorations                        |
| `scanMapPixels()`                                       | its 128 rows of raw colour bytes                                                  |
| `scanMapForMonitor()`                                   | blit rows and the 16 commonest colours                                            |
| `scanMapTile()`                                         | blit rows on the mod's fixed atlas palette, and the map's grid cell               |
| `scanPhoto`, `scanPhotoForMonitor`, `scanPhotoForPrint` | Exposure photographs; see Not emulated                                            |

`createPrintout` with `requirePrintoutMaterials` on takes paper from a folder in the slot, or needs an exact stack of
one paper per page in it. Events: `scanner` `(side, hasItem)` whenever the slot changes, `scanner_biometric` `(side,
playerName, uuid)` when a player sneak-clicks it with an empty hand.

## Fixtures

```jsonc
"lakesCcAdditions": { "requirePrintoutMaterials": false, "exposure": false },
{ "name": "top", "type": "scanner", "item": {
    "name": "lakescanner:folder", "count": 1, "displayName": "Case 42",
    "nbt": "{Items:[{Slot:0b,id:\"computercraft:printed_page\",Count:1b,tag:{Title:\"Witness\",Pages:1,Text0:\"...\"}}]}",
    "drawings": { "1": ["0123", "..."] },   // pen ink per page, rows of 0-3 (written to LakeDrawing<n>)
    "emblem": ["..."],                       // a stamp's 32 rows of 0-3 (written to Emblem)
    "map": { "centerX": 0, "centerZ": 0, "scale": 0, "locked": false, "dimension": "minecraft:overworld",
             "decorations": [{ "type": "player", "x": 0, "y": 0, "rotation": 0, "name": "..." }],
             "colors": [/* 16384 packed map colour bytes */], "fill": 0 } } }
```

`nbt` is SNBT, read as Minecraft's `TagParser` reads it, so the types (and the fingerprint) match the game.
`displayName` defaults to the item path in title case (the game's is the translated name). `damage`/`maxDamage` make
it a damageable item. `map` is the map's saved data (`colors`, or one `fill` byte for all).

## Sim commands

| Command       | Fields                                                         |
| ------------- | -------------------------------------------------------------- |
| `lkSetItem`   | `peripheral, item` (a fixture item, or null to empty the slot) |
| `lkBiometric` | `peripheral, player?, uuid?`                                   |

`craftos_sim_state` `peripherals.<name>`: `{ item = { name, count, displayName, nbt (SNBT), map } }`.

## Not emulated

- Exposure photographs. Without the Exposure mod (the default here) the three photo methods raise "The Exposure mod
  is not installed", as in game; with `exposure: true` they raise an error saying the emulator does not do them.
- The Pocket Multitool upgrade (an ender modem and a speaker in one pocket peripheral). Use a pocket world with an
  ender modem and a speaker instead.
- The pen, stamp and folder as items in a player's hands, and the Camo Network Cable (a plain wired cable to a computer).
- Written book pages that are not JSON text components (selectors, translations) are flattened to their `text` parts.
