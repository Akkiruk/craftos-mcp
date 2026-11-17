-- Do the `words` of config.json pick out CC programs and leave other Lua alone? This matches them the way
-- lua-language-server does (script/library.lua: each word between ([%w_]?) captures that must both be empty, on the
-- first place the word is found in the file). Any Lua runs it:
--
--   lua packages/cc-types/scripts/addon-words.test.lua packages/cc-types/config.json
--
-- Not part of check.mjs, which does not need a Lua interpreter.
local path = arg and arg[1] or "packages/cc-types/config.json"
local handle = assert(io.open(path, "r"))
local text = handle:read("*a")
handle:close()

-- the "words" array, without a JSON library: each entry is one double-quoted string
local words = {}
local block = assert(text:match('"words"%s*:%s*(%b[])'), "no words in " .. path)
for raw in block:gmatch('"(.-[^\\])"') do
  words[#words + 1] = (raw:gsub('\\"', '"'):gsub("\\\\", "\\"))
end

local function matches(line)
  for _, word in ipairs(words) do
    local pattern = "([%w_]?)" .. word .. "([%w_]?)"
    local captures = { line:match(pattern) }
    if captures[1] == "" and captures[#captures] == "" then return word end
  end
  return nil
end

local yes = {
  'local event, key = os.pullEvent("key")',
  "local e = { os.pullEventRaw() }",
  'local mon = peripheral.find("monitor")',
  'local modem = peripheral.wrap("back")',
  "term.setCursorPos(1, 1)",
  "term.setTextColour(colours.red)",
  "term.setBackgroundColor(colors.black)",
  "print(textutils.serialise(t))",
  'rednet.open("back")',
  "while turtle.forward() do end",
  "paintutils.drawLine(1, 1, 5, 5, colors.red)",
  'local pretty = require("cc.pretty")',
  'local expect = require "cc.expect"',
}
local no = {
  "local x = love.graphics.newImage(path)",
  'local json = require("cjson")',
  "local colors = {}",
  "myterm.setCursorPos(1, 1)",
  "return os.time()",
  'local lfs = require("lfs")',
  "ngx.say(table.concat(t))",
  "function M.rednetwork() end",
}

local failed = 0
for _, line in ipairs(yes) do
  if not matches(line) then
    failed = failed + 1
    print("should match and does not: " .. line)
  end
end
for _, line in ipairs(no) do
  local word = matches(line)
  if word then
    failed = failed + 1
    print("should not match " .. word .. ": " .. line)
  end
end
print(#words .. " words, " .. (#yes + #no) .. " lines, " .. failed .. " wrong")
os.exit(failed == 0 and 0 or 1)
