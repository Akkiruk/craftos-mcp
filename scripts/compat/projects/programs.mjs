// See ../projects.mjs. Each entry: { id, name, url, category, section, run(t) } with the driver from ../lib.mjs.
import { shellInstall } from "../helpers.mjs";

const RAW = "https://raw.githubusercontent.com";
/** A short DFPWM clip that is public on GitHub (the Jane demo's soundtrack), for the players that take a URL. */
const DFPWM_URL = `${RAW}/piguman3/PineJam2026Demo/main/janecut.dfpwm`;

const chest = (n, items = {}) => ({
  name: `minecraft:chest_${n}`,
  type: "minecraft:chest",
  size: 27,
  items,
});

/** Wait until a speaker has been given audio, and say how much. */
async function expectAudio(t, speaker, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const played = t
      .speaker(speaker)
      .sounds.filter((s) => s.kind === "audio" && s.accepted !== false);
    if (played.length >= 3) return played;
    if (Date.now() > end)
      t.fail(
        `speaker ${speaker} got ${played.length} audio buffers in ${timeoutMs} ms: ${JSON.stringify(t.speaker(speaker).raw).slice(0, 300)}`,
      );
    await t.sleep(250);
  }
}

export default [
  {
    id: "cc-misc",
    name: "MISC (Modular Item Storage and Crafting)",
    url: "https://github.com/Storehaus/CC-MISC",
    category: "program",
    section: "Storage, turtles and peripherals",
    world: {
      peripherals: [
        { name: "back", type: "modem", kind: "wired", network: "storage" },
      ],
    },
    wired: [
      {
        id: "storage",
        peripherals: [
          chest(0, {
            1: { name: "minecraft:cobblestone", count: 64 },
            2: { name: "minecraft:cobblestone", count: 36 },
            3: { name: "minecraft:iron_ingot", count: 32 },
          }),
          chest(1, { 5: { name: "minecraft:oak_log", count: 16 } }),
          chest(2),
          chest(3),
        ],
      },
    ],
    async run(t) {
      await t.boot();
      await t.shell(`wget run ${RAW}/Storehaus/CC-MISC/master/installer.lua`);
      await t.waitFor("MISC INSTALLER", 30000);
      await t.shot("installer");
      // server, then the base install (storage and its modules)
      await t.type("s");
      await t.waitFor("Base");
      await t.shot("server-options");
      await t.type("b");
      await t.waitForPrompt(120000);
      t.noCrash();
      await t.shot("installed");
      if (!t.exists("startup.lua") || !t.exists("modules"))
        t.fail(`the installer left no startup.lua and modules: ${t.list()}`);
      // it runs from startup.lua: restart the computer, as the installer says
      await t.shell("reboot");
      await t.rebooted();
      // first start: it asks for what its config lacks, the modem the chests are behind
      await t.waitFor("Please input a string:", 20000);
      await t.shot("config");
      await t.shell("back");
      await t.sleep(6000);
      await t.shot("running");
      t.noCrash();
    },
  },
  {
    id: "github-downloader",
    name: "Github Downloader",
    url: "https://pinestore.cc/projects/157/github-downloader-on-cc",
    category: "program",
    section: "Utility",
    async run(t) {
      await shellInstall(t, "pastebin get jP9CNvYS githubdw");
      t.hash("githubdw");
      await t.shell("githubdw");
      await t.waitFor("Paste repository URL");
      await t.shot("start");
      // the address is pasted, as the screen asks
      t.event("paste", "https://github.com/9551-Dev/pixelbox_lite");
      await t.waitFor("pixelbox_lite");
      await t.key("enter");
      await t.waitFor(/files downloaded/, 120000);
      await t.shot("done");
      t.expect("All files downloaded successfully!");
      t.noCrash();
      if (t.size("pixelbox_lite.lua") < 1000)
        t.fail(`pixelbox_lite.lua was not downloaded: ${t.list()}`);
      if (!t.exists("examples/first.lua"))
        t.fail("the examples folder was not downloaded");
      await t.clickText("Continue");
      await t.waitFor("Paste repository URL");
    },
  },
  {
    id: "consult",
    name: "CONSULT",
    url: "https://github.com/SammyForReal/CONSULT",
    category: "program",
    section: "Code editors",
    async run(t) {
      await shellInstall(
        t,
        "wget https://github.com/1Turtle/consult/releases/latest/download/cosu.lua",
      );
      t.hash("cosu.lua");
      await t.shell("cosu hello.lua");
      await t.waitFor("hello.lua");
      await t.waitFor("Ln 1, Col 1");
      await t.shot("empty");
      await t.type('print("hello from consult")');
      await t.key("enter");
      await t.type("local x = 1 + 2");
      await t.waitFor("Ln 2, Col 16");
      await t.shot("typed");
      await t.combo("leftCtrl", "s");
      await t.sleep(800);
      await t.shot("saved");
      t.noCrash();
      if (!t.exists("hello.lua")) t.fail("Ctrl+S did not write hello.lua");
      const saved = t.read("hello.lua").replace(/\r/g, "").trimEnd();
      if (saved !== 'print("hello from consult")\nlocal x = 1 + 2')
        t.fail(`hello.lua holds:\n${saved}`);
      // F5 runs the file
      await t.key("f5");
      await t.waitFor("hello from consult", 10000);
      await t.shot("ran");
    },
  },
  {
    id: "quark",
    name: "Quark",
    url: "https://github.com/aTimmYm/Quark",
    category: "program",
    section: "Code editors",
    minCC: "1.109.0", // goto
    async run(t) {
      await t.boot();
      await t.shell(
        `wget run "${RAW}/aTimmYm/Quark/refs/heads/main/installer_updater/installer.lua"`,
      );
      await t.waitFor("Enter the path", 30000);
      await t.shell("/");
      await t.waitForPrompt(180000);
      t.noCrash();
      await t.shot("installed");
      if (!t.exists("Quark/main.lua"))
        t.fail(`the installer left no Quark/main.lua: ${t.list()}`);
      t.put("notes.lua", 'print("one")\n');
      await t.shell("clear");
      await t.shell("Quark/main.lua");
      await t.waitFor("New File", 20000);
      await t.shot("welcome");
      t.noCrash();
      t.expect("Open Project");
      await t.clickText("New File");
      await t.settle(600, 8000);
      await t.shot("new-file");
      await t.type('print("typed in quark")');
      await t.settle(500, 5000);
      await t.shot("typed");
      t.noCrash();
      t.expect('print("typed in quark")');
    },
  },
  {
    id: "shrekword",
    name: "ShrekWord",
    url: "https://github.com/ShrekshelleraiserCC/shrekword",
    category: "program",
    section: "Code editors",
    async run(t) {
      await shellInstall(
        t,
        "wget https://github.com/ShrekshelleraiserCC/shrekword/releases/latest/download/sword.lua",
      );
      t.hash("sword.lua");
      await t.shell("sword");
      await t.waitFor("Check for updates on startup?");
      await t.shell("n");
      await t.waitFor("File");
      await t.waitFor(/Page 1\/1/);
      await t.shot("empty");
      await t.type("Dear reader, this was typed in ShrekWord.");
      await t.waitFor("ShrekWord.");
      await t.shot("typed");
      t.noCrash();
      // File > Save As
      await t.clickText("File");
      await t.waitFor("Save As");
      await t.shot("file-menu");
      await t.clickText("Save As");
      await t.settle(400, 3000);
      await t.shot("save-as");
      await t.type("letter.sdoc");
      await t.key("enter");
      await t.settle(400, 3000);
      await t.shot("saved");
      t.noCrash();
      if (!t.exists("letter.sdoc"))
        t.fail(`Save As wrote no letter.sdoc: ${t.list()}`);
      if (!t.read("letter.sdoc").includes("this was typed in ShrekWord"))
        t.fail("the saved document does not hold the text");
      // Ctrl+Q quits
      await t.combo("leftCtrl", "q");
      await t.waitForPrompt(10000);
    },
  },
  {
    id: "spritemog",
    name: "SpriteMog 1.2",
    url: "https://pastebin.com/iHpQhwvy",
    category: "program",
    section: "Code editors",
    async run(t) {
      await shellInstall(t, "pastebin get iHpQhwvy spritemog");
      t.hash("spritemog");
      await t.shell("spritemog");
      await t.waitFor("-SELECT PALETTE-");
      await t.shot("palettes");
      await t.clickText("default");
      await t.waitFor("-SELECT SPRITE-");
      await t.clickText("newSprite");
      await t.settle(600, 8000);
      await t.shot("editor");
      t.noCrash();
      const before = t.frameHash();
      await t.drag(20, 8, 30, 12);
      await t.settle(400, 4000);
      await t.shot("drawn");
      t.noCrash();
      if (t.frameHash() === before)
        t.fail("drawing with the mouse changed nothing");
    },
  },
  {
    id: "pixelcode",
    name: "PixelCode",
    url: "https://github.com/Shlomo1412/PixelUI/blob/main/code_editor_app.lua",
    category: "program",
    section: "Code editors",
    minCC: "1.109.0",
    async run(t) {
      await shellInstall(t, `wget ${RAW}/Shlomo1412/PixelUI/main/pixelui.lua`);
      await shellInstall(
        t,
        `wget ${RAW}/Shlomo1412/PixelUI/main/code_editor_app.lua`,
      );
      await t.shell("code_editor_app");
      await t.waitFor("Press Alt to open toolbar");
      await t.shot("start");
      await t.click(20, 4);
      await t.type("local answer = 42");
      await t.settle(400, 3000);
      await t.shot("typed");
      t.noCrash();
      t.expect("local answer = 42");
      // F1 is its help; Alt opens the toolbar
      await t.key("leftAlt");
      await t.settle(400, 3000);
      await t.shot("toolbar");
      t.noCrash();
    },
  },
  {
    id: "craft-web",
    name: "Craft-Web",
    url: "https://github.com/Elemnto56/Craft-Web",
    category: "program",
    section: "Web, internet and communication",
    minCC: "1.109.0",
    async run(t) {
      await shellInstall(
        t,
        `wget ${RAW}/Elemnto56/Craft-Web/refs/heads/main/craft-installer.lua`,
      );
      await t.shell("craft-installer");
      await t.waitFor("(y/n)", 30000);
      await t.shell("y");
      await t.waitFor("Done! Goodbye.", 30000);
      await t.waitForPrompt();
      await t.shell("clear");
      await t.shell("craft-web");
      await t.waitFor("Welcome to Craft-Web!", 15000);
      await t.shot("home");
      t.noCrash();
      t.expect("Address Bar");
      await t.clickText("Exit");
      await t.waitForPrompt(10000);
    },
  },
  {
    id: "musicify",
    name: "Musicify",
    url: "https://github.com/knijn/musicify",
    category: "program",
    section: "Audio and video players",
    world: { peripherals: [{ name: "right", type: "speaker" }] },
    async run(t) {
      await t.boot();
      await t.shell(`wget run ${RAW}/knijn/musicify/main/install.lua`);
      await t.waitFor("anything else to continue", 30000);
      await t.shell("y");
      await t.waitForPrompt(60000);
      t.noCrash();
      await t.shot("installed");
      await t.shell("clear");
      await t.shell("musicify list");
      await t.waitFor(/1 \| /, 30000);
      await t.shot("list");
      // S and W scroll the list, Q leaves it (by raising "Closed list")
      const first = t.text();
      await t.hold("s", 400);
      if (t.text() === first) t.fail("S did not scroll the song list");
      await t.key("q");
      await t.waitFor("Closed list", 10000);
      // the q of that key press lands on the shell's line, as it does at a real keyboard
      await t.key("backspace");
      await t.shell("clear");
      await t.shell("musicify play 1");
      const played = await expectAudio(t, "right", 60000);
      await t.shot("playing");
      t.noCrash();
      t.note(
        `speaker got ${played.length} buffers, ${played[0].samples} samples each`,
      );
    },
  },
  {
    id: "quartz",
    name: "Quartz Audio Player",
    url: "https://github.com/Ale32bit/Quartz",
    category: "program",
    section: "Audio and video players",
    // "insert a disk containing a .dfpwm": two speakers for its stereo, and a drive with a floppy in it
    world: {
      peripherals: [
        { name: "left", type: "speaker" },
        { name: "right", type: "speaker" },
        { name: "top", type: "drive", disk: 0 },
      ],
    },
    async run(t) {
      await shellInstall(
        t,
        "wget run https://raw.github.com/Ale32bit/Quartz/main/download.lua",
        60000,
      );
      // record a song onto the floppy: the first 100 kB of a clip, since a floppy holds 125 kB
      const recorded = await t.lua(`
local h = assert(http.get(${JSON.stringify(DFPWM_URL)}, nil, true))
local data = h.read(100000)
h.close()
local f = fs.open("disk/song.dfpwm", "wb")
f.write(data)
f.close()
result(#data, fs.getSize("disk/song.dfpwm"))`);
      if (recorded[0] !== "100000\t100000")
        t.fail(`the song on the disk is ${recorded[0]} bytes`);
      await t.shell("clear");
      await t.shell("player");
      await t.waitFor("Ready", 15000);
      await t.shot("log");
      t.noCrash();
      t.expect(/Speaker configuration:\s+stereo/);
      // F1 leaves the log for the player; space plays
      await t.key("f1");
      await t.settle(500, 5000);
      await t.shot("player");
      await t.key("space");
      await t.sleep(4000);
      await t.shot("playing");
      t.noCrash();
      const left = t.speaker("left").raw?.audio?.pushed ?? 0;
      const right = t.speaker("right").raw?.audio?.pushed ?? 0;
      if (left < 1 || right < 1)
        t.fail(`the speakers got ${left} and ${right} audio buffers`);
      t.note(`left ${left}, right ${right} audio buffers in 4 s`);
    },
  },
  {
    id: "pocketbox",
    name: "Pocketbox",
    url: "https://github.com/windclan/pocketbox",
    category: "program",
    section: "Audio and video players",
    world: { peripherals: [{ name: "right", type: "speaker" }] },
    async run(t) {
      await shellInstall(
        t,
        `wget ${RAW}/windclan/pocketbox/main/pocketboxv4.lua pocketbox.lua`,
      );
      t.hash("pocketbox.lua");
      t.put(
        "autoplay.pb",
        `[url]\npath:${DFPWM_URL}\ntitle:Jane\nartist:piguman3\n`,
      );
      await t.shell("clear");
      await t.shell("pocketbox");
      const played = await expectAudio(t, "right", 60000);
      await t.shot("playing");
      t.noCrash();
      t.note(`speaker got ${played.length} buffers`);
      t.expect(/Jane/);
    },
  },
  {
    id: "ccmaps",
    name: "CCMaps",
    url: "https://pinestore.cc/projects/66/ccmaps",
    category: "program",
    section: "Demoscene and proof of concept",
    async run(t) {
      await shellInstall(
        t,
        "wget run https://gist.githubusercontent.com/cyberbit/993372d662918aeb4973701ac7122987/raw/ccmaps_install.lua",
        60000,
      );
      await t.shell("ccmaps");
      // it fetches its map data, then draws coastlines with teletext characters: wait for those
      const drawn = () =>
        t
          .lines()
          .join("")
          .split("")
          .filter((c) => c.charCodeAt(0) > 128 && c.charCodeAt(0) < 160).length;
      for (let i = 0; i < 180 && drawn() < 20; i++) await t.sleep(500);
      await t.settle(1500, 30000);
      await t.shot("map");
      t.noCrash();
      if (drawn() < 20) t.fail("no map was drawn");
      const before = t.frameHash();
      // drag the map, then zoom
      await t.drag(30, 10, 15, 6);
      await t.scroll(25, 9, -1);
      await t.settle(1500, 30000);
      await t.shot("moved");
      t.noCrash();
      if (t.frameHash() === before)
        t.fail("dragging and zooming left the map as it was");
    },
  },
];
