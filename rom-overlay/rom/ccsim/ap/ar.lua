-- ccsim ap/ar: arController (AR goggles canvas). The real peripheral queues render actions
-- for goggles worn by a player; here every action is recorded so tests can inspect the
-- canvas (state.ar[<peripheral name>]). Signatures follow ARControllerPeripheral.
return function(core, B)
  local F = {}

  function F.arController(def)
    local self = B.new(def)
    local m = self.methods
    local canvas = {}
    local relative, width, height = false, nil, nil
    self.canvas = canvas

    local function add(action, id)
      action.id = id
      canvas[#canvas + 1] = action
      core.arCanvases = core.arCanvases or {}
      core.arCanvases[def.name] = canvas
    end

    local function ints(first, count, ...)
      local args = { ... }
      local out = {}
      for i = 1, count do out[i] = B.int(first + i - 1, args[i]) end
      return table.unpack(out, 1, count)
    end

    function m.isRelativeMode()
      if width then return relative, width, height end
      return relative
    end

    function m.setRelativeMode(enabled, virtualWidth, virtualHeight)
      enabled = B.boolean(1, enabled)
      if enabled then
        if virtualWidth == nil or virtualHeight == nil then
          error("You need to pass virtual screen width and height to enable relative mode.", 0)
        end
        relative, width, height = true, B.int(2, virtualWidth), B.int(3, virtualHeight)
      else
        relative, width, height = false, nil, nil
      end
    end

    local function stringDraw(kind)
      m[kind] = function(text, x, y, color)
        text = B.string(1, text)
        x, y, color = ints(2, 3, x, y, color)
        add({ type = kind, text = text, x = x, y = y, color = color })
      end
      m[kind .. "WithId"] = function(id, text, x, y, color)
        id = B.string(1, id)
        text = B.string(2, text)
        x, y, color = ints(3, 3, x, y, color)
        add({ type = kind, text = text, x = x, y = y, color = color }, id)
      end
    end
    stringDraw("drawString")
    stringDraw("drawCenteredString")
    stringDraw("drawRightboundString")

    local function shape(kind, names)
      local n = #names
      m[kind] = function(...)
        local values = { ints(1, n, ...) }
        local action = { type = kind }
        for i, name in ipairs(names) do action[name] = values[i] end
        add(action)
      end
      m[kind .. "WithId"] = function(id, ...)
        id = B.string(1, id)
        local values = { ints(2, n, ...) }
        local action = { type = kind }
        for i, name in ipairs(names) do action[name] = values[i] end
        add(action, id)
      end
    end
    shape("horizontalLine", { "minX", "maxX", "y", "color" })
    shape("verticalLine", { "x", "minY", "maxY", "color" })
    shape("fill", { "minX", "minY", "maxX", "maxY", "color" })
    shape("fillGradient", { "minX", "minY", "maxX", "maxY", "colorFrom", "colorTo" })
    shape("drawCircle", { "x", "y", "radius", "color" })
    shape("fillCircle", { "x", "y", "radius", "color" })

    function m.drawItemIcon(itemId, x, y)
      itemId = B.string(1, itemId)
      x, y = ints(2, 2, x, y)
      add({ type = "drawItemIcon", item = itemId, x = x, y = y })
    end

    function m.drawItemIconWithId(id, itemId, x, y)
      id = B.string(1, id)
      itemId = B.string(2, itemId)
      x, y = ints(3, 2, x, y)
      add({ type = "drawItemIcon", item = itemId, x = x, y = y }, id)
    end

    function m.clear()
      for i = #canvas, 1, -1 do canvas[i] = nil end
    end

    function m.clearElement(id)
      id = B.string(1, id)
      for i = #canvas, 1, -1 do
        if canvas[i].id == id then table.remove(canvas, i) end
      end
    end

    function m.getPlayerRotationY() return 0 end
    function m.getPlayerRotationZ() return 0 end

    function self.state() return { relative = relative, width = width, height = height, canvas = canvas } end
    return self
  end

  return F
end
