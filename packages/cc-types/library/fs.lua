---@meta

-- Hand-written from CC:Tweaked's FSAPI.java and core/apis/handles (1.101.3 and 1.121.0). `fs` itself is declared in
-- generated/fs.lua, with the functions the ROM adds in Lua (complete, find, isDriveRoot).

---What `fs.attributes` returns.
---@class cc.fs.Attributes
---@field size integer Size in bytes; 0 for a folder.
---@field isDir boolean
---@field isReadOnly boolean
---@field created integer When it was made, in milliseconds since 1 January 1970.
---@field modified integer When it was last changed, in milliseconds since 1 January 1970.
---@field modification integer The same as `modified`, the older name.

---A file open for reading as text (`fs.open(path, "r")`).
---
---[tweaked.cc](https://tweaked.cc/module/fs.html#ty:ReadHandle)
---@class cc.fs.ReadHandle
local ReadHandle = {}

---Read characters. Nil at the end of the file.
---@param count? integer How many. Default 1.
---@return string? text
function ReadHandle.read(count) end

---Read the rest of the file. Nil when already at the end.
---@return string? text
function ReadHandle.readAll() end

---Read one line. Nil at the end of the file.
---@param withTrailing? boolean Keep the newline. Default false.
---@return string? line
function ReadHandle.readLine(withTrailing) end

---Move to a position in the file and return it.
---
---**Not in CC:Tweaked 1.101.3** for text handles (binary ones have it): added in 1.109.0.
---@param whence? "set"|"cur"|"end" Where `offset` counts from. Default `"cur"`.
---@param offset? integer Default 0.
---@return integer? position The new position from the start of the file.
---@return string? message Why it failed.
function ReadHandle.seek(whence, offset) end

---Close the file. The handle cannot be used afterwards.
function ReadHandle.close() end

---A file open for reading bytes (`fs.open(path, "rb")`).
---
---[tweaked.cc](https://tweaked.cc/module/fs.html#ty:ReadHandle)
---@class cc.fs.BinaryReadHandle: cc.fs.ReadHandle
local BinaryReadHandle = {}

---Read one byte as a number, or `count` bytes as a string. Nil at the end of the file.
---@return integer? byte
---@overload fun(count: integer): string?
function BinaryReadHandle.read() end

---A file open for writing (`fs.open(path, "w")`, `"a"`, `"wb"`, `"ab"`).
---
---[tweaked.cc](https://tweaked.cc/module/fs.html#ty:WriteHandle)
---@class cc.fs.WriteHandle
local WriteHandle = {}

---Write text. In binary mode a number is written as one byte.
---@param text string|number
function WriteHandle.write(text) end

---Write text and a newline.
---@param text string|number
function WriteHandle.writeLine(text) end

---Save what was written so far without closing.
function WriteHandle.flush() end

---Move to a position in the file and return it. Not on append handles.
---
---**Not in CC:Tweaked 1.101.3** for text handles (binary ones have it): added in 1.109.0.
---@param whence? "set"|"cur"|"end" Where `offset` counts from. Default `"cur"`.
---@param offset? integer Default 0.
---@return integer? position The new position from the start of the file.
---@return string? message Why it failed.
function WriteHandle.seek(whence, offset) end

---Save and close the file. The handle cannot be used afterwards.
function WriteHandle.close() end

---A file open for reading and writing (`fs.open(path, "r+")` or `"w+"`).
---
---**Not in CC:Tweaked 1.101.3**: added in 1.109.0.
---
---[tweaked.cc](https://tweaked.cc/module/fs.html#ty:ReadWriteHandle)
---@class cc.fs.ReadWriteHandle: cc.fs.ReadHandle, cc.fs.WriteHandle

---The names of everything in a folder, sorted.
---
---[tweaked.cc](https://tweaked.cc/module/fs.html#v:list)
---@param path string
---@return string[] names
function fs.list(path) end

---Join parts of a path, with one `/` between them and `..` resolved.
---
---[tweaked.cc](https://tweaked.cc/module/fs.html#v:combine)
---@param path string
---@param ... string More parts.
---@return string path
function fs.combine(path, ...) end

---The last part of a path: `fs.getName("rom/startup.lua")` is `"startup.lua"`.
---
---[tweaked.cc](https://tweaked.cc/module/fs.html#v:getName)
---@param path string
---@return string name
function fs.getName(path) end

---The folder a path is in: `fs.getDir("rom/startup.lua")` is `"rom"`.
---
---[tweaked.cc](https://tweaked.cc/module/fs.html#v:getDir)
---@param path string
---@return string dir
function fs.getDir(path) end

---The size of a file in bytes. Throws when the path does not exist.
---
---[tweaked.cc](https://tweaked.cc/module/fs.html#v:getSize)
---@param path string
---@return integer size
function fs.getSize(path) end

---Whether a file or folder is there.
---
---[tweaked.cc](https://tweaked.cc/module/fs.html#v:exists)
---@param path string
---@return boolean
function fs.exists(path) end

---Whether the path is a folder.
---
---[tweaked.cc](https://tweaked.cc/module/fs.html#v:isDir)
---@param path string
---@return boolean
function fs.isDir(path) end

---Whether the path cannot be written to (the ROM, a treasure disk).
---
---[tweaked.cc](https://tweaked.cc/module/fs.html#v:isReadOnly)
---@param path string
---@return boolean
function fs.isReadOnly(path) end

---Make a folder, and the folders above it that are missing.
---
---[tweaked.cc](https://tweaked.cc/module/fs.html#v:makeDir)
---@param path string
function fs.makeDir(path) end

---Move a file or folder. Throws when the destination exists.
---
---[tweaked.cc](https://tweaked.cc/module/fs.html#v:move)
---@param path string
---@param dest string
function fs.move(path, dest) end

---Copy a file or folder. Throws when the destination exists.
---
---[tweaked.cc](https://tweaked.cc/module/fs.html#v:copy)
---@param path string
---@param dest string
function fs.copy(path, dest) end

---Delete a file, or a folder and everything in it. Nothing happens when it is not there.
---
---[tweaked.cc](https://tweaked.cc/module/fs.html#v:delete)
---@param path string
function fs.delete(path) end

---Open a file. Modes: `r` read, `w` write (the file is emptied), `a` append; add `b` for bytes. Returns nil and a
---message when it cannot be opened.
---
---**Not in CC:Tweaked 1.101.3**: the `r+` and `w+` modes (1.109.0). Since 1.109.0 text mode reads raw bytes and no
---longer decodes UTF-8.
---
---[tweaked.cc](https://tweaked.cc/module/fs.html#v:open)
---@param path string
---@param mode string
---@return (cc.fs.ReadHandle|cc.fs.BinaryReadHandle|cc.fs.WriteHandle|cc.fs.ReadWriteHandle)? handle
---@return string? message Why the file could not be opened.
---@overload fun(path: string, mode: "r"): cc.fs.ReadHandle?, string?
---@overload fun(path: string, mode: "rb"): cc.fs.BinaryReadHandle?, string?
---@overload fun(path: string, mode: "w"|"a"|"wb"|"ab"): cc.fs.WriteHandle?, string?
---@overload fun(path: string, mode: "r+"|"w+"|"r+b"|"w+b"): cc.fs.ReadWriteHandle?, string?
function fs.open(path, mode) end

---The drive a path is on: `"hdd"` for the computer's own files, `"rom"`, or the side of a disk drive. Nil when the
---path does not exist.
---
---[tweaked.cc](https://tweaked.cc/module/fs.html#v:getDrive)
---@param path string
---@return string? drive
function fs.getDrive(path) end

---Bytes free on the drive a path is on, or `"unlimited"`.
---
---[tweaked.cc](https://tweaked.cc/module/fs.html#v:getFreeSpace)
---@param path string
---@return integer|"unlimited" free
function fs.getFreeSpace(path) end

---The size of the drive a path is on in bytes. Nil for read-only drives.
---
---[tweaked.cc](https://tweaked.cc/module/fs.html#v:getCapacity)
---@param path string
---@return integer? capacity
function fs.getCapacity(path) end

---Size, kind and times of a file or folder. Throws when the path does not exist.
---
---[tweaked.cc](https://tweaked.cc/module/fs.html#v:attributes)
---@param path string
---@return cc.fs.Attributes
function fs.attributes(path) end
