-- Which addon this module belongs to and the peripheral types it builds (see ../README.md).
-- World types are the mod's block and upgrade ids; each peripheral reports the mod's own type name (docs).
-- world.finerPeripherals loads the module at boot, so a turtle can equip the mod's upgrades.
return {
  addon = "finer-peripherals",
  types = {
    "finerperipherals:chatbox",
    "finerperipherals:chatbox_pocket",
    "finerperipherals:chatbox_turtle",
    "finerperipherals:geoexplorer",
    "finerperipherals:geoexplorer_pocket",
    "finerperipherals:geoexplorer_turtle",
    "finerperipherals:player_finder",
    "finerperipherals:eventrelayer",
    "finerperipherals:eventrelayer_pocket",
    "finerperipherals:eventrelayer_turtle",
    "finerperipherals:holoitemdisplay",
    "finerperipherals:compass_turtle",
    "finerperipherals:enderchest_turtle",
    "finerperipherals:debug_pocket",
  },
  worldKeys = { "finerPeripherals" },
}
