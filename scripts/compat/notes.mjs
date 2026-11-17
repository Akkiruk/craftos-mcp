// What docs/compatibility.md says about each project besides its result (report.mjs puts the two together):
//   does   what the check does, in a few words
//   note   a caveat on a project that works ("works with notes")
//   why    why a project does not work (for one marked `expect: "broken"`)
//   fixed  what running it changed in the emulator
export const notes = {
  basalt: {
    does: "Installs the release with its installer; a frame with a button, an input and a list on the terminal, and a button on a monitor; clicks, types and touches",
  },
  basalt2: {
    does: "Installs the full release; label, button and input; then its own graphs and TabControl examples",
  },
  pixelui: {
    does: "Its own demo.lua: clicks widgets, types into a text box",
  },
  primeui: {
    does: "Its own test.lua, page by page: scroll box, check boxes, selection, input",
  },
  tamperer: {
    does: "Installs through its installer's prompts; a menu with a number and a boolean, toggled from the keyboard",
    note: 'the README\'s `tamperer.new("Main Menu")` no longer matches the library, which takes a table',
  },
  obsi2: {
    does: "A small game loop of ours: draws, reads held keys, moves a box",
  },
  pine3d: {
    does: "Its Mountains demo: flies with W and the arrow keys",
  },
  c3d: {
    does: "Installs with its installer; the spinning cube of its documentation",
    fixed:
      "`_HOST` named CraftOS-PC, so C3D called CraftOS-PC's `config` API and died; and the shell's window had a `getGraphicsMode` that raised, so `c3d` ended with a blank screen. Both fixed",
  },
  pixelbox: {
    does: "Its two examples, first.lua and chladni.lua; checks the teletext cells and colours of the first",
  },
  shrekbox: {
    does: "Its snow and pipes demos (animation), and lines.lua drawn with the mouse",
    note: "the demos folder reaches the libraries through symbolic links, which a computer has none of: the check puts the files side by side",
  },
  morefonts: {
    does: "Installs with its installer; the font browser downloads every font, then left and right step through them",
  },
  bigfont: {
    does: "Big and huge text on the terminal and on a monitor",
  },
  ecnet2: {
    does: "Its ping example between two computers with wireless modems: handshake, encrypted message and reply",
  },
  taskmaster: {
    does: "Tasks in parallel, event listeners, a timer, waitForAny",
  },
  redrun: {
    does: "A background task that outlives the program that started it, answers events from the shell prompt, and is killed",
  },
  "fatboychummy-thread": {
    does: "Threads with after and on_error handlers, stopped from inside",
  },
  aes: {
    does: "The FIPS-197 AES-128 vector, decryption, and a CBC round trip",
  },
  sha256: {
    does: "SHA-256, HMAC (RFC 4231) and PBKDF2 (RFC 7914) test vectors",
  },
  hopper: {
    does: "Three chests on a wired network: moves everything but the diamonds from the shell, then 20 iron ingots through `require`",
  },
  oil: {
    does: "A storage of two networked chests, a partition over it, item counts",
  },
  desyncc: {
    does: "Installs with its installer; async and await of ours, then its own asyncAwait test with its five second wait",
    note: "`desyncc.getVersion()` is documented as static but needs an instance",
  },
  telem: {
    does: "Its mouse and keyboard installer (compact release); a backplane with its hello-world, item storage and custom inputs and a custom output",
  },
  "cc-misc": {
    does: "Its installer's server and base options; restarts into the storage server, which asks for its modem and indexes four networked chests",
  },
  "github-downloader": {
    does: "Pastes a repository address, downloads it whole, clicks Continue",
    note: "uses the GitHub API without a key, as it does on a server: 60 requests an hour for one address",
  },
  consult: {
    does: "Opens a new file, types two lines, saves with Ctrl+S, runs it with F5",
  },
  quark: {
    does: "Installs with its installer; New File from the welcome screen, types a line",
  },
  shrekword: {
    does: "Types a sentence, File > Save As from the menu, quits with Ctrl+Q; checks the saved document",
  },
  spritemog: {
    does: "Picks the palette and a new sprite, draws with the mouse",
  },
  pixelcode: {
    does: "Types a line into the editor, opens its toolbar with Alt",
  },
  "craft-web": {
    does: "Its installer (with its own PixelUI); the browser's home page; Exit",
  },
  musicify: {
    does: "Installs the release; scrolls the song list; plays song 1 through a speaker",
    fixed:
      '`read(n)` on an http response gave what the socket had ready, often nothing: the player decoded an empty chunk and stopped at "Cannot play empty audio". Fixed',
  },
  quartz: {
    does: "Records 100 kB of a song onto a floppy disk, starts the player with two speakers: stereo is found, space plays the disk",
    fixed:
      "A world could not start with a floppy in a drive; a floppy was as big as the host's disk and `fs.getDrive` called it `disk`. All three fixed",
  },
  pocketbox: {
    does: "A one-song playlist from a URL, played through a speaker",
    note: "the README calls the playlist `autoplay.pd`; the program reads `autoplay.pb`",
    fixed: "The same http `read(n)` bug as Musicify",
  },
  ccmaps: {
    does: "Draws the world map from its tile server, drags it and zooms",
  },
  chess: {
    does: "Installs with its installer; the main menu, a local game, clicks on the board",
    note: "`main` only starts the version for CraftOS-PC's graphics mode; on CC:Tweaked it returns without a word (its text-mode branch tests a variable that is never set). The check starts `TM.lua`, the text-mode game, the way that branch would",
  },
  ccdoom: {
    does: "Installs from pastebin; starts a level, walks, turns and shoots",
  },
  "watermelon-game": {
    does: "Installs from PineStore; moves the cursor and drops fruit",
  },
  tetracraft: {
    does: "Moves, turns and drops pieces while the game runs",
  },
  "cc-minecraft": {
    does: "Creates a world from its menus, walks and looks around, breaks and places a block",
  },
  "rubiks-cube": {
    does: "Turns the cube and a face from the keyboard",
  },
  "the-button": {
    does: "Presses the button with the mouse",
  },
  "samurai-salad": {
    does: "Slices across the screen with the mouse while fruit flies",
  },
  "spamtons-jump": {
    does: "Its mouse-driven installer; title screen, then runs and jumps",
  },
  "mine-clicker": {
    does: "Clicks the block; the counters move",
  },
  "crazy-cargo-crusade": {
    does: "Starts a round and drives with W and A",
  },
  "pumpkin-carver": {
    does: "Installs from PineStore; carves the pumpkin with the mouse",
  },
  meowsynth: {
    does: "Plays four notes on the keyboard row; the speaker gets audio",
  },
  herobrine: {
    does: "Runs the demo for a minute and a half: on a computer as slow as a real one it loads its music for some minutes first, with a tune and an animated bar",
    note: "the check sees the loading screen and its music, not the demo that follows",
    fixed:
      "At the engine's own speed (about 8 times a server's) it took its fast-computer path and its music stopped after a second. The checks now run at CC:Tweaked's speed; `_HOST` naming CraftOS-PC also shifted its timing. Looking at why it needs CC:Tweaked 1.109 found that a backslash before an unknown character was an error here and is not in the game. Fixed",
  },
  "4th-dimension": {
    does: "Runs the demo for a minute and a half with its soundtrack: 3D scenes, text effects",
    note: "checked at the emulator's own speed. It mixes its music in Lua as it plays: slowed 8 times, the emulator's model of CC:Tweaked's speed, one pass runs into \"Too long without yielding\", and slowed 4 times the music falls behind. How fast a real computer is on this kind of work has not been measured, so this one may not run in the game as it does here",
  },
  "jane-demo": {
    does: "Plays the whole demo: it ends on its own after about 38 seconds, with its soundtrack",
  },
  opus: {
    does: "Its installer's wizard, restart, the first-time setup, the desktop; opens the file manager",
    fixed:
      "The root folder listed the emulator's `/ccunit` and `/results` beside `rom`: a file manager showed them. Fixed",
  },
  levelos: {
    does: "Its installer (licence, edition, download), restart, the desktop with its changelog; closes it, opens the start menu and the task manager",
    fixed:
      "`debug.sethook` was refused while the emulator ran at CC:Tweaked's speed, and LevelOS stopped at its blue screen. Fixed",
  },
  remos: {
    does: "Its installer, restart, the home screen; opens the Shell app from its icon and runs a command",
  },
  redos: {
    does: "Installs from a floppy disk as it is meant to, restarts into the desktop",
    note: "its pre-installer cannot be left without a GitHub token (its own bug, the same on a server), so the check fills the floppy from the repository by hand and goes on from there",
    fixed: "A world can now start with a floppy disk in a drive",
  },
  quint: {
    does: "Its installer restarts into the desktop; opens About, then the Snake game",
  },
  phoenix: {
    does: "The whole installer: licence, user, components, the switch into the Phoenix kernel and the install inside it; restart, log in, run commands",
  },
  "ozy-os": {
    does: "Installs, restarts through its boot menu into its shell, runs ls and help",
  },
  "ipod-os": {
    does: "Installs on a pocket computer and walks its menus",
    fixed:
      'A pocket computer had no `pocket` API, and the installer refused with "Please use a pocket computer." Fixed',
  },
};
