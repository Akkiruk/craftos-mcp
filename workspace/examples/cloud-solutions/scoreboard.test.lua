-- Runs scoreboard.lua against scoreboard.world.json (Minecraft 1.20.1), then calls every method of the KV storage,
-- the Crafka broker and the StatsD bridge: the happy path and the argument errors.

local function run(...)
  local printed = {}
  local realPrint = print
  _G.print = function(...)
    local parts = table.pack(...)
    for i = 1, parts.n do parts[i] = tostring(parts[i]) end
    printed[#printed + 1] = table.concat(parts, "\t")
  end
  shell.run("examples/cloud-solutions/scoreboard.lua", ...)
  _G.print = realPrint
  return table.concat(printed, "\n")
end

local function err(fn, ...)
  local ok, e = pcall(fn, ...)
  if ok then error("expected an error but the call succeeded", 2) end
  return (tostring(e):gsub("^pcall: ", ""):gsub("^[^:]*:%d+: ", ""))
end

local simCount = 0
local function sim(command)
  simCount = simCount + 1
  os.queueEvent("ccsim_cmd", ("sim:%d:%.0f"):format(simCount, os.epoch("utc")), textutils.serializeJSON(command))
end

--- the events that arrive within `seconds`, by name
local function collect(names, seconds, also)
  local got = {}
  local want = {}
  for _, n in ipairs(names) do want[n] = true end
  parallel.waitForAny(function()
    while true do
      local ev = table.pack(os.pullEvent())
      if want[ev[1]] then got[#got + 1] = ev end
    end
  end, function()
    if also then also() end
    sleep(seconds)
  end)
  return got
end

local kv = peripheral.wrap("kv_storage_0")
local orphan = peripheral.wrap("kv_storage_1")
local broker = peripheral.wrap("crafka_broker_0")
local statsd = peripheral.wrap("statsd_bridge_0")

ccunit.test("the scoreboard keeps records and announces them", function()
  local first = run("Steve", "120")
  ccunit.truthy(first:find("New record for Steve: 120", 1, true), first)
  ccunit.truthy(first:find("1. Alex 150\n2. Steve 120\n3. Bob 90", 1, true), first)
  local again = run("Steve", "100")
  ccunit.truthy(again:find("Steve's best is still 120", 1, true), again)
  ccunit.eq(kv.get("records"), "1.0")
  ccunit.eq(broker.fetchMessages("records", 1), { [1] = "Steve set a record: 120" })
end)

ccunit.test("KV: put, get, delete, lists and expiry", function()
  ccunit.eq({ kv.put("a", "1") }, { true })
  ccunit.eq(kv.get("a"), "1")
  ccunit.eq(kv.get("missing"), nil)
  ccunit.eq(kv.mput({ b = "2", c = 3 }), 2)
  ccunit.eq(kv.get("c"), "3.0") -- a number reaches the mod as a Double
  ccunit.eq(kv.mget({ "a", "b", "nope" }), { a = "1", b = "2" })
  ccunit.eq({ kv.mput({}) }, { false, "Where is values?" })
  ccunit.eq(kv.list("score.%"), { "score.Alex", "score.Bob", "score.Steve" })
  ccunit.eq(kv.list("SCORE.B_b"), { "score.Bob" }) -- LIKE ignores case
  ccunit.eq(kv.delete("a"), true)
  ccunit.eq(kv.get("a"), nil)
  ccunit.eq(kv.delete("never-there"), true)
  -- expiry is a whole second: +1 could leave a few ms before it passed, and the key was gone before the next call
  local soon = math.floor(os.epoch("utc") / 1000) + 2
  ccunit.eq(kv.put("temp", "x", soon), true)
  ccunit.eq(kv.get_ex("temp"), soon)
  ccunit.eq(kv.get_ex("b"), nil)
  ccunit.eq(kv.put_ex("b", soon + 100), true)
  ccunit.eq(kv.get_ex("b"), soon + 100)
  ccunit.eq(kv.put_ex("b"), true)
  ccunit.eq(kv.get_ex("b"), nil)
  while os.epoch("utc") / 1000 < soon + 0.1 do sleep(0.1) end -- until it has expired, however long the calls took
  ccunit.eq(kv.get("temp"), nil)
  ccunit.eq(kv.getConfiguration(), { keyLimit = 10240, valueLimit = 500000 })
end)

ccunit.test("KV: incr and decr do arithmetic in SQLite", function()
  ccunit.eq(kv.incr("n"), 1)
  ccunit.eq(kv.get("n"), "1.0")
  ccunit.eq(kv.incr("n", 2.5), 3.5)
  ccunit.eq(kv.decr("n", 0.5), 3)
  ccunit.eq(kv.get("n"), "3.0")
  kv.put("word", "12apples")
  ccunit.eq(kv.incr("word"), 13) -- CAST takes the number at the front
  kv.put("tiny", "0.1")
  ccunit.eq(kv.incr("tiny", 0.2), 0.3) -- REAL to TEXT keeps 15 digits
  ccunit.eq(kv.get("tiny"), "0.3")
end)

ccunit.test("KV: subscriptions and their events", function()
  ccunit.eq(kv.getSubscriptions("changed"), {})
  kv.subscribe("changed", "score\\..*")
  kv.subscribe("deleted", "temp|score\\.Bob")
  ccunit.eq(kv.getSubscriptions("changed"), { "score\\..*" })
  ccunit.eq(kv.getSubscriptions("deleted"), { "temp|score\\.Bob" })
  local got = collect({ "kv_storage_key_changed", "kv_storage_key_deleted" }, 0.3, function()
    kv.put("score.Zed", "5")
    kv.put("other", "1")
    kv.delete("score.Bob")
    sim({ cmd = "csPut", key = "score.Remote", value = "7" })
  end)
  ccunit.eq(#got, 3)
  ccunit.eq({ got[1][1], got[1][2], got[1][3] }, { "kv_storage_key_changed", "score.Zed", "5" })
  ccunit.eq({ got[2][1], got[2][2] }, { "kv_storage_key_deleted", "score.Bob" })
  ccunit.eq({ got[3][1], got[3][2], got[3][3] }, { "kv_storage_key_changed", "score.Remote", "7" })
  kv.unsubscribe("changed", "score\\..*")
  ccunit.eq(kv.getSubscriptions("changed"), {})
  ccunit.eq(err(kv.subscribe, "renamed", ".*"), "You can subscribe only to changed or deleted events")
  ccunit.eq(err(kv.unsubscribe, "renamed", ".*"), "You can unsubscribe only from changed or deleted events")
  ccunit.eq(err(kv.getSubscriptions, "renamed"), "You can only list subscriptions to changed or deleted events")
end)

ccunit.test("KV: errors", function()
  ccunit.eq(err(kv.put, "k"), "bad argument #2 (string expected, got nil)")
  ccunit.eq(err(kv.put, "k", "v", "soon"), "bad argument #3 (number expected, got string)")
  ccunit.eq(err(kv.put, "k", ("x"):rep(500001)), "Value is too long")
  ccunit.eq(err(kv.get), "bad argument #1 (string expected, got nil)")
  ccunit.eq(err(kv.mget, "a"), "bad argument #1 (table expected, got string)")
  ccunit.eq(err(kv.incr, "n", "one"), "bad argument #2 (number expected, got string)")
  ccunit.eq(err(orphan.get, "a"), "Cannot find attached player to this peripheral")
  ccunit.eq(err(orphan.list), "Cannot find attached player to this peripheral")
end)

ccunit.test("Crafka: topics, messages and subscriptions", function()
  ccunit.eq(broker.listTopics(), { "records" })
  ccunit.eq({ broker.createTopic("records") }, { nil, "Such topic already exists" })
  ccunit.eq(broker.createTopic("chat", 3), true)
  ccunit.eq(broker.listTopics(), { "chat", "records" })
  ccunit.eq(broker.describeTopic("chat"), { messageLimit = 3, firstMessage = 0, lastMessage = 0 })
  ccunit.eq(broker.describeTopic("nope"), {})
  ccunit.eq({ broker.publish("nope", "x") }, { false, "There is no such topic" })
  ccunit.eq(broker.publish("chat", "one"), true)
  local got = collect({ "crafka_broker_message" }, 0.3, function()
    ccunit.eq({ broker.subscribe("chat") }, { true, 1 })
    broker.publish("chat", "two")
    sim({ cmd = "csPublish", topic = "chat", message = "three" })
  end)
  -- the subscription starts at cursor 0: "one" comes first, then the two new ones
  ccunit.eq(#got, 3)
  ccunit.eq({ got[1][2], got[1][3], got[1][4] }, { "chat", 1, "one" })
  ccunit.eq({ got[2][3], got[2][4] }, { 2, "two" })
  ccunit.eq({ got[3][3], got[3][4] }, { 3, "three" })
  ccunit.eq(broker.getSubscription("chat"), { cursor = 3, autoCursor = true, fragile = false })
  ccunit.eq(broker.fetchMessages("chat", 2), { [2] = "two", [3] = "three" })
  ccunit.eq(broker.describeTopic("chat"), { messageLimit = 3, firstMessage = 1, lastMessage = 3 })
  ccunit.truthy(err(broker.subscribe, "chat"):find("UNIQUE constraint failed", 1, true), "second subscription")
  ccunit.eq(broker.unsubscribe("chat"), true)
  ccunit.eq({ broker.getSubscription("chat") }, { nil, "There is no such subscription" })
  ccunit.eq({ broker.getSubscription("nope") }, { nil, "There is no such topic" })
  ccunit.eq(broker.deleteTopic("chat"), true)
  ccunit.eq(broker.listTopics(), { "records" })
  ccunit.eq(broker.getConfiguration(), { topicLimit = 512, maxMessageLimit = 500000, maxMessageSize = 500000, maxResendSteps = 21, resendDelay = 100 })
end)

ccunit.test("Crafka: a manual cursor gets the message again until it moves", function()
  broker.createTopic("jobs")
  broker.publish("jobs", "build")
  local got = collect({ "crafka_broker_message" }, 0.75, function()
    broker.subscribe("jobs", { autoCursor = false })
  end)
  -- sent at once, then again 200 ms later, then 300 ms after that (each wait one step longer) while the cursor stays
  ccunit.eq(#got, 3)
  ccunit.eq(broker.setCursor("jobs", 1), true)
  ccunit.eq(broker.getSubscription("jobs").cursor, 1)
  local after = collect({ "crafka_broker_message" }, 0.5)
  ccunit.eq(#after, 0)
  ccunit.eq(broker.setCursor("jobs", 0), true) -- only moves forward
  ccunit.eq(broker.getSubscription("jobs").cursor, 1)
  ccunit.eq({ broker.subscribe("none") }, { false, "There is no such topic" })
  ccunit.eq({ broker.unsubscribe("none") }, { false, "There is no such topic" })
  ccunit.eq({ broker.setCursor("none", 1) }, { false, "There is no such topic" })
  ccunit.eq(broker.fetchMessages("none", 1), {})
  ccunit.eq({ broker.publish("jobs", ("x"):rep(500001)) }, { false, "Message is too big" })
  ccunit.eq(err(broker.publish, "jobs"), "bad argument #2 (string expected, got nil)")
  ccunit.eq(err(broker.fetchMessages, "jobs"), "bad argument #2 (number expected, got nil)")
  ccunit.eq(err(broker.subscribe, "jobs", "fast"), "bad argument #2 (table expected, got string)")
  ccunit.eq(err(broker.createTopic), "bad argument #1 (string expected, got nil)")
  ccunit.eq(err(broker.deleteTopic), "bad argument #1 (string expected, got nil)")
  ccunit.eq(err(broker.describeTopic), "bad argument #1 (string expected, got nil)")
  ccunit.eq(err(broker.getSubscription), "bad argument #1 (string expected, got nil)")
  ccunit.eq(err(broker.setCursor, "jobs"), "bad argument #2 (number expected, got nil)")
  ccunit.eq(err(broker.unsubscribe), "bad argument #1 (string expected, got nil)")
end)

ccunit.test("StatsD bridge: off in the server config by default", function()
  ccunit.eq(statsd.getConfiguration(), { playerRateLimit = 1000, globalRateLimit = 21000 })
  for _, call in ipairs({
    function() statsd.count("jumps", 1) end, function() statsd.delta("jumps", -2) end,
    function() statsd.gauge("power", 5) end, function() statsd.set("users", "Steve") end,
    function() statsd.time("tick", 12) end,
  }) do
    sleep(0.1) -- the player's rate limit: 1000 a minute
    ccunit.eq(err(call), "Statsd Bridge is disabled in server configuration")
  end
  ccunit.eq(err(statsd.count, "x"), "bad argument #2 (number expected, got nil)")
  ccunit.eq(err(statsd.count, "x", 0 / 0), "bad argument #2 (number expected, got nan)") -- 1.5 would be 1: CC truncates
  ccunit.eq(err(statsd.set, "x"), "bad argument #2 (string expected, got nil)")
end)
