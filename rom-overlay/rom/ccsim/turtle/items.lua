-- ccsim turtle items: the parts of an item the jars' data files do not say (stack size, durability, furnace fuel),
-- written from Minecraft 1.18.2 (Items, Item.Properties, AbstractFurnaceBlockEntity.getFuel). A world can override
-- any item in world.gameData.maxCount / maxDamage / fuel (burn time in ticks).
return function(data, extra)
  local M = {}
  extra = extra or {}

  local function set(list)
    local t = {}
    for _, id in ipairs(list) do t["minecraft:" .. id] = true end
    return t
  end

  local SIXTEEN = set({ "ender_pearl", "snowball", "egg", "bucket", "armor_stand", "honey_bottle", "oak_sign", "spruce_sign",
    "birch_sign", "jungle_sign", "acacia_sign", "dark_oak_sign", "crimson_sign", "warped_sign" })
  local ONE = set({ "water_bucket", "lava_bucket", "milk_bucket", "powder_snow_bucket", "pufferfish_bucket", "salmon_bucket",
    "cod_bucket", "tropical_fish_bucket", "axolotl_bucket", "potion", "splash_potion", "lingering_potion", "saddle",
    "minecart", "chest_minecart", "furnace_minecart", "tnt_minecart", "hopper_minecart", "command_block_minecart",
    "cake", "writable_book", "written_book", "enchanted_book", "totem_of_undying", "mushroom_stew", "rabbit_stew",
    "beetroot_soup", "suspicious_stew", "knowledge_book", "debug_stick", "spyglass", "bundle", "iron_horse_armor",
    "golden_horse_armor", "diamond_horse_armor", "leather_horse_armor", "flower_banner_pattern", "creeper_banner_pattern", "skull_banner_pattern", "mojang_banner_pattern",
    "globe_banner_pattern", "piglin_banner_pattern" })

  local DURABILITY = {}
  do
    local tiers = { wooden = 59, stone = 131, iron = 250, golden = 32, diamond = 1561, netherite = 2031 }
    for tier, uses in pairs(tiers) do
      for _, tool in ipairs({ "sword", "shovel", "pickaxe", "axe", "hoe" }) do DURABILITY["minecraft:" .. tier .. "_" .. tool] = uses end
    end
    -- ArmorMaterials durability multiplier x {13, 15, 16, 11} for helmet, chestplate, leggings, boots
    local armor = { leather = 5, chainmail = 15, iron = 15, golden = 7, diamond = 33, netherite = 37 }
    local base = { helmet = 11, chestplate = 16, leggings = 15, boots = 13 }
    for material, mult in pairs(armor) do
      for piece, b in pairs(base) do DURABILITY["minecraft:" .. material .. "_" .. piece] = b * mult end
    end
    DURABILITY["minecraft:turtle_helmet"] = 275
    for id, uses in pairs({ shears = 238, fishing_rod = 64, flint_and_steel = 64, bow = 384, crossbow = 465, trident = 250,
      shield = 336, elytra = 432, carrot_on_a_stick = 25, warped_fungus_on_a_stick = 100 }) do
      DURABILITY["minecraft:" .. id] = uses
    end
  end

  function M.maxDamage(id)
    local over = extra.maxDamage and extra.maxDamage[id]
    if over ~= nil then return over end
    return DURABILITY[id] or 0
  end

  local function banner(id) return id:match("^minecraft:.+_banner$") ~= nil end
  local function bed(id) return id:match("^minecraft:.+_bed$") ~= nil end
  local function boat(id) return id:match("^minecraft:.+_boat$") ~= nil end
  local function disc(id) return id:match("^minecraft:music_disc_") ~= nil end
  local function shulker(id) return id:match("^minecraft:.*shulker_box$") ~= nil end

  function M.maxCount(id)
    local over = extra.maxCount and extra.maxCount[id]
    if over ~= nil then return over end
    if M.maxDamage(id) > 0 then return 1 end
    if ONE[id] or bed(id) or boat(id) or disc(id) or shulker(id) then return 1 end
    if SIXTEEN[id] or banner(id) then return 16 end
    -- CC:Tweaked: pocket computers and floppy disks are one per slot (ItemPocketComputer, ItemDisk, ItemTreasureDisk)
    if id:match("^computercraft:pocket_computer") or id == "computercraft:disk" or id == "computercraft:treasure_disk" then
      return 1
    end
    return 64
  end

  -- AbstractFurnaceBlockEntity.getFuel, burn time in ticks
  local FUEL_ITEMS = {
    lava_bucket = 20000, coal_block = 16000, blaze_rod = 2400, coal = 1600, charcoal = 1600, note_block = 300,
    bookshelf = 300, lectern = 300, jukebox = 300, chest = 300, trapped_chest = 300, crafting_table = 300,
    daylight_detector = 300, bow = 300, fishing_rod = 300, ladder = 300, wooden_shovel = 200, wooden_sword = 200,
    wooden_hoe = 200, wooden_axe = 200, wooden_pickaxe = 200, stick = 100, bowl = 100, dried_kelp_block = 4001,
    crossbow = 300, bamboo = 50, dead_bush = 100, scaffolding = 50, loom = 300, barrel = 300, cartography_table = 300,
    fletching_table = 300, smithing_table = 300, composter = 300, azalea = 100, flowering_azalea = 100,
  }
  local FUEL_TAGS = {
    { "minecraft:logs", 300 }, { "minecraft:planks", 300 }, { "minecraft:wooden_stairs", 300 },
    { "minecraft:wooden_slabs", 150 }, { "minecraft:wooden_trapdoors", 300 }, { "minecraft:wooden_pressure_plates", 300 },
    { "minecraft:wooden_fences", 300 }, { "minecraft:fence_gates", 300 }, { "minecraft:banners", 300 },
    { "minecraft:signs", 200 }, { "minecraft:wooden_doors", 200 }, { "minecraft:boats", 1200 }, { "minecraft:wool", 100 },
    { "minecraft:wooden_buttons", 100 }, { "minecraft:saplings", 100 }, { "minecraft:carpets", 67 },
  }

  --- Furnace burn time in ticks (0: not a fuel).
  function M.burnTime(id)
    local over = extra.fuel and extra.fuel[id]
    if over ~= nil then return over end
    local plain = id:match("^minecraft:(.+)$")
    if plain and FUEL_ITEMS[plain] then return FUEL_ITEMS[plain] end
    -- crimson and warped wood never burn (ItemTags.NON_FLAMMABLE_WOOD)
    if data.itemHasTag(id, "minecraft:non_flammable_wood") then return 0 end
    local best = 0
    for _, entry in ipairs(FUEL_TAGS) do
      if data.itemHasTag(id, entry[1]) then best = entry[2] end
    end
    return best
  end

  --- What is left in the slot after burning one: a lava bucket leaves its bucket.
  function M.burnRemainder(id)
    if id == "minecraft:lava_bucket" then return "minecraft:bucket" end
    return nil
  end

  return M
end
