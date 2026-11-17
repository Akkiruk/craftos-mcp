-- lib/rng.lua
-- Part of the craftos-mcp examples (MIT).
-- A small seeded random number source: the same seed gives the same numbers, so a saved game carries on with the numbers
-- it would have had. rng() is 0 to 1 and rng(n) is 1 to n, the form the game's rules ask for.

local M = {}

--- A generator, and a function that says where it has got to: tracked(position - 1) carries on from exactly there.
function M.tracked(seed)
  local state = seed % 2147483646 + 1
  return function(n)
    state = state * 16807 % 2147483647 -- small enough to stay exact in a double
    local value = state - 1
    if n then return value % n + 1 end
    return value / 2147483646
  end, function() return state end
end

--- Just the generator.
function M.rng(seed)
  return (M.tracked(seed))
end

return M
