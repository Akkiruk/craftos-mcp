-- Which addon this module belongs to and the peripheral types it builds (see ../README.md).
-- `turtle` and `placed` load it at boot in a block world too: every turtle gets the `shop` API, and a shop block next
-- to a turtle or a placed computer is a peripheral (core.blockPeripherals). Only `ccShops` is listed in addons.ts:
-- a turtle world is not refused when the addon is off, it just has no shops.
return {
  addon = "cc-shops",
  types = { "shop" },
  worldKeys = { "ccShops", "turtle", "placed" },
}
