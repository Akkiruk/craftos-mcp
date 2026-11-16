// The vanilla suite again, on Minecraft 1.20.1 (CC:Tweaked 1.121.0): plain CC:Tweaked with its own server rules, through
// CRAFTOS_VERSION, which the runner reads when a world names no version (versions.ts). The case that needs the 1.18.2
// server mod skips itself there.
process.env["CRAFTOS_VERSION"] = "1.20.1";
await import("./vanilla.integration.test.js");
