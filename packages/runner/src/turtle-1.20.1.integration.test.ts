// The turtle suites again, on Minecraft 1.20.1 (CC:Tweaked 1.121.0, the 1.121.0 ROM and the vanilla 1.20.1 block data
// in rom-overlay/rom/ccsim/turtle/data/1.20.1/). Every world in them runs as 1.20.1 through CRAFTOS_VERSION, which the
// runner reads when a world names no version (versions.ts). The cases whose answer differs on 1.121.0 say so where
// they are (`cc121`); what is new on 1.121.0 is tested in turtle-cc121.integration.test.ts.
process.env["CRAFTOS_VERSION"] = "1.20.1";
await import("./turtle.integration.test.js");
await import("./turtle-living.integration.test.js");
await import("./turtle-build.integration.test.js");
await import("./turtle-host.integration.test.js");
