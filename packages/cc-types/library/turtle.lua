---@meta

-- Hand-written from CC:Tweaked's TurtleAPI.java (1.101.3 and 1.121.0). `turtle` itself is declared in
-- generated/turtle.lua. Only turtles have this API.

---A block as `turtle.inspect` gives it.
---@class cc.BlockDetail
---@field name string The block's id, such as `"minecraft:stone"`.
---@field state table<string, any> Its block state: `facing`, `powered` and so on.
---@field tags table<string, boolean>

---Move one block forward. Uses one fuel.
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:forward)
---@return boolean ok
---@return string? message Why it could not move.
function turtle.forward() end

---Move one block backwards. Uses one fuel.
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:back)
---@return boolean ok
---@return string? message Why it could not move.
function turtle.back() end

---Move one block up. Uses one fuel.
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:up)
---@return boolean ok
---@return string? message Why it could not move.
function turtle.up() end

---Move one block down. Uses one fuel.
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:down)
---@return boolean ok
---@return string? message Why it could not move.
function turtle.down() end

---Turn 90 degrees to the left.
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:turnLeft)
---@return boolean ok
---@return string? message Why it could not turn.
function turtle.turnLeft() end

---Turn 90 degrees to the right.
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:turnRight)
---@return boolean ok
---@return string? message Why it could not turn.
function turtle.turnRight() end

---Break the block in front of the turtle with a tool it has equipped.
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:dig)
---@param side? "left"|"right" Which tool to use. Default: whichever can.
---@return boolean ok
---@return string? message Why nothing was broken.
function turtle.dig(side) end

---Break the block above the turtle with a tool it has equipped.
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:digUp)
---@param side? "left"|"right" Which tool to use. Default: whichever can.
---@return boolean ok
---@return string? message Why nothing was broken.
function turtle.digUp(side) end

---Break the block below the turtle with a tool it has equipped.
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:digDown)
---@param side? "left"|"right" Which tool to use. Default: whichever can.
---@return boolean ok
---@return string? message Why nothing was broken.
function turtle.digDown(side) end

---Place the selected item in front of the turtle, or use it (a bucket, flint and steel, bone meal).
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:place)
---@param text? string The text of a sign being placed.
---@return boolean ok
---@return string? message Why nothing was placed.
function turtle.place(text) end

---Place the selected item above the turtle, or use it (a bucket, flint and steel, bone meal).
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:placeUp)
---@param text? string The text of a sign being placed.
---@return boolean ok
---@return string? message Why nothing was placed.
function turtle.placeUp(text) end

---Place the selected item below the turtle, or use it (a bucket, flint and steel, bone meal).
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:placeDown)
---@param text? string The text of a sign being placed.
---@return boolean ok
---@return string? message Why nothing was placed.
function turtle.placeDown(text) end

---Put items of the selected slot into the inventory in front of the turtle, or drop them into the world.
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:drop)
---@param count? integer How many. Default: the whole stack.
---@return boolean ok
---@return string? message Why nothing was dropped.
function turtle.drop(count) end

---Put items of the selected slot into the inventory above the turtle, or drop them into the world.
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:dropUp)
---@param count? integer How many. Default: the whole stack.
---@return boolean ok
---@return string? message Why nothing was dropped.
function turtle.dropUp(count) end

---Put items of the selected slot into the inventory below the turtle, or drop them into the world.
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:dropDown)
---@param count? integer How many. Default: the whole stack.
---@return boolean ok
---@return string? message Why nothing was dropped.
function turtle.dropDown(count) end

---Select a slot. Throws when the slot is out of range.
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:select)
---@param slot integer 1 to 16.
---@return true
function turtle.select(slot) end

---How many items are in a slot.
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:getItemCount)
---@param slot? integer 1 to 16. Default: the selected slot.
---@return integer count
function turtle.getItemCount(slot) end

---How many more items fit in a slot.
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:getItemSpace)
---@param slot? integer 1 to 16. Default: the selected slot.
---@return integer space
function turtle.getItemSpace(slot) end

---Whether a solid block is in front of the turtle.
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:detect)
---@return boolean
function turtle.detect() end

---Whether a solid block is above the turtle.
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:detectUp)
---@return boolean
function turtle.detectUp() end

---Whether a solid block is below the turtle.
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:detectDown)
---@return boolean
function turtle.detectDown() end

---Whether the block in front of the turtle is the same as the item in the selected slot.
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:compare)
---@return boolean
function turtle.compare() end

---Whether the block above the turtle is the same as the item in the selected slot.
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:compareUp)
---@return boolean
function turtle.compareUp() end

---Whether the block below the turtle is the same as the item in the selected slot.
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:compareDown)
---@return boolean
function turtle.compareDown() end

