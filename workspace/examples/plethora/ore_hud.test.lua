-- Runs ore_hud.lua once against ore_hud.world.json (Steve wears a neural interface with the scanner, sensor,
-- introspection, glasses and laser modules; three ores, a zombie, a sheep and a far creeper), then calls every
-- neural interface method and every method of the objects they return, happy paths and argument errors.
-- Expected values follow Plethora-Fabric 1.20.1-1.13.0's source (docs/plethora.md).

local ni = peripheral.wrap("back")
local ZOMBIE = "0b0b0b0b-0000-4000-9000-00000000000a"
local SHEEP = "0b0b0b0b-0000-4000-9000-00000000000b"
local CREEPER = "0b0b0b0b-0000-4000-9000-00000000000c"
local STEVE = "6a2b3c4d-1111-4222-8333-444455556666"

local function err(fn, ...)
  local ok, e = pcall(fn, ...)
  if ok then error("expected an error but the call succeeded", 2) end
  return (tostring(e):gsub("^[^:]*:%d+: ", ""))
end

local simCount = 0
local function sim(command)
  simCount = simCount + 1
  os.queueEvent("ccsim_cmd", ("sim:%d:%.0f"):format(simCount, os.epoch("utc")), textutils.serializeJSON(command))
  os.queueEvent("sim_done")
  os.pullEvent("sim_done")
end

local function waitFor(condition, limit)
  local started = os.clock()
  while not condition() and os.clock() - started < limit do sleep(0.1) end
  return condition()
end

local function near(a, b, eps) return math.abs(a - b) <= (eps or 1e-9) end
local function f32(x) return (string.unpack and string.unpack("<f", string.pack("<f", x))) or x end

ccunit.test("ore_hud draws the HUD and shoots the zombie", function()
  local w, h = term.getSize()
  local screen = window.create(term.current(), 1, 1, w, h, false)
  local old = term.redirect(screen)
  local ok, e = pcall(shell.run, "examples/plethora/ore_hud.lua", "once")
  term.redirect(old)
  ccunit.truthy(ok, e)
  ccunit.eq((screen.getLine(1):gsub("%s+$", "")), "ores: 3  mobs: 2  shots: 1")
  ccunit.eq((screen.getLine(2):gsub("%s+$", "")), "nearest ore: minecraft:coal_ore")
  -- the zombie is 5 blocks away: one laser shot of potency 2 does 8 damage
  ccunit.truthy(waitFor(function() return ni.getMetaByID(ZOMBIE).health < 20 end, 5), "the zombie was not hit")
  ccunit.eq(ni.getMetaByID(ZOMBIE).health, 12)
end)

ccunit.test("type, methods and modules", function()
  ccunit.eq(peripheral.getType("back"), "neuralInterface")
  ccunit.eq(peripheral.getMethods("back"), {
    "getInventory", "getEquipment", "getEnder", "listModules", "hasModule", "filterModules", "getID", "getName",
    "getMetaOwner", "fire", "sense", "getMetaByID", "getMetaByName", "scan", "getBlockMeta", "canvas", "canvas3d",
    "getDocs",
  })
  -- a HashSet of Identifiers: Java's bucket order
  ccunit.eq(ni.listModules(), { "plethora:scanner", "plethora:introspection", "plethora:glasses", "plethora:sensor", "plethora:laser" })
  ccunit.eq(ni.hasModule("plethora:scanner"), true)
  ccunit.eq(ni.hasModule("scanner"), false) -- "minecraft:scanner"
  ccunit.eq(err(ni.hasModule), "bad argument #1 (string expected, got nil)")
  ccunit.eq(err(ni.hasModule, "Bad:x"),
    "Java Exception Thrown: net.minecraft.class_151: Non [a-z0-9_.-] character in namespace of location: Bad:x")
end)

