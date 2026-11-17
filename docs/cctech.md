# CCTech 0.1.6 emulation

Addon id `cctech`. Lua in `rom-overlay/rom/ccsim/addons/cctech/init.lua`; the jar's ROM files in `rom/` next to it.

Source of truth: [github.com/ShreksHellraiser/cctech](https://github.com/ShreksHellraiser/cctech) branch `1.18.2` at
commit `ab949e6` (9 May 2023, the day 0.1.6 came out; built against CC:Tweaked 1.100.9), checked against
`cctech-1.18.2-0.1.6.jar` with `javap` (the peripheral types) and by comparing its ROM files. Paths below are under
`src/main/java/github/shrekshellraiser/cctech/`. MIT licence.

## Versions

| Minecraft | Mod release |
| --------- | ----------- |
| 1.18.2    | 0.1.6       |
| 1.20.1    | none        |
| 1.21.1    | none        |

## Peripherals

| World type             | `getType`              | Block                | Methods                                                      |
| ---------------------- | ---------------------- | -------------------- | ------------------------------------------------------------ |
| `cassette_deck`        | `cassette_deck`        | Cassette Deck        | isReady, read, write, seek, setLabel, clearLabel, getSize    |
| `reel_to_reel`         | `reel_to_reel`         | Reel to Reel         | the cassette's, plus seekAbs, getPos, lock                   |
| `card_writer`          | `magnetic_card_reader` | Magnetic Card Writer | writeCard, setLabel, getLabel, clearLabel, readCard, getUUID |
| `magnetic_card_reader` | `magnetic_card_reader` | Magnetic Card Reader | none; it sends `magnetic_card_scanned`                       |

The card writer really does call itself `magnetic_card_reader` (`CardWriterPeripheral.getType`, also in the jar), so
`peripheral.find("magnetic_card_reader")` finds writers and readers alike; the world tells them apart by `card_writer`.
Every method is a plain `@LuaFunction` (computer thread). `peripheral.getMethods` is CC 1.101.3's `HashMap` order.

### Tape drives (`common/peripheral/tape/TapePeripheral`, `TapeBlockEntity`, `cassette/*`, `reel/*`)

A tape's data is a byte array: a 4-byte pointer, then `length` bytes (`server/FileManager`). The block keeps one queue
of operations and works through it on its tick, one at a time.

| Method                           | What                                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `isReady()`                      | a tape is in the slot (the reel: and it is locked)                                                             |
| `read(n = 1, async = false)`     | the next n bytes as a string; "Cannot read <1 bytes." for n < 1, "Attempt to read past tape end." past the end |
| `write(text, async = false)`     | true; false when it does not fit (see below)                                                                   |
| `seek(offset, async = false)`    | how far the head moved, clamped to the tape                                                                    |
| `seekAbs(pos, async = false)`    | reel only: the same, to an absolute position                                                                   |
| `getPos()`                       | reel only: the head position                                                                                   |
| `lock(state = not locked)`       | reel only: the new state; "Door open" while the door is open                                                   |
| `setLabel(text)`, `clearLabel()` | the tape's label, nothing returned                                                                             |
| `getSize()`                      | the tape's length                                                                                              |

read, write and seek move the head at once and queue an operation. With `async` they return at once (true, or false
for a write that does not fit); without it they wait for its event (`MethodResult.pullEvent`) and return its value.
The event is `tape_read` / `tape_write` / `tape_seek` with `(side, true, value)`; it comes `(int)(bytes *
ticksPerByte)` ticks after the tick that takes the operation off the queue, plus one: ticksPerByte is `20 /
bytesPerSecond` (cassette 10000, reel 20000), so a short read still waits for the next tick. A wait takes the first
event of its name, from any drive. When the wait ends the drive is checked again, so taking the tape out meanwhile
raises "No device inserted.".

Every method but isReady, getPos and lock first checks the drive: "Door open", the reel's "Door unlocked" (its block's
LOCKED state, which follows `lock()` on the block's next tick), "No device inserted.".

The mod's own bugs, kept: a write that does not fit copies `pointer - (length)` bytes, which is never positive, so at
the very end it writes nothing and returns false, and anywhere before the end it fails with "Java Exception Thrown:
java.lang.ArrayIndexOutOfBoundsException: arraycopy: length -N is negative". The saved pointer is read back by adding
signed bytes (`FileManager.getPointer`), so a cassette whose pointer had a byte of 128 or more comes back with a wrong,
often negative, pointer. The reel always starts at 0 when a tape goes in.

### Card writer and reader (`common/peripheral/cards/*`, `common/item/cards/MagCardItem`)

| Method            | What                                                                |
| ----------------- | ------------------------------------------------------------------- |
| `writeCard(text)` | nothing; the card's contents become text and its UUID the writer's  |
| `readCard()`      | `{ uuid, contents }`, or nil for a card with no UUID or no contents |
| `setLabel(text)`  | nothing                                                             |
| `getLabel()`      | the card's label, or nil                                            |
| `clearLabel()`    | true                                                                |
| `getUUID()`       | the writer's UUID (the card writer block's own)                     |

