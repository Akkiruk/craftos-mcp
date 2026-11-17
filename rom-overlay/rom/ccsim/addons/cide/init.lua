-- ccsim addon cide: CIDE 1.1.0 (NeoForge, Minecraft 1.21.1), by kivts99, an in-game code editor.
--
-- The editor is the client's GUI, and its server side (file upload, console, debug sessions) answers that GUI only.
-- What a computer sees of the mod: the jar's rom/cide/agent.lua and rom/cide/run.lua (a line debugger the editor
-- starts programs under), in rom/ here unchanged, and an ILuaAPI on every computer, cide_dbg
-- (dev/kivts/cide/server/CideDebugAPI, read from the jar decompiled with Vineflower 1.10.1). It talks to
-- CideDebugService, which only has a session while a player debugs this computer from the editor: never here.
return function(core, host)
  local C = dofile("/rom/ccsim/addons/create/common.lua")
  local api = {}
  function api.paused(file, line, locals)
    C.str(1, file)
    C.int(2, line)
    C.table(3, locals)
    -- notifyPaused: no session, nothing is sent
  end
  --- getBreakpointsAsLuaTable: Map.of() with no session
  function api.getBreakpoints() return {} end
  function api.isActive() return false end
  function api.finished() end
  _G.cide_dbg = api
  return {}
end
