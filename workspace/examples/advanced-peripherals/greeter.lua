-- Advanced Peripherals player greeter.
--
-- The player detector notices who is standing near the computer and the chat box talks to them:
-- everyone gets a private welcome when they walk into range, and answers a couple of chat commands.
--
--   !players   lists the players in range
--   !where     tells you your own coordinates
--
-- Needs a Player Detector and a Chat Box next to (or wired to) the computer.
-- Usage: greeter [range]

local args = { ... }
local RANGE = tonumber(args[1]) or 20 -- blocks, as a box around the detector
local POLL = 2                        -- seconds between looks at who is near

-- Advanced Peripherals names them player_detector and chat_box from Minecraft 1.21.1 on
local detector = peripheral.find("playerDetector") or peripheral.find("player_detector")
local chat = peripheral.find("chatBox") or peripheral.find("chat_box")
if not detector then error("no player detector found", 0) end
if not chat then error("no chat box found", 0) end

--- Send `message` to one player. The chat box allows one message every 100 ms; if another one went
--- out just now, wait a moment and try again.
local function tell(player, message)
  for _ = 1, 5 do
    local ok = chat.sendMessageToPlayer(message, player, "Greeter")
    if ok then return true end
    sleep(0.2)
  end
  return false
end

-- Players seen in range on the last look: name -> true. Whoever is not in it yet is new.
local present = {}

--- Greet newcomers, forget anyone who has left (so they are greeted again next time).
local function watch()
  while true do
    local nowPresent = {}
    for _, name in ipairs(detector.getPlayersInRange(RANGE)) do
      nowPresent[name] = true
      if not present[name] then
        tell(name, ("Welcome, %s! Say !players to see who is around."):format(name))
      end
    end
    present = nowPresent
    sleep(POLL)
  end
end

--- Answer chat commands. A chat message arrives as the event "chat": name, text, uuid, hidden.
local function listen()
  while true do
    local _, name, message = os.pullEvent("chat")
    if message == "!players" then
      local names = detector.getPlayersInRange(RANGE)
      table.sort(names)
      tell(name, #names .. " player(s) in range: " .. table.concat(names, ", "))
    elseif message == "!where" then
      local position = detector.getPlayerPos(name)
      if position.x then
        tell(name, ("You are at %d, %d, %d."):format(position.x, position.y, position.z))
      else
        tell(name, "I cannot see you from here.")
      end
    end
  end
end

parallel.waitForAny(watch, listen)
