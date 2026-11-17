# Cricket's Peripherals 0.1.1 emulation

Addon id `crickets-peripherals`. Lua in `rom-overlay/rom/ccsim/addons/crickets-peripherals/` (`init.lua`; `zlib.lua`
and `crypto.lua` for what the JDK does).

Source of truth: [github.com/PewPewCricket/crickets-peripherals](https://github.com/PewPewCricket/crickets-peripherals)
at tag `0.1.1` (commit `5a263c0`), the only release for its Minecraft version. Paths below are under
`src/main/java/com/pewpewcricket/cricketsperipherals/`. The JDK parts were checked against Java 21 (what Minecraft
1.21.1 runs on): the expected bytes in the tests come from running the mod's own code there.

## Versions

| Minecraft | Mod release      |
| --------- | ---------------- |
| 1.21.1    | 0.1.1 (NeoForge) |
| 1.18.2    | none             |
| 1.20.1    | none             |

## Peripherals

| Type               | Block            | Methods                                                      |
| ------------------ | ---------------- | ------------------------------------------------------------ |
| `hard_drive`       | Hard Drive       | getMountPath, mount, unmount                                 |
| `data_coprocessor` | Data Coprocessor | deflate, inflate, sha256, crc32, key, encrypt, decrypt, uuid |

Every method is a plain `@LuaFunction`: it answers at once. No events. `peripheral.getMethods` is CC:Tweaked 1.121's
`HashMap` order (`../javamap.lua`): getMountPath, unmount, mount; deflate, inflate, sha256, encrypt, crc32, decrypt,
uuid, key. Binary data goes in and out as Lua strings (CC's `getBytes` and `ByteBuffer` results); a number where a
string is wanted is "bad argument #1 (string expected, got number)", as `getBytes` does not coerce.

### hard_drive (`peripheral/PeripheralHardDrive`, `blockentity/BlockEntityHardDrive`)

When the computer attaches the drive, it mounts the drive's own folder writable at `/hdd`, or `/hdd1`, `/hdd2`... when
that name is taken by any file or folder (`ComputerAccess.findFreeLocation`).

| Method           | Returns                                                               |
| ---------------- | --------------------------------------------------------------------- |
| `getMountPath()` | where it is mounted (`"hdd"`), or one `nil` after `unmount`           |
| `mount()`        | nothing; mounts it again (at the first free name) if it was unmounted |
| `unmount()`      | nothing; the folder disappears from the computer                      |

On the computer, `fs.getDrive` of the mount is the peripheral's name, `fs.getCapacity` is `hddSize` (default 2097152)
and `fs.getFreeSpace` is that minus what the files take. The folder is `results/addons/hdd/<mountId>` of the run, so
its files survive a reboot; a drive with no `mountId` takes the next free number (`createUniqueNumberedSaveDir`).

### data_coprocessor (`peripheral/PeripheralDataCoprocessor`, `util/CryptoUtil`)

| Method               | What                                                                                                                                                                                                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deflate(data)`      | `java.util.zip.Deflater` (zlib format, level 6). Ported from zlib 1.2.13: the same bytes as the JDK.                                                                                                                                                                                         |
| `inflate(data)`      | `Inflater`: the data, or zlib's message ("incorrect header check", "invalid block type", "invalid stored block lengths", "invalid distance too far back", "incorrect data check", ...). Input that ends early gives what came out so far, no error (the mod's loop stops on `needsInput()`). |
| `sha256(data)`       | the 32-byte digest                                                                                                                                                                                                                                                                           |
| `crc32(data)`        | `java.util.zip.CRC32`, a number                                                                                                                                                                                                                                                              |
| `key()`              | 32 random bytes (an AES-256 key)                                                                                                                                                                                                                                                             |
| `encrypt(data, key)` | AES/GCM/NoPadding, a random 12-byte IV, 128-bit tag: IV, then ciphertext and tag                                                                                                                                                                                                             |
| `decrypt(data, key)` | the plaintext                                                                                                                                                                                                                                                                                |
| `uuid()`             | `UUID.randomUUID()`, a version 4 UUID string                                                                                                                                                                                                                                                 |

`encrypt` and `decrypt` take 16, 24 or 32 byte keys. Their errors, as Java gives them: "Invalid AES key length: N
bytes"; an empty key "Java Exception Thrown: java.lang.IllegalArgumentException: Empty key"; `decrypt` of fewer than
12 bytes "Java Exception Thrown: java.nio.BufferUnderflowException", of fewer than 28 "Input data too short to
contain an expected tag length of 16bytes", a wrong key or changed data "Tag mismatch".

## Fixtures

```jsonc
"cricketsPeripherals": { "hddSize": 2097152 },
"peripherals": [
  { "name": "left", "type": "hard_drive", "mountId": 0, "files": { "readme.txt": "hello" } },
  { "name": "right", "type": "data_coprocessor" }
]
```

- `cricketsPeripherals.hddSize`: the config's `hddSize` (bytes).
- `hard_drive`: `mountId` (its save folder number), `files` (path to content, written the first time the folder is
  made).

## Sim commands

None. `craftos_sim_state` `peripherals.<name>` of a hard drive: `{ mountId, mountPath }`.

## Not emulated

- The drive's capacity is reported but not enforced: a write past `hddSize` succeeds here, where CC raises "Out of
  space".
- `inflate` of a stream with a preset dictionary (FDICT) and data after it never returns in game (Java's inflater
  waits for `setDictionary`, which the mod never calls, and its loop spins). Here it raises an error saying so.
- `util/AudioUtil` is not used by any method.
- The blocks' lit/idle look (`updateState`).
