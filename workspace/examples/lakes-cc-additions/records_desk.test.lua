-- records_desk.lua on a scanner holding a folder (records_desk.world.json), then every scanner method.
local T, eq, ok = ccunit.test, ccunit.eq, ccunit.truthy
local s = peripheral.wrap("top")
local function err(fn, ...)
  local okc, e = pcall(fn, ...)
  if okc then error("expected an error", 2) end
  return (tostring(e):gsub("^pcall: ", ""):gsub("^[^:]*:%d+: ", ""))
end
local lines = {}
local function run(...)
  local env = setmetatable({ print = function(t) lines[#lines + 1] = t end }, { __index = _ENV })
  return assert(loadfile("examples/lakes-cc-additions/records_desk.lua", nil, env))(...)
end

T("the desk reads the folder and files a summary", function()
  run()
  eq(lines, { "1 document read", "summary filed" })
  local docs = s.scanFolder()
  eq(#docs, 3)
  eq({ docs[3].slot, docs[3].type, docs[3].title }, { 3, "page", "Summary" })
  eq(s.scanPrintout(3).pages[1].text[2], ("Witness: Saw a creeper at"):sub(1, 25))
end)

T("item, NBT, fingerprint, sha256", function()
  eq(s.hasItem(), true)
  eq(s.getItem(), { name = "lakescanner:folder", count = 1, displayName = "Case 42" })
  local nbt = s.scanNBT()
  eq(nbt.nbt.Items[1].Slot, 0)
  eq(nbt.nbt.Items[1].tag.Title, "Witness")
  eq(#s.fingerprint(), 64)
  eq(s.sha256("\233"), "4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c") -- the char's UTF-8 bytes
  eq(err(s.sha256), "bad argument #1 (string expected, got nil)")
end)

T("printouts: pages, padding, folder slots and their errors", function()
  local p = s.scanPrintout(1)
  eq({ p.type, p.title, p.pageCount, p.width, p.height }, { "page", "Witness", 1, 25, 21 })
  eq(p.pages[1].text[1], "Saw a creeper at dusk    ")
  eq(p.pages[1].color[1], ("f"):rep(25))
  eq(err(s.scanPrintout, 2), "Item is not a printout") -- slot 2 is paper
  eq(err(s.scanPrintout, 9), "Folder slot 9 is empty")
  eq(err(s.scanPrintout, 28), "Folder slot out of range (1-27)")
  eq(s.countInk(0, 0, 172, 209, 1, 1), { total = 0, dark = 0, red = 0, blue = 0 })
  eq(err(s.countInk, 0, 0), "bad argument #3 (number expected, got nil)")
end)

T("what a folder is not", function()
  eq(err(s.scanContainer), "Item has no container contents")
  eq(err(s.scanStamp), "Item is not a stamp")
  eq(err(s.scanBook), "Item is not a book and quill or written book")
  eq(err(s.scanMap), "Item is not a filled map")
  eq(err(s.scanMapPixels), "Item is not a filled map")
  eq(err(s.scanMapForMonitor), "Item is not a filled map")
  eq(err(s.scanMapTile), "Item is not a filled map")
  eq(err(s.scanPhoto), "The Exposure mod is not installed")
  eq(err(s.scanPhotoForMonitor), "The Exposure mod is not installed")
  eq(err(s.scanPhotoForPrint), "The Exposure mod is not installed")
  eq(err(s.createPrintout, {}), "No pages given")
  eq(err(s.createPrintout, { {} }), "Page 1 has no text table")
  eq(err(s.createPrintout), "bad argument #1 (table expected, got nil)")
end)

T("the method list", function()
  eq(#peripheral.getMethods("top"), 19)
  eq(peripheral.getType("top"), "scanner")
end)
