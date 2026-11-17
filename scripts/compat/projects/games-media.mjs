// See ../projects.mjs. Each entry: { id, name, url, category, section, run(t) } with the driver from ../lib.mjs.
import { shellInstall, watchAnimation } from "../helpers.mjs";

const RAW = "https://raw.githubusercontent.com";
const SPEAKER = { peripherals: [{ name: "right", type: "speaker" }] };

/**
 * The installer most PineStore games share: a progress bar, then "Finished installation! Press any key to close...".
 */
async function pineInstall(t, line, timeoutMs = 180000) {
  if (!t.booted) await t.boot();
  await t.shell(line);
  await t.waitFor(/Finished installation!|Press any key/, timeoutMs);
  t.noCrash();
  await t.key("enter");
  await t.waitForPrompt(15000);
}

/** A picture, not a blank or nearly blank screen. */
function expectPicture(t, what, least = 8) {
  const variety = t.variety();
  if (variety < least)
    t.fail(`${what} drew next to nothing (${variety} kinds of cell)`);
}

/** Do something and check the screen is not what it was. */
async function expectReaction(t, what, act, settleMs = 600) {
  const before = t.frameHash();
  await act();
  await t.sleep(settleMs);
  t.noCrash();
  if (t.frameHash() === before) t.fail(`${what} changed nothing on screen`);
}

/** How many audio buffers a speaker has taken. */
const audioCount = (t, name = "right") =>
  t.speaker(name).raw?.audio?.pushed ?? 0;

