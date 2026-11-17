-- A log kept on a reel-to-reel tape. Each record is a 2-byte length and the text; a zero length ends the log.
--   tape_log add <text...>   appends a record
--   tape_log list            prints every record
local reel = peripheral.find("reel_to_reel")
if not reel then error("no reel to reel attached", 0) end
if not reel.isReady() then reel.lock(true) sleep(0.1) end

local function u16(s) local a, b = s:byte(1, 2) return a + b * 256 end

--- Walk the records from the start; returns them and the position of the end marker
local function scan()
  reel.seekAbs(0)
  local records = {}
  while true do
    local len = u16(reel.read(2))
    if len == 0 then
      reel.seek(-2)
      return records, reel.getPos()
    end
    records[#records + 1] = reel.read(len)
  end
end

local command = ...
if command == "add" then
  local text = table.concat({ select(2, ...) }, " ")
  local records, at = scan()
  reel.seekAbs(at)
  if not reel.write(string.char(#text % 256, math.floor(#text / 256)) .. text .. "\0\0") then
    error("log full", 0)
  end
  print(("record %d written at %d"):format(#records + 1, at))
elseif command == "list" then
  local records = scan()
  for i, r in ipairs(records) do print(i, r) end
  print(#records .. " records")
else
  print("usage: tape_log add <text> | tape_log list")
end
