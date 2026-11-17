-- Reports whether this computer is enrolled in secure boot, and whether its boot files carry valid signatures.
local codesign = dofile("/rom/modules/main/codesign.lua")
local id = os.getComputerID()
local enrolled = fs.exists("/rom/pxboot/certs/enrolled/" .. id)
print(("computer %d: secure boot %s"):format(id, enrolled and "on" or "off"))
for _, file in ipairs({ "/startup.lua", "/pxboot_config.lua" }) do
  if fs.exists(file) then
    local ok, why = codesign.verify(file)
    print(("%s: %s"):format(file, ok and "signed" or ("not trusted (" .. tostring(why) .. ")")))
  end
end
return enrolled
