-- lib/scores.lua
-- Part of the craftos-mcp examples (MIT).
-- The high score table for one game: the best runs, kept on disk. A save writes a new file and then swaps it in, so a
-- computer that stops half way through still has the old table.

local M = { LIMIT = 10 }
local Scores = {}
Scores.__index = Scores

local function read(path)
  if not fs.exists(path) then return nil end
  local h = fs.open(path, "r")
  if not h then return nil end
  local ok, value = pcall(textutils.unserialise, h.readAll() or "")
  h.close()
  if ok and type(value) == "table" then return value end
  return nil
end

--- The table for a game, from the folder dir.
function M.open(dir, id)
  local self = setmetatable({ path = fs.combine(dir, id .. ".scores") }, Scores)
  self.rows = read(self.path) or read(self.path .. ".tmp") or {}
  return self
end

function Scores:save()
  local tmp = self.path .. ".tmp"
  local h = fs.open(tmp, "w")
  if not h then return end
  h.write(textutils.serialise(self.rows))
  h.close()
  if fs.exists(self.path) then fs.delete(self.path) end
  fs.move(tmp, self.path)
end

--- Where a score would go on the table, or nil if it wouldn't make it.
function Scores:placeFor(score)
  if score <= 0 then return nil end
  local place = #self.rows + 1
  for i, row in ipairs(self.rows) do
    if score > row.score then
      place = i
      break
    end
  end
  return place <= M.LIMIT and place or nil
end

--- Add a finished run. Returns its place on the table, or nil if it didn't make it.
function Scores:add(name, score, level)
  local place = self:placeFor(score)
  if not place then return nil end
  table.insert(self.rows, place, { name = name, score = score, level = level })
  while #self.rows > M.LIMIT do table.remove(self.rows) end
  self:save()
  return place
end

function Scores:best()
  local row = self.rows[1]
  return row and row.score or 0
end

return M
