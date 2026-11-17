-- The part of java.util.regex that a key pattern uses, for Regex(pattern).matches(key) (the whole key must match):
-- literals, `.`, classes (`[a-z]`, `[^...]`), `\d \D \w \W \s \S` and escaped characters, groups `(...)` and
-- `(?:...)`, alternation `|`, the quantifiers `* + ? {n} {n,} {n,m}` (greedy, or lazy with a trailing `?`), and the
-- anchors `^ $`. compile() returns nil and a message for what it does not take (Java's PatternSyntaxException, or a
-- construct beyond this subset: lookaround, backreferences, possessive quantifiers, flags).
local R = {}

local function classOf(c)
  if c == "d" then return function(ch) return ch:match("%d") ~= nil end end
  if c == "D" then return function(ch) return ch:match("%d") == nil end end
  if c == "w" then return function(ch) return ch:match("[%w_]") ~= nil end end
  if c == "W" then return function(ch) return ch:match("[%w_]") == nil end end
  if c == "s" then return function(ch) return ch:match("[ \t\n\r\f\v]") ~= nil end end
  if c == "S" then return function(ch) return ch:match("[ \t\n\r\f\v]") == nil end end
  return nil
end

local ESCAPES = { t = "\t", n = "\n", r = "\r", f = "\f", a = "\a", e = "\27" }

