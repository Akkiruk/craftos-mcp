-- Which addon this module belongs to and the peripheral types it builds (see ../README.md). A world with a `drone`
-- entry makes the computer a CC: Drones drone. CC: Drones+ (../cc-drones-plus) is the same code with its changes
-- switched on; with both addons on, a drone workbench is this mod's.
return {
  addon = "cc-drones",
  types = { "droneworkbench" },
  worldKeys = { "drone" },
}
