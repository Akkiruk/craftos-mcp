-- under_debugger.lua, then the cide_dbg API with no editor session.
local T, eq = ccunit.test, ccunit.eq
local function err(fn, ...)
  local okc, e = pcall(fn, ...)
  if okc then error("expected an error", 2) end
  return (tostring(e):gsub("^pcall: ", ""):gsub("^[^:]*:%d+: ", ""))
end

T("the program runs under CIDE's runner", function()
  local lines = {}
  local realPrint = _G.print
  _G.print = function(s) lines[#lines + 1] = s end
  local ok, e = pcall(assert(loadfile("examples/cide/under_debugger.lua", nil, _ENV)))
  _G.print = realPrint
  eq(ok, true, tostring(e))
  eq(lines[1], "no debugger: the program runs straight through")
  eq(lines[#lines], "total 55")
end)

T("cide_dbg with no session", function()
  eq(cide_dbg.isActive(), false)
  eq(cide_dbg.getBreakpoints(), {})
  eq(select("#", cide_dbg.paused("x.lua", 3, {})), 0)
  eq(select("#", cide_dbg.finished()), 0)
  eq(err(cide_dbg.paused, "x.lua"), "bad argument #2 (number expected, got nil)")
  eq(fs.exists("rom/cide/agent.lua"), true)
end)
