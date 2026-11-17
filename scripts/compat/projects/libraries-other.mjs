// See ../projects.mjs. Each entry: { id, name, url, category, section, run(t) } with the driver from ../lib.mjs.
import { shellInstall } from "../helpers.mjs";

const RAW = "https://raw.githubusercontent.com";
const GIST = "https://gist.githubusercontent.com";

const chest = (n, items = {}) => ({
  name: `minecraft:chest_${n}`,
  type: "minecraft:chest",
  size: 27,
  items,
});
/** Chests behind wired modems on one cable, and the computer's own wired modem on it, as a storage room has. */
const storageRoom = (...chests) => ({
  world: {
    peripherals: [
      { name: "back", type: "modem", kind: "wired", network: "storage" },
    ],
  },
  wired: [{ id: "storage", peripherals: chests }],
});

export default [
  {
    id: "ecnet2",
    name: "ECNet2",
    url: "https://github.com/migeyel/ecnet",
    category: "library",
    section: "Networking",
    computers: [
      {
        name: "server",
        world: {
          peripherals: [{ name: "top", type: "modem" }],
          position: { x: 0, y: 64, z: 0 },
        },
      },
      {
        name: "client",
        world: {
          peripherals: [{ name: "top", type: "modem" }],
          position: { x: 5, y: 64, z: 0 },
        },
      },
    ],
    async run(t) {
      const client = t.computer("client");
      const ecnet = t.clone("https://github.com/migeyel/ecnet", "ecnet");
      const crypto = t.clone(
        "https://github.com/migeyel/ccryptolib",
        "ccryptolib",
      );
      for (const c of [t, client]) {
        c.install(`${ecnet}/ecnet2`, "ecnet2");
        c.install(`${crypto}/ccryptolib`, "ccryptolib");
      }
      // its own ping example: the server as it is, the client with the server's real address in place of the
      // author's
      t.install(`${ecnet}/examples/ping/server.lua`, "server.lua");
      t.put(
        "address.lua",
        `local ecnet2 = require "ecnet2"
require "ccryptolib.random".initWithTiming()
local h = fs.open("address.txt", "w") h.write(ecnet2.Identity("/.ecnet2").address) h.close()
`,
      );
      await t.boot();
      await t.shell("address");
      await t.waitForFile("address.txt", 30000);
      await t.waitForPrompt();
      t.noCrash();
      const address = t.read("address.txt");
      if (!/^[A-Za-z0-9_-]{43}=$/.test(address))
        t.fail(`the identity's address is ${address}`);
      const { readFileSync } = await import("node:fs");
      const source = readFileSync(
        `${ecnet}/examples/ping/client.lua`,
        "utf8",
      ).replace(
        /local server = "[^"]*"/,
        `local server = ${JSON.stringify(address)}`,
      );
      client.put("client.lua", source);
      await t.shell("server");
      await t.sleep(1500);
      t.noCrash();
      await client.shell("client");
      await client.waitFor("ping v1.0", 20000);
      await client.shell("hello over ecnet");
      await t.waitFor(/got\s+hello over ecnet\s+on channel/, 15000);
      await client.waitFor(/hello over ecnet\s*\n\s*hello over ecnet/, 15000);
      await t.shot("ping");
      await client.shot("ping");
      // "from 5 blocks away": the modem's distance, through the encrypted tunnel
      t.expect(/from\s+5\s+blocks\s+away/);
      t.noCrash();
      client.noCrash();
    },
  },
  {
    id: "taskmaster",
    name: "Taskmaster",
    url: "https://gist.github.com/MCJack123/1678fb2c240052f1480b07e9053d4537",
    category: "library",
    section: "Threads / multitasking",
    async run(t) {
      await shellInstall(
        t,
        `wget ${GIST}/MCJack123/1678fb2c240052f1480b07e9053d4537/raw taskmaster.lua`,
      );
      t.hash("taskmaster.lua");
      const out = await t.lua(`
local taskmaster = require("taskmaster")
local order = {}
-- three tasks in parallel, as its first example
taskmaster(
  function() sleep(0.3) order[#order + 1] = "slow" end,
  function() sleep(0.1) order[#order + 1] = "fast" end,
  function() order[#order + 1] = "now" end
):waitForAll()
result(table.concat(order, ","))
-- event listeners and a timer in one loop, stopped from inside
local loop = taskmaster()
local seen = {}
loop:eventListener("ping", function(ev, n) seen[#seen + 1] = "ping" .. n end)
loop:addTimer(0.1, function() os.queueEvent("ping", #seen + 1) if #seen >= 3 then loop:stop() end end)
loop:run()
result(table.concat(seen, ","))
-- waitForAny returns when the first finishes
local started = os.epoch("utc")
taskmaster(function() sleep(0.2) end, function() sleep(5) end):waitForAny()
result(os.epoch("utc") - started < 1500)
`);
      if (out[0] !== "now,fast,slow") t.fail(`task order was ${out[0]}`);
      if (!out[1].startsWith("ping1,ping2,ping3"))
        t.fail(`listeners saw ${out[1]}`);
      if (out[2] !== "true") t.fail("waitForAny waited for the slow task");
    },
  },
  {
    id: "redrun",
    name: "RedRun",
    url: "https://gist.github.com/MCJack123/473475f07b980d57dd2bd818026c97e8",
    category: "library",
    section: "Threads / multitasking",
    async run(t) {
      await shellInstall(
        t,
        `wget ${GIST}/MCJack123/473475f07b980d57dd2bd818026c97e8/raw redrun.lua`,
      );
      t.hash("redrun.lua");
      // RedRun hooks the coroutine rednet.run lives in (through getfenv), so its tasks outlive the program that
      // started them: this one keeps answering events from the shell prompt
      const out = await t.lua(`
local redrun = require("redrun")
local id = redrun.start(function()
  while true do
    local _, text = os.pullEvent("compat_note")
    local h = fs.open("heard.txt", "a") h.writeLine(text) h.close()
  end
end, "listener")
result(type(id), redrun.getid("listener") == id)
os.queueEvent("compat_note", "first")
sleep(0.2)
result(type(redrun.getstate(id)))
`);
      if (out[0] !== "number\ttrue") t.fail(`start gave ${out[0]}`);
      if (out[1] !== "table") t.fail(`the task's state is a ${out[1]}`);
      await t.waitForPrompt();
      t.event("compat_note", "second");
      await t.sleep(500);
      const heard = t.read("heard.txt").trim().split(/\r?\n/).join(",");
      if (heard !== "first,second")
        t.fail(
          `the background task heard "${heard}", not first and then second (after its program ended)`,
        );
      const killed = await t.lua(`
local redrun = require("redrun")
local id = redrun.getid("listener")
redrun.kill(id)
os.queueEvent("compat_note", "third")
sleep(0.2)
result(redrun.getstate(id))
`);
      if (killed[0] !== "nil") t.fail(`after kill its state is ${killed[0]}`);
      if (t.read("heard.txt").includes("third"))
        t.fail("the killed task still ran");
    },
  },
  {
    id: "fatboychummy-thread",
    name: "Thread (Fatboychummy libraries)",
    url: "https://github.com/Fatboychummy-CC/Libraries/blob/main/thread.lua",
    category: "library",
    section: "Threads / multitasking",
    async run(t) {
      const repo = t.clone("https://github.com/Fatboychummy-CC/Libraries");
      t.install(repo, "lib");
      await t.boot();
      const out = await t.lua(`
package.path = package.path .. ";/lib/?.lua"
local thread = require("thread")
local order = {}
thread.new(function() sleep(0.2) order[#order + 1] = "b" end)
thread.new(function() order[#order + 1] = "a" end):after(function() order[#order + 1] = "after-a" end)
thread.new(function() sleep(0.05) error("boom") end):on_error(function() order[#order + 1] = "caught" end)
thread.new(function() sleep(0.5) thread.stop() end)
thread.run()
result(table.concat(order, ","))
`);
      for (const want of ["a", "after-a", "caught", "b"])
        if (!out[0].split(",").includes(want))
          t.fail(`the threads ran as ${out[0]}; ${want} is missing`);
    },
  },
  {
    id: "aes",
    name: "AES library",
    url: "https://gist.github.com/afonya2/489c3306a7d85f8f9512df321d904dbb",
    category: "library",
    section: "Encryption",
    async run(t) {
      await shellInstall(
        t,
        `wget ${GIST}/afonya2/489c3306a7d85f8f9512df321d904dbb/raw aes.lua`,
      );
      t.hash("aes.lua");
      // FIPS-197 appendix C.1: AES-128 of 00112233445566778899aabbccddeeff under 000102030405060708090a0b0c0d0e0f
      const out = await t.lua(
        `
local aes = require("aes")
local function bytes(hex) local t = {} for b in hex:gmatch("%x%x") do t[#t + 1] = tonumber(b, 16) end return t end
local function hex(t) local s = {} for i = 1, #t do s[i] = ("%02x"):format(t[i]) end return table.concat(s) end
local key = bytes("000102030405060708090a0b0c0d0e0f")
local plain = bytes("00112233445566778899aabbccddeeff")
local cipher = aes.Encrypt(plain, key)
result(hex(cipher))
result(hex(aes.Decrypt(cipher, key)))
local iv = bytes("0f0e0d0c0b0a09080706050403020100")
local text = aes.StringToTable("the quick brown fox jumps over the lazy dog")
local back = aes.DecryptCBC(aes.EncryptCBC(text, key, iv), key, iv)
result(aes.TableToString(back))
`,
        60000,
      );
      if (!out[0].startsWith("69c4e0d86a7b0430d8cdb78070b4c55a"))
        t.fail(`AES-128 of the FIPS-197 vector gave ${out[0]}`);
      if (!out[1].startsWith("00112233445566778899aabbccddeeff"))
        t.fail(`decrypting gave ${out[1]}`);
      if (!out[2].startsWith("the quick brown fox jumps over the lazy dog"))
        t.fail(`CBC round trip gave ${out[2]}`);
    },
  },
  {
    id: "sha256",
    name: "SHA256 / HMAC / PBKDF2 (Anavrins)",
    url: "https://pastebin.com/6UV4qfNF",
    category: "library",
    section: "Encryption",
    async run(t) {
      await shellInstall(t, "pastebin get 6UV4qfNF sha256.lua");
      t.hash("sha256.lua");
      const out = await t.lua(
        `
local sha = require("sha256")
result(sha.digest("abc"):toHex())
result(sha.digest(""):toHex())
result(sha.digest(("a"):rep(1000)):toHex())
-- RFC 4231 test case 2
result(sha.hmac("what do ya want for nothing?", "Jefe"):toHex())
-- RFC 7914 section 11: PBKDF2-HMAC-SHA256, "passwd" / "salt", 1 iteration, 64 bytes
result(sha.pbkdf2("passwd", "salt", 1, 64):toHex())
`,
        60000,
      );
      const want = [
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3",
        "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
        "55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783",
      ];
      want.forEach((hash, i) => {
        if (out[i] !== hash) t.fail(`vector ${i + 1} gave ${out[i]}`);
      });
    },
  },
  {
    id: "hopper",
    name: "hopper.lua",
    url: "https://github.com/umnikos/hopper.lua",
    category: "library",
    section: "Peripheral management",
    ...storageRoom(
      chest(0, {
        1: { name: "minecraft:cobblestone", count: 64 },
        2: { name: "minecraft:cobblestone", count: 10 },
        3: { name: "minecraft:iron_ingot", count: 32 },
        5: { name: "minecraft:diamond", count: 3 },
      }),
      chest(1),
      chest(2),
    ),
    async run(t) {
      await shellInstall(t, `wget ${RAW}/umnikos/hopper.lua/main/hopper.lua`);
      t.hash("hopper.lua");
      // everything but the diamonds from chest 0 to chest 1, once
      await t.shell("hopper -once *chest_0 *chest_1 -not *:diamond");
      await t.waitForPrompt(30000);
      await t.shot("moved");
      t.noCrash();
      const count = `
local function count(name)
  local total = {}
  for _, item in pairs(peripheral.call(name, "list")) do total[item.name] = (total[item.name] or 0) + item.count end
  local keys = {} for k in pairs(total) do keys[#keys + 1] = k end table.sort(keys)
  for i, k in ipairs(keys) do keys[i] = k:gsub("minecraft:", "") .. "=" .. total[k] end
  return table.concat(keys, " ")
end`;
      let out = await t.lua(
        `${count}\nresult(count("minecraft:chest_0")) result(count("minecraft:chest_1"))`,
      );
      if (out[0] !== "diamond=3")
        t.fail(`chest 0 should keep only its diamonds, it holds: ${out[0]}`);
      if (out[1] !== "cobblestone=74 iron_ingot=32")
        t.fail(`chest 1 holds: ${out[1]}`);
      // as a library: require it and move a limited amount
      out = await t.lua(
        `${count}
local hopper = require("hopper")
hopper("*chest_1 *chest_2 *:iron_ingot -transfer-limit 20 -once")
result(count("minecraft:chest_1")) result(count("minecraft:chest_2"))`,
      );
      if (out[1] !== "iron_ingot=20")
        t.fail(
          `a 20 item limit moved: ${out[1]} (chest 1 left with ${out[0]})`,
        );
      if (out[0] !== "cobblestone=74 iron_ingot=12")
        t.fail(`chest 1 holds: ${out[0]}`);
    },
  },
  {
    id: "oil",
    name: "Open Inventory Library",
    url: "https://github.com/afonya2/CC-OpenInvLib",
    category: "library",
    section: "Peripheral management",
    ...storageRoom(
      chest(0, {
        1: { name: "minecraft:cobblestone", count: 64 },
        2: { name: "minecraft:oak_log", count: 16 },
      }),
      chest(1),
      chest(2),
    ),
    async run(t) {
      await shellInstall(
        t,
        `wget ${RAW}/afonya2/CC-OpenInvLib/refs/heads/main/openinvlib.lua oil.lua`,
      );
      t.hash("oil.lua");
      const out = await t.lua(
        `
shell.run("oil.lua")
local oil = openInvLib
result(type(oil))
oil.scanPeripherals()
local id = assert(oil.createStorage("main", { "minecraft:chest_0", "minecraft:chest_1" }))
local storage = oil.getStorage(id)
result(storage.getName(), storage.getSize())
local part = storage.getPartition(assert(storage.createPartition("all", 1, storage.getSize())))
oil.scanStorages()
result(part.getItemCount("minecraft:cobblestone"), part.getItemCount("minecraft:oak_log"))
`,
        60000,
      );
      await t.shot("oil");
      if (out[0] !== "table") t.fail("oil.lua left no openInvLib global");
      if (out[1] !== "main\t54")
        t.fail(`the storage of two chests is ${out[1]}`);
      if (out[2] !== "64\t16") t.fail(`the partition counts ${out[2]}`);
    },
  },
  {
    id: "desyncc",
    name: "DesynCC",
    url: "https://github.com/afonya2/DesynCC",
    category: "library",
    section: "Other libraries",
    async run(t) {
      await t.boot();
      await t.shell(
        `wget run ${RAW}/afonya2/DesynCC/refs/heads/main/installer.lua test`,
      );
      await t.waitFor("[y/n]", 30000);
      await t.shell("y");
      await t.waitForPrompt(60000);
      t.noCrash();
      await t.shot("installed");
      const out = await t.lua(`
local desyncc = require("desyncc.main")
local sys = desyncc:new()
local order = {}
local function main()
  local slow = sys:async(function() sleep(0.3) return "slow" end)
  local fast = sys:async(function() sleep(0.1) return "fast" end)
  local a, b = slow(), fast()
  order[#order + 1] = b.status()
  order[#order + 1] = b.await()
  order[#order + 1] = a.await()
end
-- start() ends by raising "Main task died" once main returns: that is how the library stops
local ok, err = pcall(function() sys:start(main) end)
assert(not ok and tostring(err):find("Main task died"), err)
result(table.concat(order, ","))
`);
      if (!out[0].endsWith("suspended,fast,slow"))
        t.fail(`async/await gave ${out[0]}`);
      // one of its own tests, which says what it should print: nil, "Before the function is awaited", suspended,
      // then five seconds later "Hello, world!", "a b", "After the function is awaited" and "a b" again
      await t.shell("clear");
      const started = Date.now();
      await t.shell("desyncc/test/asyncAwait.lua");
      await t.waitFor("Main task died", 15000);
      const waited = Date.now() - started;
      await t.waitForPrompt(10000);
      await t.shot("test");
      t.expect(
        /nil\s+Before the function is awaited\s+suspended\s+Hello,\s+world!\s+a\s+b\s+After the function is awaited\s+(resolved\s+)?a\s+b/,
      );
      if (waited < 4000 || waited > 8000)
        t.fail(`the awaited sleep(5) took ${waited} ms`);
    },
  },
  {
    id: "telem",
    name: "Telem",
    url: "https://github.com/cyberbit/telem",
    category: "library",
    section: "Other libraries",
    // its installer fetches the compressed modules as text and writes them with a text handle, which only keeps
    // bytes as they are from CC:Tweaked 1.109 on
    minCC: "1.109.0",
    ...storageRoom(
      chest(0, {
        1: { name: "minecraft:cobblestone", count: 64 },
        2: { name: "minecraft:cobblestone", count: 36 },
        3: { name: "minecraft:iron_ingot", count: 32 },
      }),
    ),
    async run(t) {
      await t.boot();
      await t.shell("wget run https://pinestore.cc/d/14");
      // the installer is a mouse-driven wizard: pick the compact release, then Finish
      await t.waitFor("Telem Installer", 30000);
      await t.shot("installer");
      await t.waitFor("Release (compact)", 30000);
      await t.key("enter");
      await t.waitFor("Press Enter", 30000);
      await t.key("enter");
      await t.waitFor("Complete", 90000);
      await t.shot("installed");
      await t.key("enter");
      await t.waitForPrompt(30000);
      t.noCrash();
      if (!t.exists("telem.lua"))
        t.fail(`the installer left no telem.lua: ${t.list()}`);
      t.hash("telem.lua");
      const out = await t.lua(`
local telem = require("telem")
local seen = {}
local backplane = telem.backplane()
  :addInput("hello", telem.input.helloWorld(123))
  :addInput("chest", telem.input.itemStorage("minecraft:chest_0"))
  :addInput("mine", telem.input.custom(function() return { answer = 42 } end))
  :addOutput("collect", telem.output.custom(function(collection)
    for _, metric in ipairs(collection.metrics) do seen[metric.name] = metric.value end
  end))
backplane:cycle()
local names = {} for k, v in pairs(seen) do names[#names + 1] = k .. "=" .. v end table.sort(names)
result(table.concat(names, " "))
`);
      await t.shot("metrics");
      for (const want of [
        "hello_world=123",
        "answer=42",
        "storage:minecraft:cobblestone=100",
        "storage:minecraft:iron_ingot=32",
      ])
        if (!out[0].includes(want))
          t.fail(`the backplane collected "${out[0]}", without ${want}`);
    },
  },
];
