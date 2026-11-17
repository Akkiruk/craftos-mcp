// See ../projects.mjs. Each entry: { id, name, url, category, section, run(t) } with the driver from ../lib.mjs.
const RAW = "https://raw.githubusercontent.com";

/**
 * Walk a wizard: each round, click the first of `buttons` that is on screen (its last occurrence: buttons sit under
 * the text that names them), until `done()` says it is over. Takes a screenshot of every step it sees.
 */
async function wizard(t, buttons, done, rounds = 20, pauseMs = 1500) {
  let last = "";
  for (let i = 0; i < rounds; i++) {
    if (await done()) return;
    const label = buttons.find((b) => t.has(b));
    const now = t.text();
    if (now !== last) await t.shot(`step-${i + 1}`);
    last = now;
    if (label) await t.clickText(label, 1, true);
    await t.sleep(pauseMs);
  }
  t.fail(`the installer did not finish; it shows:\n${t.text()}`);
}

export default [
  {
    id: "opus",
    name: "Opus OS",
    url: "https://github.com/kepler155c/opus",
    category: "os",
    section: "Graphical operating systems",
    timeoutS: 420,
    async run(t) {
      await t.boot();
      await t.shell("pastebin run UzGHLbNC");
      await t.waitFor("Installer v1.0", 60000);
      await wizard(
        t,
        ["Next >", "Accept", "Begin", "Install", "Ok"],
        async () => t.has("Finished") && t.has("Reboot"),
        40,
      );
      await t.shot("installed");
      await t.clickText("Reboot");
      await t.rebooted(60000);
      await t.waitFor("First Time Setup", 60000);
      await t.shot("booted");
      t.noCrash();
      // explore the first-time setup
      for (let i = 0; i < 8; i++) {
        if (!t.has("Next")) break;
        await t.clickText("Next", 1, true);
        await t.sleep(1500);
        await t.shot(`setup-${i + 1}`);
      }
      await t.clickText("Accept", 1, true);
      await t.waitFor("Files", 30000);
      await t.shot("desktop");
      t.noCrash();
      for (const app of ["Shell", "Lua", "Network", "Sniffer"]) t.expect(app);
      // open the file manager from its icon: it lists the computer's root
      const files = t.find("Files");
      await t.doubleClick(files.x + 2, files.y - 1);
      await t.waitFor("startup.lua", 30000);
      await t.shot("files");
      t.expect("sys");
      t.noCrash();
      if (t.has("ccunit") || t.has("results"))
        t.fail("the file manager lists the harness's own folders");
    },
  },
  {
    id: "levelos",
    name: "LevelOS",
    url: "https://discord.com/channels/477910221872824320/1021361044934889482",
    category: "os",
    section: "Graphical operating systems",
    timeoutS: 600,
    async run(t) {
      await t.boot();
      await t.shell("wget run https://install.leveloper.cc");
      await t.waitFor("This is the installer of the LevelOS", 60000);
      await t.shot("installer");
      await t.clickText("Next", 1, true);
      await t.waitFor("I accept the license terms", 20000);
      await t.shot("license");
      // the tick box is left of its label
      const accept = t.find("I accept the license terms");
      await t.click(accept.x - 3, accept.y);
      await t.sleep(500);
      await t.shot("accepted");
      await t.clickText("Next", 1, true);
      await t.waitFor("LevelOS Full", 20000);
      await t.shot("edition");
      await t.clickText("LevelOS Full");
      await t.sleep(500);
      await t.clickText("Next", 1, true);
      // it downloads, restarts on its own and comes up at the desktop with the changelog open
      await t.waitFor("Changelog", 400000);
      await t.sleep(2000);
      await t.shot("desktop");
      t.noCrash();
      t.expect(/v\d+\.\d+\.\d+/);
      // close the changelog with its X, then open the start menu from the taskbar's corner
      const close = t.findLast("\xd7");
      if (close) await t.click(close.x, close.y);
      await t.sleep(1500);
      await t.shot("closed");
      if (t.has("Changelog")) t.fail("the changelog window did not close");
      const { height } = { height: t.lines().length };
      await t.click(2, height);
      await t.waitFor("Task Manager", 15000);
      await t.shot("start-menu");
      t.noCrash();
      t.expect("Shut Down Options");
      for (const icon of ["My PC", "Store"]) t.expect(icon);
      await t.clickText("Task Manager");
      await t.sleep(4000);
      await t.shot("task-manager");
      t.noCrash();
    },
  },
  {
    id: "remos",
    name: "Remos",
    url: "https://github.com/MasonGulu/remos",
    category: "os",
    section: "Graphical operating systems",
    async run(t) {
      await t.boot();
      await t.shell(`wget run ${RAW}/MasonGulu/remos/main/install.lua`);
      await t.waitFor("Welcome to Remos", 60000);
      await wizard(
        t,
        ["Continue", "Install", "Finish", "Done", "Yes"],
        async () => t.exists("startup.lua") && t.has(/[Rr]eboot|[Rr]estart/),
        30,
      );
      await t.shot("installed");
      await t.clickText("Restart", 1, true);
      await t.rebooted(60000);
      await t.waitFor("Shell", 30000);
      await t.shot("home");
      t.noCrash();
      t.expect("Taskmon");
      // open the shell app from its icon and run a command in it
      const icon = t.find("Shell");
      await t.click(icon.x + 2, icon.y - 1);
      await t.sleep(2500);
      await t.shot("shell-app");
      await t.shell("ls");
      await t.sleep(1500);
      await t.shot("shell-ls");
      t.noCrash();
    },
  },
  {
    id: "redos",
    name: "RedOS",
    url: "https://github.com/Redtech0inc/RedOS-cc-Tweaked-",
    category: "os",
    section: "Graphical operating systems",
    // RedOS installs from a floppy disk: the pre-installer writes the installer onto one
    world: { peripherals: [{ name: "left", type: "drive", disk: 0 }] },
    timeoutS: 420,
    async run(t) {
      await t.boot();
      await t.shell("pastebin get dJFjzruV redOS-PreInstaller.lua");
      await t.waitForPrompt();
      await t.shell("redOS-PreInstaller.lua");
      await t.waitFor("y/n:", 30000);
      await t.shot("preinstaller");
      await t.shell("y");
      await t.waitFor("press enter if you don't want to do this", 30000);
      await t.shot("token");
      // Its own bug, the same on a real computer: Enter (no GitHub token) is offered, but the loop that asks only
      // ends with a token (`while not token and input ~= ""`, where `input` is never set). So stop it there and put
      // the repository's `os` folder on the floppy by hand, which is all the pre-installer goes on to do.
      await t.key("enter");
      await t.waitFor("you can only do 60 requests / hour", 10000);
      await t.terminate();
      await t.waitForPrompt(10000);
      t.note(
        "the pre-installer never leaves its token prompt without a GitHub token (its own bug); the disk was filled by hand",
      );
      const repo = t.clone("https://github.com/Redtech0inc/RedOS-cc-Tweaked-");
      const { cpSync } = await import("node:fs");
      cpSync(`${repo}/os`, t.diskDir(0), { recursive: true });
      // a computer starts from a disk's startup.lua: that is the installer
      await t.shell("reboot");
      await t.rebooted();
      await t.waitFor("This is the RedOS Installer", 30000);
      await t.shot("installer");
      await t.shell("i");
      await t.waitFor("do you want to restart the system now", 120000);
      await t.shot("installed");
      t.noCrash();
      // take the disk out before restarting, or the installer starts again
      await t.shell("n");
      await t.waitForPrompt(10000);
      await t.shell("eject left");
      await t.shell("reboot");
      await t.rebooted();
      // the desktop: an icon for each file and folder, and the "ROS" bar along the bottom
      await t.waitFor("ROS", 30000);
      await t.shot("desktop");
      t.noCrash();
      t.expect("sys");
      const before = t.frameHash();
      // open the system folder: a double click on its icon
      const folder = t.find("sys");
      await t.click(folder.x + 1, folder.y, 1, 100);
      await t.click(folder.x + 1, folder.y);
      await t.sleep(2500);
      await t.shot("folder");
      t.noCrash();
      if (t.frameHash() === before)
        t.fail("clicking the system folder's icon changed nothing");
    },
  },
  {
    id: "quint",
    name: "Quint",
    url: "https://pinestore.cc/projects/146/quint",
    category: "os",
    section: "Graphical operating systems",
    async run(t) {
      await t.boot();
      await t.shell("pastebin run xJvxCaeB");
      // its installer fetches three programs and Basalt, then reboots into the desktop
      await t.waitFor("KSDOS", 120000);
      await t.shot("desktop");
      t.noCrash();
      t.expect("Snake");
      await t.clickText("About");
      await t.waitFor("ABOUT QUINT");
      await t.shot("about");
      t.expect("Made by: Kubesoft Studio");
      await t.clickText("X");
      await t.sleep(500);
      await t.clickText("Snake");
      await t.sleep(2000);
      await t.shot("snake");
      t.noCrash();
      await t.key("right");
      await t.key("down");
      await t.sleep(1000);
      await t.shot("snake-moved");
      t.noCrash();
    },
  },
  {
    id: "phoenix",
    name: "Phoenix",
    url: "https://phoenix.madefor.cc",
    category: "os",
    section: "Headless operating systems",
    timeoutS: 600,
    async run(t) {
      await t.boot();
      await t.shell("wget run https://phoenix.madefor.cc/install.lua");
      await t.waitFor("To install Phoenix now, press ENTER", 60000);
      await t.shot("setup");
      await t.sleep(1000);
      await t.key("enter");
      await t.waitFor("Please read the following important information");
      await t.key("enter");
      await t.waitFor("F=Agree");
      await t.shot("licence");
      await t.key("f");
      await t.waitFor("desired root directory");
      await t.key("enter"); // /root
      await t.waitFor("Luz file");
      await t.key("enter"); // the full-size kernel
      await t.waitFor("using a span");
      await t.key("enter"); // one drive
      await t.waitFor("username for the primary user");
      await t.type("compat");
      await t.key("enter");
      await t.waitFor("enter the password");
      await t.type("hunter22");
      await t.key("enter");
      await t.waitFor("password again");
      await t.type("hunter22");
      await t.key("enter");
      await t.waitFor("Select the components");
      await t.shot("components");
      await t.key("enter");
      await t.waitFor("ENTER=Install", 20000);
      await t.shot("review");
      await t.key("enter");
      // it downloads, unpacks, then starts the new kernel in place of CraftOS and goes on installing there
      for (let i = 0; i < 90; i++) {
        await t.sleep(5000);
        if (i % 6 === 0) await t.shot(`install-${i / 6 + 1}`);
        if (t.has(/installation is complete|An error occurred|panic/i)) break;
      }
      await t.shot("after-install");
      t.expect("The Phoenix installation is complete");
      await t.key("enter");
      await t.rebooted(60000);
      // the login prompt of the new system
      for (let i = 0; i < 24 && !t.has(/login:/i); i++) await t.sleep(5000);
      await t.shot("login");
      t.expect(/login:/i);
      await t.shell("compat");
      await t.waitFor(/[Pp]assword/, 20000);
      await t.shell("hunter22");
      await t.sleep(6000);
      await t.shot("logged-in");
      await t.shell("ls /");
      await t.sleep(3000);
      await t.shell("uname -a");
      await t.waitFor(/Phoenix \d+\.\d+/, 15000);
      await t.shot("shell");
      t.expect("compat@localhost");
      for (const folder of ["bin", "etc", "home", "usr"]) t.expect(folder);
      // uname ends with the host string: the kernel runs on what it takes for a CC:Tweaked computer
      t.expect(/ComputerCraft 1\.\d+\.\d+ \(Minecraft/);
    },
  },
  {
    id: "ozy-os",
    name: "OZY OS",
    url: "https://github.com/Kuberow/OZY-OS",
    category: "os",
    section: "Headless operating systems",
    async run(t) {
      await t.boot();
      await t.shell(`wget run ${RAW}/Kuberow/OZY-OS/main/install.lua`);
      await t.waitFor("Fully Installed.", 120000);
      await t.waitForPrompt();
      await t.shot("installed");
      t.noCrash();
      await t.shell("reboot");
      await t.rebooted();
      // its boot menu ("OZY RUB") starts the first entry after three seconds
      await t.waitFor("OZY RUB", 15000);
      await t.shot("boot-menu");
      await t.waitFor("admin! |", 20000);
      await t.shot("booted");
      t.noCrash();
      await t.shell("ls");
      await t.sleep(1500);
      await t.shell("help");
      await t.sleep(1500);
      await t.shot("commands");
    },
  },
  {
    id: "ipod-os",
    name: "iPod OS",
    url: "https://github.com/kaykaypoopaa/Ipod-CC-Tweaked",
    category: "os",
    section: "Headless operating systems",
    world: { kind: "pocket" },
    async run(t) {
      await t.boot();
      await t.shell(
        `wget run ${RAW}/kaykaypoopaa/Ipod-CC-Tweaked/refs/heads/main/installer.lua`,
      );
      await t.waitFor("Welcome to ipod os", 120000);
      await t.shot("menu");
      t.noCrash();
      await t.key("down");
      await t.key("down");
      await t.shot("menu-down");
      await t.key("enter");
      await t.sleep(2000);
      await t.shot("opened");
      t.noCrash();
    },
  },
];
