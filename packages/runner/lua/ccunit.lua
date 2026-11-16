-- Minimal test harness for CC:Tweaked programs. Loaded by the runner as the
-- global `ccunit`; test files just call ccunit.test(...) and the runner
-- collects /results/results.json when the file finishes.
local M = {}

local results = {}

local function show(v)
  if type(v) == "string" then return string.format("%q", v) end
  if type(v) == "table" then
    local ok, text = pcall(textutils.serialize, v, { compact = true })
    return ok and text or tostring(v)
  end
  return tostring(v)
end

local function deepEqual(a, b)
  if a == b then return true end
  if type(a) ~= "table" or type(b) ~= "table" then return false end
  for k, v in pairs(a) do
    if not deepEqual(v, b[k]) then return false end
  end
  for k in pairs(b) do
    if a[k] == nil then return false end
  end
  return true
end

function M.test(name, fn)
  local ok, err = pcall(fn)
  results[#results + 1] = { name = name, passed = ok, error = (not ok) and tostring(err) or nil }
end

function M.eq(actual, expected, message)
  if not deepEqual(actual, expected) then
    error((message and (message .. ": ") or "") .. "expected " .. show(expected) .. " but got " .. show(actual), 2)
  end
end

function M.truthy(value, message)
  if not value then error(message or ("expected a truthy value but got " .. show(value)), 2) end
end

function M.raises(fn, pattern)
  local ok, err = pcall(fn)
  if ok then error("expected an error but the call succeeded", 2) end
  if pattern and not tostring(err):find(pattern) then
    error("error " .. show(tostring(err)) .. " does not match " .. show(pattern), 2)
  end
end

--- Write results and shut the computer down (exit code 1 on any failure).
function M.finish()
  local failed = 0
  for _, r in ipairs(results) do
    if not r.passed then failed = failed + 1 end
  end
  local handle = fs.open("/results/results.json", "w")
  handle.write(textutils.serializeJSON({ tests = results, failed = failed }))
  handle.close()
  os.shutdown(failed > 0 and 1 or 0)
end

return M
