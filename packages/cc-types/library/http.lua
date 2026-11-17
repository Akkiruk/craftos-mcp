---@meta

-- Hand-written from CC:Tweaked's HttpResponseHandle.java, WebsocketHandle.java and core/apis/transfer (1.101.3 and
-- 1.121.0). The `http` functions themselves are in generated/http.lua.

---What a HTTP request returns: the body, read like a file, and the status and headers.
---
---[tweaked.cc](https://tweaked.cc/module/http.html#ty:Response)
---@class cc.http.Response: cc.fs.ReadHandle
local Response = {}

---Read from the body: characters as a string. A response opened in binary mode returns one byte as a number when
---`count` is left out.
---@param count? integer How many. Default 1.
---@return string|integer|nil
function Response.read(count) end

---The status code and its message: `200, "OK"`.
---@return integer code
---@return string message
function Response.getResponseCode() end

---The response headers. When a header was sent more than once the last one wins.
---@return table<string, string> headers
function Response.getResponseHeaders() end

---An open websocket (`http.websocket`).
---
---[tweaked.cc](https://tweaked.cc/module/http.html#ty:Websocket)
---@class cc.http.Websocket
local Websocket = {}

---Wait for the next message. Returns nil when the websocket closes or the timeout runs out.
---
---**Not in CC:Tweaked 1.101.3**: the reason after nil (added in 1.117.0).
---@param timeout? number Seconds to wait. Default forever.
---@return string? message The message, or nil.
---@return boolean|string|nil isBinary Whether the message was binary; after nil, why nothing was received (`"Timed out"` or the close reason).
function Websocket.receive(timeout) end

---Send a message.
---@param message string|number
---@param binary? boolean Send as a binary message. Default false.
function Websocket.send(message, binary) end

---Close the websocket. It cannot be used afterwards.
function Websocket.close() end

---The headers of the handshake response.
---
---**Not in CC:Tweaked 1.101.3**: added in 1.117.0.
---@return table<string, string> headers
function Websocket.getResponseHeaders() end

---The files of a `file_transfer` event.
---
---[tweaked.cc](https://tweaked.cc/event/file_transfer.html)
---@class cc.TransferredFiles
local TransferredFiles = {}

---Every file that was dropped on the computer.
---@return cc.TransferredFile[] files
function TransferredFiles.getFiles() end

---One file dropped on the computer: a binary read handle with a name.
---@class cc.TransferredFile: cc.fs.BinaryReadHandle
local TransferredFile = {}

---The file's name.
---@return string name
function TransferredFile.getName() end
