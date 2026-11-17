-- ccsim plethora canvas: the overlay glasses' 2D and 3D canvases (Plethora-Fabric 1.20.1-1.13.0).
--
-- Written from gameplay/modules/glasses/ (GlassesMethods, canvas/Canvas2dMethods, canvas/Canvas3dMethods,
-- canvas/CanvasServer, objects/*, objects/object2d/*, objects/object3d/*) and api/method/ArgumentExt.kt. Every
-- canvas method is registered with worldThread = false, so they all run at once on the computer thread.
-- Nothing is drawn: the objects and their properties are kept, and sim state shows them (docs/plethora.md).
return function(P)
  local J, A = P.J, P.A
  local f32, i32 = J.f32, J.i32
  local floor = math.floor

  local WIDTH, HEIGHT = 512, math.floor(512 / 16) * 9 -- CanvasHandler.WIDTH / HEIGHT
  local MAX_LENGTH = 512 -- Text2d.MAX_LENGTH
  local MAX_SIZE = 255 -- MultiPointResizable2d.MAX_SIZE
  local DEFAULT_COLOUR = -1 -- 0xFFFFFFFF as an int
  local ID_2D, ID_3D = 0, 1

  local M = {}

  -- ===== ArgumentExt =====

  local function vec2d(a, start)
    -- getVec2dNullable: null when there is nothing at `start` (count() == start and args[0] == null)
    if a.n < start or (a.n == start and a[1] == nil) then A.bad(start, "number", a[start + 1]) end
    return { A.double(a, start), A.double(a, start + 1) }
  end
  local function vec3dNullable(a, start)
    if a.n < start or (a.n == start and a[1] == nil) then return nil end
    return { A.double(a, start), A.double(a, start + 1), A.double(a, start + 2) }
  end
  local function vec3d(a, start)
    local v = vec3dNullable(a, start)
    if not v then A.bad(start, "number", a[start + 1]) end
    return v
  end

  --- Map.getFiniteDouble(key): a missing key and a wrong type have their own messages.
  local function finiteKey(t, key, label)
    local v = t[key]
    if v == nil then J.lua("Expected number for key " .. label .. ", got nil") end
    if type(v) ~= "number" or v ~= v or v == math.huge or v == -math.huge then
      J.lua("Expected number for key " .. label .. ", got " .. A.luaType(v))
    end
    return v
  end
  local function vec2dTable(a, i)
    local t = A.table(a, i)
    if t.x ~= nil then return { finiteKey(t, "x", "x"), finiteKey(t, "y", "y") } end
    -- CC hands a Lua table to Java as a Map with Double keys: the key prints as "1.0"
    return { finiteKey(t, 1, "1.0"), finiteKey(t, 2, "2.0") }
  end
  local function vec3dTable(a, i)
    local t = A.table(a, i)
    if t.x ~= nil then return { finiteKey(t, "x", "x"), finiteKey(t, "y", "y"), finiteKey(t, "z", "z") } end
    return { finiteKey(t, 1, "1.0"), finiteKey(t, 2, "2.0"), finiteKey(t, 3, "3.0") }
  end

  local function intBetween(a, i, lo, hi, message)
    local v = A.int(a, i)
    if v < lo or v > hi then J.lua(message:format("between " .. lo .. " and " .. hi)) end
    return v
  end

  local function stringLength(a, i, lo, hi)
    local s = A.string(a, i)
    if #s < lo or #s > hi then J.lua(("string length out of bounds (%s)"):format("between " .. lo .. " and " .. hi)) end
    return s
  end

  --- ArgumentExt.getItem: an identifier, then the item registry.
  local function item(a, i)
    local id = P.identifier(A.string(a, i))
    if not P.data().isItem(id) then J.lua("Unknown item '" .. id .. "'") end
    return id
  end

  -- ===== the method table, by Plethora class =====
  -- name -> { doc, fn(obj, args, canvas) }. Each kind of object lists the classes it is, like Java's hierarchy.

  local C = {}
  C.ObjectGroup = {
    clear = { "function() -- Remove all objects.", function(o, _, cv)
      local children = cv.children[o.id]
      if not children then J.java("java.lang.IllegalStateException", "Object has no children") end
      cv.clearChildren(o.id)
    end },
  }
  C.BaseObject = {
    remove = { "function() -- Remove this object from the canvas.", function(o, _, cv)
      if not cv.removeObject(o.id) then J.java("java.lang.IllegalStateException", "No such object with this key") end
    end },
  }
  C.Positionable2d = {
    getPosition = { "function():number, number -- Get the position for this object.", function(o)
      return o.position[1], o.position[2]
    end },
    setPosition = { "function(number, number) -- Set the position for this object.", function(o, a)
      o.position = vec2d(a, 0)
    end },
  }
  C.Colourable = {
    getColour = { "function():number -- Get the colour for this object.", function(o) return o.colour % 4294967296 end },
    setColour = { "function(colour|r:int, [g:int, b:int], [alpha:int]):number -- Set the colour for this object.", function(o, a)
      local band, bor, lshift = bit32.band, bit32.bor, bit32.lshift
      if a.n == 1 then
        o.colour = A.int(a, 0)
      elseif a.n == 3 then
        local r, g, b = band(A.int(a, 0), 0xFF), band(A.int(a, 1), 0xFF), band(A.int(a, 2), 0xFF)
        o.colour = i32(bor(lshift(r, 24), lshift(g, 16), lshift(b, 8), band(o.colour % 4294967296, 0xFF)))
      else
        local r, g, b = band(A.int(a, 0), 0xFF), band(A.int(a, 1), 0xFF), band(A.int(a, 2), 0xFF)
        local al = band(A.int(a, 3), 0xFF)
        o.colour = i32(bor(lshift(r, 24), lshift(g, 16), lshift(b, 8), al))
      end
    end },
    getAlpha = { "function():number -- Get the alpha for this object.", function(o) return o.colour % 256 end },
    setAlpha = { "function(alpha:number):number -- Set the alpha for this object.", function(o, a)
      local alpha = bit32.band(A.int(a, 0) % 4294967296, 0xFF)
      o.colour = i32(o.colour - o.colour % 256 + alpha)
    end },
  }
  -- BasicMethod.alias keeps the docs of the method it copies
  C.Colourable.getColor = C.Colourable.getColour
  C.Colourable.setColor = C.Colourable.setColour
  C.Rectangle2d = {
    getSize = { "function():number, number -- Get the size of this rectangle.", function(o) return o.size[1], o.size[2] end },
    setSize = { "function(number, number) -- Set the size of this rectangle.", function(o, a) o.size = vec2d(a, 0) end },
  }
  C.MultiPoint2d = {
    getPoint = { "function(idx:int):number, number -- Get the specified vertex of this object.", function(o, a)
      local idx = intBetween(a, 0, 1, #o.points, "Index out of range (%s)")
      local p = o.points[idx]
      return p[1], p[2]
    end },
    setPoint = { "function(idx:int, x:number, y:number) -- Set the specified vertex of this object.", function(o, a)
      local idx = intBetween(a, 0, 1, #o.points, "Index out of range (%s)")
      o.points[idx] = vec2d(a, 1)
    end },
  }
  C.MultiPointResizable2d = {
    getPointCount = { "function():number -- Get the number of vertices on this object.", function(o) return #o.points end },
    removePoint = { "function(idx:int) -- Remove the specified vertex of this object.", function(o, a)
      local idx = intBetween(a, 0, 1, #o.points, "Index out of range (%s)")
      table.remove(o.points, idx)
    end },
    insertPoint = { "function([idx:int, ]x:number, y:number) -- Add a specified vertex to this object.", function(o, a)
      if #o.points > MAX_SIZE then J.lua("Too many vertices") end
      local idx, pos
      if a.n >= 3 then
        idx = intBetween(a, 0, 1, #o.points, "Index out of range (%s)")
        pos = vec2d(a, 1)
      else
        -- the source reads the point from argument 3 here, so insertPoint(x, y) always fails
        idx = #o.points
        pos = vec2d(a, 2)
      end
      table.insert(o.points, idx, pos) -- addPoint(idx - 1, pos): before the idx'th vertex
    end },
  }
  C.Scalable = {
    getScale = { "function():number -- Get the scale for this object.", function(o) return o.scale end },
    setScale = { "function(number) -- Set the scale for this object.", function(o, a)
      local s = f32(A.double(a, 0))
      if s <= 0 then J.lua("Scale must be > 0") end
      o.scale = s
    end },
  }
  C.TextObject = {
    getText = { "function():string -- Get the text for this object.", function(o) return o.text end },
    setText = { "function(string) -- Set the text for this object.", function(o, a) o.text = stringLength(a, 0, 0, MAX_LENGTH) end },
    setShadow = { "function(boolean) -- Set the shadow for this object.", function(o, a) o.dropShadow = A.bool(a, 0) end },
    hasShadow = { "function():boolean -- Get the shadow for this object.", function(o) return o.dropShadow end },
    getLineHeight = { "function():number -- Get the line height for this object.", function(o) return o.lineHeight end },
    setLineHeight = { "function(number) -- Set the line height for this object.", function(o, a)
      local v = A.int(a, 0) % 65536
      if v >= 32768 then v = v - 65536 end -- toShort()
      o.lineHeight = v
    end },
  }
  C.ItemObject = {
    getItem = { "function():string -- Get the item for this object.", function(o) return o.item end },
    setItem = { "function(string) -- Set the item for this object.", function(o, a) o.item = item(a, 0) end },
  }
  C.Frame2d = {
    getSize = { "function():number, number -- Get the size of this canvas.", function() return WIDTH, HEIGHT end },
  }
  C.Positionable3d = {
    getPosition = { "function():number, number, number -- Get the position for this object.", function(o)
      return o.position[1], o.position[2], o.position[3]
    end },
    setPosition = { "function(number, number, number) -- Set the position for this object.", function(o, a)
      o.position = vec3d(a, 0)
    end },
  }
  C.Rotatable3d = {
    getRotation = { "function():nil|number, number, number -- Get the rotation for this object, or nil if it faces the player.", function(o)
      if o.rotation == nil then return end -- FutureMethodResult.empty(): no values at all
      return o.rotation[1], o.rotation[2], o.rotation[3]
    end },
    setRotation = { "function([x:number, y:number, z:number]) -- Set the rotation for this object, passing nothing if it should face the player.", function(o, a)
      o.rotation = vec3dNullable(a, 0)
    end },
  }
  C.DepthTestable = {
    isDepthTested = { "function():boolean -- Determine whether depth testing is enabled for this object.", function(o) return o.depthTest end },
    setDepthTested = { "function(boolean) -- Set whether depth testing is enabled for this object.", function(o, a) o.depthTest = A.bool(a, 0) end },
  }
  C.Box3d = {
    getSize = { "function():number, number, number -- Get the size of this box.", function(o) return o.size[1], o.size[2], o.size[3] end },
    setSize = { "function(number, number, number) -- Set the size of this box.", function(o, a) o.size = vec3d(a, 0) end },
  }
  C.ObjectRoot3d = {
    recenter = { "function([offsetX: number, offsetY: number, offsetZ: number]) -- Recenter this canvas relative to the current position.", function(o, a, cv)
      local off = vec3dNullable(a, 0) or { 0, 0, 0 }
      local x, y, z = cv.origin()
      o.origin = { x + off[1], y + off[2], z + off[3] }
      o.world = cv.dimension()
    end },
  }

  -- Group2d: the add methods. Each makes the object, then returns it as a Lua object.
  local new -- forward: new(cv, kind, parent)
  C.Group2d = {
    addRectangle = { "function(x:number, y:number, width:number, height:number[, colour:number]):table -- Create a new rectangle.", function(g, a, cv)
      local pos, size = vec2d(a, 0), vec2d(a, 2)
      local colour = A.optInt(a, 4, DEFAULT_COLOUR)
      local o = new(cv, "rectangle", g.id)
      o.position, o.size, o.colour = pos, size, colour
      return cv.add(o)
    end },
    addLine = { "function(start:table, end:table[, color:number][, thickness:number]):table -- Create a new line.", function(g, a, cv)
      local s, e = vec2dTable(a, 0), vec2dTable(a, 1)
      local colour = A.optInt(a, 2, DEFAULT_COLOUR)
      local thickness = f32(A.optDouble(a, 3, 1.0))
      local o = new(cv, "line", g.id)
      o.points[1], o.points[2], o.colour, o.scale = s, e, colour, thickness
      return cv.add(o)
    end },
    addDot = { "function(position:table[, color:number][, size:number]):table -- Create a new dot.", function(g, a, cv)
      local pos = vec2dTable(a, 0)
      local colour = A.optInt(a, 1, DEFAULT_COLOUR)
      local size = f32(A.optDouble(a, 2, 1.0))
      local o = new(cv, "dot", g.id)
      o.position, o.colour, o.scale = pos, colour, size
      return cv.add(o)
    end },
    addText = { "function(position:table, contents:string[, colour:number[, size:number]]):table -- Create a new text object.", function(g, a, cv)
      local pos = vec2dTable(a, 0)
      local contents = stringLength(a, 1, 0, MAX_LENGTH)
      local colour = A.optInt(a, 2, DEFAULT_COLOUR)
      local size = f32(A.optDouble(a, 3, 1.0))
      local o = new(cv, "text", g.id)
      o.position, o.text, o.colour, o.scale = pos, contents, colour, size
      return cv.add(o)
    end },
    addTriangle = { "function(p1:table, p2:table, p3:table[, colour:number]):table -- Create a new triangle, composed of three points.", function(g, a, cv)
      local p1, p2, p3 = vec2dTable(a, 0), vec2dTable(a, 1), vec2dTable(a, 2)
      local colour = A.optInt(a, 3, DEFAULT_COLOUR)
      local o = new(cv, "triangle", g.id)
      o.points[1], o.points[2], o.points[3], o.colour = p1, p2, p3, colour
      return cv.add(o)
    end },
    addPolygon = { "function(points...:table[, color:number]):table -- Create a new polygon, composed of many points.", function(g, a, cv)
      local o = new(cv, "polygon", g.id) -- takes an object id even when the arguments are wrong (the source's TODO)
      local i = M.pointsFromArgs(o, a, 1)
      o.colour = A.optInt(a, i, DEFAULT_COLOUR)
      return cv.add(o)
    end },
    addLines = { "function(points...:table[, color:number[, thickness:number]]):table -- Create a new line loop, composed of many points.", function(g, a, cv)
      local o = new(cv, "lines", g.id)
      local i = M.pointsFromArgs(o, a, 2)
      o.colour = A.optInt(a, i, DEFAULT_COLOUR)
      o.scale = f32(A.optDouble(a, i + 1, 1.0))
      return cv.add(o)
    end },
    addItem = { "function(position:table, contents:string[, scale:number]):table -- Create an item icon.", function(g, a, cv)
      local pos = vec2dTable(a, 0)
      local id = item(a, 1)
      local scale = f32(A.optDouble(a, 2, 1.0))
      local o = new(cv, "item2d", g.id)
      o.position, o.scale, o.item = pos, scale, id
      return cv.add(o)
    end },
    addGroup = { "function(position:table):table -- Create a new object group.", function(g, a, cv)
      local pos = vec2dTable(a, 0)
      local o = new(cv, "group2d", g.id)
      o.position = pos
      return cv.add(o)
    end },
  }
  C.Origin3d = {
    create = { "function([offsetX: number, offsetY: number, offsetZ: number]) -- Create a new 3D canvas centred relative to the current position.", function(g, a, cv)
      local off = a.n > 0 and vec3dTable(a, 0) or { 0, 0, 0 }
      local o = new(cv, "origin3d", g.id)
      local x, y, z = cv.origin()
      o.origin = { x + off[1], y + off[2], z + off[3] }
      o.world = cv.dimension()
      return cv.add(o)
    end },
  }
  C.Group3d = {
    addFrame = { "function(function(position:table):table -- Create a new frame to put 2D objects in.", function(g, a, cv)
      local pos = vec3dTable(a, 0)
      local o = new(cv, "frame3d", g.id)
      o.position = pos
      return cv.add(o)
    end },
    addBox = { "function(function(x:number, y:number, z:number[, width:number, height:number, depth:number][, color:number]):table -- Create a new box.", function(g, a, cv)
      local pos = vec3d(a, 0)
      local colour = A.optInt(a, a.n <= 4 and 3 or 6, DEFAULT_COLOUR)
      local size = a.n <= 4 and { 1, 1, 1 } or vec3d(a, 3)
      local o = new(cv, "box3d", g.id)
      o.position, o.size, o.colour = pos, size, colour
      return cv.add(o)
    end },
    addItem = { "function(position:table, contents:string[, scale:number]):table -- Create an item model.", function(g, a, cv)
      local pos = vec3dTable(a, 0)
      local id = item(a, 1)
      local scale = f32(A.optDouble(a, 2, 1.0))
      local o = new(cv, "item3d", g.id)
      o.position, o.scale, o.item = pos, scale, id
      return cv.add(o)
    end },
  }

  --- MultiPointResizable2d.addPointsFromArgs: tables until the trailing optional numbers.
  function M.pointsFromArgs(o, a, optional)
    local i = 0
    while i < a.n do
      local arg = a[i + 1]
      if i >= a.n - optional and type(arg) == "number" then break end
      o.points[#o.points + 1] = vec2dTable(a, i)
      i = i + 1
    end
    return i
  end

  -- Each kind: its Plethora class, the classes whose methods it has (Java's hierarchy) and its fields.
  local KINDS = {
    frame2d = { class = "Frame2d", is = { "ObjectGroup", "Group2d", "Frame2d" } },
    origin = { class = "Origin3d", is = { "ObjectGroup", "Origin3d" } },
    rectangle = { class = "Rectangle2d", is = { "BaseObject", "Colourable", "Positionable2d", "Rectangle2d" } },
    line = { class = "Line2d", is = { "BaseObject", "Colourable", "Scalable", "MultiPoint2d" } },
    dot = { class = "Dot2d", is = { "BaseObject", "Colourable", "Positionable2d", "Scalable" } },
    text = { class = "Text2d", is = { "BaseObject", "Colourable", "Positionable2d", "Scalable", "TextObject" } },
    triangle = { class = "Triangle2d", is = { "BaseObject", "Colourable", "MultiPoint2d" } },
    polygon = { class = "Polygon2d", is = { "BaseObject", "Colourable", "MultiPoint2d", "MultiPointResizable2d" } },
    lines = { class = "LineLoop2d", is = { "BaseObject", "Colourable", "MultiPoint2d", "MultiPointResizable2d", "Scalable" } },
    item2d = { class = "Item2d", is = { "BaseObject", "Scalable", "ItemObject", "Positionable2d" } },
    group2d = { class = "ObjectGroup2d", is = { "BaseObject", "ObjectGroup", "Group2d", "Positionable2d" } },
    origin3d = { class = "ObjectRoot3d", is = { "BaseObject", "ObjectGroup", "Group3d", "ObjectRoot3d" } },
    frame3d = { class = "ObjectFrame3d", is = { "BaseObject", "ObjectGroup", "Group2d", "Frame2d", "Positionable3d", "Rotatable3d", "DepthTestable" } },
    box3d = { class = "Box3d", is = { "BaseObject", "Colourable", "Positionable3d", "DepthTestable", "Box3d" } },
    item3d = { class = "Item3d", is = { "BaseObject", "Scalable", "Positionable3d", "DepthTestable", "ItemObject", "Rotatable3d" } },
  }
  local GROUPS = { frame2d = true, origin = true, group2d = true, origin3d = true, frame3d = true }

  function new(cv, kind, parent)
    local o = { id = cv.newId(), parent = parent, kind = kind }
    local is = {}
    for _, c in ipairs(KINDS[kind].is) do is[c] = true end
    if is.Colourable then o.colour = DEFAULT_COLOUR end
    if is.Scalable then o.scale = 1 end
    if is.Positionable2d then o.position = { 0, 0 } end
    if is.Positionable3d then o.position = { 0, 0, 0 } end
    if is.DepthTestable then o.depthTest = true end
    if is.ItemObject then o.item = "minecraft:stone" end
    if kind == "rectangle" then o.size = { 0, 0 } end
    if kind == "box3d" then o.size = { 0, 0, 0 } end
    if kind == "line" or kind == "triangle" or kind == "polygon" or kind == "lines" then o.points = {} end
    if kind == "line" then o.points = { { 0, 0 }, { 0, 0 } } end
    if kind == "triangle" then o.points = { { 0, 0 }, { 0, 0 }, { 0, 0 } } end
    if kind == "text" then o.text, o.dropShadow, o.lineHeight = "", false, 9 end
    if kind == "item3d" then o.rotation = { 0, 0, 0 } end
    return o
  end

  --- The methods an object of this kind has, in a stable order, with getDocs last.
  local function methodsOf(kind)
    local out, seen = {}, {}
    for _, c in ipairs(KINDS[kind].is) do
      local names = {}
      for name in pairs(C[c]) do names[#names + 1] = name end
      table.sort(names)
      for _, name in ipairs(names) do
        if not seen[name] then
          seen[name] = true
          out[#out + 1] = { name = name, doc = C[c][name][1], fn = C[c][name][2] }
        end
      end
    end
    return out
  end

  --- A canvas server: one per neural interface built with the glasses module, worn by a player.
  --- `host`: { stale() -> message or nil, origin() -> x, y, z (the wearer's eyes), dimension() }
  function M.server(host)
    local cv = { objects = {}, children = { [ID_2D] = {}, [ID_3D] = {} } }
    local lastId = ID_3D
    function cv.newId() lastId = lastId + 1 return lastId end
    cv.origin, cv.dimension = host.origin, host.dimension

    local function wrap(o, ref)
      local list = methodsOf(o.kind)
      local docs = {}
      for _, m in ipairs(list) do docs[m.name] = m.doc end
      docs.getDocs = P.GET_DOCS_DOC
      local obj = {}
      for _, m in ipairs(list) do
        obj[m.name] = P.immediate(function(args)
          -- safeBake: the module container first, then the object's own reference
          local stale = host.stale()
          if stale then J.lua(stale) end
          local target = ref()
          return m.fn(target, args, cv)
        end, host.ex)
      end
      obj.getDocs = P.docsMethod(docs, host.ex)
      return obj
    end

    function cv.add(o)
      local parent = cv.children[o.parent]
      if not parent then J.java("java.lang.IllegalArgumentException", "No such parent") end
      cv.objects[o.id] = o
      parent[#parent + 1] = o.id
      if GROUPS[o.kind] then cv.children[o.id] = {} end
      local id = o.id
      return wrap(o, function()
        local live = cv.objects[id]
        if not live then J.lua("This object has been removed") end
        return live
      end)
    end

    local function removeImpl(id)
      if not cv.objects[id] then return false end
      cv.objects[id] = nil
      local kids = cv.children[id]
      cv.children[id] = nil
      if kids then for _, child in ipairs(kids) do removeImpl(child) end end
      return true
    end
    function cv.removeObject(id)
      local o = cv.objects[id]
      if not removeImpl(id) then return false end
      local siblings = cv.children[o.parent]
      if siblings then
        for i, child in ipairs(siblings) do if child == id then table.remove(siblings, i) break end end
      end
      return true
    end
    function cv.clearChildren(id)
      local kids = cv.children[id]
      cv.children[id] = {}
      for _, child in ipairs(kids) do removeImpl(child) end
    end

    local frame = { id = ID_2D, kind = "frame2d" }
    local origin = { id = ID_3D, kind = "origin" }
    function cv.canvas2d() return wrap(frame, function() return frame end) end
    function cv.canvas3d() return wrap(origin, function() return origin end) end

    --- Every object, by id, for sim state.
    function cv.state()
      local out = {}
      local ids = {}
      for id in pairs(cv.objects) do ids[#ids + 1] = id end
      table.sort(ids)
      for _, id in ipairs(ids) do
        local o = cv.objects[id]
        local s = { id = o.id, parent = o.parent, type = KINDS[o.kind].class }
        for k, v in pairs(o) do
          if k ~= "kind" and k ~= "id" and k ~= "parent" then s[k] = v end
        end
        if s.colour then s.colour = s.colour % 4294967296 end
        out[#out + 1] = s
      end
      return out
    end
    return cv
  end

  return M
end
