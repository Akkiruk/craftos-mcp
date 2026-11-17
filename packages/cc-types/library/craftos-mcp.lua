---@meta

-- Hand-written from packages/runner/lua/ccunit.lua: what craftos-mcp adds to a computer that runs a test file
-- (`craftos-mcp test`, the craftos_run_tests tool). Not part of CC:Tweaked.

---The test helper craftos-mcp gives every `*.test.lua` file. End the file with `ccunit.finish()`.
---@class craftosmcp.ccunit
ccunit = {}

---Run one test. It fails when `fn` throws.
---@param name string Shown in the results.
---@param fn fun()
function ccunit.test(name, fn) end

---Fail unless two values are equal. Tables are compared by what is in them.
---@param actual any
---@param expected any
---@param message? any Put in front of the failure.
function ccunit.eq(actual, expected, message) end

---Fail when a value is false or nil.
---@param value any
---@param message? any The failure, in place of the default one.
function ccunit.truthy(value, message) end

---Fail unless `fn` throws, and its error matches `pattern` when one is given.
---@param fn fun()
---@param pattern? string A Lua pattern the error message must contain.
function ccunit.raises(fn, pattern) end

---Write the results and shut the computer down: exit code 1 when a test failed. Nothing after it runs.
function ccunit.finish() end
