# Give it a world

A world file sits next to the program with the same name: `clock.lua` runs in `clock.world.json`.

```json
{
  "addons": ["advanced-peripherals"],
  "monitors": [{ "name": "top", "blocksWide": 3, "blocksHigh": 2 }],
  "players": [{ "name": "Alice", "x": 2, "y": 64, "z": 0 }],
  "peripherals": [
    {
      "name": "playerDetector_0",
      "type": "playerDetector",
      "x": 0,
      "y": 64,
      "z": 0
    }
  ]
}
```

A world file opens in the **World Editor**: the computer with what is on each side, the blocks on its network, the
players and a map. Pick a block to edit it, and **Show Text** for the JSON. Every change is an ordinary edit to the
file, so undo and source control work as usual.

Type `ccworld` in the JSON for a bigger one, with a chest and a battery.
