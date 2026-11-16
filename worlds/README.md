# Worlds

A world file is the simulated surroundings of a computer: players, inventories, peripherals from other mods, a
turtle's block world. Pass one by name with `worldFile` (for example `worldFile: "advanced-peripherals-demo"`), or
give the same JSON inline as `world`.

| World                            | Shows                                                                                     | Addons                            |
| -------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------- |
| `generic-storage-demo.json`      | Blocks with CC's generic inventory, fluid and energy peripherals, levels moving over time | none                              |
| `advanced-peripherals-demo.json` | One of every Advanced Peripherals block, with fixtures                                    | `advanced-peripherals`            |
| `mekanism-qio-demo.json`         | A QIO network with drives, a dashboard, an importer, an exporter and an entangloporter    | `mekanism`                        |
| `mekanism-multiblocks-demo.json` | Fission reactor, boiler, turbine, induction matrix and fusion reactor                     | `mekanism`, `mekanism-generators` |
| `create-demo.json`               | Train stations, gauges, a display link and Crafts & Additions blocks                      | `create`, `create-additions`      |
| `toms-peripherals-demo.json`     | A GPU on a monitor wall, keyboard, redstone port and watchdog                             | `toms-peripherals`                |
| `bigger-reactors-demo.json`      | A Bigger Reactors reactor and turbine                                                     | `bigger-reactors`                 |
| `extreme-reactors-demo.json`     | An Extreme Reactors reactor and turbine                                                   | `extreme-reactors`                |

A world that uses an addon that is switched off fails before the computer boots. Each mod's world format is in its
doc under `docs/`.
