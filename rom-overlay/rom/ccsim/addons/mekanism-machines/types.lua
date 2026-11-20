-- Which addon this module belongs to and the peripheral types it builds (see ../README.md).
-- world.mekanism.multiblocks configures the multiblocks (the QIO in ../../mek/ reads world.mekanism.qio).
local types = { "boilerValve", "inductionPort", "enrichmentChamber", "crusher", "energizedSmelter", "metallurgicInfuser",
  "electrolyticSeparator",
  -- multiblocks
  "dynamicValve", "thermalEvaporationController", "thermalEvaporationValve", "spsPort",
  -- recipes.lua
  "precisionSawmill", "osmiumCompressor", "purificationChamber", "chemicalInjectionChamber", "combiner",
  "pressurizedReactionChamber", "chemicalCrystallizer", "chemicalDissolutionChamber", "chemicalInfuser", "chemicalOxidizer",
  "chemicalWasher", "rotaryCondensentrator", "isotopicCentrifuge", "nutritionalLiquifier", "antiprotonicNucleosynthesizer",
  "pigmentExtractor", "pigmentMixer", "paintingMachine", "solarNeutronActivator",
  -- miner.lua, misc.lua
  "digitalMiner", "electricPump", "fluidicPlenisher", "resistiveHeater", "fuelwoodHeater", "seismicVibrator", "laser",
  "laserAmplifier", "laserTractorBeam", "teleporter", "chargepad", "logisticalSorter", "oredictionificator",
  "formulaicAssemblicator", "modificationStation", "dimensionalStabilizer",
  "diversionTransporter",
  -- added.lua: computer support new in Mekanism 10.4 (1.20.1, 1.21.1 only)
  "radioactiveWasteBarrel", "industrialAlarm", "personalChest", "personalBarrel", "securityDesk" }
for _, tier in ipairs({ "basic", "advanced", "elite", "ultimate", "creative" }) do
  types[#types + 1] = tier .. "EnergyCube"
  types[#types + 1] = tier .. "FluidTank"
  types[#types + 1] = tier .. "ChemicalTank"
  types[#types + 1] = tier .. "Bin"
end
for _, tier in ipairs({ "basic", "advanced", "elite", "ultimate" }) do
  for _, f in ipairs({ "Smelting", "Enriching", "Crushing", "Compressing", "Combining", "Purifying", "Injecting", "Infusing", "Sawing" }) do
    types[#types + 1] = tier .. f .. "Factory"
  end
  for _, t in ipairs({ "UniversalCable", "MechanicalPipe", "PressurizedTube" }) do types[#types + 1] = tier .. t end
end
-- Mekanism's types by Minecraft version (../README.md, the same as byVersion in packages/runner/src/addons.ts).
-- Every 1.18.2 type keeps its name on 1.20.1 (10.4.16) and 1.21.1 (10.7.19) (MekanismBlockTypes.withComputerSupport
-- in the three jars, docs/mekanism-versions.md); 10.4 gave five more blocks computer support.
local ADDED = { "radioactiveWasteBarrel", "industrialAlarm", "personalChest", "personalBarrel", "securityDesk" }
local NOTE = {}
for _, t in ipairs(ADDED) do NOTE[t] = "computer support came with Mekanism 10.4 (Minecraft 1.20.1)" end
local byVersion = { ["1.20.1"] = { added = ADDED, note = NOTE }, ["1.21.1"] = { added = ADDED, note = NOTE } }
return { addon = "mekanism", types = types, worldKeys = { "mekanism" }, byVersion = byVersion }
