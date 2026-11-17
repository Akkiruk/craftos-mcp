# Embedded Computer emulation

Addon id `embedded-computer`. Lua in `rom-overlay/rom/ccsim/addons/embedded-computer/` (`init.lua`, `hashes.lua`); the
jar's ROM files in `rom/` next to them.

Source of truth: [github.com/WindClan/EmbeddedComputerMod](https://github.com/WindClan/EmbeddedComputerMod) at tags
`v0.6.0` (commit `d840fad`, Minecraft 1.20.1) and `v1.3.0` (`2be48cf`, 1.21.1). Their Lua surface is the same except
that 1.3.0's hard drive takes a nil path. Paths below are under `src/main/java/net/rabiesland/embeddedcomputer/`. The
hashes were checked against Guava 32.1.2, which `secure/HashUtil` calls. MPL 2.0.

## Versions

| Minecraft | Mod release    |
| --------- | -------------- |
| 1.20.1    | 0.6.0 (Fabric) |
| 1.21.1    | 1.3.0 (Fabric) |
| 1.18.2    | none           |

## The computer itself

`"embeddedComputer": { "kind": "embedded" | "secure" }` makes the computer under test one of the mod's
(`embedded/block/EmbeddedComputerBlockEntity`, `secure/block/SecureComputerBlockEntity`):

| Kind       | Screen | APIs                   |
| ---------- | ------ | ---------------------- |
| `embedded` | 10x3   | `embedded`, `security` |
| `secure`   | 49x17  | `security`             |

- `security` (`secure/SecureComputerAPI`): `hashStrSHA256`, `hashStrSHA512`, `hashStrMurmur3`, `hashStrAdler32`,
  `hashStrSipHash24`, each `(string) -> lowercase hex` of Guava's `HashCode` (murmur3_128 with seed 0; Adler-32 and
  SipHash-2-4 as little-endian bytes, Guava's default SipHash key). The ROM's `rom/apis/secure/security.lua`, run by
  the autorun file, adds `lock(password)`, `lockHashed(password, type)` and `lockInsecure(password)`, which write
  `/.LOCKED_HASHED` or `/.LOCKED`.
- `embedded` (`embedded/EmbeddedComputerAPI`): `format()` (main thread) deletes every file on the computer's own drive
  and reboots it. The autorun file also sets `embedded.setPassword = security.lock`, and on an embedded computer with
  no `/startup.lua` and no `disk*/startup[.lua]` it shows ":( No startup found" on every monitor and sleeps 10 s.

## Peripherals

| Type               | Block                              | Methods                                                            |
| ------------------ | ---------------------------------- | ------------------------------------------------------------------ |
| `embeddedcomputer` | Embedded Computer, Secure Computer | isOn, getId, reboot, format, unlockPlainText, unlockHashed, unlock |
| `harddrive`        | Hard Drive                         | mount, unmount                                                     |

`peripheral.getMethods` is CC 1.121's `HashMap` order. isOn, getId and reboot answer at once; the rest are
`mainThread` and wait for the next tick. Both blocks turn their computer back on every tick it is off, so `isOn()` is
always true. The other computer is not run: its files are a folder (`results/addons/embedded/<id>`) filled from the
fixture's `files`.

| Method                         | What                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `getId()`                      | its computer ID                                                                                                                                  |
| `reboot()`                     | nothing (counted in sim state)                                                                                                                   |
| `format()`                     | false while `.LOCKED` or `.LOCKED_HASHED` exists; else every file goes, it reboots, true                                                         |
| `unlockPlainText(password)`    | nothing; deletes `.LOCKED` if it holds that password                                                                                             |
| `unlockHashed(password, type)` | nothing; deletes `.LOCKED_HASHED` if it holds the hash chain (type sha256, murmur3, adler32 or siphash24, any case; any other type does nothing) |
| `unlock(password)`             | `unlockHashed(password, "sha256")`                                                                                                               |

The chain is the mod's: hash the password, hash that `#password + 1` more times, then SHA-512 it `#password + 1`
times. The file is read with a `java.util.Scanner`, which joins its words, so a password with a space in it never
unlocks `.LOCKED` (its words are compared without the spaces: "open sesame" is unlocked by "opensesame").

`harddrive` (`storage/harddrive/*`): `mount(path)` mounts the drive's folder (`hdd/<uuid>` in the save,
`results/addons/ec-hdd/<uuid>` here) writable at `path` and returns true; false for `"rom"` or a path that exists.
`unmount(path)` returns true if this computer mounted something there, else false. On 1.21.1 a nil path is
`"drive"`; on 1.20.1 it is "bad argument #1 (string expected, got nil)". The mount's drive name is the peripheral's,
its capacity `HARD_DRIVE_STORAGE` (25000000).

## Fixtures

```jsonc
"embeddedComputer": { "kind": "secure", "hardDriveStorage": 25000000 },
"peripherals": [
  { "name": "left", "type": "embeddedcomputer", "id": 12, "files": { "startup.lua": "...", ".LOCKED": "secret" } },
  { "name": "right", "type": "harddrive", "uuid": "…", "files": { "notes.txt": "..." } }
]
```

## Sim commands

None. `craftos_sim_state` `peripherals.<name>`: an embedded computer's `{ id, files, reboots }`, a drive's `{ uuid,
mount }`.

## Not emulated

- The other computer's program: only its files are there. Running it is a second computer (a `linked` world).
- The mod's disk media (zip disk, flash card, debug media) in a disk drive, and their capacities.
- The hard drive's capacity is reported but not enforced.
