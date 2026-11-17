-- Runs dock.lua against dock.world.json (two pockets, one printout) and checks every lectern method.
local T, eq, ok, raises = ccunit.test, ccunit.eq, ccunit.truthy, ccunit.raises

local lines = {}
local realPrint = _G.print
_G.print = function(s) lines[#lines + 1] = s end
local okRun, err = pcall(dofile, "examples/lectern-hub/dock.lua")
_G.print = realPrint

T("the program runs", function() ok(okRun, tostring(err)) end)

T("it wakes the pocket that was off and lists each lectern", function()
  eq(lines, {
    "back: printout",
    "left: Scout (on)",
    "right: pocket #12 (on)",
    "woke 1 pocket computer",
  })
end)

T("the methods, in CC's HashMap order", function()
  eq(peripheral.getMethods("left"), { "reboot", "getLabel", "turnOn", "isPocket", "isOn", "getID", "shutdown" })
  eq(peripheral.getType("left"), "cc_lectern")
end)

T("a pocket: id, label, on and off", function()
  local l = peripheral.wrap("left")
  eq(l.isPocket(), true)
  eq(l.getID(), 7)
  eq(l.getLabel(), "Scout")
  eq(select("#", l.shutdown()), 0)
  eq(l.isOn(), false)
  eq(select("#", l.reboot()), 0)
  eq(l.isOn(), false) -- reboot does nothing to a computer that is off
  eq(select("#", l.turnOn()), 0)
  eq(l.isOn(), false) -- the start waits for the next server tick
  sleep(0.1)
  eq(l.isOn(), true)
  l.reboot()
  eq(l.isOn(), true)
end)

T("a pocket with no label", function()
  local r = peripheral.wrap("right")
  eq(select("#", r.getLabel()), 1)
  eq(r.getLabel(), nil)
end)

T("a printout: nothing to control", function()
  local b = peripheral.wrap("back")
  eq(b.isPocket(), false)
  eq(b.getID(), -1)
  eq(b.isOn(), false)
  eq(select("#", b.getLabel()), 1)
  eq(b.getLabel(), nil)
  eq(select("#", b.turnOn()), 0)
  b.shutdown()
  b.reboot()
  eq(b.isOn(), false)
end)

T("extra arguments are ignored, as by any Java method", function()
  local l = peripheral.wrap("left")
  eq(l.getID("x", 1), 7)
  raises(function() peripheral.call("left", "attachPC") end, "No such method attachPC") -- commented out in the source
end)
