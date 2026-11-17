-- Runs courier.lua in courier.world.json and checks that both stacks ended up in the other chest.

ccunit.test("the courier empties one chest into the other", function()
  local ok = shell.run("examples/cc-androids/courier.lua")
  ccunit.eq(ok, true)

  -- it stands by the source chest when it finds it empty; the other chest is 8 blocks away, in reach
  local from = android.getContainerInfo(4, 64, 0)
  for i = 1, from.slotCount do ccunit.eq(from.slots[i][2], 0) end
  local to = android.getContainerInfo(-4, 64, 0)
  ccunit.eq(to.slots[1], { "translation{key='item.minecraft.coal', args=[]}", 16 })
  ccunit.eq(to.slots[2], { "translation{key='item.minecraft.iron_ingot', args=[]}", 5 })

  ccunit.eq({ android.getHandInfo("main") }, { "Air", 0 })
  local fuel = android.fuelLevel()
  ccunit.truthy(fuel > 40 and fuel < 80, "80 fuel from 8 redstone, less a second's worth for each second walked: " .. fuel)
end)