All but getUUID raise "Door open" or "No card inserted". A player using a card on a reader sends
`magnetic_card_scanned` with `(writerUUID, contents)`, no side name (`MagCardPeripheral.cardScanned`).

### ROM files

From the jar, unchanged: `rom/programs/tape.lua` (the `tape` program: load, save, delete, seek, list, wipe, size,
lock, unlock) and `rom/autorun/cctech_completion.lua` (its completion). The program has its own bugs (its
`protectedRead` calls `pcall` on the read's result, so it never finds a file); they are the mod's.

## Fixtures

```jsonc
"cctech": { "cassetteBytesPerSecond": 10000, "reelBytesPerSecond": 20000, "defaultLength": 360000 },
"peripherals": [
  { "name": "left", "type": "cassette_deck", "open": false,
    "tape": { "uuid": "…", "length": 360000, "label": "songs", "data": "HELLO", "pointer": 0 } },
  { "name": "right", "type": "reel_to_reel", "locked": true, "tape": { "length": 4096 } },
  { "name": "back", "type": "card_writer", "open": false, "writerUUID": "…", "card": { "uuid": "…", "contents": "…", "label": "…" } },
  { "name": "top", "type": "magnetic_card_reader" }
]
```

`tape.data` is what the tape holds from position 0 and `tape.pointer` its saved pointer; both only for a tape with no
file yet. A tape's file is `results/addons/cctech/<cassette|reel>/<uuid>`, written when the tape comes out and when the
sim state is saved, so the same uuid carries its data from one drive to another.

## Sim commands

| Command        | Fields                                                                      |
| -------------- | --------------------------------------------------------------------------- |
| `ctSetDoor`    | `peripheral, open`: a drive's or writer's door (a locked reel's stays shut) |
| `ctInsert`     | `peripheral, tape?` (as the fixture): a tape goes in; the door must be open |
| `ctEject`      | `peripheral`: the tape comes out, its data saved; the door must be open     |
| `ctInsertCard` | `peripheral, card?`: a card goes into the writer; the door must be open     |
| `ctEjectCard`  | `peripheral`                                                                |
| `ctSwipe`      | `peripheral, uuid?, contents?`: a player uses a card on a reader            |

`craftos_sim_state` `peripherals.<name>`: a drive's `open`, `locked`, `tape`, `pointer`, `queue` (operations waiting)
and `busy`; a writer's `open`, `writerUUID`, `card`.

## Not emulated

- A tape's length growing when a player adds magnetic tape to it (`TapeItem.use`): give the fixture its final length.
- Tape and card colours, the GUI and sounds.
- `data/computercraft/TODO-FAT` in the jar: not under the ROM, so CC never loads it.
