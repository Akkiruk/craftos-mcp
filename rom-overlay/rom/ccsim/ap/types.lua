-- Advanced Peripherals is not an addon module (its blocks are built in ../peripherals.lua from the files here), so
-- its types by Minecraft version live in this file: `byVersion` as in a module's types.lua (../addons/README.md),
-- the same data as the "advanced-peripherals" entry's byVersion in packages/runner/src/addons.ts. Read at every boot.
-- From each jar's PERIPHERAL_TYPE constants and block list (docs/advanced-peripherals-versions.md).
return {
  addon = "advanced-peripherals",
  byVersion = {
    ["1.20.1"] = {
      removed = { "arController" },
      note = {
        arController = "Advanced Peripherals 0.7.48r has no AR controller or AR goggles",
      },
    },
    ["1.21.1"] = {
      rename = {
        playerDetector = "player_detector",
        chatBox = "chat_box",
        energyDetector = "energy_detector",
        nbtStorage = "nbt_storage",
        environmentDetector = "environment_detector",
        meBridge = "me_bridge",
        rsBridge = "rs_bridge",
        geoScanner = "geo_scanner",
        blockReader = "block_reader",
        inventoryManager = "inventory_manager",
      },
      removed = { "redstoneIntegrator", "arController" },
      note = {
        redstoneIntegrator = "removed in 0.7.50b; use CC:Tweaked's redstone_relay",
        arController = "Advanced Peripherals 0.7.62b has no AR controller or AR goggles",
      },
    },
  },
}
