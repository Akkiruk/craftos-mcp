-- A docking desk: every lectern next to the computer that holds a pocket computer gets it switched on, and the
-- desk prints what sits where. Lecterns with a printout on them are listed as such.
local function describe(name, lectern)
  if not lectern.isPocket() then return name .. ": printout" end
  local label = lectern.getLabel() or ("pocket #" .. lectern.getID())
  return ("%s: %s (%s)"):format(name, label, lectern.isOn() and "on" or "off")
end

local woken = 0
local names = peripheral.getNames()
table.sort(names)
for _, name in ipairs(names) do
  if peripheral.hasType(name, "cc_lectern") then
    local lectern = peripheral.wrap(name)
    if lectern.isPocket() and not lectern.isOn() then
      lectern.turnOn()
      woken = woken + 1
    end
  end
end

-- a pocket starts on the next server tick
if woken > 0 then sleep(0.1) end

for _, name in ipairs(names) do
  if peripheral.hasType(name, "cc_lectern") then print(describe(name, peripheral.wrap(name))) end
end
print(("woke %d pocket computer%s"):format(woken, woken == 1 and "" or "s"))
