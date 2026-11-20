-- Which addon this module belongs to and the peripheral types it builds (see ../README.md).
-- The Energizer's computer port exists from 2.0.7x on (1.20.1 and 1.21.1); 1.18.2-2.0.71 has none.
return {
  addon = "extreme-reactors",
  types = { "BigReactors-Reactor", "BigReactors-Turbine", "BigReactors-Energizer" },
  worldKeys = { "extremeReactors" },
  byVersion = {
    ["1.20.1"] = { added = { "BigReactors-Energizer" } },
    ["1.21.1"] = { added = { "BigReactors-Energizer" } },
  },
}
