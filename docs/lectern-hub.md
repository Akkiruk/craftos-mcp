# CC: Lectern Hub 1.0.0-1.115.0 emulation

Addon id `lectern-hub`. Lua in `rom-overlay/rom/ccsim/addons/lectern-hub/init.lua`.

Source of truth: [github.com/minecraftbossdj/CC-Lectern-Hub](https://github.com/minecraftbossdj/CC-Lectern-Hub) at
commit `566ba01`, the source of the only release (`1.0.0-1.115.0`, Forge, Minecraft 1.20.1, built against CC:Tweaked
1.115.0). Paths below are under `src/main/java/com/awesoft/lectern_hub/`. What the pocket computer does when told to
start or stop is CC:Tweaked 1.121.0's (`Computer`, `ComputerExecutor`).

## Versions

| Minecraft | Mod release                                                   |
| --------- | ------------------------------------------------------------- |
| 1.20.1    | 1.0.0-1.115.0                                                 |
| 1.18.2    | none (CC:Tweaked 1.101.3 has no pocket computers on lecterns) |
| 1.21.1    | none                                                          |

## Peripheral

| Type         | Block                                       | Methods                                                   |
| ------------ | ------------------------------------------- | --------------------------------------------------------- |
| `cc_lectern` | CC:Tweaked's lectern (`CustomLecternBlock`) | turnOn, shutdown, reboot, getID, isOn, getLabel, isPocket |

`block/lectern/LecternPeripheralProvider` gives every `CustomLecternBlockEntity` the peripheral. CC:Tweaked only turns a
lectern into its own block while it holds a CC item: a pocket computer or a printout. An empty lectern, or one with a
book, is a vanilla lectern and no peripheral at all.

Every method is a plain `@LuaFunction` (no `mainThread`), so it answers at once. `peripheral.getMethods` is CC's
`HashMap` order: reboot, getLabel, turnOn, isPocket, isOn, getID, shutdown.

| Method       | Returns                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------- |
| `turnOn()`   | nothing. Asks the pocket to start (`Computer.turnOn` sets `startRequested`); it is on from the next server tick.    |
| `shutdown()` | nothing. The pocket stops; nothing happens when it is off.                                                          |
| `reboot()`   | nothing. An on pocket restarts and is on again; an off one stays off (`ComputerExecutor`: REBOOT returns when off). |
| `getID()`    | the pocket's computer ID; `-1` when the lectern holds a printout.                                                   |
| `isOn()`     | whether the pocket runs; `false` for a printout.                                                                    |
| `getLabel()` | the pocket's label, or one `nil` (no label, or a printout).                                                         |
| `isPocket()` | whether the item is a pocket computer.                                                                              |

No method takes arguments; extra ones are ignored, as for any Java method. No events. In `LecternPeripheral`, getID and
getLabel would throw a NullPointerException for a pocket with no `ServerComputer`; one sitting on a lectern always has
one (the lectern ticks it, which creates it), so that case does not come up here.

## Fixtures

```jsonc
{ "name": "left", "type": "cc_lectern", "pocket": { "id": 7, "label": "Scout", "on": false } }
{ "name": "right", "type": "cc_lectern", "item": "computercraft:printed_book" }
```

- `pocket`: the pocket computer on the lectern. `id` (default 1), `label` (default none), `on` (default false).
- `item`: without `pocket`, the printout on the lectern (default `computercraft:printed_page`). Only shown in sim state.

## Sim commands

| Command       | Fields                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------- |
| `lhSetPocket` | `peripheral, on?, label?, id?`: the pocket changes by other means (`label: false` clears it) |

Taking the item off, or putting one on, changes the block: use `detachPeripheral` / `attachPeripheral`.

`craftos_sim_state` `peripherals.<name>`: `{ pocket = { id, label, on }, starting }` or `{ item }`.

## Not emulated

- The hub itself: `mixin/CustomLecternBlockMixin` gives the pocket computer, while it sits on the lectern, the
  peripheral of a full-block wired modem under the lectern on its `bottom` side. That changes what a program on the
  pocket sees, not the computer driving the lectern. To test such a pocket program, use a `kind: "pocket"` world with
  that modem as a peripheral named `bottom`.
- The timing of a start or stop on the pocket's own computer thread: here `shutdown` takes effect at once and `turnOn`
  at the next 50 ms tick. In game both are queued and land a moment later.