function R.compile(pattern)
  local pos, n = 1, #pattern
  local fail

  local function peek() return pattern:sub(pos, pos) end

  local parseAlt

  local function parseClass()
    -- after "["
    local negate = false
    if peek() == "^" then negate = true pos = pos + 1 end
    local tests = {}
    local first = true
    while true do
      if pos > n then fail("Unclosed character class") end
      local c = peek()
      if c == "]" and not first then pos = pos + 1 break end
      first = false
      local lo
      if c == "\\" then
        local e = pattern:sub(pos + 1, pos + 1)
        pos = pos + 2
        local cls = classOf(e)
        if cls then tests[#tests + 1] = cls else lo = ESCAPES[e] or e end
      elseif c == "[" then
        fail("nested classes are not supported")
      else
        lo = c
        pos = pos + 1
      end
      if lo == nil then
        -- a class escape (\d, \w, ...) inside the brackets: already added
      elseif peek() == "-" and pattern:sub(pos + 1, pos + 1) ~= "]" and pos + 1 <= n then
        local hi = pattern:sub(pos + 1, pos + 1)
        if hi == "\\" then hi = ESCAPES[pattern:sub(pos + 2, pos + 2)] or pattern:sub(pos + 2, pos + 2) pos = pos + 3
        else pos = pos + 2 end
        if hi:byte() < lo:byte() then fail("Illegal character range") end
        local a, b = lo:byte(), hi:byte()
        tests[#tests + 1] = function(ch) local x = ch:byte() return x >= a and x <= b end
      else
        local want = lo
        tests[#tests + 1] = function(ch) return ch == want end
      end
    end
    return { kind = "set", test = function(ch)
      local hit = false
      for _, t in ipairs(tests) do if t(ch) then hit = true break end end
      if negate then return not hit end
      return hit
    end }
  end

  local function parseAtom()
    local c = peek()
    if c == "(" then
      pos = pos + 1
      if pattern:sub(pos, pos + 1) == "?:" then pos = pos + 2
      elseif peek() == "?" then fail("group constructs other than (?:) are not supported") end
      local node = parseAlt()
      if peek() ~= ")" then fail("Unclosed group") end
      pos = pos + 1
      return { kind = "group", node = node }
    elseif c == "[" then
      pos = pos + 1
      return parseClass()
    elseif c == "." then
      pos = pos + 1
      return { kind = "set", test = function(ch) return ch ~= "\n" and ch ~= "\r" end }
    elseif c == "^" then
      pos = pos + 1
      return { kind = "bol" }
    elseif c == "$" then
      pos = pos + 1
      return { kind = "eol" }
    elseif c == "\\" then
      local e = pattern:sub(pos + 1, pos + 1)
      if e == "" then fail("Unexpected internal error") end
      pos = pos + 2
      local cls = classOf(e)
      if cls then return { kind = "set", test = cls } end
      if e:match("%d") then fail("backreferences are not supported") end
      if e:match("%a") and not ESCAPES[e] then fail("Illegal/unsupported escape sequence") end
      local lit = ESCAPES[e] or e
      return { kind = "set", test = function(ch) return ch == lit end }
    elseif c == "*" or c == "+" or c == "?" or c == "{" then
      fail("Dangling meta character '" .. c .. "'")
    else
      pos = pos + 1
      return { kind = "set", test = function(ch) return ch == c end }
    end
  end

  local function parseQuant(atom)
    local c = peek()
    local lo, hi
    if c == "*" then lo, hi = 0, math.huge pos = pos + 1
    elseif c == "+" then lo, hi = 1, math.huge pos = pos + 1
    elseif c == "?" then lo, hi = 0, 1 pos = pos + 1
    elseif c == "{" then
      local a, b, close = pattern:match("^{(%d+)(,?%d*)()}", pos)
      if not a then fail("Illegal repetition") end
      lo = tonumber(a)
      if b == "" then hi = lo elseif b == "," then hi = math.huge else hi = tonumber(b:sub(2)) end
      pos = close + 1
    else
      return atom
    end
    local lazy = false
    if peek() == "?" then lazy = true pos = pos + 1
    elseif peek() == "+" then fail("possessive quantifiers are not supported") end
    return { kind = "rep", node = atom, lo = lo, hi = hi, lazy = lazy }
  end

  local function parseSeq()
    local items = {}
    while pos <= n and peek() ~= "|" and peek() ~= ")" do
      items[#items + 1] = parseQuant(parseAtom())
    end
    return { kind = "seq", items = items }
  end

  parseAlt = function()
    local alts = { parseSeq() }
    while peek() == "|" do
      pos = pos + 1
      alts[#alts + 1] = parseSeq()
    end
    if #alts == 1 then return alts[1] end
    return { kind = "alt", alts = alts }
  end

  local ok, tree = pcall(function()
    fail = function(m) error({ regex = m .. " near index " .. (pos - 1) .. "\n" .. pattern }, 0) end
    local t = parseAlt()
    if pos <= n then fail("Unmatched closing ')'") end
    return t
  end)
  if not ok then
    if type(tree) == "table" and tree.regex then return nil, tree.regex end
    error(tree, 0)
  end

  -- backtracking matcher in continuation style: m(node, i, k) tries node at i, then k(j)
  local s
  local function m(node, i, k)
    local kind = node.kind
    if kind == "set" then
      if i <= #s and node.test(s:sub(i, i)) then return k(i + 1) end
      return false
    elseif kind == "seq" then
      local function step(idx, j)
        if idx > #node.items then return k(j) end
        return m(node.items[idx], j, function(j2) return step(idx + 1, j2) end)
      end
      return step(1, i)
    elseif kind == "alt" then
      for _, a in ipairs(node.alts) do if m(a, i, k) then return true end end
      return false
    elseif kind == "group" then
      return m(node.node, i, k)
    elseif kind == "bol" then
      if i == 1 then return k(i) end
      return false
    elseif kind == "eol" then
      if i == #s + 1 then return k(i) end
      return false
    elseif kind == "rep" then
      local function rep(count, j)
        local function more()
          if count < node.hi then
            return m(node.node, j, function(j2)
              if j2 == j then return false end -- an empty match does not repeat
              return rep(count + 1, j2)
            end)
          end
          return false
        end
        if count < node.lo then return more() end
        if node.lazy then return k(j) or more() end
        return more() or k(j)
      end
      return rep(0, i)
    end
    return false
  end

  return function(subject)
    s = subject
    return m(tree, 1, function(j) return j == #s + 1 end)
  end
end

return R
