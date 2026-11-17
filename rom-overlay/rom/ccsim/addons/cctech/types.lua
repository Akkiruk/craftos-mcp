-- Which addon this module belongs to and the peripheral types it builds (see ../README.md). The card writer's
-- world type is card_writer; on the computer it is a "magnetic_card_reader", like the reader (the mod's getType).
return {
  addon = "cctech",
  types = { "cassette_deck", "reel_to_reel", "magnetic_card_reader", "card_writer" },
  worldKeys = { "cctech" },
  rom = true, -- rom/programs/tape.lua and rom/autorun/cctech_completion.lua, from the jar
}