---Attack what is in front of the turtle with a tool it has equipped.
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:attack)
---@param side? "left"|"right" Which tool to use. Default: whichever can.
---@return boolean ok
---@return string? message Why nothing was attacked.
function turtle.attack(side) end

---Attack what is above the turtle with a tool it has equipped.
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:attackUp)
---@param side? "left"|"right" Which tool to use. Default: whichever can.
---@return boolean ok
---@return string? message Why nothing was attacked.
function turtle.attackUp(side) end

---Attack what is below the turtle with a tool it has equipped.
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:attackDown)
---@param side? "left"|"right" Which tool to use. Default: whichever can.
---@return boolean ok
---@return string? message Why nothing was attacked.
function turtle.attackDown(side) end

---Take items from the inventory in front of the turtle, or pick them up from the world.
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:suck)
---@param count? integer How many at most. Default: a stack.
---@return boolean ok
---@return string? message Why nothing was picked up.
function turtle.suck(count) end

---Take items from the inventory above the turtle, or pick them up from the world.
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:suckUp)
---@param count? integer How many at most. Default: a stack.
---@return boolean ok
---@return string? message Why nothing was picked up.
function turtle.suckUp(count) end

---Take items from the inventory below the turtle, or pick them up from the world.
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:suckDown)
---@param count? integer How many at most. Default: a stack.
---@return boolean ok
---@return string? message Why nothing was picked up.
function turtle.suckDown(count) end

---How much fuel the turtle has: one per block moved.
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:getFuelLevel)
---@return integer|"unlimited" fuel "unlimited" when the server has fuel switched off.
function turtle.getFuelLevel() end

---Burn items of the selected slot as fuel. `turtle.refuel(0)` only checks whether the item is fuel.
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:refuel)
---@param count? integer How many items at most. Default: the whole stack.
---@return boolean ok
---@return string? message Why it was not refuelled.
function turtle.refuel(count) end

---Whether the item in the selected slot is the same as the item in another slot.
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:compareTo)
---@param slot integer 1 to 16.
---@return boolean
function turtle.compareTo(slot) end

---Move items from the selected slot to another slot.
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:transferTo)
---@param slot integer 1 to 16.
---@param count? integer How many at most. Default: the whole stack.
---@return boolean moved Whether anything was moved.
function turtle.transferTo(slot, count) end

---The selected slot.
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:getSelectedSlot)
---@return integer slot 1 to 16.
function turtle.getSelectedSlot() end

---The most fuel the turtle can hold.
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:getFuelLimit)
---@return integer|"unlimited" limit
function turtle.getFuelLimit() end

---Swap the upgrade on the left side with the item in the selected slot. An empty slot takes the upgrade off.
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:equipLeft)
---@return boolean ok
---@return string? message Why the item could not be equipped.
function turtle.equipLeft() end

---Swap the upgrade on the right side with the item in the selected slot. An empty slot takes the upgrade off.
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:equipRight)
---@return boolean ok
---@return string? message Why the item could not be equipped.
function turtle.equipRight() end

---The upgrade on the left side as an item, or nil.
---
---**Not in CC:Tweaked 1.101.3**: added in 1.116.0.
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:getEquippedLeft)
---@return cc.ItemDetail? item
function turtle.getEquippedLeft() end

---The upgrade on the right side as an item, or nil.
---
---**Not in CC:Tweaked 1.101.3**: added in 1.116.0.
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:getEquippedRight)
---@return cc.ItemDetail? item
function turtle.getEquippedRight() end

---Look at the block in front of the turtle.
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:inspect)
---@return boolean found Whether a block is there.
---@return cc.BlockDetail|string block The block, or a message saying there is none.
function turtle.inspect() end

---Look at the block above the turtle.
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:inspectUp)
---@return boolean found Whether a block is there.
---@return cc.BlockDetail|string block The block, or a message saying there is none.
function turtle.inspectUp() end

---Look at the block below the turtle.
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:inspectDown)
---@return boolean found Whether a block is there.
---@return cc.BlockDetail|string block The block, or a message saying there is none.
function turtle.inspectDown() end

---The item in a slot, or nil when it is empty.
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:getItemDetail)
---@param slot? integer 1 to 16. Default: the selected slot.
---@param detailed? boolean Include everything `inventory.getItemDetail` gives. Slower: it waits a tick. Default false.
---@return cc.ItemDetail? item
function turtle.getItemDetail(slot, detailed) end

---Craft with the items in the turtle's inventory, laid out as in a crafting table. Only on a turtle with a crafting table.
---
---[tweaked.cc](https://tweaked.cc/module/turtle.html#v:craft)
---@param limit? integer How many to craft at most. Default 64.
---@return boolean ok
---@return string? message Why nothing was crafted.
function turtle.craft(limit) end

