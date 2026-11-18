-- What CraftOS-PC's own commands and APIs (attach, detach, config, mount; periphemu, config, mounter) mean in this
-- emulator. CraftOS-PC can do things a real computer cannot: plug in a monitor from the keyboard, mount a folder of the
-- PC, change its settings. Here each one does what the real game would have you do (place the block next to the
-- computer, live) or says where the setting lives instead. Used by the shell programs next to this file (only on a
-- computer a person drives, world.simProgram) and by rom/ccsim/craftospc_api.lua (only with world.craftosPcApis).
local M = {}

-- CraftOS-PC's peripheral types (periphemu.names) and what each is here: a world peripheral spec, or why there is none
local SIDES = { left = true, right = true, top = true, bottom = true, front = true, back = true }

--- The world peripheral for CraftOS-PC's `attach <side> <type> [args...]`, or nil and why not.
function M.spec(side, kind, args)
  args = args or {}
  if type(side) ~= "string" or side == "" then return nil, "Which side? e.g. attach left monitor" end
  if type(kind) ~= "string" or kind == "" then return nil, "Which peripheral? e.g. attach " .. side .. " monitor" end
  if kind == "monitor" then
    -- CraftOS-PC's monitor is a window, 51x19 at first; a real one is a wall of 1x1 to 8x6 blocks, and 5x3 is 50x19
    local w, h = tonumber(args[1]), tonumber(args[2])
    return { name = side, type = "monitor", blocksWide = w or 5, blocksHigh = h or (w and 1 or 3) }
  elseif kind == "drive" then
    return { name = side, type = "drive" }, nil, tonumber(args[1])
  elseif kind == "speaker" then
    return { name = side, type = "speaker" }
  elseif kind == "modem" then
    return { name = side, type = "modem" }
  elseif kind == "chest" then
    return { name = side, type = "minecraft:chest", size = 27 }
  elseif kind == "tank" then
    return { name = side, type = "fluid_storage" }
  elseif kind == "energy" then
    return { name = side, type = "energy_storage" }
  elseif kind == "printer" then
    -- CraftOS-PC's printer prints to a file and never runs out; a real one needs ink and paper, so it gets a stack of
    -- each (the pages it prints show in the sim state, and in the app)
    return { name = side, type = "printer", ink = 64, paper = 64 }
  elseif kind == "computer" then
    return nil, "A second computer is its own window here: in the app, make a network (New computer, more than one) and"
      .. " its computers reach each other over modems, as in the game."
  elseif kind == "debugger" or kind == "debug_adapter" then
    return nil, "Debugging is built in: open the file in VS Code with the craftos-mcp extension and press F5."
  end
  -- any type the world knows (minecraft:barrel, playerDetector, ...): the world says if it does not
  return { name = side, type = kind }
end

