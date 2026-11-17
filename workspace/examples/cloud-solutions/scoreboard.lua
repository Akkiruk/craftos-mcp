-- Scoreboard: keeps players' best scores in the owner's KV storage (shared by every computer of that player) and
-- announces each new record on a Crafka topic. Run it with a player name and a score: scoreboard Steve 120

local kv = peripheral.find("kv_storage")
local broker = peripheral.find("crafka_broker")
local name, score = ...
score = tonumber(score)
if not (name and score) then error("usage: scoreboard <player> <score>", 0) end

local key = "score." .. name
local best = tonumber(kv.get(key))
if best == nil or score > best then
  assert(kv.put(key, tostring(score)))
  kv.incr("records")
  if broker then
    broker.createTopic("records") -- nil and "Such topic already exists" after the first time
    broker.publish("records", ("%s set a record: %d"):format(name, score))
  end
  print(("New record for %s: %d"):format(name, score))
else
  print(("%s's best is still %d"):format(name, best))
end

print("Top scores:")
local rows = {}
for _, k in ipairs(kv.list("score.%")) do
  rows[#rows + 1] = { k:sub(7), tonumber(kv.get(k)) }
end
table.sort(rows, function(a, b) return a[2] > b[2] end)
for i, row in ipairs(rows) do print(("%d. %s %d"):format(i, row[1], row[2])) end
