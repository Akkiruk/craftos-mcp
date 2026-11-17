-- Which addon this module belongs to and the peripheral types it builds (see ../README.md).
-- "plethora:<module>" are the modules as turtle upgrades (TurtleUpgradeModule names the peripheral after the module).
return {
  addon = "plethora",
  types = {
    "neuralInterface",
    "manipulator",
    "redstone_integrator",
    "plethora:scanner",
    "plethora:sensor",
    "plethora:introspection",
    "plethora:laser",
  },
  worldKeys = { "plethora" },
}
