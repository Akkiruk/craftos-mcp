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
  "diversionTransporter" }
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
return { addon = "mekanism", types = types, worldKeys = { "mekanism" } }
