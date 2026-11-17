-- Which addon this module belongs to and the peripheral types it builds (see ../README.md). The secure computer's
-- block is an "embeddedcomputer" too (SecureComputerPeripheral extends EmbeddedComputerPeripheral).
return {
  addon = "embedded-computer",
  types = { "embeddedcomputer", "harddrive" },
  worldKeys = { "embeddedComputer" },
  rom = true, -- rom/autorun/embedded.lua, rom/apis/secure/security.lua
}
