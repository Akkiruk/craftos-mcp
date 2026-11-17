# Classic Peripherals emulation

Classic Peripherals by AlexDevs is **not in the pack**. The emulator follows two releases, picked by the world's
Minecraft version:

| Minecraft | Release | Loader           | Source                                                    |
| --------- | ------- | ---------------- | --------------------------------------------------------- |
| 1.18.2    | none    |                  |                                                           |
| 1.20.1    | 0.5.1   | Fabric only      | `github.com/Ale32bit/ClassicPeripherals` tag `v0.5.1`     |
| 1.21.1    | 0.6.6   | Fabric, NeoForge | the same repository, tag `v0.6.6` (`common/` and loaders) |

Method names, signatures and messages were checked in both jars (`classicperipherals-0.5.1-fabric-1.20.1.jar`,
`classicperipherals-fabric-1.21.1-0.6.6.jar` from Modrinth) with `javap`. Nothing here could be measured in game.

The addon id is `classic-peripherals`. The Lua is `rom-overlay/rom/ccsim/addons/classic-peripherals/`
(`init.lua`, `crypto.lua`, `zlib.lua`). Tests: `packages/runner/src/classic-peripherals.integration.test.ts`. Example:
`workspace/examples/classic-peripherals/badge_door.lua`, a door that opens for signed RFID badges.

## How the crypto was checked

The accelerator's answers come from Bouncy Castle 1.78.1 (bundled in the mod), javax.crypto (0.5.1's AES),
java.util.Base64 and java.util.zip. `crypto.lua` and `zlib.lua` are plain-Lua ports of each algorithm. To pin them,
the mod's own `core/Crypto.java` and `core/Compression.java` classes were run from the jars on a JVM (JDK 17 for
0.5.1, as Minecraft 1.20.1 runs; JDK 21 for 0.6.6) over about 470 inputs: every hash and HMAC at block-boundary
lengths and long keys, BLAKE3 in all three modes across chunk boundaries and extended output, AES with every key
size, wrong lengths, broken padding and wrong keys, java's base64 decoder on padding and character errors, Ed25519
signatures and verification (valid, flipped bits, a non-canonical `S`, small-order and non-canonical public keys,
non-canonical `R`), X25519 including low-order peers, and deflate on inputs from empty to 300 KB (stored, fixed and
dynamic blocks, window slides, more than 16383 symbols a block). The results, exceptions included, are
`packages/runner/src/classic-peripherals-vectors.json`; the integration test calls the peripheral with each input and
compares. Every one matches, byte for byte, deflate's output included (a port of zlib 1.2.x/1.3's `deflate_slow` and
`trees.c` at Deflater's defaults).

## Peripherals

| World type                   | `getType`                   | Block                                                           |
| ---------------------------- | --------------------------- | --------------------------------------------------------------- |
| `cryptographic_accelerator`  | `cryptographic_accelerator` | Cryptographic Accelerator (full or slim), turtle/pocket upgrade |
| `radio_tower`                | `radio_tower`               | Radio tower controller, mini antenna, turtle/pocket radio       |
| `nfc_reader`                 | `nfc_reader`                | NFC Reader                                                      |
| `rfid_scanner`               | `rfid_scanner`              | RFID Scanner, turtle/pocket RFID upgrade                        |
| `classicperipherals:scanner` | `scanner`                   | Scanner (reads printouts)                                       |

The scanner's type is `scanner`, which More Peripherals also uses, so the world names it
`classicperipherals:scanner`; programs see `scanner`.

`peripheral.getMethods` follows CC's HashMap of the declared methods (`init.lua`, `hashMapOrder`). Every value is
returned as Java returns it (`exactReturns`): a `void` method returns nothing, a `null` one nil.

### Cryptographic accelerator: 20 methods (0.5.1), 23 (0.6.6)

`peripherals/crypto/AbstractCryptographicAcceleratorPeripheral.java` (0.5.1: `peripherals/`). All run on the computer
thread.

- `md5`, `sha1`, `sha256`, `sha512 (data, hex?)`: hex (lowercase) by default, raw bytes with `false`.
- `hmacMd5`, `hmacSha1`, `hmacSha256`, `hmacSha512 (key, data, hex?)`.
- `blake3(data, hex?, mode?, key|context?, size?)` (0.6.6): mode `hash` (default), `keyed` (32-byte key) or `derive`
  (any context), any case; size 1 to 4096 bytes, 32 by default. The size is checked before the key is read.
