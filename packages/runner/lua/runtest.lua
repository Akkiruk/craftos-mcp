-- Run one *.test.lua file from the shell the way `craftos-mcp test` runs it: with ccunit as a global, results
-- written to /results/results.json, and the computer shut down at the end (exit code 1 on any failure).
--   /ccunit/runtest path/to/thing.test.lua
-- The app types this for a test started from the editor (a debug session on a test file). Since a person is
-- looking at this terminal and not at a report, each test's result is printed before the computer shuts down.
local file = ...
if not file then error("usage: /ccunit/runtest <file.test.lua>", 0) end
_G.ccunit = dofile("/ccunit/ccunit.lua")
ccunit._shell = shell
local ok, err = pcall(shell.run, file)
if not ok then ccunit.test("load " .. file, function() error(err, 0) end) end

local function say(colour, text)
  if term.isColour() then term.setTextColour(colour) end
  print(text)
  if term.isColour() then term.setTextColour(colours.white) end
end

-- ccunit writes each test to /results/results.jsonl as it ends
local passed, failed, skipped = 0, 0, 0
local stream = fs.open("/results/results.jsonl", "r")
if stream then
  for line in stream.readLine do
    local entry = textutils.unserialiseJSON(line)
    if type(entry) == "table" and entry.event == "end" then
      if entry.skipped then
        skipped = skipped + 1
        say(colours.lightGrey, "skip  " .. tostring(entry.name))
      elseif entry.passed then
        passed = passed + 1
        say(colours.lime, "pass  " .. tostring(entry.name))
      else
        failed = failed + 1
        say(colours.red, "FAIL  " .. tostring(entry.name))
        if entry.error then print("      " .. tostring(entry.error)) end
      end
    end
  end
  stream.close()
end
say(failed > 0 and colours.red or colours.lime,
  ("%d passed, %d failed%s"):format(passed, failed, skipped > 0 and (", " .. skipped .. " skipped") or ""))
ccunit.finish()
