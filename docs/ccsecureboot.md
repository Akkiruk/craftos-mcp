# CCSecureBoot 1.0.2 emulation

Addon id `ccsecureboot`. Lua in `rom-overlay/rom/ccsim/addons/ccsecureboot/init.lua`; the mod's ROM files, unchanged,
in `rom/` next to it.

Source of truth: [github.com/MCJack123/CCSecureBoot](https://github.com/MCJack123/CCSecureBoot) at tag `1.0.2`
(commit `707fb68`, branch `mc-1.20.1`): `common/src/main/java/cc/madefor/phoenix/ccsecureboot/CCSecureBootAPI.java`
and `common/src/main/resources/data/computercraft/lua/rom/`. The `mc-1.21.1` branch changes only the build and the
loader metadata (GitHub compare 1.0.2...mc-1.21.1), so 1.21.1 is the same. MPL 2.0 (portions MIT).

## Versions

| Minecraft | Mod release                            |
| --------- | -------------------------------------- |
| 1.20.1    | 1.0.2                                  |
| 1.21.1    | 1.0.2                                  |
| 1.18.2    | none (needs CC:Tweaked 1.112 or later) |

## What it changes at boot

The jar puts files into CC's ROM; with the addon on they are there from boot (`../romfiles.lua`):

- `rom/autorun/pxboot.lua`: when `/rom/pxboot/certs/enrolled/<id>` exists, the shell's autorun hands the computer to
  pxboot for good (`while true do shell.run("/rom/pxboot/pxboot.lua") end`). pxboot boots `/startup.lua` only when it
  has a valid signature (`startup.lua.sig`), offers the key disk's signed rescue entries, and blocks Ctrl+T and disk
  startup files. On such a computer the test harness's own boot script never runs, as no other program would: drive it
  through a session (type, read the screen), as the integration test does.
- `rom/pxboot/`, `rom/programs/enroll-secure-boot.lua`, `sign.lua`, `unenroll-secure-boot.lua`,
  `rom/modules/main/` (codesign, libcert `cert`, `ccryptolib`, `asn1`, `aes`, `sha2`).

## require "secureboot" (`CCSecureBootAPI`)

An `ILuaAPI` with no global name, only a module (`getModuleName`): `require("secureboot")`. Both methods run on the
computer thread.

| Function                 | What                                                                                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enroll(csrPem)`         | signs the PKCS#10 request with the server's root key and returns the certificate (PEM); writes `certs/enrolled/<id>`                                                                                               |
| `unenroll(certPem, sig)` | `true` when this computer is not enrolled; else checks the certificate against the root and the CRL and `sig` (a bare Ed25519 signature of the ID in its subject), revokes it and returns true, or `false, reason` |

`enroll` errors, as the Java: "This computer is already enrolled in secure boot", "CSR does not contain computer ID",
"CSR ID does not match computer ID", "Could not sign certificate: ..." for anything unreadable. `unenroll` reasons:
"Certificate has been revoked", "Signature does not match." (not signed by the root), "Certificate does not contain
computer ID", "Could not verify signature". Like the Java, `unenroll` looks at the computer it runs on, not the
certificate's: run on another computer it returns true and changes nothing.

The server side (`startup()`): an Ed25519 root key, a self-signed root certificate "CN=CCSecureBoot Root" valid 30
years, an empty CRL, and the `certs` folder mounted read-only at `/rom/pxboot/certs`. A certificate gets a random
32-byte serial, the CSR's subject and key, the root as issuer, validity now to now + 30 years. Bouncy Castle builds
these in game; here the mod's own libcert and ccryptolib do (loaded from its ROM files), so they are real certificates
that pxboot, `sign` and `codesign` check exactly as in game. The files are `results/addons/secureboot/` of the run, so
an enrolment survives reboots.

A new sim command, `insertDisk {peripheral, disk}`, puts a floppy into an engine drive (the enroll program waits for
one); it is CC's, not the mod's, and works for any world.

## Fixtures and sim commands

No fixture fields. `craftos_sim_state` `addons.ccsecureboot`: `{ enrolled, revoked }` (this computer, CRL entries).

## Not emulated

- The exact DER of Bouncy Castle's certificates and CRLs (field order and encoding choices of its builders): what
  matters to every Lua consumer (subject, key, issuer, serial, validity, signature) is the same.
- `unenroll`'s CRL entry reason (`superseded`) is not written as an entry extension.
- One server for all computers: a `linked` world's computers each have their own root.
