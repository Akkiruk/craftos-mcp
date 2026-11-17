-- A records desk: the scanner holds a case folder. The desk lists what is filed in it, reads every printout and
-- files a one-page summary back into the folder.
local scanner = peripheral.find("scanner")
if not scanner or not scanner.hasItem() then error("put a folder in the scanner", 0) end

local summary = {}
for _, doc in ipairs(scanner.scanFolder()) do
  if doc.type == "page" or doc.type == "pages" then
    local printout = scanner.scanPrintout(doc.slot)
    local first = printout.pages[1].text[1]:gsub("%s+$", "")
    summary[#summary + 1] = (doc.title or "untitled") .. ": " .. first
  end
end
print(("%d document%s read"):format(#summary, #summary == 1 and "" or "s"))

local text = { "Summary" }
for _, line in ipairs(summary) do text[#text + 1] = line:sub(1, 25) end
scanner.createPrintout({ { text = text } }, "Summary")
print("summary filed")
