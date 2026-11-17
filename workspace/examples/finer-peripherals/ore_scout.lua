-- ore_scout.lua: a Finer Peripherals ore scout. Say "!ores" in chat and it scans around its geo explorer and tells
-- you what ores are within 4 blocks; say "!where <name>" and it reads the player finder.
-- Needs a chat box (type chatBox), a geo explorer (geoExplorer) and a player finder (playerFinder).

local chat = peripheral.find("chatBox")
local geo = peripheral.find("geoExplorer")
local finder = peripheral.find("playerFinder")
if not (chat and geo and finder) then error("needs a chatBox, a geoExplorer and a playerFinder", 0) end

local function say(text) chat.sendMessage(text, "Scout", "[]") end

local function ores()
  local blocks, why = geo.scan(4)
  if not blocks then return nil, why end
  local counts, names = {}, {}
  for _, b in ipairs(blocks) do
    if b.name:find("_ore$") then
      if not counts[b.name] then names[#names + 1] = b.name end
      counts[b.name] = (counts[b.name] or 0) + 1
    end
  end
  table.sort(names)
  local parts = {}
  for _, n in ipairs(names) do parts[#parts + 1] = counts[n] .. " " .. n:gsub("^minecraft:", "") end
  return #parts > 0 and table.concat(parts, ", ") or "no ores"
end

say("Ore scout online. Say !ores or !where <player>.")
print("Ore scout listening")
while true do
  local _, who, message = os.pullEvent("chat")
  if message == "!ores" then
    local text, why = ores()
    if text then
      chat.tellrawToPlayer("Within 4 blocks: " .. text, who)
      print(who .. ": " .. text)
    else
      chat.tellrawToPlayer("Busy: " .. why, who)
    end
  else
    local name = message:match("^!where (%S+)$")
    if name then
      local ok, pos = finder.getPlayerPos(name)
      if ok then
        chat.tellrawToPlayer(("%s is at %d %d %d"):format(name, math.floor(pos.x), math.floor(pos.y), math.floor(pos.z)), who)
      else
        chat.tellrawToPlayer(pos, who)
      end
    end
  end
end
