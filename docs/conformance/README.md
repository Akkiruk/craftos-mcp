# CC:Tweaked conformance

The engine is checked against CC:Tweaked's own test suite (`mcfly` + `spec/`)
at the exact version in the modpack, tag `v1.18.2-1.101.3`, and, for Minecraft 1.20.1 and 1.21.1
(`world.version`, `packages/runner/src/versions.ts`), at tag `v1.20.1-1.121.0`.

```text
git clone --depth 1 --branch v1.18.2-1.101.3 https://github.com/cc-tweaked/CC-Tweaked <dir>
# Git Bash: keep in-computer paths from being rewritten, and use UTC like upstream CI
MSYS_NO_PATHCONV=1 TZ=UTC node scripts/run-cct-conformance.mjs <dir> docs/conformance/cct-1.101.3.log /test-rom/spec 200 lua
MSYS_NO_PATHCONV=1 TZ=UTC node scripts/run-cct-conformance.mjs <dir> docs/conformance/cct-1.101.3-lua.log /test-rom/spec 120 apis,modules,programs,lua/timeout_spec.lua
```

CC:Tweaked 1.121.0 (needs its ROM: `node scripts/build-rom.mjs --download 1.20.1`). A full checkout of the newer tags
fails on Windows (long paths), so export just the suite, which moved to `projects/core/src/test/resources/test-rom`:

```text
git clone --bare --filter=blob:none https://github.com/cc-tweaked/CC-Tweaked <clone>
mkdir <dir> && git -C <clone> archive v1.20.1-1.121.0 projects/core/src/test/resources/test-rom | tar -x -C <dir>
MSYS_NO_PATHCONV=1 TZ=UTC node scripts/run-cct-conformance.mjs --mc 1.20.1 <dir> docs/conformance/cct-1.121.0.log /test-rom/spec 200 lua
MSYS_NO_PATHCONV=1 TZ=UTC node scripts/run-cct-conformance.mjs --mc 1.20.1 <dir> docs/conformance/cct-1.121.0-lua.log /test-rom/spec 120 apis,modules,programs,lua/timeout_spec.lua
```

The 1.20.1 and 1.21.1 suites are identical, so one run covers both. The logs stay on the machine (`*.log` is ignored).

## Result (2026-11-16)

| Group                                  | Passed      |
| -------------------------------------- | ----------- |
| apis + modules + programs (whole spec) | 1189 / 1190 |
| `spec/lua` without `timeout_spec.lua`  | 27 / 27     |

Run again on 2026-11-17, after the fixes of `docs/compatibility.md`. The suite is one test shorter than the 1191 it
was: "cc.internal.syntax can parse all of CC's Lua files" walks the computer's whole disk, and used to find the
harness's own `/ccunit/ccunit.lua` there, which a program no longer sees. The one failure is `os.date` (below).

The same on three runs in a row. The script hides the emulator's extras before the specs run (`emulator.hide()`, as the
runner does for every program) and gives the computer CC's 10 MB test disk; programs run by the runner get the real
server's 25 MB.

`timeout_spec.lua` is run separately by hand: an infinite `while true do end`
is aborted after 7 s with CC's exact "Too long without yielding" message, but a
pathological pattern inside `string.find` is not interruptible (see below).

## Result for CC:Tweaked 1.121.0 (2026-11-16)

`--mc 1.20.1`: the engine runs with `--cc-version 1.121.0`, which switches every place it was pinned to 1.101.3.

| Group                                  | Before the switch (1.121.0 ROM, 1.101.3 engine) | Now         |
| -------------------------------------- | ----------------------------------------------- | ----------- |
| apis + modules + programs (whole spec) | 1333 / 1363                                     | 1361 / 1362 |
| `spec/lua` without `timeout_spec.lua`  | 27 / 27                                         | 27 / 27     |

The 29 cleared: file handles (raw bytes in every mode, `r+`/`w+`, seek on every handle but append, `readAll` returns
`""` at the end, `readLine(true)` keeps `\r\n`, writes coerce like Lua's `tostring`) and messages ("Not a file",
`fs.list` "No such file"), `fs.combine` with `". ."` and `fs.getDir("..")` (1.117 path rules), the `io` library on
top of them, http (`[::1]` is private, websocket "Invalid protocol") and `os.queueEvent` copying its arguments. The one
failure left is `os.date` on Windows, the same as on 1.101.3. The suite hardly tests the Lua VM. Its 1.121.0 behaviour
(Cobalt 0.9.9) is checked against Cobalt itself instead: `packages/runner/src/versions-vm.integration.test.ts` and
`tools/conformance/cobalt-oracle/`, which also runs Cobalt 0.9.9's own spec suite in the engine (268 of 303 on 1.20.1;
the rest are mostly tests for later Lua versions). See rows 99, 108 and 115 of the deviations list.

## The one remaining failure

| Test                            | Cause                                                                                                                                                                                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `os.date` "formats as expected" | The test passes `os.epoch("local")` (milliseconds) as a time in seconds, i.e. a year around 58000. The Windows C runtime cannot format years beyond 3000, so `os.date` returns nil. Not a problem on Linux. Open as row 96 of the deviations list. |

The `io` "a readable handle support seeking" spec (a raw `0xE1` byte in the spec source) passes now.

## Fixed on 2026-11-16

Later work had brought the run to 7 failures:

- Four `cc.shell.completion` specs: the emulator's own `rom/ccsim` folder showed in `/rom`. Programs no longer see it
  (listings, `fs.find`, completion, `fs.exists`, `fs.open`); the simulation reads its files through its own `fs`
  (`rom/ccsim/env.lua`).
- `fs.getCapacity`: the conformance run used the runner's 25 MB disk instead of CC's 10 MB test disk.
- `peripheral.find` "validates arguments": both emulator copies of `peripheral.find` had lost CC's `expect` checks.
- Hiding the emulator before the specs then showed that the `os.epoch`, `peripheral.getMethods` and `peripheral.wrap`
  wrappers put `/rom/startup.lua:N` in front of their errors. They are fixed too.
- The two `textutils.serialise` key-order specs below no longer flake: the engine's Lua hash seed is fixed.

## Fixed during this audit

- Reported version is 1.101.3.
- Default disk size is 10 MB, abort timeout is 7 s, `$private` addresses are
  blocked for HTTP by default.
- Reading a directory returns "No such file"; `fs.list` on a missing node says
  "Not a directory"; `fs.makeDir` on a file says "File exists".
- `fs.copy` into a read-only mount reports the full path (a wide-string bug
  printed only its first character).
- `fs.delete` collects garbage and retries when a dropped, unclosed handle
  blocks deletion on Windows.
- Windows device names (`CON`, `NUL`, `COM1`, ...) are refused as file names.
- `os.shutdown(code)` sets the exit status (an emulator-only extra for the headless runner; real CC:Tweaked takes no argument).

## Key order

Two `textutils.serialise` tests (key order of `{1,2,3,a=1,[false]={}}`) used to
fail in about two runs out of three: the engine's Lua seeded its string hash at
random, so `pairs` order changed between runs. The seed is now fixed
(`engine/craftos2-lua/src/lstate.c`), so the order is the same on every run and
matches Cobalt's for these tables. A failure there now is a real regression.

The conformance script gives the test computer an empty `startup.lua`, as CC's
own harness does, because several `fs` specs rely on it.

## Other known limits

- Patterns that run forever inside a C function (for example `string.find` on
  a 10,000-character string with `.-.-.-.-b$`) cannot be interrupted by the 7 s
  abort. The runner's own wall-clock timeout kills the process instead.
