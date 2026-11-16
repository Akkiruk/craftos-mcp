-- Rednet chat between computers.
--
-- Run it on two or more computers that each have a modem (wireless modems within range of each
-- other, or computers on one wired network). Type a line and press Enter to send it to everyone;
-- /who lists the people that have joined, /quit leaves.
--
-- Usage: chat <name>

local args = { ... }
local name = args[1]
if not name then error("usage: chat <name>", 0) end

local PROTOCOL = "craftos-chat"

-- Open every modem so the chat works whichever side it is on
local opened = false
for _, side in ipairs(peripheral.getNames()) do
  if peripheral.getType(side) == "modem" then
    rednet.open(side)
    opened = true
  end
end
if not opened then error("no modem found", 0) end

-- Messages are tables { kind = "join" | "here" | "say" | "leave", name = ..., text = ... }
local peers = {}  -- computer id -> name
local lines = {}  -- what is on the screen: { text, colour }
local typed = ""  -- the line being typed
local running = true

local function add(text, colour)
  lines[#lines + 1] = { text = text, colour = colour or colors.white }
end

local function draw()
  local width, height = term.getSize()
  term.setBackgroundColor(colors.black)
  term.clear()
  term.setCursorPos(1, 1)
  term.setBackgroundColor(colors.blue)
  term.setTextColor(colors.white)
  term.write((" Chat as " .. name .. (" "):rep(width)):sub(1, width))
  term.setBackgroundColor(colors.black)

  -- The newest lines that fit between the title and the input line
  local rows = height - 2
  for row = 1, math.min(rows, #lines) do
    local line = lines[#lines - math.min(rows, #lines) + row]
    term.setCursorPos(1, 1 + row)
    term.setTextColor(line.colour)
    term.write(line.text:sub(1, width))
  end

  term.setCursorPos(1, height)
  term.setTextColor(colors.lightGray)
  local prompt = "> " .. typed
  term.write(prompt:sub(-width))
  term.setCursorBlink(true)
end

local function broadcast(message)
  message.name = name
  rednet.broadcast(message, PROTOCOL)
end

local function receive()
  while running do
    local sender, message = rednet.receive(PROTOCOL)
    if type(message) == "table" then
      if message.kind == "join" then
        peers[sender] = message.name
        add(message.name .. " joined", colors.lime)
        rednet.send(sender, { kind = "here", name = name }, PROTOCOL)
      elseif message.kind == "here" then
        peers[sender] = message.name
      elseif message.kind == "say" then
        add(("%s: %s"):format(message.name, tostring(message.text)), colors.yellow)
      elseif message.kind == "leave" then
        peers[sender] = nil
        add(message.name .. " left", colors.orange)
      end
      draw()
    end
  end
end

--- Handle one finished line of input.
local function submit(text)
  if text == "/quit" then
    running = false
  elseif text == "/who" then
    local names = { name }
    for _, peer in pairs(peers) do names[#names + 1] = peer end
    table.sort(names)
    add("here: " .. table.concat(names, ", "), colors.lightGray)
  elseif text ~= "" then
    add(name .. ": " .. text, colors.cyan)
    broadcast({ kind = "say", text = text })
  end
end

local function type_()
  while running do
    local event, key = os.pullEvent()
    if event == "char" then
      typed = typed .. key
    elseif event == "key" and key == keys.backspace then
      typed = typed:sub(1, -2)
    elseif event == "key" and key == keys.enter then
      local text = typed
      typed = ""
      submit(text)
    end
    draw()
  end
end

broadcast({ kind = "join" })
add("Connected. Type to chat, /who to see who is here, /quit to leave.", colors.lightGray)
draw()
parallel.waitForAny(receive, type_)

broadcast({ kind = "leave" })
for _, side in ipairs(peripheral.getNames()) do
  if peripheral.getType(side) == "modem" then rednet.close(side) end
end
term.setCursorBlink(false)
term.setBackgroundColor(colors.black)
term.clear()
term.setCursorPos(1, 1)
