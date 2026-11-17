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

Type `ccworld` in a JSON file for a bigger one, with a chest and a battery.
