---@meta

-- Hand-written from CC:Tweaked's CommandAPI.java (1.101.3 and 1.121.0). `commands` itself is declared in
-- generated/commands.lua, with `commands.native` and `commands.async`. Only command computers have this API.

---A block as `commands.getBlockInfo` gives it.
---@class cc.CommandBlockInfo: cc.BlockDetail
---@field nbt? table The block entity's data, when it has one.

---Run a command and wait for it.
---
---[tweaked.cc](https://tweaked.cc/module/commands.html#v:exec)
---@param command string The command, without the leading `/`.
---@return boolean ok
---@return string[] output What the command printed, one line each.
---@return integer? affected How many things it affected. Nil when it failed.
function commands.exec(command) end

---Run a command without waiting. A `task_complete` event with the returned id carries the result.
---
---[tweaked.cc](https://tweaked.cc/module/commands.html#v:execAsync)
---@param command string The command, without the leading `/`.
---@return integer id
function commands.execAsync(command) end

---The commands this computer may run, or the sub-commands of one.
---
---[tweaked.cc](https://tweaked.cc/module/commands.html#v:list)
---@param ... string The command whose sub-commands to list.
---@return string[] commands
function commands.list(...) end

---Where the command computer is.
---
---[tweaked.cc](https://tweaked.cc/module/commands.html#v:getBlockPosition)
---@return integer x
---@return integer y
---@return integer z
function commands.getBlockPosition() end

---Every block in a box, at most 4096 of them. The list runs through x first, then z, then y.
---
---[tweaked.cc](https://tweaked.cc/module/commands.html#v:getBlockInfos)
---@param minX integer
---@param minY integer
---@param minZ integer
---@param maxX integer
---@param maxY integer
---@param maxZ integer
---@param dimension? string Default: the computer's own.
---@return cc.CommandBlockInfo[] blocks
function commands.getBlockInfos(minX, minY, minZ, maxX, maxY, maxZ, dimension) end

---One block.
---
---[tweaked.cc](https://tweaked.cc/module/commands.html#v:getBlockInfo)
---@param x integer
---@param y integer
---@param z integer
---@param dimension? string Default: the computer's own.
---@return cc.CommandBlockInfo block
function commands.getBlockInfo(x, y, z, dimension) end

---The dimension the command computer is in, such as `"minecraft:overworld"`.
---
---**Not in CC:Tweaked 1.101.3**: added in 1.119.0.
---
---[tweaked.cc](https://tweaked.cc/module/commands.html#v:getDimension)
---@return string dimension
function commands.getDimension() end

---Every entity a selector matches, such as `"@e[type=minecraft:cow]"`.
---
---**Not in CC:Tweaked 1.101.3**: added in 1.118.0.
---
---[tweaked.cc](https://tweaked.cc/module/commands.html#v:getEntities)
---@param selector string
---@return { name: string, displayName: string, tags: table<string, boolean>, [string]: any }[] entities `name` is the entity type's id.
function commands.getEntities(selector) end
