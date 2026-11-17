-- Which addon this module belongs to and the peripheral types it builds (see ../README.md).
-- The scanner's own type is "scanner", which More Peripherals uses too: the world names it "classicperipherals:scanner".
return {
  addon = "classic-peripherals",
  types = { "cryptographic_accelerator", "radio_tower", "nfc_reader", "rfid_scanner", "classicperipherals:scanner" },
  worldKeys = { "classicPeripherals" },
}
