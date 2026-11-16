-- Which addon this module belongs to and the peripheral types it builds (see ../README.md).
-- world.mekanism.multiblocks configures the multiblocks (the QIO in ../../mek/ reads world.mekanism.qio).
local types = { "boilerValve", "inductionPort", "enrichmentChamber", "crusher", "energizedSmelter", "metallurgicInfuser",
  "electrolyticSeparator" }
for _, tier in ipairs({ "basic", "advanced", "elite", "ultimate", "creative" }) do
  types[#types + 1] = tier .. "EnergyCube"
  types[#types + 1] = tier .. "FluidTank"
  types[#types + 1] = tier .. "ChemicalTank"
end
return { addon = "mekanism", types = types, worldKeys = { "mekanism" } }
