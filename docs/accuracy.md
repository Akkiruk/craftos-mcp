# How exact is it

Everything here aims at one thing: a program that works in the emulator works on a real server, and one that breaks
there breaks here too, with the same message. Any difference from the real game is a bug, however small. Report one
with the "Differs from the real game" issue template.

There are three levels of evidence, best first:

1. **Measured in game.** A probe program ran on a real computer in Minecraft (singleplayer and a dedicated server,
   CC:Tweaked 1.101.3 on Forge 1.18.2) and in the emulator, and the answers were compared value by value.
2. **CC:Tweaked's own tests.** The engine runs CC:Tweaked's test suite from the matching tag.
3. **Written from source and checked against the jar.** The mod's source at the version in question was followed line
   by line, and the method names, argument checks, error messages and method order were confirmed against the
   released jar with `javap`. Behaviour no one has measured in game yet.

## By area

| Area                                                                                                 | Evidence                                                                                        | Details                                                                              |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Lua, `fs`, `os`, `term`, `http`, `textutils` and the rest of CC's APIs                               | 2: 1189 of 1191 of CC:Tweaked's tests pass (the two failures are explained)                     | [conformance](conformance/README.md)                                                 |
| Monitors, speakers, timers, events, the 256-event queue                                              | 1: measured in game                                                                             |                                                                                      |
| Wireless, ender and wired modems, rednet, ranges, wired names                                        | 1: 234 of 234 measured values match                                                             |                                                                                      |
| Turtles: movement, digging, placing, tick timing, crafting, fuel                                     | 3, from CC:Tweaked's source, with block data from the real game jars                            | [turtle.md](turtle.md)                                                               |
| Inventories, `fluid_storage`, `energy_storage`                                                       | Chests: 1. Fluid and energy: 3                                                                  | [generic-storage.md](generic-storage.md)                                             |
| Advanced Peripherals 0.7.31r: detectors, chat box, integrator, NBT storage, AR controller            | 1: measured in game                                                                             | [advanced-peripherals.md](advanced-peripherals.md)                                   |
| Advanced Peripherals: ME and RS bridges, geo scanner, block reader, inventory manager, chunky turtle | 3                                                                                               | [advanced-peripherals.md](advanced-peripherals.md)                                   |
| Mekanism 10.2.5: QIO and the entangloporter                                                          | 3                                                                                               | [mekanism-qio.md](mekanism-qio.md)                                                   |
| Mekanism and Mekanism Generators: reactors, turbine, boiler, matrix, machines, factories             | 3                                                                                               | [mekanism-multiblocks.md](mekanism-multiblocks.md)                                   |
| Create 0.5.1.i and Create Crafts & Additions 1.0.0                                                   | 3                                                                                               | [create.md](create.md), [create-additions.md](create-additions.md)                   |
| Tom's Peripherals 1.18.2-1.2.1                                                                       | 3; GPU drawing pixel-exact against the source, PNG output byte-exact against the game's encoder | [toms-peripherals.md](toms-peripherals.md)                                           |
| Bigger Reactors and Extreme Reactors                                                                 | 3; the physics matches a second, independent port of the Java to 14 digits                      | [bigger-reactors.md](bigger-reactors.md), [extreme-reactors.md](extreme-reactors.md) |

## What is a fixture instead of a simulation

Some mechanics are too large to copy whole, so the world file states them and the mod's computer methods report them
exactly:

- Create's stress network and track graph: gauges read the speeds and stress you give, trains run straight track at
  the distances you give.
- Multiblock formation (Mekanism, the reactor mods): the world says the structure is formed and how big it is.
- Recipes: a machine turns the input you name into the output you name.
- Pipes and cables: fixed rates between named blocks.

Each mod's doc ends with a list of what is not simulated or not confirmed yet. Those lists are the honest edge of
this table: if your program depends on something there, test it in game too.

## Timing

The emulator runs on the real clock, 50 ms to a server tick, and every peripheral call that waits for the server
thread in the real game waits for the next tick here, losing the events that arrive meanwhile, as real programs do.
`timeScale` speeds the clock up and `advance` jumps it, and the machines of every mod catch up tick by tick, so a
reactor left alone for an hour of game time behaves as it would have.