- `random(...)`: 0.6.6: none `[0, 1)`; one `max` `[0, max)`, `0` is anywhere in `[-2^63, 2^63)`, negative is
  `bad argument #1 (interval is empty)`; two `[min, max)`, empty range the same error. 0.5.1: the bounds are ints
  and the mod's own formulas: one argument `floor(r * max)`, two `floor(r * max) + min`.
- `randomBytes(n)`: at most 65536 (0.6.6, `cryptographicRandomBytesMaxSize`) or 0x7ffffff0 (0.5.1), else
  `buffer size limit exceeded`; negative is `Java Exception Thrown: java.lang.NegativeArraySizeException: -n`.
- `encodeBase64(data)`, `decodeBase64(data)`: java's basic decoder. Bad input is nil on 0.6.6 and
  `Java Exception Thrown: java.lang.IllegalArgumentException: ...` (java's own message) on 0.5.1.
- `encryptAes(data, key, iv)`, `decryptAes(data, key, iv)`: AES-CBC with PKCS#7 padding. 0.6.6 checks lengths first
  (`bad argument length #2 (expected 16, 24, 32, got n)`, `bad argument length #3 (expected 16, got n)`), a broken
  padding is `pad block corrupted`, and ciphertext that is empty or not whole blocks is
  `Java Exception Thrown: org.bouncycastle.crypto.DataLengthException: last block incomplete in decryption`. 0.5.1
  uses SunJCE: an empty key is `Java Exception Thrown: java.lang.IllegalArgumentException: Empty key`, then the IV
  (`Wrong IV length: must be 16 bytes long`), then the key (`Invalid AES key length: n bytes`); decrypting a partial
  block is `Input length must be multiple of 16 when decrypting with padded cipher`, empty data decrypts to `""`, and
  broken padding is SunJCE's `Given final block not properly padded. ...`.
- `generatePrivateKey()`: 32 random bytes. `derivePublicKey(key)`, `sign(message, key)`,
  `verify(message, signature, publicKey)`: Ed25519. Keys must be 32 bytes and signatures 64
  (`Invalid key length, expected 32 bytes.`, `Invalid signature length, expected 64 bytes.`). A public key that is not
  a valid point of large order (y of 0, 1, p - 1, at least p, a point of order 8, or no point at all) makes Bouncy
  Castle's key constructor throw: `Java Exception Thrown: java.lang.IllegalArgumentException: invalid public key`.
  A non-canonical `S` or `R` verifies false.
- `deriveEcdhPublicKey(key)`, `computeSharedSecret(key, peerPublicKey)`: X25519. A low-order peer is
  `Java Exception Thrown: java.lang.IllegalStateException: X25519 agreement failed`.
- `deflate(data)`, `inflate(data)` (0.6.6): zlib streams as `java.util.zip.Deflater()` writes them. Anything inflate
  cannot finish (bad header, bad data, wrong Adler-32, truncated, a preset dictionary) is
  `invalid compressed data format`; bytes after the stream are ignored.

### Radio tower: 6 methods

`peripherals/radio/AbstractRadioPeripheral.java`, `core/RadioNetwork.java` (0.5.1: `core/TowerNetwork.java`).
`isValid`, `canBroadcast`, `broadcast(data)`, `setFrequency(f)` (the only one on the server thread), `getFrequency`,
`getHeight`.

- A tower (`kind: "tower"`) is valid with its head on and a height of 2 to 24 blocks, base and head included. Its
  range is `height * 128`, cut below y 96 to `floor(range * 1.0375^(y - 96))`, y being the head's (0.6.6: the head's
  centre, y + 0.5). A mini antenna has range 0 and height 1; turtle and pocket radios too, and are always valid.
- `broadcast` reaches every other radio on the same frequency and dimension within `max(sender range, receiver
range)`: `radio_message(name, data, distance)`. 0.6.6 measures across the ground (Y ignored), 0.5.1 in three
  dimensions. Past 85% of that range (`radioTowerLossFactor`) random bits are flipped, `ceil(bits * fraction)` of
  them. Errors: `The radio tower is not built correctly.`, `This antenna is not capable of broadcasting.`,
  `Frequency out of range. Must be between 0 and 65535.`