--- Lines `attach` prints once the block is there.
function M.attached(def)
  local what = def.type == "minecraft:chest" and "chest" or def.type
  local size = def.type == "monitor" and (" (%dx%d blocks)"):format(def.blocksWide, def.blocksHigh) or ""
  -- the world file's entry, keys in a fixed order (a monitor wall goes in "monitors", the rest in "peripherals")
  local keys = def.type == "monitor" and { "name", "blocksWide", "blocksHigh" } or { "name", "type", "size", "ink", "paper" }
  local parts = {}
  for _, k in ipairs(keys) do
    if def[k] ~= nil then parts[#parts + 1] = ("%q: %s"):format(k, textutils.serializeJSON(def[k])) end
  end
  return {
    ("Placed a %s%s on %s."):format(what, size, def.name),
    "In the game you would put the block next to the computer; here it goes into the simulated world, live.",
    ("To have it every time, add it to the world file's %s:"):format(def.type == "monitor" and '"monitors"' or '"peripherals"'),
    "  { " .. table.concat(parts, ", ") .. " }",
  }
end

M.SIDES = SIDES
M.TYPES = { "monitor", "drive", "speaker", "printer", "modem", "chest", "tank", "energy" }

-- ===== config: CraftOS-PC's settings and where each lives here =====

--- name -> { get = function() value end, type = "boolean"|"number"|"string", where = "how to change it" }
M.settings = {
  http_enable = {
    type = "boolean",
    get = function() return http ~= nil end,
    where = "the server's config (computercraft-server.toml) has it on, as here",
  },
  isColor = {
    type = "boolean",
    get = function() return term.isColor() end,
    where = 'the world file: "advanced": false is a plain (no colour) computer',
  },
  defaultWidth = {
    type = "number",
    get = function() return (term.getSize()) end,
    where = 'the world file: "terminal": { "width": 51, "height": 19 }',
  },
  defaultHeight = {
    type = "number",
    get = function() return select(2, term.getSize()) end,
    where = 'the world file: "terminal": { "width": 51, "height": 19 }',
  },
  computerSpaceLimit = {
    type = "number",
    get = function()
      local ok, cap = pcall(fs.getCapacity, "/")
      return ok and cap or nil
    end,
    where = "fixed, as on the server (computer_space_limit in computercraft-server.toml)",
  },
  default_computer_settings = {
    type = "string",
    get = function() return "" end,
    where = "use the settings program on the computer (settings set motd.enable false)",
  },
  clockSpeed = {
    type = "number",
    get = function() return 20 end,
    where = "fixed at 20 ticks a second, as in the game; `sim advance <seconds>` moves the clock on",
  },
}

local NO_COUNTERPART = "CraftOS-PC's %s has no counterpart here: craftos-mcp behaves as a computer on a real server does."

--- Every setting name, sorted.
function M.settingNames()
  local names = {}
  for name in pairs(M.settings) do names[#names + 1] = name end
  table.sort(names)
  return names
end

--- What `config set` (and config.set) answers: where the setting lives instead.
function M.whereSet(name)
  local s = M.settings[name]
  if not s then return NO_COUNTERPART:format(tostring(name)) end
  return ("%s cannot be changed from inside the computer here (a real computer cannot either). Instead: %s."):format(name, s.where)
end

function M.noCounterpart(name) return NO_COUNTERPART:format(tostring(name)) end

-- ===== mount =====

M.MOUNT = {
  "A real computer cannot see folders on your PC, so craftos-mcp has no mount.",
  "Instead:",
  " - the computer's own files are your project folder (craftos.json's workspace, or --dir); edit them there",
  "   and reboot (hold Ctrl+R)",
  " - to carry files between computers, use a floppy: attach left drive, then put a disk in",
}

--- What is mounted where, as CraftOS-PC's `mount` lists it: the ROM and any disks.
local HARNESS = { ccunit = true, results = true } -- the emulator's own mounts (and hidden dot ones), not the computer's
function M.mounts()
  local out = {}
  for _, name in ipairs(fs.list("/")) do
    local drive = not HARNESS[name] and name:sub(1, 1) ~= "." and fs.getDrive(name)
    if drive and drive ~= "hdd" then out[#out + 1] = { path = "/" .. name, drive = drive, readOnly = fs.isReadOnly(name) } end
  end
  return out
end

-- ===== the shell programs talk to the simulated world as `sim` does (rom/ccsim/sim.lua) =====

local seq = 0
--- Send one sim command and wait for the answer: ok, error.
function M.send(command)
  if not fs.exists("/results/world.json") then return false, "this computer has no simulated world" end
  seq = seq + 1
  local token = ("sim:cpc%d:%s"):format(seq, tostring(os.epoch("utc")))
  os.queueEvent("ccsim_cmd", token, textutils.serializeJSON(command))
  local timer = os.startTimer(5)
  while true do
    local event, a, ok, err = os.pullEvent()
    if event == "ccsim_reply" and a == token then
      os.cancelTimer(timer)
      return ok, err
    elseif event == "timer" and a == timer then
      return false, "no answer from the simulated world"
    end
  end
end

--- Print lines, wrapped to the screen.
function M.say(lines)
  for _, line in ipairs(type(lines) == "table" and lines or { lines }) do print(line) end
end

return M
