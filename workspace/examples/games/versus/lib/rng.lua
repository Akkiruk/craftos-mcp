-- lib/rng.lua
-- Part of the craftos-mcp examples (MIT).
-- A random number source both cabinets can share. Given the same seed, two computers draw the same numbers, so they can
-- each run the same match from the same taps and stay in step (see "Two computers, one match" in the README).
-- It is the Park-Miller generator: every step is exact in Lua's numbers, on any computer.

local M = {}

local MOD, MUL = 2147483647, 16807

--- A source seeded with seed (any whole number). Call it as rules expect: r() is 0 to 1, r(n) is 1 to n.
--- r.state() and r.set(x) read and restore where it has got to.
function M.new(seed)
  local x = math.floor(seed) % (MOD - 1) + 1
  local r = {}
  local function next()
    x = x * MUL % MOD
    return x / MOD
  end
  function r.state() return x end
  function r.set(value) x = value end
  return setmetatable(r, {
    __call = function(_, n)
      if n then return math.floor(next() * n) + 1 end
      return next()
    end,
  })
end

return M
