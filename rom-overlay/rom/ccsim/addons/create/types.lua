-- Which addon this module belongs to and the peripheral types it builds (see ../README.md).
-- Create 0.5.1.i (1.18.2) has the first six; Create 6.0 (6.0.8 on 1.20.1, 6.0.10 on 1.21.1) keeps their names and
-- adds the other twelve (byVersion; docs/create-versions.md has every difference).
return {
  addon = "create",
  types = {
    "Create_DisplayLink",
    "Create_Speedometer",
    "Create_Stressometer",
    "Create_RotationSpeedController",
    "Create_SequencedGearshift",
    "Create_Station",
    -- Create 6.0 only
    "Create_CreativeMotor",
    "Create_Frogport",
    "Create_Postbox",
    "Create_NixieTube",
    "Create_Signal",
    "Create_StockTicker",
    "Create_Repackager",
    "Create_Packager",
    "Create_RedstoneRequester",
    "Create_TableClothShop",
    "Create_Sticker",
    "Create_TrainObserver",
  },
  byVersion = {
    ["1.20.1"] = {
      added = {
        "Create_CreativeMotor", "Create_Frogport", "Create_Postbox", "Create_NixieTube", "Create_Signal",
        "Create_StockTicker", "Create_Repackager", "Create_Packager", "Create_RedstoneRequester",
        "Create_TableClothShop", "Create_Sticker", "Create_TrainObserver",
      },
    },
    ["1.21.1"] = {
      added = {
        "Create_CreativeMotor", "Create_Frogport", "Create_Postbox", "Create_NixieTube", "Create_Signal",
        "Create_StockTicker", "Create_Repackager", "Create_Packager", "Create_RedstoneRequester",
        "Create_TableClothShop", "Create_Sticker", "Create_TrainObserver",
      },
    },
  },
  worldKeys = { "create" },
}
