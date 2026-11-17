-- lib/saves.lua
-- Part of the craftos-mcp examples (MIT).
-- Saved games: one file for each player, in a folder on the computer, so a story too long for one sitting can wait for its
-- player. With no player detector there is one player, "Player", and so one save. A save is written beside the file and
-- then swapped in, keeping the last good copy, so a computer that stops half way through a write still has a save.

local M = { AUTOSAVE_MS = 30000 }

local VERSION = 1
local SUFFIXES = { "", ".tmp", ".bak" } -- after a reboot in the middle of a swap, .tmp is newer than .bak
local MAX_NAME = 40
-- A state may share a table between two fields, such as a town from a list: the default refuses those outright.
local SERIALISE = { compact = true, allow_repetitions = true }

local dir = "saves"

--- Keep saves in this folder.
function M.init(folder) dir = folder end

--- A name fit for a file, different for every different name: anything but a letter or digit becomes _ and its hex code.
local function safe(text)
  local out = tostring(text):gsub("[^%w]", function(c) return string.format("_%02X", c:byte()) end)
  if #out <= MAX_NAME then return out end
  local hash = 5381
  for i = 1, #out do hash = (hash * 33 + out:byte(i)) % 2147483647 end
  return out:sub(1, MAX_NAME - 9) .. "_" .. string.format("%08x", hash)
end

function M.path(player)
  return fs.combine(dir, safe(player) .. ".save")
end

--- Is this what a save looks like, for this player?
local function sound(save, player)
  if type(save) ~= "table" or save.version ~= VERSION or (player and save.player ~= player) then return false end
  local s, position = save.state, save.rng
  if type(s) ~= "table" or s.over or type(s.score) ~= "number" then return false end
  return type(position) == "number" and position >= 1 and position <= 2147483646 and position % 1 == 0
end

local function readCopy(path, player)
  if not fs.exists(path) then return nil end
  local h = fs.open(path, "r")
  if not h then return nil end
  local text = h.readAll()
  h.close()
  local ok, value = pcall(textutils.unserialise, text or "")
  if ok and sound(value, player) then return value end
  return nil
end

--- The newest good copy of a player's save: { state, rng, player, at }, or nil if there is none worth offering.
function M.read(player)
  local path = M.path(player)
  for _, suffix in ipairs(SUFFIXES) do
    local ok, save = pcall(readCopy, path .. suffix, player)
    if ok and save then return save end
  end
  return nil
end

--- A player's save. rng is the generator's position (lib/rng.lua tracked). Returns true, or false and why: nothing here
--- raises an error, and a failure (a full disk, say) leaves the last good save in place.
function M.write(player, state, rng)
  local save = { version = VERSION, player = player, rng = rng, state = state, at = os.epoch("utc") }
  local made, text = pcall(textutils.serialise, save, SERIALISE)
  if not made then return false, text end
  local path = M.path(player)
  local tmp, bak = path .. ".tmp", path .. ".bak"
  local ok, err = pcall(function()
    if not fs.exists(dir) then fs.makeDir(dir) end
    local h, why = fs.open(tmp, "w")
    if not h then error(why or ("could not open " .. tmp), 0) end
    local wrote, problem = pcall(h.write, text)
    h.close()
    if not wrote then error(problem, 0) end
    if fs.exists(bak) then fs.delete(bak) end
    if fs.exists(path) then fs.move(path, bak) end
    fs.move(tmp, path)
  end)
  if ok then return true end
  pcall(fs.delete, tmp)
  return false, err
end

--- Lose a player's save, every copy of it.
function M.delete(player)
  local path = M.path(player)
  for _, suffix in ipairs(SUFFIXES) do
    if fs.exists(path .. suffix) then fs.delete(path .. suffix) end
  end
end

--- Every player's save on this computer, newest first.
function M.list()
  local out = {}
  if not fs.isDir(dir) then return out end
  for _, name in ipairs(fs.list(dir)) do
    if name:sub(-5) == ".save" then
      local save = readCopy(fs.combine(dir, name))
      if save then out[#out + 1] = save end
    end
  end
  table.sort(out, function(a, b) return (a.at or 0) > (b.at or 0) end)
  return out
end

return M
