-- lib/link.lua
-- Part of the craftos-mcp examples (MIT).
-- Finding the other cabinet and talking to it, over rednet on a wireless (or ender) modem.
-- Every cabinet says hello every couple of seconds. The last cabinet heard from is "the other cabinet"; it counts as
-- here while its hellos keep coming. Messages are plain tables with a type in t; anything else on the network, or a
-- message that isn't a table, is ignored.

local M = { PROTOCOL = "craftos-versus", HELLO_MS = 2000, GONE_MS = 7000 }

local modemName
local peer = nil      -- { id, name, game, busy, at }
local lastHello = -1e9

local function nowMs() return os.epoch("utc") end

--- This cabinet's name: the computer's label, or its number.
function M.name()
  return os.getComputerLabel() or ("Cabinet " .. os.getComputerID())
end

--- Open the first wireless modem. Returns true if there is one: with none, only the computer can be played.
function M.open()
  local modem = peripheral.find("modem", function(_, m) return m.isWireless() end)
  if not modem then
    modemName = nil
    return false
  end
  modemName = peripheral.getName(modem)
  if not rednet.isOpen(modemName) then rednet.open(modemName) end
  return true
end

function M.online() return modemName ~= nil end

--- The other cabinet, while it's still saying hello, or nil.
function M.peer()
  if peer and nowMs() - peer.at <= M.GONE_MS then return peer end
  return nil
end

--- Send a message to the other cabinet (or to id).
function M.send(msg, id)
  id = id or (peer and peer.id)
  if not modemName or not id then return false end
  msg.name = M.name()
  rednet.send(id, msg, M.PROTOCOL)
  return true
end

--- Say hello now and then, with what this cabinet is up to. Call it on every tick.
function M.hello(info)
  if not modemName or nowMs() - lastHello < M.HELLO_MS then return end
  lastHello = nowMs()
  local msg = { t = "hello", name = M.name() }
  for k, v in pairs(info or {}) do msg[k] = v end
  rednet.broadcast(msg, M.PROTOCOL)
end

--- A rednet_message event's message, if it's one of ours: the sender's id and the message, or nil.
--- Any message from a cabinet keeps it counted as here.
function M.read(sender, msg, protocol)
  if protocol ~= M.PROTOCOL or type(msg) ~= "table" or type(msg.t) ~= "string" or sender == os.getComputerID() then
    return nil
  end
  if msg.t == "hello" or not peer or peer.id ~= sender then
    peer = { id = sender, name = tostring(msg.name), busy = msg.busy, at = nowMs() }
  else
    peer.at = nowMs()
  end
  return sender, msg
end

return M