ccunit.test("filterModules and getDocs", function()
  local f = ni.filterModules("plethora:sensor", "plethora:sensor", "minecraft:none")
  local names = {}
  for k in pairs(f) do names[#names + 1] = k end
  table.sort(names)
  ccunit.eq(names, { "filterModules", "getDocs", "getMetaByID", "getMetaByName", "hasModule", "listModules", "sense" })
  ccunit.eq(f.listModules(), { "plethora:sensor" })
  ccunit.eq(#f.sense(), 3)
  ccunit.eq(err(ni.filterModules, "minecraft:none"),
    'Java Exception Thrown: java.lang.NullPointerException: Cannot invoke "io.sc3.plethora.api.method.FutureMethodResult.isFinal()" because "next" is null')
  ccunit.eq(err(ni.filterModules, 1), "bad argument #1 (string expected, got number)")
  ccunit.eq(ni.getDocs("scan"), "function():table -- Scan all blocks in the vicinity")
  ccunit.eq(ni.getDocs().getDocs, "function([name: string]):string|table -- Get the documentation for all functions or the function specified. Errors if the function cannot be found.")
  ccunit.eq(err(ni.getDocs, "nope"), "No such method")
  ccunit.eq(err(ni.getDocs, 2), "bad argument #1 (string expected, got number)")
  ccunit.eq(f.getDocs("sense"), "function():table -- Scan for entities in the vicinity")
end)

ccunit.test("block scanner", function()
  local blocks = ni.scan()
  ccunit.eq(#blocks, 17 * 17 * 17)
  ccunit.eq(blocks[1], { x = -8, y = -8, z = -8, name = "minecraft:stone", state = {} })
  -- the scan is centred on the block of Steve's eyes (y 65.62 -> 65)
  local found
  for _, b in ipairs(blocks) do if b.name == "minecraft:diamond_ore" then found = b end end
  ccunit.eq({ found.x, found.y, found.z }, { 3, -5, 2 })
  local grass
  for _, b in ipairs(blocks) do if b.x == 0 and b.y == -2 and b.z == 0 then grass = b end end
  ccunit.eq(grass, { x = 0, y = -2, z = 0, name = "minecraft:grass_block", state = { snowy = false } })

  local meta = ni.getBlockMeta(3, -5, 2)
  ccunit.eq(meta.name, "minecraft:diamond_ore")
  ccunit.eq(meta.displayName, "Diamond Ore")
  ccunit.eq(meta.translationKey, "block.minecraft.diamond_ore")
  ccunit.eq(meta.hardness, 3)
  ccunit.eq(meta.state, {})
  ccunit.truthy(type(meta.colour) == "number" and meta.colour == meta.color)
  ccunit.eq(ni.getBlockMeta(0, 0, 0).name, "minecraft:air")
  ccunit.eq(ni.getBlockMeta(0, 0, 0).hardness, 0)
  ccunit.eq(ni.getBlockMeta(0.9, -2.5, 0).name, "minecraft:grass_block") -- getInt truncates
  ccunit.eq(err(ni.getBlockMeta, 9, 0, 0), "X coordinate out of bounds (between -8 and 8)")
  ccunit.eq(err(ni.getBlockMeta, 0, -9, 0), "Y coordinate out of bounds (between -8 and 8)")
  ccunit.eq(err(ni.getBlockMeta, 0, 0), "bad argument #3 (number expected, got nil)")
  ccunit.eq(err(ni.getBlockMeta, 0 / 0, 0, 0), "bad argument #1 (number expected, got nan)")
end)

ccunit.test("entity sensor", function()
  local seen = ni.sense()
  -- the creeper is 40 blocks away: out of the 16-block box
  ccunit.eq(#seen, 3)
  ccunit.eq(seen[1].id, STEVE)
  ccunit.eq({ seen[1].x, seen[1].y, seen[1].z }, { 0, 0, 0 })
  ccunit.eq(seen[1].key, "minecraft:player")
  ccunit.eq(seen[1].name, "Steve")
  local z = seen[2]
  ccunit.eq(z.id, ZOMBIE)
  ccunit.eq(z.key, "minecraft:zombie")
  ccunit.eq(z.name, "Zombie")
  ccunit.eq(z.displayName, "Zombie")
  ccunit.eq({ z.x, z.z }, { 4, 3 })
  ccunit.truthy(near(z.y, (64 + f32(f32(1.95) * f32(0.85))) - (64 + f32(1.62))), "zombie eyes " .. z.y)
  ccunit.eq({ z.motionX, z.motionY, z.motionZ, z.deltaPosX, z.pitch, z.yaw }, { 0, 0, 0, 0, 0, 0 })
  ccunit.eq(seen[3].id, SHEEP)

  local meta = ni.getMetaByID(ZOMBIE)
  ccunit.eq(meta.maxHealth, 20)
  ccunit.eq(meta.isAlive, true)
  ccunit.eq(meta.armor, {})
  ccunit.eq(meta.potionEffects, {})
  ccunit.truthy(meta.withinBlock and meta.withinBlock.x == 0.5)
  ccunit.eq(ni.getMetaByID(CREEPER), nil)
  ccunit.eq(select("#", ni.getMetaByID(CREEPER)), 0)
  ccunit.eq(ni.getMetaByID(ZOMBIE:upper()).key, "minecraft:zombie")
  ccunit.eq(err(ni.getMetaByID, "not-a-uuid"), "Invalid UUID")
  ccunit.eq(err(ni.getMetaByID), "bad argument #1 (string expected, got nil)")

  ccunit.eq(ni.getMetaByName("minecraft:sheep").woolColour, "black")
  ccunit.eq(ni.getMetaByName("Sheep").woolColor, "black")
  ccunit.eq(ni.getMetaByName("Steve").food.hunger, 18)
  ccunit.eq(ni.getMetaByName("Nobody"), nil)
  ccunit.eq(err(ni.getMetaByName, 1), "Unknown error in getMetaByName")
end)

ccunit.test("introspection", function()
  ccunit.eq(ni.getID(), STEVE)
  ccunit.eq(ni.getName(), "Steve")
  local me = ni.getMetaOwner()
  ccunit.eq(me.name, "Steve")
  ccunit.eq({ me.x, me.y, me.z }, { 0, 0, 0 })
  ccunit.eq(me.health, 20)
  ccunit.eq(me.food, { hunger = 18, saturation = 2.5, hungry = true })
  ccunit.eq(me.heldItemSlot, 0)
  ccunit.eq(me.heldItem.getMetadata().name, "minecraft:diamond_pickaxe")
  ccunit.eq(me.armor.helmet.getMetadata().name, "minecraft:iron_helmet")
  ccunit.eq(me.armor.boots, nil)
  ccunit.eq(me.heldItem.getDocs("getMetadata"), "function():table -- Get metadata about this object")
  ccunit.eq(err(me.heldItem.getDocs, "x"), "No such method")
  ccunit.eq(me.trinkets.head.face[1].getMetadata().name, "plethora:neural_interface")

  local inv = ni.getInventory()
  ccunit.eq(inv.size(), 36)
  ccunit.eq(inv.list()[1], { name = "minecraft:diamond_pickaxe", count = 1 })
  ccunit.eq(inv.getItemDetail(2).count, 5)
  ccunit.eq(inv.getItemDetail(2).hunger, 5)
  ccunit.eq(inv.getItemLimit(1), 64)
  ccunit.eq(err(inv.getItemDetail), "bad argument #1 (number expected, got nil)")
  ccunit.eq(inv.consume(1), false) -- a pickaxe is not eaten
  ccunit.eq(inv.consume(2), true)
  ccunit.eq(inv.getItemDetail(2).count, 4)
  ccunit.eq(ni.getMetaOwner().food.hunger, 20)
  ccunit.eq(inv.consume(10), false)
  ccunit.eq(err(inv.consume, 0), "Slot out of range (between 1 and 36)")
  ccunit.eq(err(inv.consume, 37), "Slot out of range (between 1 and 36)")
  ccunit.eq(inv.drop(3, 4, "up"), 4)
  ccunit.eq(inv.getItemDetail(3).count, 28)
  ccunit.eq(inv.drop(20, 1), 0)
  ccunit.eq(err(inv.drop, 3), "bad argument #2 (number expected, got nil)")
  ccunit.eq(err(inv.drop, 3, 0), "Limit out of range (between 1 and 2147483647)")
  ccunit.eq(err(inv.drop, 3, 1, "left"), "Invalid direction: left")
  local item
  for _, e in ipairs(ni.sense()) do if e.key == "minecraft:item" then item = e end end
  ccunit.eq(item.displayName, "Torch")
  ccunit.eq(item.name, "Item")
  ccunit.eq(ni.getMetaByID(item.id).item.count, 4)
  ccunit.eq(err(inv.pushItems, "nowhere", 1), "Target 'nowhere' does not exist")
  ccunit.eq(err(inv.pullItems, "nowhere", 1), "Source 'nowhere' does not exist")
  ccunit.eq(err(inv.pushItems), "bad argument #1 (string expected, got nil)")
  ccunit.eq(inv.getDocs("consume"), "function(slot:number):boolean -- Consume an item from the given slot in the inventory")

  local eq = ni.getEquipment()
  ccunit.eq(eq.size(), 6)
  ccunit.eq(eq.list(), { [1] = { name = "minecraft:diamond_pickaxe", count = 1 }, [6] = { name = "minecraft:iron_helmet", count = 1 } })
  ccunit.eq(eq.consume, nil) -- only the ranged inventories have consume and drop
  local ender = ni.getEnder()
  ccunit.eq(ender.size(), 27)
  ccunit.eq(ender.list(), { { name = "minecraft:emerald", count = 7 } })
end)

ccunit.test("overlay glasses: 2D canvas", function()
  local c = ni.canvas()
  ccunit.eq({ c.getSize() }, { 512, 288 })
  c.clear()
  local r = c.addRectangle(10, 20, 30, 40)
  ccunit.eq({ r.getPosition() }, { 10, 20 })
  ccunit.eq({ r.getSize() }, { 30, 40 })
  ccunit.eq(r.getColour(), 0xFFFFFFFF)
  r.setColour(0x11223344)
  ccunit.eq(r.getColor(), 0x11223344)
  r.setColor(255, 0, 0)
  ccunit.eq(r.getColour(), 0xFF000044) -- three numbers keep the alpha
  r.setColour(1, 2, 3, 4)
  ccunit.eq(r.getColour(), 0x01020304)
  ccunit.eq(r.getAlpha(), 4)
  r.setAlpha(0x1FF)
  ccunit.eq(r.getAlpha(), 0xFF)
  r.setSize(5, 6)
  r.setPosition(7, 8)
  ccunit.eq({ r.getSize() }, { 5, 6 })
  ccunit.eq({ r.getPosition() }, { 7, 8 })
  ccunit.eq(err(r.setColour, 1, 2), "bad argument #3 (number expected, got nil)")
  ccunit.eq(err(r.setPosition), "bad argument #1 (number expected, got nil)")
  ccunit.eq(err(c.addRectangle, 1, 2, 3), "bad argument #4 (number expected, got nil)")

  local t = c.addText({ x = 1, y = 2 }, "hi", 0xFF00FFFF, 2)
  ccunit.eq(t.getText(), "hi")
  ccunit.eq(t.getScale(), 2)
  ccunit.eq(t.hasShadow(), false)
  t.setShadow(true)
  ccunit.eq(t.hasShadow(), true)
  ccunit.eq(t.getLineHeight(), 9)
  t.setLineHeight(70000)
  ccunit.eq(t.getLineHeight(), 4464) -- toShort()
  t.setText("bye")
  ccunit.eq(t.getText(), "bye")
  ccunit.eq(err(t.setText, string.rep("x", 513)), "string length out of bounds (between 0 and 512)")
  ccunit.eq(err(t.setScale, 0), "Scale must be > 0")
  ccunit.eq(err(c.addText, { 1 }, "x"), "Expected number for key 2.0, got nil")
  ccunit.eq(err(c.addText, { x = 1, y = "a" }, "x"), "Expected number for key y, got string")
  ccunit.eq(err(c.addText, { 1, 2 }), "bad argument #2 (string expected, got nil)")

  local line = c.addLine({ 0, 0 }, { 10, 10 }, 0xFF0000FF, 3)
  ccunit.eq({ line.getPoint(2) }, { 10, 10 })
  line.setPoint(1, 5, 5)
  ccunit.eq({ line.getPoint(1) }, { 5, 5 })
  ccunit.eq(line.getScale(), 3)
  ccunit.eq(err(line.getPoint, 3), "Index out of range (between 1 and 2)")
  local dot = c.addDot({ 3, 4 }, 0x00FF00FF, 0.5)
  ccunit.eq({ dot.getPosition() }, { 3, 4 })
  ccunit.eq(dot.getScale(), 0.5)
  local tri = c.addTriangle({ 0, 0 }, { 1, 0 }, { 0, 1 })
  ccunit.eq({ tri.getPoint(3) }, { 0, 1 })
  local poly = c.addPolygon({ 0, 0 }, { 4, 0 }, { 4, 4 }, 0x0000FFFF)
  ccunit.eq(poly.getPointCount(), 3)
  ccunit.eq(poly.getColour(), 0x0000FFFF)
  poly.insertPoint(2, 2, -1)
  ccunit.eq(poly.getPointCount(), 4)
  ccunit.eq({ poly.getPoint(2) }, { 2, -1 })
  -- the source reads the point from the third argument when there are only two
  ccunit.eq(err(poly.insertPoint, 1, 1), "bad argument #3 (number expected, got nil)")
  poly.removePoint(1)
  ccunit.eq({ poly.getPoint(1) }, { 2, -1 })
  ccunit.eq(err(poly.removePoint, 9), "Index out of range (between 1 and 3)")
  local loop = c.addLines({ 0, 0 }, { 1, 1 }, { 2, 0 }, 0xFFFFFF80, 2)
  ccunit.eq(loop.getPointCount(), 3)
  ccunit.eq(loop.getScale(), 2)
  local it = c.addItem({ 1, 1 }, "minecraft:diamond", 2)
  ccunit.eq(it.getItem(), "minecraft:diamond")
  it.setItem("stick")
  ccunit.eq(it.getItem(), "minecraft:stick")
  ccunit.eq(err(c.addItem, { 1, 1 }, "minecraft:nope"), "Unknown item 'minecraft:nope'")
  ccunit.eq(err(it.setItem, "Bad Item"),
    "Java Exception Thrown: net.minecraft.class_151: Non [a-z0-9/._-] character in path of location: minecraft:Bad Item")

  local g = c.addGroup({ 100, 100 })
  local inner = g.addText({ 0, 0 }, "inside")
  ccunit.eq(inner.getText(), "inside")
  g.clear()
  ccunit.eq(err(inner.getText), "This object has been removed")
  local again = g.addDot({ 1, 1 })
  g.remove()
  ccunit.eq(err(again.getPosition), "This object has been removed")
  ccunit.eq(err(g.addDot, { 1, 1 }), "This object has been removed")
  t.remove()
  ccunit.eq(err(t.getText), "This object has been removed")
  ccunit.eq(c.getDocs("addText"), "function(position:table, contents:string[, colour:number[, size:number]]):table -- Create a new text object.")
end)

ccunit.test("overlay glasses: 3D canvas", function()
  local c3 = ni.canvas3d()
  local root = c3.create({ 0, 1, 0 })
  local box = root.addBox(1, 2, 3)
  ccunit.eq({ box.getPosition() }, { 1, 2, 3 })
  ccunit.eq({ box.getSize() }, { 1, 1, 1 })
  ccunit.eq(box.isDepthTested(), true)
  box.setDepthTested(false)
  ccunit.eq(box.isDepthTested(), false)
  local big = root.addBox(0, 0, 0, 2, 3, 4, 0xFF0000FF)
  ccunit.eq({ big.getSize() }, { 2, 3, 4 })
  ccunit.eq(big.getColour(), 0xFF0000FF)
  big.setSize(5, 5, 5)
  big.setPosition(1, 1, 1)
  ccunit.eq({ big.getSize() }, { 5, 5, 5 })
  local frame = root.addFrame({ 0, 2, 0 })
  ccunit.eq({ frame.getSize() }, { 512, 288 })
  ccunit.eq(select("#", frame.getRotation()), 0) -- faces the player
  frame.setRotation(0, 90, 0)
  ccunit.eq({ frame.getRotation() }, { 0, 90, 0 })
  frame.setRotation()
  ccunit.eq(select("#", frame.getRotation()), 0)
  ccunit.eq(frame.addText({ 1, 1 }, "on a frame").getText(), "on a frame")
  local item = root.addItem({ 0, 0, 0 }, "minecraft:apple", 0.5)
  ccunit.eq({ item.getRotation() }, { 0, 0, 0 })
  ccunit.eq(item.getScale(), 0.5)
  root.recenter()
  root.recenter(1, 2, 3)
  ccunit.eq(err(root.addBox), "bad argument #1 (number expected, got nil)")
  ccunit.eq(err(c3.create, 5), "bad argument #1 (table expected, got number)")
end)

ccunit.test("laser", function()
  ccunit.eq(err(ni.fire, 0, 0, 10), "Potency out of range (between 0.5 and 5.0).")
  ccunit.eq(err(ni.fire, "a", 0, 1), "bad argument #1 (number expected, got string)")
  ccunit.eq(err(ni.fire, 0, 1 / 0, 1), "bad argument #2 (number expected, got inf)")
  -- straight down: the grass under Steve's feet goes
  ccunit.eq(select("#", ni.fire(0, 90, 1)), 0)
  ccunit.truthy(waitFor(function() return ni.getBlockMeta(0, -2, 0).name == "minecraft:air" end, 3), "the grass block was not broken")
  ccunit.eq(ni.getBlockMeta(0, -3, 0).name, "minecraft:stone") -- potency 1: grass takes 0.6, stone needs 1.5
end)

ccunit.test("module changes rebuild the peripheral", function()
  local text = ni.canvas().addText({ 1, 1 }, "old")
  local inv = ni.getInventory()
  sim({ cmd = "plethoraSetModules", peripheral = "back", modules = { "plethora:kinetic", "plethora:introspection", "plethora:sensor" } })
  -- the old wrap still calls by name, so it reaches the new peripheral; only a new wrap has the new methods
  ccunit.eq(ni.listModules(), { "plethora:kinetic", "plethora:introspection", "plethora:sensor" })
  ccunit.eq(ni.scan, ni.scan) -- still there in the old wrap...
  ccunit.eq(err(ni.scan), "No such method scan")
  ni = peripheral.wrap("back")
  ccunit.eq(peripheral.getMethods("back"), {
    "getInventory", "getEquipment", "getEnder", "look", "use", "swing", "listModules", "hasModule", "filterModules",
    "getID", "getName", "getMetaOwner", "launch", "sense", "getMetaByID", "getMetaByName", "getDocs",
  })
  ccunit.eq(err(text.getText), "A module has changed")
  ccunit.eq(err(inv.size), "Peripheral 'back' is no longer attached")

  ni.look(90, 100)
  local me = ni.getMetaOwner()
  ccunit.eq({ me.yaw, me.pitch }, { 90, 90 }) -- pitch is clamped to 90
  ni.look(-270, -30)
  me = ni.getMetaOwner()
  ccunit.eq({ me.yaw, me.pitch }, { 90, -30 })
  ccunit.eq(select("#", ni.launch(0, -90, 1)), 0)
  ccunit.eq(err(ni.launch, 0, 0, 5), "Power out of range (between 0.0 and 4.0).")
  ccunit.eq(err(ni.launch, 0, 0), "bad argument #3 (number expected, got nil)")
  ccunit.truthy(err(ni.use):find("not emulated", 1, true))
  ccunit.truthy(err(ni.swing):find("not emulated", 1, true))
end)
