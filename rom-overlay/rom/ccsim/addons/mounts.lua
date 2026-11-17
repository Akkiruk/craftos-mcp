-- A mod's block that mounts a save folder on the computer (IComputerAccess.mountWritable): Cricket's hard drive,
-- Embedded Computer's hard drive. The folder is results/addons/<dir> of the run, mounted writable with the engine's
-- own mounter (taken at ccsim's start, core.mounter), so the files are real and outlive a reboot. CC's view of the
-- mount is kept too: fs.getDrive is the peripheral's name (mountWritable's driveName), fs.getCapacity the mount's
-- capacity and fs.getFreeSpace what is left of it.
return function(core)
  local rawFs = fs -- the simulation's own fs (rom/ccsim/env.lua)
  local computerFs = _G.fs
  local mounter = core.mounter
  local M = {}
  local mounted = {} -- location -> { drive = name, dir = sim path, capacity }

  local hostResults
  local function hostRoot()
    if hostResults ~= nil then return hostResults end
    hostResults = false
    if mounter and mounter.list then
      local r = mounter.list()["results"]
      if type(r) == "table" and type(r[1]) == "string" then hostResults = r[1] end
    end
    return hostResults
  end

  local function canonical(path)
    local ok, p = pcall(computerFs.combine, "", path)
    return ok and p or nil
  end

  local function used(dir)
    local total = 0
    for _, name in ipairs(rawFs.list(dir)) do
      local p = dir .. "/" .. name
      if rawFs.isDir(p) then total = total + used(p) else total = total + rawFs.getSize(p) end
    end
    return total
  end

  local wrapped = false
  local function wrapFs()
    if wrapped then return end
    wrapped = true
    local raw = { getDrive = computerFs.getDrive, getCapacity = computerFs.getCapacity,
      getFreeSpace = computerFs.getFreeSpace }
    local function mountOf(path)
      local p = canonical(path)
      if not p then return nil end
      local best, bestLen
      for loc, m in pairs(mounted) do
        if (p == loc or p:sub(1, #loc + 1) == loc .. "/") and (not bestLen or #loc > bestLen) then
          best, bestLen = m, #loc
        end
      end
      return best
    end
    computerFs.getDrive = function(path)
      local m = mountOf(path)
      if m and computerFs.exists(path) then return m.drive end
      return raw.getDrive(path)
    end
    computerFs.getCapacity = function(path)
      local m = mountOf(path)
      if m then return m.capacity end
      return raw.getCapacity(path)
    end
    computerFs.getFreeSpace = function(path)
      local m = mountOf(path)
      if m then return math.max(0, m.capacity - used(m.dir)) end
      return raw.getFreeSpace(path)
    end
  end

  --- The sim folder for `dir` (under results/addons/), made if missing; `files` (path -> content) fill a new one
  function M.folder(dir, files)
    local path = "results/addons/" .. dir
    if not rawFs.exists(path) then
      rawFs.makeDir(path)
      if type(files) == "table" then
        for name, content in pairs(files) do
          local h = rawFs.open(rawFs.combine(path, name), "wb")
          if h then h.write(tostring(content)); h.close() end
        end
      end
    end
    return path
  end

  --- ComputerAccess.mountWritable: nil when `location` already exists on the computer (findFreeLocation)
  function M.mount(location, dir, driveName, capacity)
    local p = canonical(location)
    local root = hostRoot()
    if not root then error("ccsim: mounting a drive needs the engine's mounter, which this run does not have", 0) end
    local simDir = "results/addons/" .. dir
    local hostDir = root .. "/addons/" .. dir
    -- the engine keeps a mount over a reboot; the attach after it mounts again, as the block does in game
    for name, paths in pairs(mounter.list()) do
      if not mounted[name] and type(paths) == "table" and paths[1] and paths[1]:gsub("\\", "/") == hostDir:gsub("\\", "/") then
        mounter.unmount(name)
      end
    end
    if not p or p == "" or rawFs.exists(p) then return nil end
    if not mounter.mount(p, hostDir, false) then error("ccsim: the engine would not mount " .. hostDir, 0) end
    mounted[p] = { drive = driveName, dir = simDir, capacity = capacity }
    wrapFs()
    return p
  end

  --- ComputerAccess.unmount: false when nothing was mounted there by us
  function M.unmount(location)
    local p = canonical(location)
    if not p or not mounted[p] then return false end
    mounter.unmount(p)
    mounted[p] = nil
    return true
  end

  return M
end
