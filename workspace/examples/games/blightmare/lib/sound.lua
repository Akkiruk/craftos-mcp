-- lib/sound.lua
-- Part of the craftos-mcp examples (MIT).
-- Every sound in the game, by name, and the speaker that plays them. All are vanilla Minecraft sounds (1.18.2 and later),
-- so a sound changes here and nowhere else. With no speaker attached every call quietly does nothing, so the game plays the
-- same without one. A speaker takes one sound per game tick (50 ms) and refuses a second, so a sound asked for too soon
-- after the last is played a moment later instead of being lost.

local M = {}

-- name = { Minecraft sound event, volume, pitch }
M.SOUNDS = {
  -- the shell: menus, the opening and the ready screen
  tap = { "minecraft:block.wooden_button.click_on", 0.7, 1.2 },
  select = { "minecraft:block.note_block.xylophone", 0.7, 1 },
  back = { "minecraft:block.wooden_button.click_off", 0.7, 1 },
  error = { "minecraft:block.note_block.didgeridoo", 0.7, 0.8 },
  start = { "minecraft:item.trident.return", 0.7, 1 },
  page = { "minecraft:item.book.page_turn", 0.7, 1 },
  win = { "minecraft:entity.player.levelup", 0.7, 1 },
  winFanfare = { "minecraft:ui.toast.challenge_complete", 0.6, 1 },
  rank = { "minecraft:entity.experience_orb.pickup", 0.7, 0.8 },

  -- menus inside the game
  ui_tap = { "minecraft:block.wooden_button.click_on", 0.6, 1.4 },
  ui_page = { "minecraft:item.book.page_turn", 0.7, 1 },

  -- walking about
  step = { "minecraft:block.stone.step", 0.7, 1 },
  wall = { "minecraft:block.stone.hit", 0.8, 0.8 },
  door_open = { "minecraft:block.wooden_door.open", 0.8, 0.9 },
  unlock = { "minecraft:block.iron_door.open", 0.7, 1.2 },
  chest = { "minecraft:block.chest.open", 0.7, 1 },
  coin = { "minecraft:block.chain.place", 0.7, 1.8 },
  pickup = { "minecraft:entity.item.pickup", 0.7, 1 },
  save = { "minecraft:block.respawn_anchor.charge", 0.6, 1.2 },
  level_clear = { "minecraft:ui.toast.challenge_complete", 0.6, 1 },
  horn = { "minecraft:event.raid.horn", 0.5, 1 },
  crush = { "minecraft:block.anvil.land", 0.6, 0.6 },
  cave_in = { "minecraft:entity.generic.explode", 0.6, 0.5 },

  -- fights
  battle = { "minecraft:entity.ravager.roar", 0.5, 1.3 },
  sword_hit = { "minecraft:entity.player.attack.knockback", 0.7, 1 },
  miss = { "minecraft:entity.player.attack.nodamage", 0.7, 1 },
  block = { "minecraft:item.shield.block", 0.7, 1 },
  player_hurt = { "minecraft:entity.player.hurt", 0.7, 1 },
  death = { "minecraft:entity.player.death", 0.7, 1 },
  spell = { "minecraft:entity.illusioner.mirror_move", 0.7, 1 },
  heal = { "minecraft:block.beacon.power_select", 0.6, 1.5 },
  powerup = { "minecraft:block.beacon.activate", 0.6, 1.4 },
  curse = { "minecraft:block.bell.resonate", 0.7, 1 },
  sting = { "minecraft:entity.bee.sting", 0.7, 1 },
  telegraph = { "minecraft:entity.evoker.prepare_summon", 0.7, 1 },
  flee = { "minecraft:entity.parrot.fly", 0.7, 1 },
  level_up = { "minecraft:entity.player.levelup", 0.7, 1 },
  win_big = { "minecraft:ui.toast.challenge_complete", 0.7, 1 },
  lose = { "minecraft:block.beacon.deactivate", 0.7, 1 },
  monster_hurt = { "minecraft:entity.zombie.hurt", 0.6, 0.8 },
  monster_die = { "minecraft:entity.husk.death", 0.7, 1 },

  -- monsters, by kind: what they sound like attacking, hurt and dying
  mon_rat_attack = { "minecraft:entity.fox.bite", 0.7, 1 },
  mon_rat_hurt = { "minecraft:entity.rabbit.hurt", 0.7, 1 },
  mon_rat_die = { "minecraft:entity.rabbit.death", 0.7, 1 },
  mon_bat_attack = { "minecraft:entity.bat.ambient", 0.7, 1 },
  mon_bat_hurt = { "minecraft:entity.bat.hurt", 0.7, 1 },
  mon_bat_die = { "minecraft:entity.bat.death", 0.7, 1 },
  mon_slime_attack = { "minecraft:entity.slime.hurt", 0.7, 1 },
  mon_slime_hurt = { "minecraft:entity.slime.squish", 0.7, 1 },
  mon_slime_die = { "minecraft:entity.drowned.death_water", 0.7, 1 },
  mon_bug_attack = { "minecraft:entity.spider.ambient", 0.7, 1.2 },
  mon_bug_hurt = { "minecraft:entity.silverfish.hurt", 0.7, 1 },
  mon_bug_die = { "minecraft:entity.spider.death", 0.7, 1 },
  mon_harpy_attack = { "minecraft:entity.phantom.bite", 0.3, 1.26 },
  mon_harpy_hurt = { "minecraft:entity.phantom.hurt", 0.3, 0.53 },
  mon_harpy_die = { "minecraft:entity.phantom.death", 0.8, 1.498 },
  mon_frog_attack = { "minecraft:entity.axolotl.attack", 0.8, 1 },
  mon_frog_hurt = { "minecraft:entity.axolotl.hurt", 0.4, 0.5 },
  mon_frog_die = { "minecraft:entity.axolotl.death", 0.4, 1 },
  mon_skeleton_attack = { "minecraft:entity.skeleton.ambient", 0.4, 1 },
  mon_skeleton_hurt = { "minecraft:entity.skeleton.hurt", 0.4, 1 },
  mon_skeleton_die = { "minecraft:entity.skeleton.death", 0.4, 0.5 },
  mon_ghost_attack = { "minecraft:entity.vex.charge", 0.4, 1 },
  mon_ghost_hurt = { "minecraft:entity.vex.hurt", 1, 0.5 },
  mon_ghost_die = { "minecraft:entity.vex.death", 1, 0.8 },
  mon_orc_attack = { "minecraft:entity.piglin_brute.angry", 0.5, 0.561 },
  mon_orc_hurt = { "minecraft:entity.piglin_brute.hurt", 0.5, 1 },
  mon_orc_die = { "minecraft:entity.piglin_brute.death", 0.5, 1 },
  mon_knight_attack = { "minecraft:entity.horse.armor", 0.5, 1 },
  mon_knight_hurt = { "minecraft:entity.iron_golem.damage", 0.5, 1 },
  mon_knight_die = { "minecraft:entity.glow_squid.death", 0.5, 1 },
  mon_mage_attack = { "minecraft:entity.evoker.cast_spell", 0.5, 1 },
  mon_mage_hurt = { "minecraft:entity.evoker.hurt", 0.5, 1 },
  mon_mage_die = { "minecraft:entity.illusioner.death", 0.5, 1 },
  mon_stalker_attack = { "minecraft:entity.ravager.attack", 0.5, 1.2 },
  mon_stalker_hurt = { "minecraft:entity.stray.hurt", 0.5, 1 },
  mon_stalker_die = { "minecraft:entity.stray.death", 0.5, 1 },
  mon_staff_attack = { "minecraft:entity.evoker.ambient", 0.5, 1 },
  mon_staff_hurt = { "minecraft:entity.pillager.hurt", 0.5, 1 },
  mon_staff_die = { "minecraft:entity.vindicator.death", 0.5, 1 },
  mon_blighted_attack = { "minecraft:entity.zombie.ambient", 0.5, 1 },
  mon_blighted_hurt = { "minecraft:entity.zombie_villager.hurt", 0.5, 1 },
  mon_blighted_die = { "minecraft:entity.zombie_villager.death", 0.5, 1 },
  mon_roper_attack = { "minecraft:entity.fishing_bobber.retrieve", 0.6, 0.8 },
  mon_roper_hurt = { "minecraft:entity.squid.hurt", 0.5, 1 },
  mon_roper_die = { "minecraft:entity.squid.death", 0.5, 1 },
  mon_dragon_attack = { "minecraft:entity.ender_dragon.shoot", 0.5, 1 },
  mon_dragon_hurt = { "minecraft:entity.ender_dragon.hurt", 0.5, 1 },
  mon_dragon_die = { "minecraft:entity.ender_dragon.death", 0.5, 1 },
  mon_boss_attack = { "minecraft:entity.wither.shoot", 0.5, 0.8 },
  mon_boss_hurt = { "minecraft:entity.wither.hurt", 0.5, 1 },
  mon_boss_die = { "minecraft:entity.wither.death", 0.5, 1 },

  -- the opening: music under each movement, then the moments in it
  intro_music_legend = { "minecraft:music.nether.crimson_forest", 0.7, 1 },
  intro_music_map = { "minecraft:music.overworld.lush_caves", 0.7, 1 },
  intro_music_dread = { "minecraft:ambient.nether_wastes.loop", 0.7, 1 },
  intro_music_town = { "minecraft:music.overworld.dripstone_caves", 0.7, 1 },
  intro_chain = { "minecraft:block.chain.place", 0.8, 0.6 },
  intro_god_fade = { "minecraft:block.bell.resonate", 0.7, 1 },
  intro_raven = { "minecraft:entity.phantom.flap", 0.7, 0.8 },
  intro_map_open = { "minecraft:item.book.page_turn", 0.7, 1 },
  intro_label = { "minecraft:block.note_block.hat", 0.6, 1.6 },
  intro_empire_glow = { "minecraft:block.amethyst_block.chime", 0.7, 1 },
  intro_nightmare = { "minecraft:ambient.soul_sand_valley.mood", 0.7, 1 },
  intro_candle_out = { "minecraft:block.candle.extinguish", 0.7, 1 },
  intro_sting_blightmare = { "minecraft:ambient.cave", 0.7, 1 },
  intro_wall_course = { "minecraft:block.polished_deepslate.place", 0.7, 1 },
  intro_wall_done = { "minecraft:block.end_portal_frame.fill", 0.7, 0.5 },
  intro_refugees = { "minecraft:block.gravel.step", 0.7, 0.8 },
  intro_dusk = { "minecraft:ambient.warped_forest.mood", 0.6, 1 },
  intro_lamp = { "minecraft:item.flintandsteel.use", 0.7, 1 },
  intro_book = { "minecraft:item.book.put", 0.7, 1 },
  intro_window = { "minecraft:block.wooden_trapdoor.close", 0.7, 1 },
  intro_dream_rise = { "minecraft:block.amethyst_block.chime", 0.7, 1 },
  intro_grey = { "minecraft:entity.glow_squid.ambient", 0.7, 1 },
  intro_knock = { "minecraft:block.wood.place", 0.7, 1 },
  intro_door = { "minecraft:block.wooden_door.open", 0.8, 0.7 },
  intro_sting_one = { "minecraft:entity.elder_guardian.curse", 0.4, 0.8 },
  intro_title = { "minecraft:block.end_portal.spawn", 0.4, 0.8 },
  intro_bell = { "minecraft:block.bell.use", 0.7, 1 },
}

