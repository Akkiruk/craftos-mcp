-- Create train departure board.
--
-- Shows every Train Station that is attached to the computer (directly or over a wired modem)
-- on a monitor: which train is at the platform, which one is about to arrive, and where each
-- train goes next according to its schedule. A station peripheral only knows its own platform,
-- so connect every station you want on the board to this computer with wired modems.
--
-- Usage: train_board [monitor_name]

local args = { ... }
local REFRESH = 1 -- seconds between updates

local monitor = args[1] and peripheral.wrap(args[1]) or peripheral.find("monitor")
if not monitor then error("no monitor found", 0) end

-- Column x positions and widths
local COLUMNS = {
  { title = "PLATFORM", x = 1, width = 11 },
  { title = "TRAIN", x = 12, width = 15 },
  { title = "STATUS", x = 27, width = 12 },
  { title = "SCHEDULE", x = 39, width = 24 },
}

--- Call f and give back its result, or nil when it throws (most station methods throw when
--- no train is present).
local function try(f, ...)
  local ok, result = pcall(f, ...)
  if ok then return result end
end

--- The station names a schedule visits, in order: {"Farm", "Central"}.
local function stops(schedule)
  local names = {}
  for _, entry in ipairs(schedule and schedule.entries or {}) do
    local instruction = entry.instruction
    if instruction and instruction.id == "create:destination" then
      names[#names + 1] = instruction.data.text
    end
  end
  return names
end

--- Everything the board shows about one station.
local function readStation(station)
  local row = { platform = station.getStationName() }
  if station.isTrainPresent() then
    row.train = try(station.getTrainName) or "Unnamed Train"
    row.status, row.colour = "AT PLATFORM", colors.lime
    local schedule = try(station.getSchedule)
    row.route = schedule and table.concat(stops(schedule), " > ") or "no schedule"
  elseif station.isTrainImminent() then
    row.status, row.colour = "ARRIVING", colors.yellow
  elseif station.isTrainEnroute() then
    row.status, row.colour = "EXPECTED", colors.lightBlue
  else
    row.status, row.colour = "NO TRAIN", colors.gray
  end
  return row
end

local function readAll()
  local rows = {}
  for _, station in ipairs({ peripheral.find("Create_Station") }) do
    rows[#rows + 1] = readStation(station)
  end
  table.sort(rows, function(a, b) return a.platform < b.platform end)
  return rows
end

local function cell(column, y, text, colour)
  monitor.setCursorPos(column.x, y)
  monitor.setTextColor(colour)
  monitor.write((text .. (" "):rep(column.width)):sub(1, column.width - 1))
end

local function draw(rows)
  local width, height = monitor.getSize()
  monitor.setBackgroundColor(colors.black)
  monitor.clear()

  monitor.setBackgroundColor(colors.gray)
  monitor.setTextColor(colors.white)
  monitor.setCursorPos(1, 1)
  monitor.write((" DEPARTURES" .. (" "):rep(width)):sub(1, width))
  monitor.setCursorPos(width - 5, 1)
  monitor.write(textutils.formatTime(os.time(), true))

  monitor.setBackgroundColor(colors.black)
  for _, column in ipairs(COLUMNS) do cell(column, 3, column.title, colors.orange) end
  for i, row in ipairs(rows) do
    local y = 3 + i * 2
    if y > height then break end
    cell(COLUMNS[1], y, row.platform, colors.white)
    cell(COLUMNS[2], y, row.train or "", colors.white)
    cell(COLUMNS[3], y, row.status, row.colour)
    cell(COLUMNS[4], y, row.route or "", colors.lightGray)
  end
end

while true do
  draw(readAll())
  sleep(REFRESH)
end
