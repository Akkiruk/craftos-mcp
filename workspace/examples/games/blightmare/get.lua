-- get.lua: installs BLIGHTMARE on this computer from the craftos-mcp GitHub release.
-- Part of the craftos-mcp examples (MIT). https://github.com/Akkiruk/craftos-mcp
--
--   pastebin run <code>        (or: wget run <raw url of this file>)
--
-- Downloads the packed game (about 540 kB) next to this program's folder, leaves saves/ alone, and asks before
-- replacing startup.lua. Needs the http API on (it is by default).

local TAG = "blightmare-v1"
local BASE = "https://github.com/Akkiruk/craftos-mcp/releases/download/" .. TAG .. "/"
-- release asset name, where it goes, its size in bytes
local FILES = {
  { "blightmare.lua", "blightmare.lua", 1622 },
  { "pack.lua", "pack.lua", 9929 },
  { "font", "lib/font", 3056 },
  { "blightmare.pak", "blightmare.pak", 522492 },
}
local STARTUP = { "startup.lua", "startup.lua", 1073 }

local dir = shell and shell.dir() or ""
local function path(p) return fs.combine(dir, p) end

local function say(colour, text)
  if term.isColour() then term.setTextColour(colour) end
  print(text)
  term.setTextColour(colours.white)
end

if not http then
  say(colours.red, "The http API is off on this server, so nothing can be downloaded.")
  say(colours.lightGrey, "Copy the files by hand instead: see the README on GitHub.")
  return
end

local need = 0
for _, f in ipairs(FILES) do
  local old = path(f[2])
  need = need + f[3] - (fs.exists(old) and fs.getSize(old) or 0)
end
if need > fs.getFreeSpace(path("")) then
  say(colours.red, ("Not enough room: BLIGHTMARE needs %d more bytes than this disk has free."):format(need - fs.getFreeSpace(path(""))))
  return
end

local function fetch(name, size)
  local h, err = http.get(BASE .. name, nil, true)
  if not h then return nil, err end
  local data = h.readAll()
  h.close()
  if not data or #data ~= size then
    return nil, ("got %d bytes, expected %d"):format(data and #data or 0, size)
  end
  return data
end

say(colours.red, "BLIGHTMARE")
print("Downloading from GitHub (" .. TAG .. ")...")

-- Everything is downloaded before anything is written, so a failed download leaves an old copy as it was.
local got = {}
for _, f in ipairs(FILES) do
  write("  " .. f[2] .. " ")
  local data, err = fetch(f[1], f[3])
  if not data then
    print()
    say(colours.red, "Download failed: " .. tostring(err))
    say(colours.lightGrey, "Nothing was changed. Try again in a moment.")
    return
  end
  got[#got + 1] = { f[2], data }
  say(colours.lime, "ok")
end

for _, g in ipairs(got) do
  fs.makeDir(fs.getDir(path(g[1])))
  local h = fs.open(path(g[1]), "wb")
  h.write(g[2])
  h.close()
end

local start = path("startup.lua")
local wantStartup = true
if fs.exists(start) then
  local h = fs.open(start, "r")
  local first = h.readLine() or ""
  h.close()
  if first ~= "-- startup.lua" then
    write("Replace startup.lua so BLIGHTMARE starts when the computer boots? (y/n) ")
    wantStartup = (read() or ""):lower():sub(1, 1) == "y"
  end
end
if wantStartup then
  local data = fetch(STARTUP[1], STARTUP[3])
  if data then
    local h = fs.open(start, "wb")
    h.write(data)
    h.close()
  else
    say(colours.orange, "Couldn't fetch startup.lua; run blightmare by hand.")
  end
end

print()
say(colours.lime, "Installed. Saves in saves/ were left alone.")
print("Needs a 6x6 wall of advanced monitors touching this computer. A speaker and an Advanced Peripherals player detector are optional.")
say(colours.yellow, "Run: blightmare" .. (wantStartup and "   (or reboot)" or ""))
