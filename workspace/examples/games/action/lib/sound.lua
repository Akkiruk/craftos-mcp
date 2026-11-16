-- lib/sound.lua
-- Part of the craftos-mcp examples (MIT).
-- Named sound effects on a speaker, all vanilla Minecraft sounds. Games play these by name, so a sound changes here and
-- nowhere else. With no speaker attached every call quietly does nothing, so a game plays the same without one.
-- A speaker takes one sound per game tick (50 ms) and refuses a second, so a sound asked for too soon after the last is
-- played a moment later instead of being lost.

local M = {}

-- name = { Minecraft sound event, volume, pitch }
M.SOUNDS = {
  -- menus
  tap = { "minecraft:block.wooden_button.click_on", 0.7, 1.2 },
  select = { "minecraft:block.note_block.xylophone", 0.7, 1 },
  back = { "minecraft:block.wooden_button.click_off", 0.7, 1 },
  error = { "minecraft:block.note_block.didgeridoo", 0.7, 0.8 },
  start = { "minecraft:item.trident.return", 0.8, 1 },
  count = { "minecraft:block.note_block.hat", 0.8, 1.2 },
  go = { "minecraft:block.note_block.bell", 0.8, 1.4 },
  warning = { "minecraft:block.note_block.bell", 0.7, 0.8 },
  hint = { "minecraft:block.note_block.chime", 0.7, 1 },
  timeout = { "minecraft:block.note_block.bass", 0.8, 0.6 },
  win = { "minecraft:entity.player.levelup", 0.7, 1 },
  fanfare = { "minecraft:ui.toast.challenge_complete", 0.6, 1 },
  lose = { "minecraft:entity.villager.no", 0.7, 0.9 },
  draw = { "minecraft:block.note_block.bass", 0.8, 1 },
  rank = { "minecraft:entity.experience_orb.pickup", 0.7, 0.8 },
  -- play
  pickup = { "minecraft:entity.item.pickup", 0.8, 1 },
  point = { "minecraft:entity.experience_orb.pickup", 0.8, 1 },
  level_up = { "minecraft:block.beacon.power_select", 0.8, 1.2 },
  death = { "minecraft:entity.player.hurt", 0.8, 0.8 },
  boom_small = { "minecraft:entity.firework_rocket.large_blast", 0.8, 1 },
  boom_big = { "minecraft:entity.generic.explode", 0.8, 1 },
  blip = { "minecraft:block.note_block.bit", 0.8, 1.6 },
  boop = { "minecraft:block.note_block.bit", 0.8, 0.8 },
  brick = { "minecraft:block.note_block.pling", 0.6, 1.2 },
  lock = { "minecraft:block.stone.place", 0.8, 1 },
  turn = { "minecraft:entity.item_frame.rotate_item", 0.8, 1 },
  line = { "minecraft:entity.player.levelup", 0.6, 1.4 },
  swish = { "minecraft:entity.player.attack.sweep", 0.6, 1.2 },
  thrust = { "minecraft:block.fire.extinguish", 0.4, 1.4 },
  flag = { "minecraft:entity.armor_stand.place", 0.8, 1 },
  open = { "minecraft:block.wooden_button.click_on", 0.6, 1.4 },
  cannon = { "minecraft:entity.firework_rocket.blast", 1, 0.6 },
  dig = { "minecraft:block.gravel.break", 0.8, 1 },
  hit = { "minecraft:entity.iron_golem.damage", 0.8, 1 },
}

local speaker = nil
local pending = {}       -- { at = ms, name, vol, pitch }, soonest first
local lastAt = -1e9
local MIN_GAP_MS = 60

local function nowMs() return os.epoch("utc") end

--- Use this speaker (a wrapped peripheral), or nil for silence.
function M.init(sp)
  speaker = sp
  pending = {}
end

local function queue(item)
  pending[#pending + 1] = item
  table.sort(pending, function(a, b) return a.at < b.at end)
end

--- Play a named sound now, scaled in volume and pitch. Returns true if the speaker took it.
function M.play(name, volScale, pitchScale)
  local def = M.SOUNDS[name]
  if not speaker or not def then return false end
  local t = nowMs()
  if t - lastAt < MIN_GAP_MS then
    queue({ at = lastAt + MIN_GAP_MS, name = name, vol = volScale, pitch = pitchScale })
    return false
  end
  lastAt = t
  local vol = math.min(3, def[2] * (volScale or 1))
  local pitch = math.max(0.5, math.min(2, def[3] * (pitchScale or 1)))
  local ok, played = pcall(speaker.playSound, def[1], vol, pitch)
  return ok and played
end

--- Play a named sound after delayMs. pump() plays it when it's due.
function M.later(name, delayMs, volScale, pitchScale)
  queue({ at = nowMs() + delayMs, name = name, vol = volScale, pitch = pitchScale })
end

--- Play every sound that's due. The shell calls this on every tick.
function M.pump()
  local t = nowMs()
  while pending[1] and pending[1].at <= t do
    local item = table.remove(pending, 1)
    M.play(item.name, item.vol, item.pitch)
  end
end

return M
