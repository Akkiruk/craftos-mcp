# CC:Tweaked conformance

The engine is checked against CC:Tweaked's own test suite (`mcfly` + `spec/`)
at the exact version in the modpack, tag `v1.18.2-1.101.3`.

```text
git clone --depth 1 --branch v1.18.2-1.101.3 https://github.com/cc-tweaked/CC-Tweaked <dir>
# Git Bash: keep in-computer paths from being rewritten, and use UTC like upstream CI
MSYS_NO_PATHCONV=1 TZ=UTC node scripts/run-cct-conformance.mjs <dir> docs/conformance/cct-1.101.3.log /test-rom/spec 200 lua
MSYS_NO_PATHCONV=1 TZ=UTC node scripts/run-cct-conformance.mjs <dir> docs/conformance/cct-1.101.3-lua.log /test-rom/spec 120 apis,modules,programs,lua/timeout_spec.lua
```

## Result (2026-10-29)

| Group                                  | Passed      |
| -------------------------------------- | ----------- |
| apis + modules + programs (whole spec) | 1189 / 1191 |
| `spec/lua` without `timeout_spec.lua`  | 27 / 27     |

`timeout_spec.lua` is run separately by hand: an infinite `while true do end`
is aborted after 7 s with CC's exact "Too long without yielding" message, but a
pathological pattern inside `string.find` is not interruptible (see below).

## The two remaining failures

| Test                                     | Cause                                                                                                                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `io` "a readable handle support seeking" | The spec's own Lua source contains a raw `0xE1` byte. The engine mangles that byte while loading the spec file, so the expected string differs. Reading and writing such bytes at runtime works (checked with `fs.open`). |
| `os.date` "formats as expected"          | The test passes `os.epoch("local")` (milliseconds) as a time in seconds, i.e. a year around 58000. The Windows C runtime cannot format years beyond 3000, so `os.date` returns nil. Not a problem on Linux.               |

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
- `os.shutdown(code)` sets the exit status.

## Possibly flaky

Two `textutils.serialise` tests (key order of `{1,2,3,a=1,[false]={}}`) failed in
earlier runs and passed in the latest ones, with no change on our side. They
depend on Lua's table iteration order, which can vary between runs, so treat a
failure there as noise rather than a regression.

The conformance script gives the test computer an empty `startup.lua`, as CC's
own harness does, because several `fs` specs rely on it.

## Other known limits

- Patterns that run forever inside a C function (for example `string.find` on
  a 10,000-character string with `.-.-.-.-b$`) cannot be interrupted by the 7 s
  abort. The runner's own wall-clock timeout kills the process instead.
