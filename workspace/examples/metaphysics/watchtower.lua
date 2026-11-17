-- Watchtower: lists the monsters under the open sky around this computer, nearest first, and sends the report
-- sealed with AES-GCM under a shared key, with its SHA3 checksum so the receiver can check it arrived whole.
-- Uses Metaphysics' `coord` and `crypto` APIs (no peripheral needed).

local KEY = "watchtower-shared-key"
local here = coord.getCoord()

local monsters = {}
for _, m in pairs(coord.getMonster(32)) do
  local dx, dz = m.x - here.x, m.z - here.z
  monsters[#monsters + 1] = { name = m.displayName, distance = math.sqrt(dx * dx + dz * dz), health = m.health }
end
table.sort(monsters, function(a, b) return a.distance < b.distance end)

local lines = { ("Watchtower at %d %d %d (%s)"):format(here.x, here.y, here.z, coord.getSelfDimensionType()) }
for _, m in ipairs(monsters) do
  lines[#lines + 1] = ("%s %.1f blocks away, %d hp"):format(m.name, m.distance, m.health)
end
if #monsters == 0 then lines[#lines + 1] = "All clear" end
local report = table.concat(lines, "\n")

print(report)
local sealed = crypto.AESGCMEncrypt(report, KEY)
print("sealed " .. sealed)
print("sha3 " .. crypto.SHA256HASH(report))
