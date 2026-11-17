# Write a test

A test file is plain Lua that calls the `ccunit` harness. It runs in a fresh computer:

```lua
ccunit.test("addition", function() ccunit.eq(1 + 1, 2) end)
ccunit.test("raises on bad argument", function()
  ccunit.raises(function() error("boom") end, "boom")
end)
```

Every `*.test.lua` shows in the Testing view with its tests. Run them from there, the gutter, or **Run test** above
each test. `name.test.lua` runs
in `name.world.json` when there is one.

The same tests run in a terminal or CI with `npx craftos-mcp test`.
