-- cabinet/audio.lua
-- Part of the craftos-mcp examples (MIT).
-- Named sound events on a speaker, with a small timeline so one event can play several sounds a little apart.
-- Every sound in the cabinet is listed here, by the name the games use: change a sound here and nowhere else.
-- With no speaker attached every call simply does nothing, so the games play the same either way.

local M = {}

-- { Minecraft sound event, volume, pitch }. All of them are vanilla sounds, so they work on any server.
local SOUNDS = {
  -- menus and the cabinet
  tap = { "minecraft:block.wooden_button.click_on", 0.7, 1 },
  select = { "minecraft:block.note_block.xylophone", 0.7, 1 },
  back = { "minecraft:block.wooden_button.click_off", 0.7, 1 },
  error = { "minecraft:block.note_block.didgeridoo", 0.7, 0.7 },
  page = { "minecraft:item.book.page_turn", 0.7, 1 },
  boot = { "minecraft:block.beacon.activate", 0.7, 1 },
  start = { "minecraft:item.trident.return", 0.7, 1 },
  hint = { "minecraft:block.note_block.chime", 0.7, 1 },
  warning = { "minecraft:block.note_block.bell", 0.7, 1 },
  tick = { "minecraft:block.note_block.hat", 0.7, 1 },
  rank = { "minecraft:block.amethyst_block.chime", 1, 1 },

  -- results
  win = { "minecraft:entity.player.levelup", 0.7, 1 },
  winFanfare = { "minecraft:ui.toast.challenge_complete", 0.7, 1 },
  lose = { "minecraft:block.note_block.didgeridoo", 0.8, 0.5 },
  draw = { "minecraft:block.note_block.bass", 0.7, 1 },
  resign = { "minecraft:block.beacon.deactivate", 0.7, 1 },

  -- the board games
  piece_a = { "minecraft:entity.armor_stand.place", 0.7, 1 },
  piece_b = { "minecraft:block.amethyst_block.place", 0.7, 1 },
  capture = { "minecraft:entity.item.pickup", 0.7, 1 },
  flip = { "minecraft:item.book.page_turn", 0.7, 1 },
  disc_drop = { "minecraft:block.slime_block.fall", 0.7, 1 },
  pen_line = { "minecraft:ui.cartography_table.take_result", 0.7, 1 },
  pebbles = { "minecraft:block.nether_sprouts.fall", 0.7, 1 },
  cracked = { "minecraft:entity.experience_orb.pickup", 0.7, 1 },
  cannon = { "minecraft:entity.firework_rocket.launch", 0.9, 0.8 },
  splash = { "minecraft:block.pointed_dripstone.drip_water_into_cauldron", 0.9, 1 },
  ship_hit = { "minecraft:entity.firework_rocket.large_blast_far", 0.8, 1 },
  boom_big = { "minecraft:entity.generic.explode", 0.6, 1 },
}
M.SOUNDS = SOUNDS

local speaker
local enabled = true
local pending = {} -- { at = ms, event, vol, pitch }, soonest first
local lastAny = -1e9
local MIN_GAP_MS = 60 -- a speaker takes one sound per game tick (50 ms); a second in the same tick is refused

local function nowMs() return os.epoch("utc") end

--- Find the speaker. Returns true if there is one.
function M.init()
  speaker = peripheral.find("speaker")
  return speaker ~= nil
end

function M.setEnabled(on) enabled = on and true or false end
function M.isEnabled() return enabled end

local function schedule(item)
  pending[#pending + 1] = item
  table.sort(pending, function(a, b) return a.at < b.at end)
end

--- Play an event now. volScale and pitchScale multiply the event's own volume and pitch.
function M.play(event, volScale, pitchScale)
  local def = SOUNDS[event]
  if not (enabled and speaker and def) then return false end
  local t = nowMs()
  if t - lastAny < MIN_GAP_MS then
    -- too close to the previous sound: play it right after instead of losing it
    schedule({ at = lastAny + MIN_GAP_MS, event = event, vol = volScale, pitch = pitchScale })
    return false
  end
  lastAny = t
  local volume = math.min(3, def[2] * (volScale or 1))
  local pitch = math.max(0.5, math.min(2, def[3] * (pitchScale or 1)))
  local ok, played = pcall(speaker.playSound, def[1], volume, pitch)
  return ok and played
end

--- Play an event after delayMs. The main loop calls pump() to play what is due.
function M.later(event, delayMs, volScale, pitchScale)
  schedule({ at = nowMs() + delayMs, event = event, vol = volScale, pitch = pitchScale })
end

function M.pump()
  local t = nowMs()
  while pending[1] and pending[1].at <= t do
    local item = table.remove(pending, 1)
    M.play(item.event, item.vol, item.pitch)
  end
end

--- A few events that are always several sounds.
function M.cue(name)
  if name == "win" then
    M.play("win")
    M.later("winFanfare", 450)
    M.later("rank", 1100, 0.6)
  elseif name == "start" then
    M.play("start")
    M.later("tap", 400, 0.8, 0.8)
  else
    M.play(name)
  end
end

return M
