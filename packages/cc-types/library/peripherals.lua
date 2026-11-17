---@meta

-- Hand-written from the peripheral classes of CC:Tweaked's Java source, 1.101.3 and 1.121.0
-- (shared/peripheral/**, shared/computer/blocks/ComputerPeripheral.java). `peripheral.find("monitor")` returns these;
-- for `peripheral.wrap`, which cannot know, say which one you expect:
--
--   local mon = peripheral.wrap("left") --[[@as cc.Monitor]]

---A monitor: everything a terminal can do, and a text scale.
---
---[tweaked.cc](https://tweaked.cc/peripheral/monitor.html)
---@class cc.Monitor: cc.Redirect
local Monitor = {}

---Set the size of the text. The monitor's size in characters changes with it.
---@param scale number 0.5 to 5, in steps of 0.5.
function Monitor.setTextScale(scale) end

---The size of the text.
---@return number scale
function Monitor.getTextScale() end

---A speaker: note block notes, Minecraft sounds and raw audio.
---
---[tweaked.cc](https://tweaked.cc/peripheral/speaker.html)
---@class cc.Speaker
local Speaker = {}

---@alias cc.Instrument "harp"|"basedrum"|"snare"|"hat"|"bass"|"flute"|"bell"|"guitar"|"chime"|"xylophone"|"iron_xylophone"|"cow_bell"|"didgeridoo"|"bit"|"banjo"|"pling"|string

---Play a note block note. At most 8 notes play in one tick.
---@param instrument cc.Instrument
---@param volume? number 0 to 3. Default 1.
---@param pitch? number Semitones above F#, 0 to 24. Default 12.
---@return boolean played False when too many notes were played this tick.
function Speaker.playNote(instrument, volume, pitch) end

---Play a Minecraft sound, such as `"entity.creeper.primed"`. One sound per tick, and none while audio plays.
---@param name string The sound's id.
---@param volume? number 0 to 3. Default 1.
---@param pitch? number Speed, 0.5 to 2. Default 1.
---@return boolean played False when another sound was started this tick.
function Speaker.playSound(name, volume, pitch) end

---Queue raw audio: 48 kHz mono samples from -128 to 127, at most 128 × 1024 in one call. When it returns false the
---speaker is full: wait for `speaker_audio_empty` and send the same samples again.
---@param audio integer[] The samples.
---@param volume? number 0 to 3. Default: the volume of the last call.
---@return boolean accepted
function Speaker.playAudio(audio, volume) end

---Stop everything this speaker plays.
function Speaker.stop() end

---A modem, wireless or wired. A wired modem also reaches the peripherals on its cable.
---
---[tweaked.cc](https://tweaked.cc/peripheral/modem.html)
---@class cc.Modem
local Modem = {}

---Start listening on a channel. At most 128 can be open.
---@param channel integer 0 to 65535.
function Modem.open(channel) end

---Whether a channel is open.
---@param channel integer 0 to 65535.
---@return boolean
function Modem.isOpen(channel) end

---Stop listening on a channel.
---@param channel integer 0 to 65535.
function Modem.close(channel) end

---Stop listening on every channel.
function Modem.closeAll() end

---Send a message. Modems listening on `channel` get a `modem_message` event.
---@param channel integer 0 to 65535.
---@param replyChannel integer The channel to answer on. 0 to 65535.
---@param payload any A boolean, number, string or table. Functions and metatables are not sent.
function Modem.transmit(channel, replyChannel, payload) end

---True for a wireless or ender modem, false for a wired one.
---@return boolean
function Modem.isWireless() end

---Wired modems only. The names of the peripherals on the cable.
---@return string[] names
function Modem.getNamesRemote() end

---Wired modems only. Whether a peripheral with this name is on the cable.
---@param name string
---@return boolean
function Modem.isPresentRemote(name) end

---Wired modems only. The types of a peripheral on the cable, or nil when it is not there.
---@param name string
---@return string? type
---@return string ... More types, when it has several.
function Modem.getTypeRemote(name) end

---Wired modems only. Whether a peripheral on the cable is of a type. Nil when it is not there.
---@param name string
---@param type string
---@return boolean?
function Modem.hasTypeRemote(name, type) end

---Wired modems only. The methods of a peripheral on the cable, or nil when it is not there.
---@param name string
---@return string[]? methods
function Modem.getMethodsRemote(name) end

---Wired modems only. Call a method of a peripheral on the cable.
---@param remoteName string
---@param method string
---@param ... any Arguments for the method.
---@return any ... What the method returns.
function Modem.callRemote(remoteName, method, ...) end

---Wired modems only. This computer's own name on the cable, or nil when the modem is off.
---@return string? name
function Modem.getNameLocal() end

---A printer. Start a page, write on it, end it.
---
---[tweaked.cc](https://tweaked.cc/peripheral/printer.html)
---@class cc.Printer
local Printer = {}

---Write text at the cursor of the page.
---@param ... string|number|boolean|nil
function Printer.write(...) end

---Where the cursor is on the page.
---@return integer x
---@return integer y
function Printer.getCursorPos() end

---Move the cursor on the page.
---@param x integer
---@param y integer
function Printer.setCursorPos(x, y) end

---The size of the page in characters.
---@return integer width
---@return integer height
function Printer.getPageSize() end

---Start a new page. False when there is no paper or ink.
---@return boolean started
function Printer.newPage() end

---Finish the page and put it in the tray. False when the tray is full.
---@return boolean ended
function Printer.endPage() end

---Give the page a title.
---@param title? string
function Printer.setPageTitle(title) end

---How much ink is left.
---@return integer
function Printer.getInkLevel() end

---How much paper is left.
---@return integer
function Printer.getPaperLevel() end

---A disk drive.
---
---[tweaked.cc](https://tweaked.cc/peripheral/drive.html)
---@class cc.Drive
local Drive = {}

---Whether anything is in the drive.
---@return boolean
function Drive.isDiskPresent() end

---The label of the disk, or nil.
---@return string? label
function Drive.getDiskLabel() end

---Set the label of the disk, or clear it with nil.
---@param label? string
function Drive.setDiskLabel(label) end

---Whether the disk holds files (a floppy, or a computer).
---@return boolean
function Drive.hasData() end

---Where the disk's files are, such as `"disk"`. Nil without a data disk.
---@return string? path
function Drive.getMountPath() end

---Whether the disk is a music disc.
---@return boolean
function Drive.hasAudio() end

---The title of the music disc. False when the drive is empty, nil when the disk has no audio.
---@return string|false|nil title
function Drive.getAudioTitle() end

---Play the music disc.
function Drive.playAudio() end

---Stop the music.
function Drive.stopAudio() end

---Eject the disk.
function Drive.ejectDisk() end

---The id of the floppy disk, or nil.
---@return integer? id
function Drive.getDiskID() end

---A command block.
---
---[tweaked.cc](https://tweaked.cc/peripheral/command.html)
---@class cc.CommandBlock
local CommandBlock = {}

---The command the block will run.
---@return string command
function CommandBlock.getCommand() end

---Set the command the block will run.
---@param command string
function CommandBlock.setCommand(command) end

---Run the command once.
---@return boolean ok
---@return string? message Why it failed.
function CommandBlock.runCommand() end

---Another computer or turtle next to this one, or on its cable.
---
---[tweaked.cc](https://tweaked.cc/peripheral/computer.html)
---@class cc.Computer
local Computer = {}

---Turn the other computer on.
function Computer.turnOn() end

---Turn the other computer off.
function Computer.shutdown() end

---Restart the other computer, or turn it on.
function Computer.reboot() end

---The other computer's id.
---@return integer id
function Computer.getID() end

---Whether the other computer is on.
---@return boolean
function Computer.isOn() end

---The other computer's label, or nil.
---@return string? label
function Computer.getLabel() end

---The crafting table a crafty turtle carries (`workbench`).
---@class cc.Workbench
local Workbench = {}

---Craft with the items in the turtle's inventory, like `turtle.craft`.
---@param limit? integer How many to craft at most. Default 64.
---@return boolean ok
---@return string? message Why nothing was crafted.
function Workbench.craft(limit) end

---A redstone relay: the `redstone` API of a block on a wired network.
---
---**Not in CC:Tweaked 1.101.3**: added in 1.114.0.
---
---[tweaked.cc](https://tweaked.cc/peripheral/redstone_relay.html)
---@class cc.RedstoneRelay
local RedstoneRelay = {}

---@param side cc.ComputerSide
---@param on boolean
function RedstoneRelay.setOutput(side, on) end

---@param side cc.ComputerSide
---@return boolean
function RedstoneRelay.getOutput(side) end

---@param side cc.ComputerSide
---@return boolean
function RedstoneRelay.getInput(side) end

---@param side cc.ComputerSide
---@param value integer 0 to 15.
function RedstoneRelay.setAnalogOutput(side, value) end

---@param side cc.ComputerSide
---@param value integer 0 to 15.
function RedstoneRelay.setAnalogueOutput(side, value) end

---@param side cc.ComputerSide
---@return integer
function RedstoneRelay.getAnalogOutput(side) end

---@param side cc.ComputerSide
---@return integer
function RedstoneRelay.getAnalogueOutput(side) end

---@param side cc.ComputerSide
---@return integer
function RedstoneRelay.getAnalogInput(side) end

---@param side cc.ComputerSide
---@return integer
function RedstoneRelay.getAnalogueInput(side) end

---@param side cc.ComputerSide
---@param output cc.ColourSet
function RedstoneRelay.setBundledOutput(side, output) end

---@param side cc.ComputerSide
---@return cc.ColourSet
function RedstoneRelay.getBundledOutput(side) end

---@param side cc.ComputerSide
---@return cc.ColourSet
function RedstoneRelay.getBundledInput(side) end

---@param side cc.ComputerSide
---@param mask cc.ColourSet
---@return boolean
function RedstoneRelay.testBundledInput(side, mask) end

-- ===== the generic peripherals: any block of any mod that holds items, fluid or energy =====

---An item as `list` gives it.
---@class cc.ItemStack
---@field name string The item's id, such as `"minecraft:stone"`.
---@field count integer
---@field nbt? string A hash of the item's NBT, when it has any.

---An item as `getItemDetail` gives it. Mods add more fields.
---@class cc.ItemDetail: cc.ItemStack
---@field displayName string
---@field maxCount integer
---@field damage? integer
---@field maxDamage? integer
---@field durability? number What is left, from 0 to 1.
---@field tags? table<string, boolean>
---@field itemGroups? { id: string, displayName: string }[]
---@field lore? string[]
---@field enchantments? { name: string, level: integer, displayName: string }[]
---@field unbreakable? boolean
---@field [string] any

---A fluid in a tank.
---@class cc.FluidStack
---@field name string The fluid's id, such as `"minecraft:water"`.
---@field amount integer In millibuckets.

---A block that holds items: a chest, a barrel, a machine (`inventory`).
---
---[tweaked.cc](https://tweaked.cc/generic_peripheral/inventory.html)
---@class cc.Inventory
local Inventory = {}

---How many slots there are.
---@return integer
function Inventory.size() end

---Every item, by slot. Empty slots are left out, so do not use `#` or `ipairs` on it.
---@return table<integer, cc.ItemStack> items
function Inventory.list() end

---All about the item in a slot, or nil when it is empty.
---@param slot integer
---@return cc.ItemDetail? item
function Inventory.getItemDetail(slot) end

---How many items a slot can hold. Usually 64.
---@param slot integer
---@return integer limit
function Inventory.getItemLimit(slot) end

---Move items from a slot of this inventory to another inventory on the same wired network.
---@param toName string The other inventory's name, as the modem lists it.
---@param fromSlot integer
---@param limit? integer How many to move at most. Default: the whole stack.
---@param toSlot? integer The slot to put them in. Default: any that fits.
---@return integer moved
function Inventory.pushItems(toName, fromSlot, limit, toSlot) end

---Move items from another inventory on the same wired network into this one.
---@param fromName string The other inventory's name, as the modem lists it.
---@param fromSlot integer
---@param limit? integer How many to move at most. Default: the whole stack.
---@param toSlot? integer The slot to put them in. Default: any that fits.
---@return integer moved
function Inventory.pullItems(fromName, fromSlot, limit, toSlot) end

---A block that holds fluids (`fluid_storage`).
---
---[tweaked.cc](https://tweaked.cc/generic_peripheral/fluid_storage.html)
---@class cc.FluidStorage
local FluidStorage = {}

---Every tank. Empty tanks are left out, so do not use `#` or `ipairs` on it.
---@return table<integer, cc.FluidStack> tanks
function FluidStorage.tanks() end

---Move fluid from this block to another on the same wired network.
---@param toName string The other block's name, as the modem lists it.
---@param limit? integer Millibuckets to move at most.
---@param fluidName? string The fluid to move. Default: any.
---@return integer moved In millibuckets.
function FluidStorage.pushFluid(toName, limit, fluidName) end

---Move fluid from another block on the same wired network into this one.
---@param fromName string The other block's name, as the modem lists it.
---@param limit? integer Millibuckets to move at most.
---@param fluidName? string The fluid to move. Default: any.
---@return integer moved In millibuckets.
function FluidStorage.pullFluid(fromName, limit, fluidName) end

---A block that holds Forge Energy (`energy_storage`).
---
---[tweaked.cc](https://tweaked.cc/generic_peripheral/energy_storage.html)
---@class cc.EnergyStorage
local EnergyStorage = {}

---The energy stored, in FE.
---@return integer
function EnergyStorage.getEnergy() end

---The most energy it can store, in FE.
---@return integer
function EnergyStorage.getEnergyCapacity() end
