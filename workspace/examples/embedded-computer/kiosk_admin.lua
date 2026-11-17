-- Admin desk for a kiosk built on an embedded computer: shows its state, unlocks it with the plain password the
-- kiosk was locked with, and mounts the backup hard drive at /backup.
local kiosk = peripheral.find("embeddedcomputer")
local drive = peripheral.find("harddrive")
if not kiosk then error("no embedded computer attached", 0) end

print(("kiosk #%d is %s"):format(kiosk.getId(), kiosk.isOn() and "on" or "off"))
local password = ...
if password then
  kiosk.unlockPlainText(password)
  print("unlock sent")
end
if drive and not fs.exists("backup") then
  print(drive.mount("backup") and "backup drive at /backup" or "could not mount the backup drive")
end
-- this desk is a secure computer itself: it signs what it prints
if security then print("desk hash " .. security.hashStrSHA256("desk"):sub(1, 12)) end
