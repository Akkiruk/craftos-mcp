-- Peripheral types a mod names differently by Minecraft version: `byVersion` in a module's types.lua (addons/README.md),
-- the same data as AddonInfo.byVersion in packages/runner/src/addons.ts, which refuses such a world before boot.
--
--   byVersion = { ["1.21.1"] = { rename = { playerDetector = "player_detector" }, removed = { "redstoneIntegrator" },
--                                added = { "newBlock" }, note = { redstoneIntegrator = "replaced by ..." } } }
--
-- A type's canonical name is the one in `types` (its 1.18.2 name). A world may name a block by either name; the sim
-- builds it by the canonical one and the program sees the version's (peripheral.getType, hasType, find).
--
-- `infos`: the types.lua tables of the addons that are on (several modules of one addon are merged). Returns
--   resolve(type) -> canonical, reported   or nil, message when this version's mod has no such type
--   canonical(type) -> the canonical name of either name (itself when no mod renames it)
return function(mc, infos)
  local canonicalOf, reportedOf, absent = {}, {}, {}
  local byAddon, order = {}, {}
  for _, info in ipairs(infos) do
    if type(info.byVersion) == "table" then
      local id = info.addon or "?"
      if not byAddon[id] then byAddon[id] = {}; order[#order + 1] = id end
      for version, changes in pairs(info.byVersion) do
        local merged = byAddon[id][version] or { rename = {}, removed = {}, added = {}, note = {} }
        byAddon[id][version] = merged
        for k, v in pairs(changes.rename or {}) do merged.rename[k] = v end
        for _, t in ipairs(changes.removed or {}) do merged.removed[#merged.removed + 1] = t end
        for _, t in ipairs(changes.added or {}) do merged.added[#merged.added + 1] = t end
        for k, v in pairs(changes.note or {}) do merged.note[k] = v end
      end
    end
  end

  for _, id in ipairs(order) do
    local by = byAddon[id]
    local notes, addedOn = {}, {}
    for version, changes in pairs(by) do
      for canonical, renamed in pairs(changes.rename) do canonicalOf[renamed] = canonical end
      for t, note in pairs(changes.note) do notes[t] = note end
      for _, t in ipairs(changes.added) do
        addedOn[t] = addedOn[t] or {}
        addedOn[t][version] = true
      end
    end
    local function gone(t)
      absent[t] = ("%s has no peripheral type '%s' on Minecraft %s%s"):format(id, t, mc,
        notes[t] and (" (" .. notes[t] .. ")") or "")
    end
    local here = by[mc]
    if here then
      for canonical, renamed in pairs(here.rename) do reportedOf[canonical] = renamed end
      for _, t in ipairs(here.removed) do gone(t) end
    end
    for t, versions in pairs(addedOn) do
      if not versions[mc] then gone(t) end
    end
  end

  local M = {}
  function M.canonical(ty) return canonicalOf[ty] or ty end
  function M.resolve(ty)
    local canonical = canonicalOf[ty] or ty
    if absent[canonical] then return nil, absent[canonical] end
    return canonical, reportedOf[canonical] or canonical
  end
  -- for type-versions.integration.test.ts: what the Lua side read, to compare with addons.ts
  M.byAddon = byAddon
  return M
end
