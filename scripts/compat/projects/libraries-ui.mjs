// See ../projects.mjs. Each entry: { id, name, url, category, section, run(t) } with the driver from ../lib.mjs.
import { shellInstall, watchAnimation } from "../helpers.mjs";

const RAW = "https://raw.githubusercontent.com";

/** A Lua line that writes `value` to `file`, for demos that report what happened. */
const NOTE = `local function note(file, value) local h = fs.open(file, "w") h.write(tostring(value)) h.close() end`;

export default [
  {
    id: "basalt",
    name: "Basalt",
    url: "https://github.com/Pyroxenium/Basalt",
    category: "library",
    section: "UI frameworks",
    monitors: [{ name: "top", blocksWide: 3, blocksHigh: 2 }],
    async run(t) {
      await shellInstall(
        t,
        `wget run ${RAW}/Pyroxenium/Basalt/master/docs/install.lua release latest.lua`,
      );
      if (!t.exists("basalt.lua")) t.fail("the installer left no basalt.lua");
      t.hash("basalt.lua");
      t.put(
        "demo.lua",
        `${NOTE}
local basalt = require("basalt")
local main = basalt.createFrame()
local label = main:addLabel():setText("Hello Basalt"):setPosition(2, 2)
local button = main:addButton():setText("Press"):setPosition(2, 4):setSize(12, 3)
button:onClick(function() label:setText("Clicked!") note("clicked.txt", "yes") end)
local input = main:addInput():setPosition(2, 8):setSize(20, 1)
input:onChange(function(self) note("typed.txt", self:getValue()) end)
local list = main:addList():setPosition(26, 2):setSize(14, 6)
for i = 1, 10 do list:addItem("Item " .. i) end
list:onChange(function(self) note("picked.txt", self:getItem(self:getItemIndex()).text) end)
local mon = basalt.addMonitor():setMonitor("top")
mon:addButton():setText("Touch"):setPosition(2, 2):setSize(10, 3):onClick(function(self)
  self:setText("Touched") note("touched.txt", "yes")
end)
basalt.autoUpdate()
`,
      );
      await t.shell("demo");
      await t.waitFor("Hello Basalt");
      await t.waitFor("Touch", 5000, "top");
      await t.shot("start");
      await t.click(5, 5);
      await t.waitFor("Clicked!");
      await t.click(4, 8);
      await t.type("hello");
      await t.waitFor("hello");
      await t.click(28, 4);
      await t.touch("top", 4, 3);
      await t.waitFor("Touched", 5000, "top");
      await t.shot("used");
      t.noCrash();
      if (t.read("typed.txt") !== "hello")
        t.fail(`the input holds "${t.read("typed.txt")}", not hello`);
      if (t.read("picked.txt") !== "Item 3")
        t.fail(`the list picked "${t.read("picked.txt")}", not Item 3`);
    },
  },
  {
    id: "basalt2",
    name: "Basalt 2",
    url: "https://github.com/Pyroxenium/Basalt2",
    category: "library",
    section: "UI frameworks",
    async run(t) {
      await shellInstall(
        t,
        `wget run ${RAW}/Pyroxenium/Basalt2/main/install.lua -f`,
      );
      if (!t.exists("basalt.lua")) t.fail("the installer left no basalt.lua");
      t.hash("basalt.lua");
      t.put(
        "demo.lua",
        `${NOTE}
local basalt = require("basalt")
local main = basalt.getMainFrame()
local label = main:addLabel({ x = 2, y = 2, text = "Hello Basalt2" })
main:addButton({ x = 2, y = 4, width = 12, height = 3, text = "Press" }):onClick(function()
  label:setText("Clicked!") note("clicked.txt", "yes")
end)
local input = main:addInput({ x = 2, y = 8, width = 20 })
input:onChange("text", function(self, value) note("typed.txt", value) end)
basalt.run()
`,
      );
      await t.shell("demo");
      await t.waitFor("Hello Basalt2");
      await t.shot("start");
      await t.click(5, 5);
      await t.waitFor("Clicked!");
      await t.click(4, 8);
      await t.type("hello");
      await t.waitFor("hello");
      await t.shot("used");
      t.noCrash();
      if (t.read("typed.txt") !== "hello")
        t.fail(`the input holds "${t.read("typed.txt")}", not hello`);
      // its own examples
      await t.terminate();
      await t.shell("clear");
      for (const example of ["graphs", "TabControl"]) {
        await t.shell(
          `wget ${RAW}/Pyroxenium/Basalt2/main/examples/${example}.lua ${example}.lua`,
          1500,
        );
        await t.waitForPrompt();
        await t.shell(example);
        await t.settle(700, 8000);
        await t.shot(example);
        t.noCrash();
        if (t.variety() < 4) t.fail(`${example} drew next to nothing`);
        await t.click(10, 2);
        await t.click(20, 8);
        t.noCrash();
        await t.terminate();
        await t.shell("clear");
      }
    },
  },
  {
    id: "pixelui",
    name: "PixelUI",
    url: "https://github.com/Shlomo1412/PixelUI",
    category: "library",
    section: "UI frameworks",
    // written with goto, which CC:Tweaked has from 1.109 (Lua 5.2)
    minCC: "1.109.0",
    async run(t) {
      await shellInstall(t, `wget ${RAW}/Shlomo1412/PixelUI/main/pixelui.lua`);
      await shellInstall(t, `wget ${RAW}/Shlomo1412/PixelUI/main/demo.lua`);
      t.hash("pixelui.lua");
      await t.shell("demo");
      await t.settle(700, 10000);
      await t.shot("demo");
      t.noCrash();
      if (t.variety() < 6) t.fail("the demo drew next to nothing");
      const before = t.frameHash();
      await t.click(10, 5);
      await t.click(25, 8);
      await t.key("tab");
      await t.type("abc");
      await t.settle(400, 3000);
      await t.shot("used");
      t.noCrash();
      if (t.frameHash() === before)
        t.fail("clicking and typing changed nothing on screen");
    },
  },
  {
    id: "primeui",
    name: "PrimeUI",
    url: "https://github.com/MCJack123/PrimeUI",
    category: "library",
    section: "UI frameworks",
    async run(t) {
      const repo = t.clone("https://github.com/MCJack123/PrimeUI");
      t.install(repo, "primeui");
      await t.boot();
      await t.shell("cd primeui");
      await t.shell("test");
      // its test program walks through every component, one page at a time
      await t.waitFor("Sample Text");
      await t.waitFor("Next");
      await t.shot("scrollbox");
      await t.scroll(10, 10, 1);
      await t.key("enter");
      await t.waitFor("Item 1");
      await t.shot("checkboxes");
      await t.key("space");
      await t.key("down");
      await t.key("space");
      await t.key("enter");
      await t.settle(500, 5000);
      await t.shot("page3");
      t.noCrash();
      for (let page = 0; page < 8 && !/> ?$/.test(t.text().trimEnd()); page++) {
        await t.type("x");
        await t.key("enter");
        await t.settle(500, 4000);
        t.noCrash();
      }
      await t.shot("end");
    },
  },
  {
    id: "tamperer",
    name: "Tamperer 2.0",
    url: "https://github.com/Fatboychummy-CC/Tamperer",
    category: "library",
    section: "UI frameworks",
    async run(t) {
      await t.boot();
      await t.shell(
        `wget run ${RAW}/Fatboychummy-CC/Tamperer/refs/heads/better/installer.lua lib no_ccryptolib`,
      );
      await t.waitFor("(y/n)", 30000);
      await t.shell("y");
      await t.waitFor("What version", 30000);
      await t.shell("no_ccryptolib");
      await t.waitForPrompt(60000);
      t.noCrash();
      await t.shot("installed");
      if (!t.exists("lib/tamperer.lua") && !t.exists("lib/tamperer/init.lua"))
        t.fail(`the installer left no tamperer in lib: ${t.list("lib")}`);
      await t.shell("clear");
      t.put(
        "demo.lua",
        `${NOTE}
package.path = package.path .. ";lib/?.lua;lib/?/init.lua"
local tamperer = require("tamperer")
local menu = tamperer.new({ title = "Main Menu", description = "A menu of ours" })
menu:add_number("volume", "Volume", "Volume of the music", 50, 0, 100)
menu:add_boolean("fullscreen", "Fullscreen", "Enable fullscreen mode", false)
menu:set_on_change(function(m, selection)
  note("changed.txt", selection.i_label .. "=" .. tostring(selection.value))
end)
menu:run()
`,
      );
      await t.shell("demo");
      await t.waitFor("Main Menu");
      await t.waitFor("Fullscreen");
      await t.shot("menu");
      await t.key("down");
      await t.key("enter");
      await t.settle(400, 3000);
      await t.shot("toggled");
      t.noCrash();
      if (!t.exists("changed.txt"))
        t.fail("toggling Fullscreen never reached the change callback");
      if (t.read("changed.txt") !== "fullscreen=true")
        t.fail(`the callback saw ${t.read("changed.txt")}`);
    },
  },
  {
    id: "obsi2",
    name: "Obsi 2",
    url: "https://github.com/simadude/obsi2",
    category: "library",
    section: "2D game development",
    async run(t) {
      const repo = t.clone("https://github.com/simadude/obsi2");
      t.install(repo, "obsi2");
      t.put(
        "main.lua",
        `local obsi = require("obsi2")
local x, frames = 1, 0
function obsi.update(dt)
  if obsi.keyboard.isDown("right") then x = x + 40 * dt end
  frames = frames + 1
  if frames % 5 == 0 then
    local h = fs.open("state.txt", "w") h.write(math.floor(x) .. " " .. frames) h.close()
  end
end
function obsi.draw()
  obsi.graphics.setBackgroundColor(colors.blue)
  obsi.graphics.setForegroundColor(colors.yellow)
  obsi.graphics.rectangle("fill", math.floor(x), 5, 6, 4)
  obsi.graphics.write("obsi " .. frames, 2, 1)
end
obsi.init()
`,
      );
      await t.boot();
      await t.shell("main");
      await t.waitFor(/obsi \d+/);
      await watchAnimation(t, 1500, 5);
      await t.shot("start");
      const before = Number(t.read("state.txt").split(" ")[0]);
      await t.hold("right", 1000);
      await t.sleep(300);
      await t.shot("moved");
      const after = Number(t.read("state.txt").split(" ")[0]);
      if (!(after > before + 10))
        t.fail(`holding right moved the box from ${before} to ${after}`);
      t.noCrash();
    },
  },
  {
    id: "pine3d",
    name: "Pine3D",
    url: "https://github.com/Xella37/Pine3D",
    category: "library",
    section: "3D renderers",
    async run(t) {
      const repo = t.clone("https://github.com/Xella37/Pine3D");
      t.install(repo, ".");
      await t.boot();
      await t.shell("Mountains");
      await t.sleep(2500);
      t.noCrash();
      await t.shot("mountains");
      if (t.variety() < 10) t.fail("the mountains scene drew next to nothing");
      const before = t.frameHash();
      await t.hold("w", 800);
      await t.hold("left", 600);
      await t.shot("flown");
      t.noCrash();
      if (t.frameHash() === before)
        t.fail("flying with W and the arrow keys did not change the view");
    },
  },
  {
    id: "c3d",
    name: "C3D",
    url: "https://github.com/9551-Dev/libC3D-dev",
    category: "library",
    section: "3D renderers",
    async run(t) {
      await shellInstall(
        t,
        `wget run ${RAW}/9551-Dev/C3D/master/installer.lua`,
        180000,
      );
      if (!t.exists("c3d.lua")) t.fail("the installer left no c3d.lua");
      // the spinning cube of its documentation (c3d.madefor.cc, "texturing"), without the texture
      t.put(
        "cube/main.lua",
        `local cube = c3d.geometry.cube_simple()
local frames = 0
function c3d.load()
  cube = cube:push():reposition(0, 0, 1)
end
function c3d.update()
  frames = frames + 1
  cube:set_rotation(0, 1, 0, os.epoch("utc") / 10)
  if frames % 5 == 0 then
    local h = fs.open("frames.txt", "w") h.write(tostring(frames)) h.close()
  end
end
`,
      );
      await t.shell("c3d cube");
      await t.sleep(2000);
      t.noCrash();
      await watchAnimation(t, 2000, 4);
      await t.shot("cube");
      if (!(Number(t.read("frames.txt")) > 10))
        t.fail("the update callback barely ran");
    },
  },
  {
    id: "pixelbox",
    name: "Pixelbox Lite",
    url: "https://github.com/9551-Dev/pixelbox_lite",
    category: "library",
    section: "Teletext renderers",
    async run(t) {
      await shellInstall(
        t,
        `wget ${RAW}/9551-Dev/pixelbox_lite/master/pixelbox_lite.lua`,
      );
      t.hash("pixelbox_lite.lua");
      // the two programs in its examples folder
      for (const example of ["first", "chladni"]) {
        await shellInstall(
          t,
          `wget ${RAW}/9551-Dev/pixelbox_lite/master/examples/${example}.lua`,
        );
      }
      await t.shell("clear");
      await t.shell("first");
      await t.sleep(500);
      await t.shot("first");
      t.noCrash();
      // first.lua: a blue column at pixel x 5 and a yellow one at 7, rows 5 to 7, joined by one blue pixel. Pixels are
      // 2x3 to a cell, so that is cells (3,2) to (4,3), drawn with teletext characters in those two colours. The
      // render leaves the cursor on the last line, so the shell's next prompt scrolls it all up a line.
      const drawn = [t.cell(3, 1), t.cell(4, 1), t.cell(3, 2), t.cell(4, 2)];
      const colours = new Set(drawn.flatMap((c) => [c.fg, c.bg]));
      if (!drawn.every((c) => c.code >= 128 && c.code < 160))
        t.fail(`expected teletext characters, got ${JSON.stringify(drawn)}`);
      if (!colours.has(11) || !colours.has(4))
        t.fail(`expected blue and yellow, got ${JSON.stringify(drawn)}`);
      await t.shell("clear");
      await t.shell("chladni");
      await t.sleep(1500);
      await t.shot("chladni");
      t.noCrash();
      if (t.variety() < 8) t.fail("the Chladni figure drew next to nothing");
    },
  },
  {
    id: "shrekbox",
    name: "Shrekbox",
    url: "https://codeberg.org/ShreksHellraiser/shrekbox",
    category: "library",
    section: "Teletext renderers",
    async run(t) {
      const repo = t.clone("https://codeberg.org/ShreksHellraiser/shrekbox");
      // the demos folder reaches the two libraries through symbolic links, which a computer has none of: a player
      // puts the libraries and a demo side by side
      for (const file of ["shrekbox.lua", "shrekdraw.lua"])
        t.install(`${repo}/${file}`, file);
      for (const demo of ["snow", "lines", "pipes"])
        t.install(`${repo}/demos/${demo}.lua`, `${demo}.lua`);
      await t.boot();
      for (const demo of ["snow", "pipes"]) {
        await t.shell(demo);
        await t.sleep(1200);
        t.noCrash();
        const frames = await watchAnimation(t, 1500, 3);
        t.note(`${demo}: ${frames} frames in 1.5 s`);
        await t.shot(demo);
        await t.terminate();
        await t.shell("clear");
      }
      // lines.lua is a drawing program: drag the mouse and the three layers each get a line
      await t.shell("lines");
      await t.waitFor("Draw!");
      const empty = t.variety();
      await t.drag(5, 3, 40, 14);
      await t.shot("lines");
      t.noCrash();
      if (t.variety() <= empty + 2)
        t.fail("dragging the mouse across the screen drew no line");
    },
  },
  {
    id: "morefonts",
    name: "More Fonts",
    url: "https://github.com/MichielP1807/more-fonts",
    category: "library",
    section: "Fonts",
    async run(t) {
      await t.boot();
      await t.shell(
        `wget run ${RAW}/MichielP1807/more-fonts/main/installer.lua`,
      );
      await t.waitFor("Finished installation!", 60000);
      await t.shot("installer");
      await t.key("enter");
      await t.waitForPrompt();
      if (!t.exists("morefonts.lua"))
        t.fail("the installer left no morefonts.lua");
      t.hash("morefonts.lua");
      await t.shell("fontbrowser");
      // on its first run it downloads every font and sleeps a second (which drops keys); it draws nothing until the
      // first event after that, so the download list stays up until a key is pressed
      await t.waitFor("Downloading", 30000);
      await t.settle(2500, 120000);
      await t.key("left");
      await t.waitFor(/^(?![\s\S]*Downloading)/, 20000);
      await t.shot("browser");
      t.noCrash();
      const first = t.frameHash();
      await t.key("right");
      await t.settle(600, 8000);
      await t.shot("next-font");
      t.noCrash();
      if (t.frameHash() === first)
        t.fail("the right arrow did not show another font");
      if (t.variety() < 6) t.fail("the font browser drew next to nothing");
    },
  },
  {
    id: "bigfont",
    name: "Bigfont",
    url: "https://pastebin.com/3LfWxRWh",
    category: "library",
    section: "Fonts",
    monitors: [{ name: "top", blocksWide: 4, blocksHigh: 2, textScale: 0.5 }],
    async run(t) {
      await shellInstall(t, "pastebin get 3LfWxRWh bigfont");
      t.hash("bigfont");
      t.put(
        "demo.lua",
        `local bigfont = require("bigfont")
term.clear() term.setCursorPos(1, 1)
bigfont.bigPrint("Big")
bigfont.hugePrint("Huge")
local mon = peripheral.wrap("top")
mon.clear()
bigfont.writeOn(mon, 1, "MONITOR", 2, 2)
print("done")
`,
      );
      await t.shell("demo");
      await t.waitFor("done");
      await t.shot("fonts");
      t.noCrash();
      // big text is drawn with the teletext characters 128 to 159, three rows a line
      const teletext = (monitor) =>
        t
          .lines(monitor)
          .join("")
          .split("")
          .filter((c) => c.charCodeAt(0) >= 128 && c.charCodeAt(0) < 160)
          .length;
      if (teletext() < 20) t.fail("the terminal shows no big letters");
      if (teletext("top") < 10) t.fail("the monitor shows no big letters");
    },
  },
];
