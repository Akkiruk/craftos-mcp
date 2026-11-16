-- Tom's Peripherals GPU3D (createWindow3D): a software rasteriser. A port of, api branch commit 5dbf6fc,
-- src/shared/java/com/tom/peripherals/: gpu/GPU3D, gpu/Triangle, gpu/TriBuilder, gpu/TextureManager,
-- gpu/GLConstants, math/Matrix4d, math/Vec2d, math/Vec3d, math/Vec4d.
-- Kept as Java has it, because the pixels depend on it: vectors are shared objects (Triangle's swaps move values
-- inside them, and clipped triangles share vertex arrays), float arithmetic is rounded where Java uses float
-- (J.f), the near plane clips with the original positions, and triangles sort stably by mean depth.
return function(J, G)
  local P = J.P
  local f = J.f
  local d2i = J.d2i
  local function lerr(msg) error(msg, 0) end

  -- ===== vectors and the matrix =====
  local function v3(x, y, z) return { x = x or 0, y = y or 0, z = z or 0 } end
  local function v4(x, y, z, w) return { x = x or 0, y = y or 0, z = z or 0, w = w or 0 } end
  local function need(v, name)
    if v == nil then J.npe('Cannot read field "x" because "' .. name .. '" is null') end
    return v
  end
  local function normalize(v)
    local l = math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z)
    v.x, v.y, v.z = v.x / l, v.y / l, v.z / l
    return v
  end
  local function dot(a, b)
    need(b, "other")
    return a.x * b.x + a.y * b.y + a.z * b.z
  end
  local ZERO3 = v3()

  local function identity(m)
    m.m00, m.m10, m.m20, m.m30 = 1, 0, 0, 0
    m.m01, m.m11, m.m21, m.m31 = 0, 1, 0, 0
    m.m02, m.m12, m.m22, m.m32 = 0, 0, 1, 0
    m.m03, m.m13, m.m23, m.m33 = 0, 0, 0, 1
    return m
  end
  local KEYS = { "m00", "m01", "m02", "m03", "m10", "m11", "m12", "m13", "m20", "m21", "m22", "m23", "m30", "m31", "m32", "m33" }
  local function newMatrix(from)
    local m = {}
    for _, k in ipairs(KEYS) do m[k] = from and from[k] or 0 end
    return m
  end
  --- Matrix4d.mul(Vec3d): with the perspective divide
  local function mul3(m, i)
    local o = v3()
    o.x = i.x * m.m00 + i.y * m.m10 + i.z * m.m20 + m.m30
    o.y = i.x * m.m01 + i.y * m.m11 + i.z * m.m21 + m.m31
    o.z = i.x * m.m02 + i.y * m.m12 + i.z * m.m22 + m.m32
    local w = i.x * m.m03 + i.y * m.m13 + i.z * m.m23 + m.m33
    if w ~= 0 then o.x, o.y, o.z = o.x / w, o.y / w, o.z / w end
    return o
  end
  local function mul4(m, i, o)
    o.x = i.x * m.m00 + i.y * m.m10 + i.z * m.m20 + m.m30
    o.y = i.x * m.m01 + i.y * m.m11 + i.z * m.m21 + m.m31
    o.z = i.x * m.m02 + i.y * m.m12 + i.z * m.m22 + m.m32
    o.w = i.x * m.m03 + i.y * m.m13 + i.z * m.m23 + m.m33
  end
  local function translate(c, x, y, z)
    c.m30 = c.m00 * x + c.m10 * y + c.m20 * z + c.m30
    c.m31 = c.m01 * x + c.m11 * y + c.m21 * z + c.m31
    c.m32 = c.m02 * x + c.m12 * y + c.m22 * z + c.m32
    c.m33 = c.m03 * x + c.m13 * y + c.m23 * z + c.m33
  end
  local function scale(m, x, y, z)
    m.m00, m.m01, m.m02, m.m03 = m.m00 * x, m.m01 * x, m.m02 * x, m.m03 * x
    m.m10, m.m11, m.m12, m.m13 = m.m10 * y, m.m11 * y, m.m12 * y, m.m13 * y
    m.m20, m.m21, m.m22, m.m23 = m.m20 * z, m.m21 * z, m.m22 * z, m.m23 * z
  end
  local function rotate(m, ang, x, y, z)
    local s, c = math.sin(ang), math.cos(ang)
    local C = 1.0 - c
    local xx, xy, xz = x * x, x * y, x * z
    local yy, yz = y * y, y * z
    local zz = z * z
    local rm00, rm01, rm02 = xx * C + c, xy * C + z * s, xz * C - y * s
    local rm10, rm11, rm12 = xy * C - z * s, yy * C + c, yz * C + x * s
    local rm20, rm21, rm22 = xz * C + y * s, yz * C - x * s, zz * C + c
    local nm00 = m.m00 * rm00 + m.m10 * rm01 + m.m20 * rm02
    local nm01 = m.m01 * rm00 + m.m11 * rm01 + m.m21 * rm02
    local nm02 = m.m02 * rm00 + m.m12 * rm01 + m.m22 * rm02
    local nm03 = m.m03 * rm00 + m.m13 * rm01 + m.m23 * rm02
    local nm10 = m.m00 * rm10 + m.m10 * rm11 + m.m20 * rm12
    local nm11 = m.m01 * rm10 + m.m11 * rm11 + m.m21 * rm12
    local nm12 = m.m02 * rm10 + m.m12 * rm11 + m.m22 * rm12
    local nm13 = m.m03 * rm10 + m.m13 * rm11 + m.m23 * rm12
    m.m20 = m.m00 * rm20 + m.m10 * rm21 + m.m20 * rm22
    m.m21 = m.m01 * rm20 + m.m11 * rm21 + m.m21 * rm22
    m.m22 = m.m02 * rm20 + m.m12 * rm21 + m.m22 * rm22
    m.m23 = m.m03 * rm20 + m.m13 * rm21 + m.m23 * rm22
    m.m00, m.m01, m.m02, m.m03 = nm00, nm01, nm02, nm03
    m.m10, m.m11, m.m12, m.m13 = nm10, nm11, nm12, nm13
  end
  local DEG = 0.017453292519943295 -- Math.toRadians: angdeg * DEGREES_TO_RADIANS

  -- ===== Triangle =====
  -- vert[i] = { [1] = position, [2] = texture (u, v, 1/w), [3] = colour }, as Java's Vec4d[3][3]
  local POS, TEX, COL = 1, 2, 3

  local function newTriangle() return { vert = { {}, {}, {} }, tex = nil } end
  local function copyTriangle(t)
    local n = { vert = {}, tex = t.tex }
    for i = 1, 3 do n.vert[i] = { t.vert[i][1], t.vert[i][2], t.vert[i][3] } end
    return n
  end
  local function builtTriangle(vecs, color, uv, texID)
    local t = newTriangle()
    for i = 1, 3 do
      local v = need(vecs[i], "v")
      t.vert[i][POS] = v4(v.x, v.y, v.z, 1)
      t.vert[i][COL] = color[i]
      local u = need(uv[i], "uv[i]")
      t.vert[i][TEX] = v4(u.x, u.y, 0, 0)
    end
    t.tex = texID
    return t
  end

  local function intersect(plane_p, plane_n, startIn, endIn, t)
    local s = v3(startIn.x, startIn.y, startIn.z)
    local e = v3(endIn.x, endIn.y, endIn.z)
    plane_n = normalize(v3(plane_n.x, plane_n.y, plane_n.z))
    local plane_d = -dot(plane_n, plane_p)
    local ad = dot(s, plane_n)
    local bd = dot(e, plane_n)
    t[1] = (-plane_d - ad) / (bd - ad)
    local tt = t[1]
    return v4(s.x + (e.x - s.x) * tt, s.y + (e.y - s.y) * tt, s.z + (e.z - s.z) * tt, 0)
  end

  --- calcValue: a new vertex array whose texture and colour lie at t between an inside and an outside vertex
  local function calcValue(inside, outside, t)
    local out = {}
    for j = 2, 3 do
      local a, b = inside[j], outside[j]
      out[j] = v4(t * (b.x - a.x) + a.x, t * (b.y - a.y) + a.y, t * (b.z - a.z) + a.z, t * (b.w - a.w) + a.w)
    end
    return out
  end

  local function clipAgainst(tri, plane_p, plane_n)
    normalize(plane_n)
    local pd = dot(plane_n, need(plane_p, "other"))
    local function dist(p) return plane_n.x * p.x + plane_n.y * p.y + plane_n.z * p.z - pd end
    local inside, outside = {}, {}
    for i = 1, 3 do
      if dist(tri.vert[i][POS]) >= 0 then inside[#inside + 1] = tri.vert[i] else outside[#outside + 1] = tri.vert[i] end
    end
    if #inside == 0 then return {} end
    if #inside == 3 then return { tri } end
    local t = { 0 }
    if #inside == 1 then
      local o = newTriangle()
      o.tex = tri.tex
      o.vert[1] = inside[1]
      o.vert[2] = calcValue(inside[1], outside[1], t[1])
      o.vert[2][POS] = intersect(plane_p, plane_n, inside[1][POS], outside[1][POS], t)
      o.vert[3] = calcValue(inside[1], outside[2], t[1])
      o.vert[3][POS] = intersect(plane_p, plane_n, inside[1][POS], outside[2][POS], t)
      return { o }
    end
    local o1, o2 = newTriangle(), newTriangle()
    o1.tex, o2.tex = tri.tex, tri.tex
    o1.vert[1] = inside[1]
    o1.vert[2] = inside[2]
    o1.vert[3] = calcValue(inside[1], outside[1], t[1])
    o1.vert[3][POS] = intersect(plane_p, plane_n, inside[1][POS], outside[1][POS], t)
    o2.vert[1] = inside[2]
    o2.vert[2] = o1.vert[3]
    o2.vert[3] = calcValue(inside[2], outside[1], t[1])
    o2.vert[3][POS] = intersect(plane_p, plane_n, inside[2][POS], outside[1][POS], t)
    return { o1, o2 }
  end

  local function normalOf(tri)
    local a, b, c = tri.vert[1][POS], tri.vert[2][POS], tri.vert[3][POS]
    local l1 = v3(b.x - a.x, b.y - a.y, b.z - a.z)
    local l2 = v3(c.x - a.x, c.y - a.y, c.z - a.z)
    local n = v3(l1.y * l2.z - l1.z * l2.y, l1.z * l2.x - l1.x * l2.z, l1.x * l2.y - l1.y * l2.x)
    return normalize(n)
  end

  local function swap4(a, b)
    a.x, b.x = b.x, a.x
    a.y, b.y = b.y, a.y
    a.z, b.z = b.z, a.z
    a.w, b.w = b.w, a.w
  end

  -- ===== TextureManager =====

  local function colorMul(c1, v)
    local c = (c1 % 256) / 255
    local r = c * v
    if r < 0 then r = 0 elseif r > 1 then r = 1 end
    return d2i(r * 255)
  end

  local function newTextures(vram)
    local tm = { map = {}, last = 1, bound = nil, enabled = false }
    function tm.gen(a)
      local c = P.optionalInt(a, 0, 1)
      local id = tm.last
      for i = 0, c - 1 do
        local tx = { id = i + id }
        function tx.vsize() return tx.pixels and tx.pixels.w * tx.pixels.h * 4 or 1 end
        vram.allocEx(tx, 1)
        tm.map[i + id] = tx
      end
      tm.last = J.i32(tm.last + c)
      return id
    end
    function tm.delete(a)
      if a.n == 0 then lerr("Too few arguments: number texture ids...") end
      for _, t in ipairs(P.ints(a, 0)) do
        local tx = tm.map[t]
        tm.map[t] = nil
        if tx then vram.free(tx) end
      end
    end
    function tm.bind(a)
      if a.n == 0 then lerr("Too few arguments: number id") end
      tm.bound = tm.map[P.getInt(a, 0)]
    end
    function tm.image(a)
      if a.n < 1 then lerr("Too few arguments: image ref or number width, numbers texture...") end
      if tm.bound == nil then lerr("No bound texture") end
      if a.n == 1 and type(a[1]) == "string" then
        local li = G.imageOf(vram, a[1])
        vram.reallocEx(tm.bound, li.vsize())
        tm.bound.pixels = li.getImage().copy()
      else
        local w = P.getInt(a, 0)
        local d = P.uints(a, 1)
        local h = J.idiv(#d, w)
        vram.reallocEx(tm.bound, w * h * 4)
        tm.bound.pixels = G.newImage(w, h, d, #d)
      end
    end
    function tm.id() return (not tm.enabled or tm.bound == nil) and 0 or tm.bound.id end
    function tm.sample(u, v, tri, r, g, b, al)
      local tx = tri.tex ~= nil and tm.map[tri.tex] or nil
      if tx == nil or not tm.enabled then
        local ri, gi, bi, ai = d2i(r * 255) % 256, d2i(g * 255) % 256, d2i(b * 255) % 256, d2i(al * 255) % 256
        return J.i32(((ai * 256 + ri) * 256 + gi) * 256 + bi)
      end
      if tx.pixels == nil then J.npe('Cannot invoke "com.tom.peripherals.util.Image.getWidth()" because "tx.pixels" is null') end
      local w, h = tx.pixels.w, tx.pixels.h
      local iu, iv = d2i(u * w), d2i(v * h)
      if iu < 0 then iu = d2i(iu + math.ceil((-iu) / w) * w) end
      if iv < 0 then iv = d2i(iv + math.ceil((-iv) / h) * h) end
      iu = J.irem(iu, w)
      iv = J.irem(iv, h)
      local c = tx.pixels.get(iu, iv)
      local cu = c % 4294967296
      local ri = colorMul(math.floor(cu / 65536), r)
      local gi = colorMul(math.floor(cu / 256), g)
      local bi = colorMul(cu, b)
      local ai = colorMul(math.floor(cu / 16777216), al)
      return J.i32(((ai * 16777216) + ri * 65536 + gi * 256 + bi) % 4294967296)
    end
    return tm
  end

  -- ===== rasteriser (Triangle.textureTriangle) =====

  local function textureTriangle(tri, gpu)
    local ctx, depth = gpu.ctx, gpu.depth
    local W = ctx.width()
    local function vi(v) return { x = d2i(v.x), y = d2i(v.y) } end
    local p1, p2, p3 = vi(tri.vert[1][POS]), vi(tri.vert[2][POS]), vi(tri.vert[3][POS])
    local uv1, uv2, uv3 = tri.vert[1][TEX], tri.vert[2][TEX], tri.vert[3][TEX]
    local c1, c2, c3 = tri.vert[1][COL], tri.vert[2][COL], tri.vert[3][COL]
    local function swapP(a, b) a.x, b.x = b.x, a.x; a.y, b.y = b.y, a.y end
    if p2.y < p1.y then swapP(p1, p2); swap4(uv1, uv2); swap4(c1, c2) end
    if p3.y < p1.y then swapP(p1, p3); swap4(uv1, uv3); swap4(c1, c3) end
    if p3.y < p2.y then swapP(p3, p2); swap4(uv3, uv2); swap4(c3, c2) end

    local abs = math.abs
    local dy1, dx1 = p2.y - p1.y, p2.x - p1.x
    local du1, dv1, dw1 = uv2.x - uv1.x, uv2.y - uv1.y, uv2.z - uv1.z
    local dr1, dg1, db1, da1 = c2.x - c1.x, c2.y - c1.y, c2.z - c1.z, c2.w - c1.w
    local dy2, dx2 = p3.y - p1.y, p3.x - p1.x
    local du2, dv2, dw2 = uv3.x - uv1.x, uv3.y - uv1.y, uv3.z - uv1.z
    local dr2, dg2, db2, da2 = c3.x - c1.x, c3.y - c1.y, c3.z - c1.z, c3.w - c1.w

    local dax, dbx, du1s, dv1s, du2s, dv2s, dw1s, dw2s = 0, 0, 0, 0, 0, 0, 0, 0
    local dr1s, dg1s, db1s, da1s, dr2s, dg2s, db2s, da2s = 0, 0, 0, 0, 0, 0, 0, 0
    if dy1 ~= 0 then
      dax = dx1 / abs(dy1)
      du1s, dv1s, dw1s = du1 / abs(dy1), dv1 / abs(dy1), dw1 / abs(dy1)
      dr1s, dg1s, db1s, da1s = dr1 / abs(dy1), dg1 / abs(dy1), db1 / abs(dy1), da1 / abs(dy1)
    end
    if dy2 ~= 0 then
      dbx = dx2 / abs(dy2)
      du2s, dv2s, dw2s = du2 / abs(dy2), dv2 / abs(dy2), dw2 / abs(dy2)
      dr2s, dg2s, db2s, da2s = dr2 / abs(dy2), dg2 / abs(dy2), db2 / abs(dy2), da2 / abs(dy2)
    end

    local function plot(i, j, tu, tv, tw, cr, cg, cb, ca)
      local k = i * W + j
      if k < 0 or k >= gpu.depthLen then J.aioobe(k, gpu.depthLen) end
      if tw > (depth[k] or 0) then
        ctx.set(j, i, gpu.tm.sample(tu / tw, tv / tw, tri, cr, cg, cb, ca))
        depth[k] = f(tw)
      end
    end

    if dy1 ~= 0 then
      for i = p1.y, p2.y do
        local ax = d2i(p1.x + (i - p1.y) * dax)
        local bx = d2i(p1.x + (i - p1.y) * dbx)
        local ts = v3(uv1.x + (i - p1.y) * du1s, uv1.y + (i - p1.y) * dv1s, uv1.z + (i - p1.y) * dw1s)
        local te = v3(uv1.x + (i - p1.y) * du2s, uv1.y + (i - p1.y) * dv2s, uv1.z + (i - p1.y) * dw2s)
        local cs = v4(c1.x + (i - p1.y) * dr1s, c1.y + (i - p1.y) * dg1s, c1.z + (i - p1.y) * db1s, c1.w + (i - p1.y) * da1s)
        local ce = v4(c1.x + (i - p1.y) * dr2s, c1.y + (i - p1.y) * dg2s, c1.z + (i - p1.y) * db2s, c1.w + (i - p1.y) * da2s)
        if ax > bx then ax, bx = bx, ax; ts, te = te, ts; cs, ce = ce, cs end
        local tstep = f(1 / (bx - ax)) -- double tstep = 1.0f / (bx - ax): a float division
        local t = 0
        for j = ax, bx - 1 do
          local s = 1 - t
          plot(i, j, s * ts.x + t * te.x, s * ts.y + t * te.y, s * ts.z + t * te.z,
            s * cs.x + t * ce.x, s * cs.y + t * ce.y, s * cs.z + t * ce.z, s * cs.w + t * ce.w)
          t = t + tstep
        end
      end
    end

    dy1, dx1 = p3.y - p2.y, p3.x - p2.x
    du1, dv1, dw1 = uv3.x - uv2.x, uv3.y - uv2.y, uv3.z - uv2.z
    dr1, dg1, db1, da1 = c3.x - c2.x, c3.y - c2.y, c3.z - c2.z, c3.w - c2.w
    if dy1 ~= 0 then dax = dx1 / abs(dy1) end
    if dy2 ~= 0 then dbx = dx2 / abs(dy2) end
    du1s, dv1s, dw1s, dr1s, dg1s, db1s, da1s = 0, 0, 0, 0, 0, 0, 0
    if dy1 ~= 0 then
      du1s, dv1s, dw1s = du1 / abs(dy1), dv1 / abs(dy1), dw1 / abs(dy1)
      dr1s, dg1s, db1s, da1s = dr1 / abs(dy1), dg1 / abs(dy1), db1 / abs(dy1), da1 / abs(dy1)
    end

    if dy1 ~= 0 then
      for i = p2.y, p3.y do
        local ax = d2i(p2.x + (i - p2.y) * dax)
        local bx = d2i(p1.x + (i - p1.y) * dbx)
        local ts = v3(uv2.x + (i - p2.y) * du1s, uv2.y + (i - p2.y) * dv1s, uv2.z + (i - p2.y) * dw1s)
        local te = v3(uv1.x + (i - p1.y) * du2s, uv1.y + (i - p1.y) * dv2s, uv1.z + (i - p1.y) * dw2s)
        local cs = v4(c2.x + (i - p2.y) * dr1s, c2.y + (i - p2.y) * dg1s, c2.z + (i - p2.y) * db1s, c2.w + (i - p2.y) * da1s)
        local ce = v4(c1.x + (i - p1.y) * dr2s, c1.y + (i - p1.y) * dg2s, c1.z + (i - p1.y) * db2s, c1.w + (i - p1.y) * da2s)
        if ax > bx then ax, bx = bx, ax; ts, te = te, ts; cs, ce = ce, cs end
        local tstep = f(1 / (bx - ax)) -- float tstep, float t: the second half is all float
        local t = 0
        for j = ax, bx - 1 do
          local s = f(1 - t)
          plot(i, j, s * ts.x + t * te.x, s * ts.y + t * te.y, s * ts.z + t * te.z,
            s * cs.x + t * ce.x, s * cs.y + t * ce.y, s * cs.z + t * ce.z, s * cs.w + t * ce.w)
          t = f(t + tstep)
        end
      end
    end
  end

  local function clipAndBlit(tri, gpu)
    local w, h = gpu.ctx.width() - 1, gpu.ctx.height() - 1
    local queue, head, tail = { tri }, 1, 1 -- ArrayDeque: pop at the head, addAll at the tail
    local nNew = 1
    for p = 0, 3 do
      while nNew > 0 do
        local test = queue[head]
        queue[head] = nil
        head = head + 1
        nNew = nNew - 1
        local out
        if p == 0 then out = clipAgainst(test, ZERO3, v3(0, 1, 0))
        elseif p == 1 then out = clipAgainst(test, v3(0, h, 0), v3(0, -1, 0))
        elseif p == 2 then out = clipAgainst(test, ZERO3, v3(1, 0, 0))
        else out = clipAgainst(test, v3(w, 0, 0), v3(-1, 0, 0)) end
        for _, o in ipairs(out) do tail = tail + 1; queue[tail] = o end
      end
      nNew = tail - head + 1
    end
    for k = head, tail do textureTriangle(queue[k], gpu) end
  end

  --- -Double.compare(z1, z2), for a stable merge sort (List.sort is TimSort, stable)
  local function compareDouble(a, b)
    if a < b then return -1 end
    if a > b then return 1 end
    local an, bn = a ~= a, b ~= b
    if an or bn then
      if an and bn then return 0 end
      return an and 1 or -1
    end
    if a == 0 and b == 0 then
      local na, nb = 1 / a < 0, 1 / b < 0
      if na == nb then return 0 end
      return na and -1 or 1
    end
    return 0
  end
  local function meanZ(t)
    return (t.vert[1][POS].z + t.vert[2][POS].z + t.vert[3][POS].z) / 3
  end
  local function stableSort(list)
    local n = #list
    if n < 2 then return list end
    local keys = {}
    for i = 1, n do keys[list[i]] = meanZ(list[i]) end
    local function before(a, b) return -compareDouble(keys[a], keys[b]) < 0 end
    local src, dst = list, {}
    local width = 1
    while width < n do
      local i = 1
      while i <= n do
        local mid, hi = math.min(i + width, n + 1), math.min(i + 2 * width, n + 1)
        local a, b, k = i, mid, i
        while a < mid and b < hi do
          if before(src[b], src[a]) then dst[k] = src[b]; b = b + 1 else dst[k] = src[a]; a = a + 1 end
          k = k + 1
        end
        while a < mid do dst[k] = src[a]; a = a + 1; k = k + 1 end
        while b < hi do dst[k] = src[b]; b = b + 1; k = k + 1 end
        i = i + 2 * width
      end
      src, dst = dst, src
      width = width * 2
    end
    return src
  end

  -- ===== GPU3D =====

  local M = {}

  function M.glFrustum(g, a)
    if a.n < 3 then lerr("Too few arguments, expected: number fov, number Znear, number Zfar") end
    local fov, zNear, zFar = P.getDouble(a, 0), P.getDouble(a, 1), P.getDouble(a, 2)
    local rtanFov = 1 / math.tan((fov / 2) * DEG)
    local proj = newMatrix()
    proj.m00 = (g.ctx.height() / g.ctx.width()) * rtanFov
    proj.m11 = rtanFov
    proj.m22 = zFar / (zFar - zNear)
    proj.m23 = 1
    proj.m32 = (-zFar * zNear) / (zFar - zNear)
    g.proj = proj
    g.nearPlane = v3(0, 0, zNear)
  end

  function M.glDirLight(g, a)
    if a.n < 3 then lerr("Too few arguments, expected: number x, number y, number z") end
    g.light.x = P.getDouble(a, 0)
    g.light.y = P.getDouble(a, 1)
    g.light.z = P.getDouble(a, 2)
    g.light = normalize(mul3(g.mat, g.light))
  end

  function M.render(g)
    local W, H = g.ctx.width(), g.ctx.height()
    if g.depth == nil or g.depthLen ~= W * H then
      g.ctx.vram.reallocEx(g, W * H * 4 + 1024)
      g.depth, g.depthLen = {}, W * H
    end
    local tris = {}
    for _, tri in ipairs(g.triangles) do
      local normal = normalOf(tri)
      local p0 = tri.vert[1][POS]
      local normalDot = normal.x * (p0.x - g.camera.x) + normal.y * (p0.y - g.camera.y) + normal.z * (p0.z - g.camera.z)
      if not (normalDot > 0) then
        local light = dot(normal, g.light)
        local dup = copyTriangle(tri)
        for _, ctri in ipairs(clipAgainst(dup, g.nearPlane, v3(0, 0, 1))) do
          local nt = copyTriangle(ctri)
          for i = 1, 3 do
            local pos = tri.vert[i][POS]
            local out = v4()
            mul4(g.proj, pos, out)
            local uv = ctri.vert[i][TEX]
            local nuv = v4()
            local w = out.w
            if w ~= 0 then
              nuv.x, nuv.y, nuv.z = uv.x / w, uv.y / w, 1 / w
              out.x, out.y, out.z = out.x / w, out.y / w, out.z / w
            end
            out.x = (out.x + 1) * (0.5 * W)
            out.y = (out.y + 1) * (0.5 * H)
            nt.vert[i][POS] = out
            local c0 = ctri.vert[i][COL]
            local c = v4(c0.x * light, c0.y * light, c0.z * light, c0.w * light)
            if c.x > 1 then c.x = 1 end
            if c.y > 1 then c.y = 1 end
            if c.z > 1 then c.z = 1 end
            if c.w > 1 then c.w = 1 end
            if c.x < 0 then c.x = 0 end
            if c.y < 0 then c.y = 0 end
            if c.z < 0 then c.z = 0 end
            if c.w < 0 then c.w = 0 end
            nt.vert[i][COL] = c
            nt.vert[i][TEX] = nuv
          end
          tris[#tris + 1] = nt
        end
      end
    end
    tris = stableSort(tris)
    for _, t in ipairs(tris) do clipAndBlit(t, g) end
  end

  function M.sync(g) g.ctx.sync() end

  function M.clear(g)
    local ctx = g.ctx
    local i = 0
    while i < ctx.width() do
      local j = 0
      while j < ctx.height() do ctx.set(i, j, 0); j = j + 1 end
      i = i + 1
    end
    g.triangles = {}
    identity(g.mat)
    if g.depth then g.depth = {} end
  end

  function M.glBegin(g, a)
    if g.building then lerr("Already building") end
    local id = P.optionalInt(a, 0, 4)
    if id ~= 4 then lerr("Unknown build mode: " .. id) end
    g.building = { p = -1, v = {}, c = {}, t = {} }
  end

  local function buildTri(g, b)
    g.triangles[#g.triangles + 1] = builtTriangle(b.v, b.c, b.t, g.tm.id())
    b.v, b.c, b.t, b.p = {}, {}, {}, -1
  end

  function M.glEnd(g)
    local b = g.building
    if not b then lerr("not building") end
    if b.p ~= -1 and b.p ~= 2 then lerr("Incomplete triangle") end
    buildTri(g, b)
    g.building = nil
  end

  function M.glVertex(g, a)
    if a.n < 3 then lerr("Too few arguments, expected: number x, number y, number z") end
    local x, y, z = P.getDouble(a, 0), P.getDouble(a, 1), P.getDouble(a, 2)
    local b = g.building
    if not b then lerr("not building") end
    if b.p >= 2 then buildTri(g, b) end
    b.p = b.p + 1
    b.v[b.p + 1] = mul3(g.mat, v3(x, y, z))
    b.c[b.p + 1] = v4(g.color.x, g.color.y, g.color.z, g.color.w)
    b.t[b.p + 1] = { x = 0, y = 0 }
  end

  function M.glTexCoord(g, a)
    if a.n < 2 then lerr("Too few arguments, expected: number u, number v") end
    local u, v = P.getDouble(a, 0), P.getDouble(a, 1)
    local b = g.building
    if not b then lerr("not building") end
    if b.p ~= -1 then b.t[b.p + 1] = { x = u, y = v } end
  end

  function M.glColor(g, a)
    local c = P.toColor(a, 0) % 4294967296
    local function ch(shift) return math.floor(c / shift) % 256 end
    g.color = v4(f(ch(65536) / 255), f(ch(256) / 255), f(ch(1) / 255), f(ch(16777216) / 255))
    local b = g.building
    if b and b.p ~= -1 then b.c[b.p + 1] = v4(g.color.x, g.color.y, g.color.z, g.color.w) end
  end

  function M.glLoadIdentity(g) identity(g.mat) end
  function M.glPushMatrix(g) g.stack[#g.stack + 1] = newMatrix(g.mat) end
  function M.glPopMatrix(g)
    if #g.stack == 0 then J.throw("java.util.EmptyStackException") end
    g.mat = g.stack[#g.stack]
    g.stack[#g.stack] = nil
  end

  local function xyz(a)
    if a.n < 3 then lerr("Too few arguments, expected: number x, number y, number z") end
    return P.getDouble(a, 0), P.getDouble(a, 1), P.getDouble(a, 2)
  end
  function M.glTranslate(g, a) translate(g.mat, xyz(a)) end
  function M.glScale(g, a) scale(g.mat, xyz(a)) end
  function M.glRotate(g, a)
    if a.n < 4 then lerr("Too few arguments, expected: number angle, number x, number y, number z") end
    local d, x, y, z = P.getDouble(a, 0), P.getDouble(a, 1), P.getDouble(a, 2), P.getDouble(a, 3)
    rotate(g.mat, d * DEG, x, y, z)
  end

  function M.glGenTextures(g, a) return g.tm.gen(a) end
  function M.glDeleteTextures(g, a) g.tm.delete(a) end
  function M.glBindTexture(g, a) g.tm.bind(a) end
  function M.glTexImage(g, a) g.tm.image(a) end
  function M.getBounds(g) return g.ctx.bounds() end

  local function glState(g, a, on)
    local mode = P.getInt(a, 0)
    if mode == 0xDE1 then g.tm.enabled = on else lerr("Bad argument #1: unknown GL state" .. mode) end
  end
  function M.glEnable(g, a) glState(g, a, true) end
  function M.glDisable(g, a) glState(g, a, false) end
  --- GLConstants.ALL_CONST is empty: @Const has no runtime retention, so isAnnotationPresent never sees it
  function M.getConstants() end

  G.ORDER.GPU3D = { "glScale", "glGenTextures", "getBounds", "glPushMatrix", "glFrustum", "glVertex", "glRotate",
    "glTexImage", "getConstants", "glTranslate", "glDirLight", "glDisable", "render", "glTexCoord", "clear",
    "glBindTexture", "glEnd", "sync", "glDeleteTextures", "glColor", "glLoadIdentity", "listMethods", "glBegin",
    "glEnable", "glPopMatrix" }
  local Class = G.class("GPU3D", M)

  local GPU3D = {}
  function GPU3D.new(ctx)
    local g = { __class = Class, ctx = ctx, mat = identity(newMatrix()), proj = newMatrix(), stack = {},
      triangles = {}, camera = v3(), light = v3(), color = v4(1, 1, 1, 1), tm = newTextures(ctx.vram) }
    function g.vsize() return (g.depth and g.depthLen * 4 or 0) + 1024 end
    ctx.vram.alloc(g)
    return g
  end
  return GPU3D
end
