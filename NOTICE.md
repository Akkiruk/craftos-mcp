# Third-party notices

- **CraftOS-PC 2** (`engine/`): MIT, copyright JackMacWindows. See `engine/LICENSE` and `engine/UPSTREAM.md`. Its
  speaker note samples are CC BY 3.0 or public domain, as credited in `engine/src/peripheral/speaker_sounds.cpp`.
- **craftos2-lua** (`engine/craftos2-lua/`): Lua 5.2 fork, MIT.
- **CC:Tweaked**: not included. `scripts/build-rom.mjs` builds the ROM on your machine from the CC:Tweaked jar,
  which is under the ComputerCraft Public License, and adds a five-line hook to its `startup.lua` there.
- **Minecraft and Forge data** (`rom-overlay/rom/ccsim/turtle/data/`): block, item, tag, recipe and loot-table
  identifiers and values extracted from Minecraft 1.18.2, Forge 40.2.21 and CC:Tweaked 1.101.3 by
  `tools/turtledata/extract.py`, for interoperability. Minecraft is a trademark of Mojang. Not an official
  Minecraft product, not approved by or associated with Mojang or Microsoft.
- **Advanced Peripherals**, **Mekanism**, **Mekanism Generators**, **Create**, **Create Crafts & Additions**,
  **Bigger Reactors** and **Extreme Reactors**: not included. Their computer peripherals are reimplemented in Lua from
  their public source code and documentation, for interoperability.
- **Tom's Peripherals** (MIT, tom5454): its GPU drawing is reimplemented in Lua from its source. Its font files are
  not included; `scripts/build-toms-fonts.mjs` builds them on your machine from the mod's jar.