export default [
  {
    id: "chess",
    name: "Chess",
    url: "https://github.com/aTimmYm/Chess",
    category: "program",
    section: "Games",
    // its sha2 library picks CC's `bit` API over bit32 unless _VERSION is "Lua 5.2", and `bit` lacks what it needs
    minCC: "1.109.0",
    async run(t) {
      await t.boot();
      await t.shell(
        `wget run "${RAW}/aTimmYm/Chess/refs/heads/main/installer.lua"`,
      );
      await t.waitFor("success", 120000);
      await t.waitForPrompt(10000);
      t.noCrash();
      if (!t.exists("main.lua")) t.fail(`no main.lua installed: ${t.list()}`);
      // main.lua starts the graphics-mode version when the terminal has CraftOS-PC's setGraphicsMode, and nothing
      // otherwise (its text-mode branch tests a variable that is never set): on CC:Tweaked it returns without a
      // word. So the check starts the text-mode game the way that branch would have.
      await t.shell("main");
      await t.waitForPrompt(10000);
      t.noCrash();
      t.put(
        "textmode.lua",
        `package.path = package.path .. ";/Data/?;/Data/?.lua;/Data/?/init.lua"\nos.run(_ENV, "TM.lua")\n`,
      );
      await t.shell("clear");
      await t.shell("textmode");
      await t.sleep(5000);
      await t.shot("menu");
      t.noCrash();
      if (/> ?$/.test(t.text().trimEnd()))
        t.fail(`TM.lua ended at once:\n${t.text()}`);
      expectPicture(t, "the main menu", 6);
      t.expect("Local Game");
      await expectReaction(
        t,
        "starting a local game",
        () => t.clickText("Local Game"),
        2500,
      );
      await t.shot("board");
      // a first move: the pawn in front of the king, two squares up (wherever the board is, clicking two cells in
      // its middle column must not break anything)
      const { width, height } = {
        width: t.lines()[0].length,
        height: t.lines().length,
      };
      await t.click(Math.floor(width / 2), height - 4);
      await t.click(Math.floor(width / 2), height - 8);
      await t.sleep(1000);
      await t.shot("moved");
      t.noCrash();
    },
  },
  {
    id: "ccdoom",
    name: "CCDoom",
    url: "https://github.com/Xella37/CCDoom",
    category: "program",
    section: "Games",
    async run(t) {
      await pineInstall(t, "pastebin run xLC8mABU");
      await t.shell("Doom");
      await t.sleep(3000);
      await t.shot("menu");
      t.noCrash();
      expectPicture(t, "the title screen");
      // Play, then "Normal Mode"
      await t.key("enter");
      await t.waitFor("Normal Mode", 15000);
      await t.shot("modes");
      await t.key("enter");
      await t.waitFor(/^(?![\s\S]*Normal Mode)/, 30000);
      await t.sleep(4000);
      await t.shot("level");
      t.noCrash();
      expectPicture(t, "the level", 12);
      await expectReaction(t, "walking and turning", async () => {
        await t.hold("w", 700);
        await t.hold("right", 500);
      });
      await expectReaction(
        t,
        "shooting and walking on",
        async () => {
          await t.key("space");
          await t.hold("s", 600);
        },
        800,
      );
      await t.shot("played");
    },
  },
  {
    id: "watermelon-game",
    name: "Watermelon Game 3D",
    url: "https://github.com/Xella37/Watermelon-Game-3D",
    category: "program",
    section: "Games",
    async run(t) {
      await t.boot();
      await t.shell("wget run https://pinestore.cc/d/psi/32");
      await t.sleep(4000);
      await t.shot("installer");
      for (let i = 0; i < 60 && !/> ?$/.test(t.text().trimEnd()); i++) {
        if (t.has(/[Pp]ress any key|key to/)) await t.key("enter");
        await t.sleep(2000);
      }
      await t.waitForPrompt(10000);
      t.noCrash();
      await t.shell("WatermelonGame");
      await t.waitFor("Press enter to continue", 15000);
      await t.shot("controls");
      await t.key("enter");
      await t.sleep(3000);
      await t.shot("game");
      t.noCrash();
      expectPicture(t, "the game");
      await expectReaction(t, "moving and dropping a fruit", async () => {
        await t.hold("left", 400);
        await t.key("space");
        await t.sleep(1500);
        await t.hold("right", 600);
        await t.key("space");
      });
      await t.shot("dropped");
    },
  },
  {
    id: "tetracraft",
    name: "Tetracraft",
    url: "https://pastebin.com/2jmN835i",
    category: "program",
    section: "Games",
    async run(t) {
      await shellInstall(t, "pastebin get 2jmN835i tetracraft");
      t.hash("tetracraft");
      await t.shell("tetracraft");
      await t.sleep(2500);
      await t.shot("start");
      t.noCrash();
      expectPicture(t, "the game", 4);
      await expectReaction(t, "moving a piece", async () => {
        await t.key("left");
        await t.key("left");
        await t.key("up");
        await t.hold("down", 600);
      });
      await t.shot("played");
      await watchAnimation(t, 3000, 2);
    },
  },
  {
    id: "cc-minecraft",
    name: "CC:Minecraft",
    url: "https://github.com/Xella37/CC-Minecraft",
    category: "program",
    section: "Games",
    async run(t) {
      await pineInstall(t, "pastebin run hgm142Pj");
      await t.shell("Minecraft");
      await t.waitFor("Singleplayer", 20000);
      await t.shot("menu");
      await t.clickText("Singleplayer");
      await t.sleep(1500);
      await t.shot("worlds");
      await t.clickText("New World");
      await t.waitFor("World Creation");
      const name = t.find("Name:");
      await t.click(name.x + 12, name.y);
      await t.type("compat");
      await t.shot("creation");
      await t.clickText("Create World");
      // generating the world takes a while
      await t.waitFor(/^(?![\s\S]*World Creation)/, 60000);
      await t.sleep(6000);
      await t.shot("start");
      t.noCrash();
      expectPicture(t, "the world", 10);
      await expectReaction(t, "walking and looking around", async () => {
        await t.hold("w", 800);
        await t.hold("left", 600);
      });
      await t.shot("walked");
      // break the block in front, pick another and place it
      await t.click(26, 10, 1);
      await t.key("two");
      await t.click(26, 10, 2);
      await t.sleep(500);
      await t.shot("built");
      t.noCrash();
    },
  },
  {
    id: "rubiks-cube",
    name: "CC Rubik's Cube",
    url: "https://github.com/MichielP1807/CC-Rubiks-Cube",
    category: "program",
    section: "Games",
    async run(t) {
      await pineInstall(t, "pastebin run A5wTQs2B");
      await t.shell("Cube");
      await t.sleep(3000);
      await t.shot("cube");
      t.noCrash();
      expectPicture(t, "the cube");
      await expectReaction(t, "turning the cube", () => t.hold("left", 600));
      await expectReaction(t, "turning a face", async () => {
        await t.key("e");
        await t.key("space");
      });
      await t.shot("turned");
    },
  },
  {
    id: "the-button",
    name: "The Button",
    url: "https://github.com/MichielP1807/CC-Bored-Button",
    category: "program",
    section: "Games",
    async run(t) {
      await pineInstall(
        t,
        `wget run ${RAW}/MichielP1807/CC-Bored-Button/main/installer.lua`,
      );
      await t.shell("Button");
      await t.sleep(3000);
      await t.shot("button");
      t.noCrash();
      expectPicture(t, "the button");
      await expectReaction(t, "pressing the button", async () => {
        await t.click(26, 10);
        await t.click(26, 10);
      });
      await t.shot("pressed");
    },
  },
  {
    id: "samurai-salad",
    name: "Samurai Salad",
    url: "https://github.com/MichielP1807/CC-Samurai-Salad",
    category: "program",
    section: "Games",
    async run(t) {
      await pineInstall(t, "pastebin run Sxfk57tP");
      await t.shell("SamuraiSalad");
      await t.sleep(3000);
      await t.shot("start");
      t.noCrash();
      expectPicture(t, "the game");
      // slicing is dragging the mouse across the fruit
      await t.drag(10, 14, 40, 5);
      await t.drag(40, 14, 10, 5);
      await watchAnimation(t, 2500, 3);
      await t.shot("sliced");
    },
  },
  {
    id: "spamtons-jump",
    name: "Spamton's Jump",
    url: "https://github.com/simadude/obsi2-pinejam25-game",
    category: "program",
    section: "Games",
    // its installer fetches the sprites as text: before CC:Tweaked 1.109 a text handle decodes UTF-8 and they
    // arrive damaged ("Unknown character (?) ... Make sure your image is valid")
    minCC: "1.109.0",
    world: SPEAKER,
    async run(t) {
      await t.boot();
      await t.shell(
        `wget run ${RAW}/simadude/obsi2-pinejam25-game/refs/heads/main/installer.lua`,
      );
      await t.sleep(5000);
      await t.shot("installer");
      for (let i = 0; i < 60 && !/> ?$/.test(t.text().trimEnd()); i++) {
        if (t.has("Continue")) await t.clickText("Continue");
        await t.sleep(2000);
      }
      await t.waitForPrompt(10000);
      t.noCrash();
      await t.shot("installed");
      await t.shell("main");
      await t.sleep(3000);
      await t.shot("title");
      t.noCrash();
      expectPicture(t, "the title screen", 4);
      await t.key("enter");
      await t.key("space");
      await t.sleep(1500);
      await expectReaction(t, "running and jumping", async () => {
        await t.hold("right", 600);
        await t.key("space");
        await t.key("up");
      });
      await t.shot("played");
    },
  },
  {
    id: "mine-clicker",
    name: "Mine Clicker",
    url: "https://github.com/Sparkwave2/mine-clicker",
    category: "program",
    section: "Games",
    world: SPEAKER,
    async run(t) {
      await shellInstall(t, "pastebin get hgw016VY mineclicker.lua");
      t.hash("mineclicker.lua");
      await t.shell("mineclicker");
      await t.sleep(2500);
      await t.shot("start");
      t.noCrash();
      expectPicture(t, "the game", 4);
      await expectReaction(t, "clicking the block", async () => {
        for (let i = 0; i < 6; i++) await t.click(12, 9, 1, 80);
      });
      await t.shot("clicked");
    },
  },
  {
    id: "crazy-cargo-crusade",
    name: "Crazy Cargo Crusade",
    url: "https://github.com/SammyForReal/CrazyCargoCrusade",
    category: "program",
    section: "Games",
    async run(t) {
      await shellInstall(
        t,
        "wget https://github.com/SammyForReal/CrazyCargoCrusade/releases/download/0.1.0/ccc.lua",
      );
      t.hash("ccc.lua");
      await t.shell("ccc");
      await t.sleep(4000);
      await t.shot("start");
      t.noCrash();
      expectPicture(t, "the game", 4);
      await t.key("enter");
      await t.sleep(1500);
      await expectReaction(t, "driving", async () => {
        await t.hold("w", 800);
        await t.hold("a", 400);
      });
      await t.shot("driving");
    },
  },
  {
    id: "pumpkin-carver",
    name: "Pumpkin Carver",
    url: "https://github.com/Xella37/Pumpkin-Carver",
    category: "program",
    section: "Games",
    async run(t) {
      await t.boot();
      await t.shell("wget run https://pinestore.cc/d/psi/118");
      await t.sleep(4000);
      for (let i = 0; i < 60 && !/> ?$/.test(t.text().trimEnd()); i++) {
        if (t.has(/[Pp]ress any key|key to/)) await t.key("enter");
        await t.sleep(2000);
      }
      await t.waitForPrompt(10000);
      t.noCrash();
      await t.shell("pumpkincarver");
      // its own instructions end with "Press any key to continue..."
      await t.waitFor("Press any key to continue", 15000);
      await t.shot("instructions");
      await t.key("enter");
      await t.sleep(3000);
      await t.shot("pumpkin");
      t.noCrash();
      expectPicture(t, "the pumpkin");
      await expectReaction(t, "carving", () => t.drag(22, 8, 30, 12));
      await t.shot("carved");
    },
  },
  {
    id: "meowsynth",
    name: "MeowSynthCC",
    url: "https://github.com/MichielP1807/MeowSynthCC",
    category: "program",
    section: "Audio and video players",
    world: SPEAKER,
    async run(t) {
      await pineInstall(
        t,
        `wget run ${RAW}/MichielP1807/MeowSynthCC/main/installer.lua`,
      );
      await t.shell("meow");
      await t.sleep(3000);
      await t.shot("synth");
      t.noCrash();
      expectPicture(t, "the synth");
      const before = audioCount(t);
      // the keyboard row plays notes
      for (let round = 0; round < 5 && audioCount(t) <= before; round++) {
        for (const key of ["a", "s", "d", "f"]) await t.hold(key, 250);
        await t.sleep(1000);
      }
      await t.shot("played");
      t.noCrash();
      if (audioCount(t) <= before)
        t.fail(
          `playing four notes sent the speaker no audio: ${JSON.stringify(t.speaker("right").raw).slice(0, 300)}`,
        );
    },
  },
  {
    id: "herobrine",
    name: "Herobrine",
    url: "https://github.com/MCJack123/Herobrine",
    category: "program",
    section: "Demoscene and proof of concept",
    // the release is one file with its data as raw bytes in a string: before CC:Tweaked 1.109 a program is read as
    // UTF-8 text and those bytes do not survive
    minCC: "1.109.0",
    world: SPEAKER,
    timeoutS: 420,
    async run(t) {
      await shellInstall(
        t,
        "wget https://github.com/MCJack123/Herobrine/releases/download/1.0.1/herobrine.lua herobrine.lua",
        120000,
      );
      t.hash("herobrine.lua");
      await t.shell("herobrine");
      await t.sleep(8000);
      await t.shot("start");
      t.noCrash();
      // the demo is timed to its soundtrack: sample it for a minute and a half
      let frames = 0;
      for (let i = 0; i < 9; i++) {
        frames += await watchAnimation(t, 10000, 1);
        await t.shot(`at-${(i + 1) * 10 + 8}s`);
        if (/> ?$/.test(t.text().trimEnd())) break;
      }
      t.note(`${frames} different frames seen, ${audioCount(t)} audio buffers`);
      if (frames < 40) t.fail(`only ${frames} different frames in the demo`);
      if (audioCount(t) < 10)
        t.fail(`the soundtrack sent the speaker ${audioCount(t)} buffers`);
    },
  },
  {
    id: "4th-dimension",
    name: "4th Dimension",
    url: "https://github.com/MCJack123/4thDimension",
    category: "program",
    section: "Demoscene and proof of concept",
    // Its music is mixed in Lua while it plays. At the 8 times slowdown the other checks use, one mixing pass runs
    // past CC's 7 seconds without yielding; at 4 times it plays, late. It runs here at the engine's own speed, and
    // notes.mjs says so: which of these a real computer is on this workload has not been measured.
    world: { ...SPEAKER, cobaltSpeed: false },
    timeoutS: 420,
    async run(t) {
      const repo = t.clone("https://github.com/MCJack123/4thDimension");
      t.install(repo, ".");
      await t.boot();
      await t.shell("player");
      await t.sleep(8000);
      await t.shot("start");
      t.noCrash();
      let frames = 0;
      for (let i = 0; i < 9; i++) {
        frames += await watchAnimation(t, 10000, 1);
        await t.shot(`at-${(i + 1) * 10 + 8}s`);
        if (/> ?$/.test(t.text().trimEnd())) break;
      }
      t.note(`${frames} different frames seen, ${audioCount(t)} audio buffers`);
      if (frames < 40) t.fail(`only ${frames} different frames in the demo`);
      if (audioCount(t) < 10)
        t.fail(`the soundtrack sent the speaker ${audioCount(t)} buffers`);
    },
  },
  {
    id: "jane-demo",
    name: "Jane Demo",
    url: "https://github.com/piguman3/PineJam2026Demo",
    category: "program",
    section: "Demoscene and proof of concept",
    world: SPEAKER,
    async run(t) {
      const repo = t.clone("https://github.com/piguman3/PineJam2026Demo");
      for (const file of [
        "demo.lua",
        "Pine3D.lua",
        "betterblittle.lua",
        "anim.bin",
        "janecut.dfpwm",
      ])
        t.install(`${repo}/${file}`, file);
      await t.boot();
      const started = Date.now();
      await t.shell("demo");
      await t.sleep(3000);
      await t.shot("start");
      t.noCrash();
      let frames = 0;
      for (let i = 0; i < 4; i++) {
        frames += await watchAnimation(t, 8000, 1);
        await t.shot(`at-${(i + 1) * 8 + 3}s`);
        if (/> ?$/.test(t.text().trimEnd())) break;
      }
      // "a really tiny 38 second demo": it ends on its own
      await t.waitForPrompt(30000);
      const seconds = (Date.now() - started) / 1000;
      t.note(
        `${frames} different frames seen, ${audioCount(t)} audio buffers, ended after ${seconds.toFixed(0)} s`,
      );
      t.noCrash();
      if (frames < 30) t.fail(`only ${frames} different frames in the demo`);
      if (audioCount(t) < 10)
        t.fail(`the soundtrack sent the speaker ${audioCount(t)} buffers`);
      if (seconds < 30 || seconds > 60)
        t.fail(`a 38 second demo took ${seconds.toFixed(0)} s`);
    },
  },
];
