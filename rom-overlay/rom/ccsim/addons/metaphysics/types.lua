-- Which addon this module belongs to (see ../README.md). Metaphysics has no blocks: its APIs are globals, so the
-- module loads at boot when the world has a `metaphysics` key.
return {
  addon = "metaphysics",
  types = {},
  worldKeys = { "metaphysics" },
}
