-- Minimal test harness for CC:Tweaked programs. Loaded by the runner as the
-- global `ccunit`; test files just call ccunit.test(...) and the runner
-- collects /results/results.json when the file finishes.
--
-- Each test also goes to /results/results.jsonl the moment it starts and ends, so a file that hangs keeps the
-- results it had, and the runner can name the test that was running at the timeout.
local M = {}

local results = {}
local STREAM = "/results/results.jsonl"

local function record(entry)
  local h = fs.open(STREAM, "a")
  if h then
    h.write(textutils.serializeJSON(entry) .. "\n")
    h.close()
  end
end

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

local function finishTest(name, ok, err)
  results[#results + 1] = { name = name, passed = ok, error = (not ok) and tostring(err) or nil }
  record({ event = "end", name = name, passed = ok, error = (not ok) and tostring(err) or nil })
end

--- ccunit.test(name, fn [, {timeout = seconds}]): run one test. With a timeout, a test still running after that many
--- (virtual) seconds fails instead of holding up the whole file.
function M.test(name, fn, opts)
  record({ event = "start", name = name })
  local timeout = type(opts) == "table" and tonumber(opts.timeout) or nil
  if not timeout then
    local ok, err = pcall(fn)
    return finishTest(name, ok, err)
  end
  local ok, err, finished = false, nil, false
  parallel.waitForAny(function()
    ok, err = pcall(fn)
    finished = true
  end, function() sleep(timeout) end)
  if not finished then ok, err = false, "timed out after " .. timeout .. " s" end
  finishTest(name, ok, err)
end

--- ccunit.skip(name, fn): a test that is not run now, listed as skipped.
function M.skip(name)
  results[#results + 1] = { name = name, passed = true, skipped = true }
  record({ event = "end", name = name, passed = true, skipped = true })
end

function M.eq(actual, expected, message)
  if not deepEqual(actual, expected) then
    error((message and (message .. ": ") or "") .. "expected " .. show(expected) .. " but got " .. show(actual), 2)
  end
end

function M.neq(actual, unexpected, message)
  if deepEqual(actual, unexpected) then
    error((message and (message .. ": ") or "") .. "expected anything but " .. show(unexpected), 2)
  end
end

--- ccunit.near(actual, expected [, within = 1e-6]): numbers equal give or take `within`.
function M.near(actual, expected, within, message)
  within = within or 1e-6
  if type(actual) ~= "number" or math.abs(actual - expected) > within then
    error((message and (message .. ": ") or "") .. "expected " .. show(expected) .. " +/- " .. within .. " but got " .. show(actual), 2)
  end
end

--- ccunit.contains(haystack, needle): a string holds the text (plain, not a pattern), a list holds the value, or a
--- table of screen lines (ccunit.screen()) has a line with the text.
function M.contains(haystack, needle, message)
  local found = false
  if type(haystack) == "string" then
    found = haystack:find(tostring(needle), 1, true) ~= nil
  elseif type(haystack) == "table" then
    for _, v in pairs(haystack) do
      if deepEqual(v, needle) or (type(v) == "string" and type(needle) == "string" and v:find(needle, 1, true)) then
        found = true
        break
      end
    end
  end
  if not found then
    error((message and (message .. ": ") or "") .. show(haystack) .. " does not contain " .. show(needle), 2)
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

-- ===== running a program and reading its screens =====

local captures = {}

local function linesOf(win)
  local _, h = win.getSize()
  local lines = {}
  for y = 1, h do lines[y] = (win.getLine(y)):gsub("%s+$", "") end
  while #lines > 0 and lines[#lines] == "" do lines[#lines] = nil end
  return lines
end

-- A monitor the program wraps, drawn through a window so its text can be read back. Same methods, same metatable,
-- and it still draws on the real monitor.
local function capturedMonitor(name, mon)
  local w, h = mon.getSize()
  local win = window.create(mon, 1, 1, w, h, true)
  local obj = {}
  for k, v in pairs(mon) do obj[k] = v end
  for k, v in pairs(win) do
    if k ~= "reposition" and k ~= "redraw" and k ~= "restoreCursor" and k ~= "getPosition" and k ~= "setVisible"
      and k ~= "isVisible" and k ~= "getLine" then
      obj[k] = v
    end
  end
  obj.setTextScale = function(scale)
    mon.setTextScale(scale)
    local nw, nh = mon.getSize()
    win.reposition(1, 1, nw, nh)
  end
  local mt = getmetatable(mon)
  if mt then setmetatable(obj, mt) end
  captures[name] = win
  return obj
end

--- ccunit.run(program [, opts]): run a workspace program as the shell would, while the test watches its screens.
--- opts.args: its arguments. opts.script: a function run alongside (touch, type, sleep); the run ends when it returns.
--- Without a script the run ends after opts.seconds (default 1, virtual) or when the program exits.
--- Returns { ok = true/false (nil if still running), done = whether it exited, screen = the terminal's lines }.
--- Read monitors afterwards with ccunit.screen("top").
function M.run(program, opts)
  opts = opts or {}
  local sh = M._shell
  if not sh then error("ccunit.run needs the shell (run the file with craftos_test or craftos-mcp test)", 2) end
  captures = {}
  local parent = term.current()
  local tw, th = parent.getSize()
  local termWin = window.create(parent, 1, 1, tw, th, true)
  captures.term = termWin
  local rawWrap, rawFind = peripheral.wrap, peripheral.find
  local wrapped = {}
  peripheral.wrap = function(name)
    local p = rawWrap(name)
    if p and peripheral.hasType(name, "monitor") then
      wrapped[name] = wrapped[name] or capturedMonitor(name, p)
      return wrapped[name]
    end
    return p
  end
  peripheral.find = function(ty, filter)
    local found = {}
    for _, name in ipairs(peripheral.getNames()) do
      if peripheral.hasType(name, ty) then
        local p = peripheral.wrap(name)
        if p and (not filter or filter(name, p)) then found[#found + 1] = p end
      end
    end
    return table.unpack(found)
  end
  local old = term.redirect(termWin)
  local ok, done = nil, false
  local args = opts.args or {}
  local restore = function()
    term.redirect(old)
    peripheral.wrap, peripheral.find = rawWrap, rawFind
  end
  local okRun, err = pcall(parallel.waitForAny, function()
    ok = sh.run(program, table.unpack(args))
    done = true
  end, function()
    if opts.script then
      opts.script()
      sleep(0)
    else
      sleep(opts.seconds or 1)
    end
  end)
  restore()
  if not okRun then error(err, 0) end
  return { ok = ok, done = done, screen = linesOf(termWin) }
end

--- ccunit.screen([monitor]): the text lines of the terminal (no name) or of a monitor, as the last ccunit.run left
--- them, trailing spaces and blank lines trimmed. Without a run it reads the test's own terminal.
function M.screen(name)
  local win = captures[name or "term"]
  if win then return linesOf(win) end
  if name then
    if not peripheral.isPresent(name) then
      error("no monitor " .. show(name) .. " is attached: give the test one (--monitor " .. tostring(name) ..
        ":2x1 on the command line, or \"monitors\" in the world file)", 2)
    end
    if not peripheral.hasType(name, "monitor") then
      error(show(name) .. " is a " .. tostring(peripheral.getType(name)) .. ", not a monitor", 2)
    end
    error("no screen " .. show(name) .. " captured: the program never wrapped the monitor " .. show(name) ..
      " (call ccunit.run first, and check the program uses that name)", 2)
  end
  local t = term.current()
  if t.getLine then return linesOf(t) end
  return {}
end

--- ccunit.touch(monitor, x, y): a player right-clicks a monitor cell (a monitor_touch event).
function M.touch(monitor, x, y)
  os.queueEvent("monitor_touch", monitor, x, y)
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
