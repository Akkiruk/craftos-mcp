-- lift.lua: a lift operator for a Create elevator, through CC: LiftLink's create_elevator peripheral.
-- Usage: lift [floor ...]   with no floors it lists them. Each floor is a short or long name (case does not matter).
-- It calls the cab to each floor in turn and waits for it to arrive.

local lift = peripheral.find("create_elevator")
if not lift then error("no create_elevator next to this computer", 0) end

local function describe(floor)
  local name = floor.longName ~= "" and floor.longName or floor.name
  return ("%s (%s, y=%d)"):format(floor.name, name, floor.y)
end

local function listFloors()
  print("Floors:")
  local floors = lift.listFloors()
  for i = #floors, 1, -1 do
    local f = floors[i]
    local mark = f.isCurrent and "*" or (f.isTarget and ">" or " ")
    print((" %s %s"):format(mark, describe(f)))
  end
end

local function waitForArrival(timeout)
  local started = os.clock()
  sleep(0.1)
  while lift.isMoving() do
    if os.clock() - started > timeout then return false end
    sleep(0.25)
  end
  return true
end

local args = { ... }
if #args == 0 then
  listFloors()
  return
end

for _, wanted in ipairs(args) do
  local ok, err = pcall(lift.callToFloor, wanted)
  if not ok then
    print("Skipping " .. wanted .. ": " .. tostring(err))
  else
    print("Going to " .. wanted .. "...")
    if waitForArrival(60) then
      local here = lift.getNearestFloor()
      print(("Arrived at %s"):format(describe(here)))
    else
      print("The cab did not arrive in time")
    end
  end
end
