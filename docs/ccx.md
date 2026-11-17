# CCX 6.1.1 emulation

Addon id `ccx`. Lua in `rom-overlay/rom/ccsim/addons/ccx/init.lua`.

Source of truth: [github.com/minecraftbossdj/CCX](https://github.com/minecraftbossdj/CCX) at commit `20f1e4e` (branch
`multiloader`, `mod_version = 6.1.1`, Minecraft 1.20.1). Paths below are under
`common/src/main/java/com/awesoft/ccx/`. CC BY-SA 4.0.

## Versions

| Minecraft | Mod release                                                                      |
| --------- | -------------------------------------------------------------------------------- |
| 1.20.1    | 6.1.1 (Forge and Fabric)                                                         |
| 1.21.1    | left out: CCX 0.3.x for 1.21.1 is a different code base with no source published |
| 1.18.2    | none                                                                             |

## Peripherals

| Type       | Block    | Methods    |
| ---------- | -------- | ---------- |
| `pcie`     | PCIe Hub | getMethods |
| `usb_port` | USB Port | getMethods |

Each has one method, `getMethods()` (`mainThread`), which returns tables of functions for what is plugged in. Those
functions (`ILuaFunction`s) run where they are called and report problems as `false, message` rather than errors.

### PCIe hub (`block/pcie/PCIePeripheral`, `luaFunctions/cards/*`)

Four card slots. `getMethods()` returns `{ card_<slot> = {...} }`:

- inventory card (`InventoryCardFunctions`): `size()`, `list()` (every slot 1..size, an item table or nil),
  `getItemDetail(slot)`, `getItemLimit(slot)` on the inventory the card was bound to. Item tables are
  `LuaConverter.itemToLua`: `name, count, displayName` (in square brackets, as `ItemStack.getDisplayName`),
  `maxStackSize, nbt` (`{}` with no tag), and `damage, maxDamage` for damageable items. "Card not inserted!" once
  the card is out, "Block is NOT a inventory!" when its block is not a container.
- peripheral card (`PeripheralCardFunctions`): `attachPeripheral()` / `detachPeripheral()` return `true,
"Peripheral Attached!"` / `"Peripheral Detached!"` when the bound block is a peripheral, else `false, "Not a valid
peripheral! (debug: actual peripheral)"`. They only call that peripheral's attach hook; the mod's own comment says
  it does not work, and the computer does not get the peripheral. A card bound to nothing throws a
  NullPointerException.
- command card: nothing. `PCIePeripheral` has no case for it (and `CommandCardFunctions.getFunctions` checks for the
  inventory card), so in 6.1.1 it gives no functions.
- a card with no NBT (never bound): the whole answer is nil.

### USB port (`block/usb/USBPeripheral`, `luaFunctions/usb/WirelessUSBFunctions`, `misc/WiFiNetwork`)

With a wireless USB in the port, `getMethods()` returns `{ usb = { setChannel, getChannel, broadcast } }`:
`setChannel(n)` clamps to 1..65535 and returns `true, n`; `getChannel()` returns `true, channel` (1 by default);
`broadcast(message, channel)` returns `true, "Message sent!"` and sends `wifi_message (channel, message)` to every
_other_ computer listening on that channel. A computer listens on the USB's channel from when it attaches the port
(the channel then, not after `setChannel`). "USB not inserted!" once it is out.

## Fixtures

```jsonc
{ "name": "pcie_0", "type": "pcie", "cards": { "1": { "kind": "inventory", "target": "chest_far" },
                                               "2": { "kind": "peripheral", "target": "monitor_3" },
                                               "3": { "kind": "command" }, "4": { "kind": "inventory", "bound": false } } },
{ "name": "usb_port_0", "type": "usb_port", "usb": { "channel": 5 } },
{ "name": "chest_far", "type": "minecraft:chest", "size": 27, "items": { "1": { "name": "minecraft:diamond", "count": 12 } } }
```

`target` is the peripheral name of the bound block (any inventory in the world, wired or not: the card reaches it by
position). An item's `displayName` (without brackets) and `maxCount` come from its fixture.

## Sim commands

| Command      | Fields                                                            |
| ------------ | ----------------------------------------------------------------- |
| `ccxSetCard` | `peripheral, slot (1-4), card = { kind, target, bound? } or null` |
| `ccxSetUsb`  | `peripheral, usb = { channel? } or null`                          |

`craftos_sim_state` `peripherals.<name>`: a hub's `cards`, a port's `usb` and `listening` channel.

## Not emulated

- `wifi_message` delivery between computers: the world has one computer, and the sender never hears itself.
- Item NBT in `itemToLua` (`nbt` is `{}`), and an item's real `maxStackSize` unless the fixture gives `maxCount`.
- The rest of CCX is other kinds of computer, not peripherals: drones (`ccx_drones`, the drone API and its
  upgrades), the head-mounted display and pocket pack (`ccx_pocket`), rack servers and the PC reader. They need an
  entity or a computer inside an item, which the emulator has no model for.
