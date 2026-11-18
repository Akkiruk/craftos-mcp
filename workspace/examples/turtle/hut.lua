-- A turtle builds a small hut and sets a computer up next to it.
--
-- The hut is 5 by 5 blocks: cobblestone walls three high with a doorway, and a roof of planks. The turtle starts on
-- the ground at what becomes the hut's south-west corner, facing north. When the roof is on it lands behind the hut,
-- places a computer there and turns it on.
--
-- It needs 46 cobblestone, 25 planks (any kind) and a computer in its inventory, and about 100 fuel.
--
-- Usage: hut            build it
--        hut dry        only say what it needs

local SIZE, HEIGHT = 5, 3
local WALL, ROOF = "cobblestone", "planks"

local function count(word)
  local total = 0
  for slot = 1, 16 do
    local item = turtle.getItemDetail(slot)
    if item and item.name:find(word, 1, true) then total = total + item.count end
  end
  return total
end

--- Select a slot that holds an item whose name has `word` in it.
local function pick(word)
  for slot = 1, 16 do
    local item = turtle.getItemDetail(slot)
    if item and item.name:find(word, 1, true) then
      turtle.select(slot)
      return true
    end
  end
  error("out of " .. word, 0)
end

local function go(move, what)
  for _ = 1, 20 do
    if move() then return end
    sleep(0.2) -- something is in the way for a moment (a mob, another turtle)
  end
  error("cannot move " .. what, 0)
end
local function forward() go(turtle.forward, "forward") end
local function up() go(turtle.up, "up") end
local function down() go(turtle.down, "down") end

local function placeBelow(word)
  pick(word)
  if not turtle.placeDown() and not turtle.detectDown() then error("cannot place " .. word, 0) end
end

local wallBlocks = (SIZE - 1) * 4 * HEIGHT - 2
local roofBlocks = SIZE * SIZE
local needs = {
  { WALL, wallBlocks },
  { ROOF, roofBlocks },
  { "computer", 1 },
}

local missing = {}
for _, need in ipairs(needs) do
  local have = count(need[1])
  print(("%-12s %3d of %d"):format(need[1], math.min(have, need[2]), need[2]))
  if have < need[2] then missing[#missing + 1] = need[1] end
end
local fuel = turtle.getFuelLevel()
if fuel ~= "unlimited" and fuel < 100 then missing[#missing + 1] = "fuel" end
if #missing > 0 then error("not enough " .. table.concat(missing, ", "), 0) end
if ... == "dry" then return end

-- The walls: one ring a layer, placed below the turtle as it flies round. The doorway is two blocks high in the
-- middle of the west wall, the first side it walks.
for layer = 1, HEIGHT do
  up()
  for side = 1, 4 do
    for step = 1, SIZE - 1 do
      local doorway = side == 1 and step == 3 and layer <= 2
      if not doorway then placeBelow(WALL) end
      forward()
    end
    turtle.turnRight()
  end
  print("wall layer " .. layer .. " of " .. HEIGHT)
end

-- The roof: back and forth over the whole square
up()
for row = 1, SIZE do
  for step = 1, SIZE do
    placeBelow(ROOF)
    if step < SIZE then forward() end
  end
  if row < SIZE then
    local turn = row % 2 == 1 and turtle.turnRight or turtle.turnLeft
    turn()
    forward()
    turn()
  end
end
print("roof on")

-- Land behind the hut and set the computer up
forward()
for _ = 1, HEIGHT + 1 do down() end
pick("computer")
if not turtle.place() then error("cannot place the computer", 0) end
local computer = peripheral.wrap("front")
if computer and computer.turnOn then computer.turnOn() end
print("Done: the hut stands, and its computer is on.")
