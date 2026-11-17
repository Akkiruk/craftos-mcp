---@meta

-- Hand-written from CC:Tweaked's PocketAPI.java (1.101.3 and 1.121.0, the same in both). Only pocket computers have
-- this API.

---Change the upgrade on the back of a pocket computer.
---
---[tweaked.cc](https://tweaked.cc/module/pocket.html)
---@class cc.pocket
pocket = {}

---Take an upgrade from the player's inventory and put it on the pocket computer. The one that was on goes back to
---the player.
---
---[tweaked.cc](https://tweaked.cc/module/pocket.html#v:equipBack)
---@return boolean ok
---@return string? message Why nothing was equipped.
function pocket.equipBack() end

---Take the upgrade off and give it to the player.
---
---[tweaked.cc](https://tweaked.cc/module/pocket.html#v:unequipBack)
---@return boolean ok
---@return string? message Why nothing was taken off.
function pocket.unequipBack() end
