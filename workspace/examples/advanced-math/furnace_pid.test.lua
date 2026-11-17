-- furnace_pid.lua against Advanced Math's own files, mounted into the ROM as the datapack puts them.
local T, eq, ok, raises = ccunit.test, ccunit.eq, ccunit.truthy, ccunit.raises

T("the program settles near its target", function()
  -- loaded with this file's environment, which has require (a dofile'd chunk does not, as on a real computer)
  local history = loadfile("examples/advanced-math/furnace_pid.lua", nil, _ENV)()
  eq(#history, 60)
  ok(math.abs(history[#history] - 800) < 80, "final " .. history[#history])
end)

T("the datapack's files are in the ROM", function()
  for _, path in ipairs({ "rom/apis/quaternion.lua", "rom/apis/matrix.lua", "rom/help/quaternion.txt",
    "rom/help/matrix.txt", "rom/modules/main/advanced_math/pid.lua", "rom/modules/main/advanced_math/mmath.lua",
    "rom/modules/main/advanced_math/stats.lua" }) do
    ok(fs.exists(path), path)
    eq(fs.isReadOnly(path), true)
  end
  eq(fs.list("rom/modules/main/advanced_math"), { "mmath.lua", "pid.lua", "stats.lua" })
  eq(fs.find("rom/apis/*.lua")[3] ~= nil, true)
  ok(help.lookup("matrix"), "help matrix")
end)

T("bios loaded the two APIs", function()
  eq(type(quaternion.new), "function")
  eq(type(matrix.new), "function")
end)

T("quaternion: constructors, operators, conversions", function()
  if not getmetatable(vector.new()).__name then
    -- CC:Tweaked 1.101.3 (Minecraft 1.18.2) vectors have no __name, and the datapack checks for it
    raises(function() quaternion.fromAxisAngle(vector.new(0, 1, 0), 1) end, "expected vector, got table")
    return
  end
  local q = quaternion.fromAxisAngle(vector.new(0, 1, 0), math.pi / 2)
  local e = quaternion.fromEuler(0, math.pi / 2, 0)
  ok(q:equals(q:copy()), "copy")
  local v = q * vector.new(1, 0, 0)
  ok(math.abs(v.z + 1) < 1e-9 or math.abs(v.z - 1) < 1e-9, tostring(v))
  eq(quaternion.identity():getAngle(), 0)
  ok(tostring(quaternion.fromComponents(1, 2, 3, 4)):find("4"), "tostring")
  local m = matrix.fromQuaternion(e)
  ok(quaternion.fromMatrix(m), "fromMatrix")
  raises(function() quaternion.fromShip() end, "no longer required")
  raises(function() quaternion.fromComponents("x") end, "bad argument #1")
end)

T("matrix: arithmetic, determinant, transpose, trace", function()
  local a = matrix.new(2, 2, function(r, c) return r == c and 2 or 1 end)
  eq(a:determinant(), 3)
  eq(a:transpose():isSymmetric(), true)
  eq(a:trace(), 4)
  raises(function() matrix.new("x") end, "bad argument #1")
end)

T("stats, mmath and pid modules", function()
  local stats = require("advanced_math.stats")
  eq(stats.mean({ 1, 2, 3, 4 }), 2.5)
  eq(stats.median({ 5, 1, 3 }), 3)
  local mmath = require("advanced_math.mmath")
  eq(type(mmath.solveRoot), "function")
  local pid = require("advanced_math.pid")
  local c = pid.new(10, 1, 0, 0)
  eq(c:step(4, 1), 6)
  raises(function() pid.new("x") end, "bad argument #1")
end)