### NFC reader: 4 methods

`peripherals/nfc/*` (0.5.1: `peripherals/NfcReaderPeripheral.java`, `tiles/NfcReaderBlockEntity.java`). All four run
on the server thread.

- `write(data, label?, readOnly?, privateKey?)`: the next card tapped gets the data (cut to 128 bytes,
  `nfcMaxDataSize`), the label through CC's `normaliseLabel`, the read-only flag and, when given, the key; events
  `nfc_write(name, true, "success")` or `nfc_write(name, false, "read_only")`.
- `sign(data)`: the next card tapped signs it with its own key: `nfc_sign(name, signature, publicKey)`. A card that
  never held data has no key and is ignored.
- `cancelWrite()`, `cancelSign()`: whether that mode was on. Either one leaves the reader idle, whatever it was
  doing (the source sets the state to idle in both).
- Idle, a tapped card with data is read: `nfc_data(name, data, publicKey)`. A card with an id but no key is given a
  random key on its first tap.
- A pocket computer held to the reader (`cpNfcTapPocket`) gives its `os.nfc` data. The pocket's stored key comes back
  from `PocketNfcAccess.getPrivateKey` already turned into its public key, so the reader signs with that and reports
  the public key of it. A reader in write mode sends the pocket `nfc_data("internal", data, label, readOnly, key)`.

### RFID scanner: 1 method

`peripherals/rfid/AbstractRfidScannerPeripheral.java`. `scan()` runs the scan 4 ticks later, queues
`rfid_scan(name, badges)` and returns `badges`: `{ { data = ..., distance = ... }, ... }`. Like
`MethodResult.pullEvent`, the call waits for the first `rfid_scan` event from any scanner. Range 8
(`rfidScanRange`) from the block in front of the scanner (a turtle's or pocket's own position). In order: players
within 8 blocks (a sphere), each badge in their inventory then the worn one; other living entities and dropped
badges whose bounding box touches the 8-block box around the scanner (`AABB.ofSize`, so 4 blocks each way): first an
injected badge, then held ones; then dropped badges.

### Scanner: 5 methods

`peripherals/scanner/*`. `hasPages`, `getLabel` (nil for no title), `getPageCount` (0 without a printout), `eject`
(the next tick; then `scanner_eject(name)`), `scan`. `scan` returns `{ { texts, colours }, ... }` per page, and keeps
the mod's indexing: page 2's lines are at 22 to 42, not 1 to 21. Lines are 25 characters, padded with spaces and
colour `f` like a printed page. Putting a printout in queues `scanner(name)`, taking one out `scanner_eject(name)`,
replacing it both.

### os.nfc and os.ban

`require("os.nfc")` exists on a pocket computer (`classicPeripherals.pocket`): `write(data|nil)` (cut to 128 bytes),
`setPrivateKey(key|nil)`, `pop()`. On 1.21.1 every computer has `require("os.ban")`, a modem with range 1 on the
carrier's body (`open`, `isOpen`, `close`, `closeAll`, `transmit`, `isWireless`): with one computer per world, what it
sends reaches nobody, like a computer that is not carried.

## World fixture

Each `world.peripherals` entry: `name`, `type` and

| Type                         | Fields                                                                                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `radio_tower`                | `kind` (`tower`, `antenna`, `pocket`, `turtle`), `height`, `complete` (head on, default true), `valid`, `x`, `y`, `z` (the base), `dimension`, `frequency` |
| `rfid_scanner`               | `kind` (`block`, `pocket`, `turtle`), `x`, `y`, `z`, `facing` (`north` default), `dimension`                                                               |
| `classicperipherals:scanner` | `printout`: `{ title, pages, lines = { "text" or { text, color } } }` or `{ item = "id" }` (not a printout)                                                |

`world.classicPeripherals`:

- `seed`: the random numbers (keys, `random`, `randomBytes`, radio corruption); the clock when absent.
- `pocket`: true for a pocket computer (`os.nfc`, `nfc_data("internal", ...)`).
- `cards`: `{ id = { data, label, readOnly, privateKey } }`, the NFC cards `cpNfcTap` can use.
- `entities`: what RFID scanners see: `{ kind = "player", x, y, z, dimension?, inventory = { data, ... },
equipped? }`, `{ kind = "mob", x, y, z, width?, height?, injected?, hands = { ... } }`,
  `{ kind = "item", x, y, z, data }`.
