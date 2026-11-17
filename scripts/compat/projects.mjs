// The projects scripts/compat/run.mjs checks, picked from the awesome-cctweaked list: the popular and well known
// ones in each section, and every operating system that still installs.
//
// Each entry fetches the project when it runs (nothing of theirs is kept here) and then uses it as a player would.
// `run(t)` gets the driver from lib.mjs. The small Lua demos in these files are ours, written against each
// library's documented API.
//
//   id        short name, also the folder its downloads and screenshots go in
//   name, url what docs/compatibility.md links
//   category  "library" | "program" | "os"; section: the list's own heading
//   world     extra world settings (peripherals: speakers, modems, drives, ...; kind: "pocket"); monitors: monitor walls
//   computers several computers whose modems reach each other: [{ name, world, monitors }]; `run` gets the first
//   wired     wired networks: [{ id, peripherals }] (chests behind modems on a cable), joined with a wired modem
//   minCC     the oldest CC:Tweaked it runs on ("1.109.0"): on an older one it is expected to fail
//   expect    "broken" for a project known not to run; notes.mjs says why
//   timeoutS  the whole check's limit, default 300
// What docs/compatibility.md says about each project is in notes.mjs, by id.
import librariesUi from "./projects/libraries-ui.mjs";
import librariesOther from "./projects/libraries-other.mjs";
import programs from "./projects/programs.mjs";
import gamesMedia from "./projects/games-media.mjs";
import os from "./projects/os.mjs";

export const projects = [
  ...librariesUi,
  ...librariesOther,
  ...programs,
  ...gamesMedia,
  ...os,
];
