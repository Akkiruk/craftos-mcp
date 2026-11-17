// The pack settings (Minecraft version, addons) -> environment, the checklist -> craftos-mcp.addons value, and the
// version and addon data the build reads from packages/runner.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addonSpec,
  ccFor,
  effectiveMc,
  enabledAddons,
  packEnv,
  packLabel,
  packSummary,
  specForVersion,
  withRequired,
} from "../../src/pack.ts";
import { loadPackData } from "../../pack-data.mjs";

const data = await loadPackData();

test("the build reads 3 Minecraft versions and 38 addons with their names", () => {
  assert.deepEqual(
    data.versions.map((v) => `${v.mc}=${v.cc}`),
    ["1.18.2=1.101.3", "1.20.1=1.121.0", "1.21.1=1.121.0"],
  );
  assert.equal(data.newest, "1.21.1");
  assert.equal(data.addons.length, 38);
  const ap = data.addons.find((a) => a.id === "advanced-peripherals");
  assert.equal(ap.name, "Advanced Peripherals");
  assert.ok(ap.types.includes("playerDetector"));
  assert.deepEqual(
    data.addons.find((a) => a.id === "mekanism-generators").requires,
    ["mekanism"],
  );
});

test("settings become CRAFTOS_VERSION and CRAFTOS_ADDONS, empty ones nothing", () => {
  assert.deepEqual(packEnv({ addons: "", mc: "" }), {});
  assert.deepEqual(packEnv({ addons: " create,mekanism ", mc: "1.18.2" }), {
    CRAFTOS_ADDONS: "create,mekanism",
    CRAFTOS_VERSION: "1.18.2",
  });
  assert.deepEqual(packEnv({ addons: "none", mc: "" }), {
    CRAFTOS_ADDONS: "none",
  });
});

test("the version a file runs: the world's, else the setting, else the newest", () => {
  assert.equal(effectiveMc(data, "", undefined), "1.21.1");
  assert.equal(effectiveMc(data, "1.20.1", undefined), "1.20.1");
  assert.equal(effectiveMc(data, "1.20.1", "1.18.2"), "1.18.2");
  assert.equal(
    effectiveMc(data, "", { mc: "1.18.2", loader: "forge" }),
    "1.18.2",
  );
  assert.equal(ccFor(data, "1.18.2"), "1.101.3");
});

test("which addons are on for a spec", () => {
  const on121 = enabledAddons(data, "", "1.21.1").on;
  assert.equal(on121.size, 19, "every addon with a 1.21.1 release");
  assert.ok(!on121.has("bigger-reactors"));
  assert.equal(enabledAddons(data, "all", "1.18.2").on.size, 15);
  assert.equal(enabledAddons(data, "all", "1.20.1").on.size, 33);
  assert.equal(enabledAddons(data, "none", "1.18.2").on.size, 0);
  assert.equal(
    enabledAddons(data, [], "1.18.2").on.size,
    0,
    "a world's empty list is none",
  );
  const some = enabledAddons(
    data,
    "Advanced Peripherals, create,nope",
    "1.18.2",
  );
  assert.deepEqual([...some.on], ["advanced-peripherals", "create"]);
  assert.deepEqual(some.unknown, ["nope"]);
});

test("the checklist's picks become all, none or ids, with what they need added", () => {
  assert.deepEqual(
    withRequired(data, ["create-additions", "mekanism-generators"]),
    ["mekanism", "mekanism-generators", "create", "create-additions"],
  );
  assert.equal(addonSpec(data, [], "1.18.2"), "none");
  assert.equal(
    addonSpec(data, ["mekanism-generators"], "1.18.2"),
    "mekanism,mekanism-generators",
  );
  const every121 = data.addons
    .filter((a) => a.versions["1.21.1"])
    .map((a) => a.id);
  assert.equal(addonSpec(data, every121, "1.21.1"), "all");
  assert.notEqual(addonSpec(data, every121, "1.18.2"), "all");
});

test("a new version drops the listed addons it has no release for", () => {
  const moved = specForVersion(data, "bigger-reactors,create", "1.21.1");
  assert.equal(moved.spec, "create");
  assert.deepEqual(
    moved.dropped.map((a) => a.id),
    ["bigger-reactors"],
  );
  assert.deepEqual(
    specForVersion(data, "bigger-reactors", "1.21.1").spec,
    "none",
  );
  assert.deepEqual(specForVersion(data, "all", "1.21.1"), {
    spec: "all",
    dropped: [],
  });
  assert.deepEqual(specForVersion(data, "create", "1.18.2"), {
    spec: "create",
    dropped: [],
  });
});

test("the status bar summary", () => {
  assert.equal(
    packSummary(data, { mc: "", addons: "" }),
    "1.21.1 · 19/19 addons",
  );
  assert.equal(
    packSummary(data, { mc: "1.18.2", addons: "create,mekanism" }),
    "1.18.2 · 2/15 addons",
  );
  // the status bar leaves the count out while every addon is on
  assert.equal(packLabel(data, { mc: "", addons: "" }), "1.21.1");
  assert.equal(packLabel(data, { mc: "1.18.2", addons: "all" }), "1.18.2");
  assert.equal(
    packLabel(data, { mc: "1.18.2", addons: "create,mekanism" }),
    "1.18.2 · 2/15 addons",
  );
  assert.equal(
    packLabel(data, { mc: "", addons: "none" }),
    "1.21.1 · 0/19 addons",
  );
});
