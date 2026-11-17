-- Which addon this module belongs to and the peripheral types it builds (see ../README.md).
-- "moreperipherals:scanner" is the world type of the mod's "scanner" (Classic Peripherals has a "scanner" too).
return {
  addon = "more-peripherals",
  types = {
    "xp_collector",
    "xp_bottler",
    "crafter",
    "loom_interface",
    "magnetic_card_manipulator",
    "beehive_interface",
    "trading_interface",
    "spawner_interface",
    "player_interface",
    "ender_chest_interface",
    "moreperipherals:scanner",
    "grinder",
  },
  worldKeys = { "morePeripherals" },
}
