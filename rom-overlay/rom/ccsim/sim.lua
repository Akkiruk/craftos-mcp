-- sim: change the simulated world from the shell. This program is the emulator's own: a real CC:Tweaked computer has
-- no `sim`. It sends the same commands the host sends (craftos_sim_command), through the emulator's world simulation
-- (rom/ccsim/core.lua, M.localCommand), and prints what came of them.
local args = { ... }

local function usage()
  print("sim is the emulator's, not CC:Tweaked's: a real computer has no such program.")
  print("Usage:")
  print(" sim join <player>          (adds them if new)")
  print(" sim leave <player>")
  print(" sim chat <player> <text>")
  print(" sim advance <seconds>")
  print(" sim item <inv> <slot> [item] [count]")
  print(" sim state")
  print(" sim <command> key=value ...")
  print(" sim help                   (every command)")
  print("Values: numbers, true, false, nil, {lua table};")
  print("a.b=x sets a nested field.")
end

if not fs.exists("/results/world.json") then
  printError("sim: this computer has no simulated world")
  return
end

local seq = 0
--- Send one command (a table, or "list"/"state") and wait for the sim's answer.
local function send(command)
  seq = seq + 1
  local token = ("sim:%d:%s"):format(seq, tostring(os.epoch("utc")))
  os.queueEvent("ccsim_cmd", token, type(command) == "table" and textutils.serializeJSON(command) or command)
  local timer = os.startTimer(5)
  while true do
    local event, a, ok, err, data = os.pullEvent()
    if event == "ccsim_reply" and a == token then
      os.cancelTimer(timer)
      return ok, err, data
    elseif event == "timer" and a == timer then
      -- `advance` fires this timer before the answer is queued: whatever is queued already comes before the marker
      os.queueEvent("sim_timeout", token)
    elseif event == "sim_timeout" and a == token then
      return false, "no answer from the simulated world"
    end
  end
end

local function parseValue(text)
  if text == "true" then return true end
  if text == "false" then return false end
  if text == "nil" or text == "null" then return nil end
  local n = tonumber(text)
  if n then return n end
  local first = text:sub(1, 1)
  if first == "{" or first == "[" then
    local value = textutils.unserializeJSON(text) or textutils.unserialize(text)
    if value ~= nil then return value end
  end
  return text
end

--- key=value words into a command table; dotted keys build nested tables.
local function parseFields(command, words)
  for _, word in ipairs(words) do
    local key, value = word:match("^([^=]+)=(.*)$")
    if not key then return nil, "expected key=value, got " .. word end
    local target, path = command, {}
    for part in key:gmatch("[^.]+") do path[#path + 1] = tonumber(part) or part end
    for i = 1, #path - 1 do
      if type(target[path[i]]) ~= "table" then target[path[i]] = {} end
      target = target[path[i]]
    end
    target[path[#path]] = parseValue(value)
  end
  return command
end

local function report(ok, err)
  if ok then
    print("ok")
  else
    printError("sim: " .. tostring(err or "failed"))
  end
end

local function state()
  local ok, err, data = send("state")
  if not ok then return report(ok, err) end
  local players = textutils.unserialize(data or "") or {}
  local h = fs.open("/results/state.json", "r")
  local saved = h and textutils.unserializeJSON(h.readAll()) or {}
  if h then h.close() end
  print(("Day %d, %s, %.1f s up"):format(os.day(), textutils.formatTime(os.time(), true), os.clock()))
  if #players == 0 then print("Players: none") end
  for _, p in ipairs(players) do
    local balance = p.balance ~= nil and (", balance %s"):format(tostring(p.balance)) or ""
    print((" %s %s%s"):format(p.name, p.online and "online" or "offline", balance))
  end
  local names = peripheral.getNames()
  print("Peripherals: " .. (#names == 0 and "none" or ""))
  for _, name in ipairs(names) do print((" %s (%s)"):format(name, table.concat({ peripheral.getType(name) }, ", "))) end
  local chat = type(saved.chat) == "table" and saved.chat or {}
  if #chat > 0 then
    print("Last chat sent to players:")
    for i = math.max(1, #chat - 2), #chat do print((" to %s: %s"):format(tostring(chat[i].to), tostring(chat[i].text))) end
  end
end

local function help()
  usage()
  local ok, err, names = send("list")
  if not ok then return report(ok, err) end
  print("Commands this world knows:")
  -- a run or a test (the runner leaves /results/unattended): nobody is there to press a key, so no "Press any key"
  if fs.exists("/results/unattended") then print(names or "") else textutils.pagedPrint(names or "") end
end

local verb = args[1]
if verb == nil or verb == "-h" or verb == "--help" then
  usage()
elseif verb == "help" then
  help()
elseif verb == "state" then
  state()
elseif verb == "join" or verb == "leave" then
  if not args[2] then return usage() end
  local ok, err = send({ cmd = verb, player = args[2] })
  if not ok and err == "unknown player" and verb == "join" then
    ok, err = send({ cmd = "addPlayer", name = args[2], online = true })
  end
  report(ok, err)
elseif verb == "chat" then
  if not args[2] or not args[3] then return usage() end
  report(send({ cmd = "chat", player = args[2], message = table.concat(args, " ", 3) }))
elseif verb == "advance" then
  -- as the time bar's jump: each timer on the way fires and the programs run before the next
  report(send({ cmd = "advance", seconds = tonumber(args[2]), stepped = true }))
elseif verb == "item" then
  local slot = tonumber(args[3])
  if not args[2] or not slot then return usage() end
  local item = args[4] and { name = args[4], count = tonumber(args[5]) or 1 } or nil
  report(send({ cmd = "setItem", peripheral = args[2], slot = slot, item = item }))
elseif verb == "unload" then
  -- an unloaded computer runs nothing, this shell included, so nothing could type `sim load` again
  printError("sim: unloading would stop this computer for good; hold Ctrl+R to reboot instead")
else
  local command, err = parseFields({ cmd = verb }, { table.unpack(args, 2) })
  if not command then
    printError("sim: " .. err)
    return
  end
  report(send(command))
end