local speaker = nil
local enabled = true
local pending = {} -- { at = ms, name, vol, pitch }, soonest first
local lastAt = -1e9
local music = nil  -- the name of the music playing, if any
local MIN_GAP_MS = 60

local function nowMs() return os.epoch("utc") end

--- Use this speaker (a wrapped peripheral), or nil for silence.
function M.init(sp)
  speaker = sp
  pending = {}
end

--- Sound on or off.
function M.setEnabled(on) enabled = on and true or false end

local function queue(item)
  pending[#pending + 1] = item
  table.sort(pending, function(a, b) return a.at < b.at end)
end

--- Play a named sound now, scaled in volume and pitch. Returns true if the speaker took it.
function M.play(name, volScale, pitchScale)
  local def = M.SOUNDS[name]
  if not speaker or not enabled or not def then return false end
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

--- Music under a scene: whatever was playing stops first, and nil only stops it. A speaker's stop silences everything it
--- is playing, so the game starts music where nothing short is due.
function M.music(name)
  if music and speaker and speaker.stop then pcall(speaker.stop) end
  music = nil
  if name and M.SOUNDS[name] then
    music = name
    lastAt = -1e9 -- the stop has cleared the speaker, so the music needn't wait its turn
    M.play(name)
  end
end

--- A few sounds a little apart, for the shell's big moments.
function M.cue(name)
  if name == "start" then
    M.play("start")
    M.later("tap", 400, 0.8, 0.8)
  elseif name == "win" then
    M.play("win")
    M.later("winFanfare", 450)
  else
    M.play(name)
  end
end

return M
