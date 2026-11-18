## Addons (other mods)

Every mod besides CC:Tweaked is an addon. Switch on only the ones the user's modpack has, so a program cannot come to
rely on a peripheral their server lacks: `world.addons` in a world file, `CRAFTOS_ADDONS` in the MCP server's
environment, `"addons"` in craftos.json, or `--addons` on the command line. Each takes addon ids (a list in JSON,
separated by commas elsewhere), `"all"` or `"none"`; with no setting at all, everything the Minecraft version has is
on. A peripheral of an addon that is off fails the world at boot and names the addon. `craftos_info` lists what is on
and `craftos_help` lists every id. An addon only runs on the Minecraft versions its mod came out for; a mod that also
came out for 1.18.2 behaves as its 1.18.2 version on 1.20.1 and 1.21.1 too, so `world.version: "1.18.2"` gives the
most complete simulation.

- Advanced Peripherals 0.7.31r (`advanced-peripherals`): player, energy and environment detectors, chat box, redstone
  integrator, NBT storage, AR controller, ME and RS bridges, from fixtures (`docs/advanced-peripherals.md`,
  `worlds/advanced-peripherals-demo.json`).
- Mekanism 10.2.5 (`mekanism`, `mekanism-generators`): QIO, the Quantum Entangloporter, machines and reactors
  (`docs/mekanism-qio.md`, `worlds/mekanism-qio-demo.json`).
- Create, Tom's Peripherals (GPU screens appear in screenshots), Bigger and Extreme Reactors each have a doc in
  `docs/` and a demo in `worlds/`. CC's own `energy_storage` and `fluid_storage` work on any block
  (`docs/generic-storage.md`).

vhcctweaks (github.com/Akkiruk/vhcctweaks, a server mod for Vault Hunters on Minecraft 1.18.2) is an addon that is
OFF by default and not part of "all": switch it on by naming `vhcctweaks` in world.addons / CRAFTOS_ADDONS /
craftos.json addons, or with `world.vhcctweaks: "2.2.36"` or `"2.2.37"` (`"2.2.35"` also accepted; `false` forces it
off). It needs `world.version: "1.18.2"`. It adds the `ccvault` API (player token balances, transfers with an approval
prompt, the computer's host), the `vhcc` sandboxed file store, lockdown, linked ender modems and the inventory
batch/watch methods; 2.2.37 adds player Gear Power/Temper/reputation/skills/stats reads, items inside container items
and `identify`. The 2.2.37 API is modelled from the mod's spec: identify's roll is the emulator's, not Vault Hunters'
(docs/vhcctweaks.md lists what is simulated and how faithfully).
