-- ccsim lockdown: emulation of vhcctweaks' root-mount lockdown (LockdownManifest /
-- LockdownWritableMount). If the computer root contains vhcc_lockdown.txt, writes to
-- the root drive are refused with "Access denied" unless the path is allowed by the
-- manifest or the unlock file exists.
return function()
  local MANIFEST = "vhcc_lockdown.txt"
  if not fs.exists("/" .. MANIFEST) then return nil end

  local function normalize(path)
    local s = path:gsub("\\", "/"):match("^%s*(.-)%s*$")
    while s:sub(1, 2) == "./" do s = s:sub(3) end
    while s:sub(1, 1) == "/" do s = s:sub(2) end
    while s:find("//", 1, true) do s = s:gsub("//", "/") end
    while #s > 1 and s:sub(-1) == "/" do s = s:sub(1, -2) end
    return s
  end

  local unlockFile = ".vhcc_unlock"
  local exact, prefixes, suffixes = {}, {}, {}
  local h = fs.open("/" .. MANIFEST, "r")
  if not h then return nil end
  while true do
    local raw = h.readLine()
    if raw == nil then break end
    local line = raw:match("^%s*(.-)%s*$")
    if line ~= "" and line:sub(1, 1) ~= "#" then
      local eq = line:find("=", 1, true)
      if eq and eq > 1 then
        local key = line:sub(1, eq - 1):match("^%s*(.-)%s*$"):lower()
        local value = line:sub(eq + 1):match("^%s*(.-)%s*$")
        if value ~= "" then
          if key == "unlock-file" or key == "unlock_file" then
            unlockFile = normalize(value)
          elseif key == "allow-exact" or key == "allow_exact" then
            exact[#exact + 1] = normalize(value)
          elseif key == "allow-prefix" or key == "allow_prefix" then
            prefixes[#prefixes + 1] = normalize(value)
          elseif key == "allow-suffix" or key == "allow_suffix" then
            suffixes[#suffixes + 1] = value
          end
        end
      end
    end
  end
  h.close()

  local rawExists = fs.exists
  local rawGetDrive = fs.getDrive
  local rawOpen, rawDelete, rawMakeDir = fs.open, fs.delete, fs.makeDir
  local rawMove, rawCopy = fs.move, fs.copy

  local function allows(path)
    if path == "" then return false end
    if path == MANIFEST then return false end
    for _, e in ipairs(exact) do if e == path then return true end end
    for _, p in ipairs(prefixes) do
      if path == p or path:sub(1, #p + 1) == p .. "/" then return true end
    end
    for _, s in ipairs(suffixes) do
      if #path >= #s and path:sub(-#s) == s then return true end
    end
    return false
  end

  --- fs.getDrive returns nothing for paths that do not exist yet, so use the nearest
  --- existing ancestor to find which mount a new file would land on.
  local function driveOf(path)
    local probe = path
    while probe ~= "" and not rawExists(probe) do probe = fs.getDir(probe) end
    return rawGetDrive(probe == "" and "/" or probe)
  end

  --- Returns an error message when a write to `path` must be refused, else nil.
  local function denied(path)
    local abs = fs.combine("", path)
    if driveOf(abs) ~= "hdd" then return nil end -- only the root mount is locked
    local normalized = normalize(abs)
    if allows(normalized) or rawExists(unlockFile) then return nil end
    return "/" .. normalized .. ": Access denied"
  end

  function fs.open(path, mode)
    if type(path) == "string" and type(mode) == "string" and mode:match("^[wa]") then
      local message = denied(path)
      if message then return nil, message end
    end
    return rawOpen(path, mode)
  end

  -- CC only asks the mount to delete/create when the node exists/does not exist, so a
  -- missing delete target or an existing directory is never refused.
  function fs.delete(path)
    local message = type(path) == "string" and rawExists(path) and denied(path)
    if message then error(message, 2) end
    return rawDelete(path)
  end

  function fs.makeDir(path)
    local message = type(path) == "string" and not rawExists(path) and denied(path)
    if message then error(message, 2) end
    return rawMakeDir(path)
  end

  function fs.move(from, to)
    local message = (type(to) == "string" and denied(to)) or (type(from) == "string" and denied(from))
    if message then error(message, 2) end
    return rawMove(from, to)
  end

  function fs.copy(from, to)
    local message = type(to) == "string" and denied(to)
    if message then error(message, 2) end
    return rawCopy(from, to)
  end

  return { unlockFile = unlockFile }
end
