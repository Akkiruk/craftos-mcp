-- Which addon this module belongs to and the peripheral types it builds (see ../README.md). A world with a
-- `dronePlus` entry makes the computer a CC: Drones+ drone. The fork keeps the original's workbench type; with both
-- addons on, ../cc-drones builds it (it is listed after this one in ../modules.lua).
return {
  addon = "cc-drones-plus",
  types = { "droneworkbench" },
  worldKeys = { "dronePlus" },
}
