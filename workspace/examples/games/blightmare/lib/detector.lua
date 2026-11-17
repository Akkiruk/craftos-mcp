-- lib/detector.lua
-- Part of the craftos-mcp examples (MIT).
-- Who is standing at the wall, from an Advanced Peripherals player detector if there is one: the hero takes their name,
-- and each player near the wall has a save of their own. With no detector this knows nobody, and the game asks for a name.
-- A detector call waits for the server and swallows the events that come meanwhile, so the calls only ever run in
-- M.worker, a coroutine of their own beside the game loop (parallel gives each its own copy of every event).

local M = {}

local RANGE = 8     -- blocks around the detector that count as at the wall
local POLL_MS = 1000

local state = { detector = nil, closest = nil, near = {} }

local function nowMs() return os.epoch("utc") end

--- Find the detector again (at start, and when a peripheral comes or goes).
function M.init()
  state.detector = peripheral.find("playerDetector")
  if not state.detector then state.closest, state.near = nil, {} end
end

function M.present() return state.detector ~= nil end

local function inRange(range)
  local ok, players = pcall(state.detector.getPlayersInRange, range)
  if ok and type(players) == "table" then return players end
  return nil
end

--- Ask the detector who is near, and which of them is closest: the smallest range anyone is in, found by halving.
function M.poll()
  if not state.detector then return end
  local near = inRange(RANGE)
  if not near then return end
  table.sort(near)
  local closest = near[1]
  if #near > 1 then
    local lo, hi, inner = 0, RANGE, near
    while hi - lo > 0.5 do
      local mid = (lo + hi) / 2
      local found = inRange(mid)
      if found and #found > 0 then hi, inner = mid, found else lo = mid end
    end
    table.sort(inner)
    closest = inner[1]
    for _, name in ipairs(inner) do
      if name == state.closest then closest = name end -- level pegging: whoever was closest before keeps it
    end
  end
  state.closest, state.near = closest, near
end

--- The player standing closest to the wall at the last poll, or nil with nobody there or no detector.
function M.closest() return state.closest end

--- Is this player still near the wall? Always true with no detector, which can't tell.
function M.isNear(name)
  if not state.detector then return true end
  for _, n in ipairs(state.near) do
    if n == name then return true end
  end
  return false
end

--- Runs beside the game loop with parallel, for ever.
function M.worker()
  local lastAt = -1e9
  while true do
    if state.detector and nowMs() - lastAt >= POLL_MS then
      lastAt = nowMs()
      M.poll()
    end
    sleep(0.25)
  end
end

return M