- `config`: ClassicPeripheralsConfig overrides (`radioTowerMaxHeight`, `radioTowerMinHeight`,
  `radioTowerSegmentRange`, `radioTowerMinY`, `radioTowerLossFactor`, `radioTowerMaxMessageSize`,
  `antennaCanBroadcast`, `nfcMaxDataSize`, `rfidScanRange`, `cryptographicRandomBytesMaxSize`).

## Sim commands

| Command             | Fields                                                                         | Does                                          |
| ------------------- | ------------------------------------------------------------------------------ | --------------------------------------------- |
| `cpNfcTap`          | `peripheral`, `card` (an id from `cards`, or a card table)                     | holds a card to the reader                    |
| `cpNfcTapPocket`    | `peripheral`, `self: true` or `data?`, `privateKey?`                           | holds this (or another) pocket computer to it |
| `cpNfcCardToPocket` | `card`                                                                         | someone uses a card on this pocket's carrier  |
| `cpRadioReceive`    | `frequency`, `data`, `x?`, `y?`, `z?`, `dimension?`, `range?`                  | a broadcast from a radio outside this world   |
| `cpSetRadio`        | `peripheral`, `valid?`, `height?`, `complete?`, `x?`, `y?`, `z?`, `dimension?` | rebuilds or moves a radio                     |
| `cpSetEntities`     | `entities`                                                                     | replaces what RFID scanners see               |
| `cpSetPrintout`     | `peripheral`, `printout` (null takes it out)                                   | puts a printout in a scanner                  |

Sim state: each radio's kind, frequency, validity, height, range and position; each NFC reader's mode and pending
write or signature; each scanner's printout and what it ejected; under `addons.classic-peripherals` the release, the
last 50 broadcasts, the cards and the pocket's `os.nfc` data.

## Not emulated

- **The ender modem nerf and the redstone relay tweak.** With the mod installed, its mixins change CC itself: ender
  modems get twice a wireless modem's range and only reach another dimension within 8 (scaled) blocks
  (`enderModemNerf`, on by default), and the redstone relay's `redstone` event carries the relay's name
  (`betterRedstoneRelayEvent`). Both live in CC's own modem and relay code (`ccsim/modem.lua`, `ccsim/ap/simple.lua`),
  outside this addon, and are not changed by it.
- **Radio between computers.** Radios on one computer reach each other; another computer's broadcasts come in only
  through `cpRadioReceive`. The emulator's network relay carries modem packets, not radio.
- **Which bits a corrupted message loses.** The count is the mod's; the bits come from the emulator's own random
  generator, not `java.util.Random` / `SplittableRandom`, so the same seed does not flip the same bits as a server.
- **`random` and key generation draw from a seeded xorshift**, not SecureRandom: the ranges and errors are the mod's,
  the numbers are not.
- **Terminating a waiting `scan()`.** On a real computer the `terminate` event reaches the callback, which returns
  null, and CC fails with a NullPointerException outside its usual handler; the emulator raises `Terminated`.
- **The Fabric scanner's inventory.** On Fabric, the scanner block is a one-slot container, which Fabric's transfer
  API may expose to CC as an `inventory`; the emulated scanner has no inventory methods.
- **Block light and particles**: the tower head's and antenna's "active" glow, the reader's state, particles.
- **Time spent in the ports.** The Java runs in microseconds; the Lua ports of BLAKE3, deflate and the curve
  arithmetic take real time on big inputs (deflate of 300 KB of text takes several seconds). That time counts as the
  server's work, so it never trips "Too long without yielding", but a program sees it on the clock.
- **Ed25519 verification of crafted small-order signatures.** Bouncy Castle checks `[v]([S]B - R - [k]A) = 0` for a
  short `v`; the emulator checks `[S]B - [k]A = R`. They agree on every valid and corrupted signature; a signature
  built on purpose with a small-order component could in theory be judged differently.
- Pocket computers: `classicPeripherals.pocket` only switches on `os.nfc`. A world with `"kind": "pocket"` is a
  pocket computer (terminal, `pocket` API), but that does not set `classicPeripherals.pocket` by itself.
