// The World Editor's model: every world file in the repo survives parse -> edit -> write with only the edited part
// changed, the schema validator agrees with the repo's own files and catches what VS Code would, and the scene
// (sides, network, addons, links between computers) reads the files the way the runner does.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyEdit,
  applyOps,
  detectFormat,
  minimalEdit,
  parseTree,
  removeEdit,
  setEdit,
  stringify,
} from "../../../../packages/world-editor/src/jsonDoc.ts";
import {
  addonsOn,
  bySide,
  computerOf,
  freeName,
  freeSide,
  linkBetween,
  neighbourOf,
  thingsOf,
  worldProblems,
} from "../../../../packages/world-editor/src/model.ts";
import {
  fieldsOf,
  peripheralFields,
  peripheralTypes,
  schemaAt,
  validate,
} from "../../../../packages/world-editor/src/schema.ts";

const repo = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
const publicSchema = JSON.parse(
  readFileSync(join(repo, "schemas", "world.schema.json"), "utf8"),
);

/** Every world file the repo has, as on disk (CRLF on a Windows checkout). */
const files = execFileSync(
  "git",
  ["ls-files", "*.world.json", "worlds/*.json"],
  { cwd: repo, encoding: "utf8" },
)
  .split("\n")
  .map((f) => f.trim())
  .filter((f) => f && !f.startsWith("worlds/labels/"));

const read = (f) => readFileSync(join(repo, f), "utf8");

/** The schema a file names in $schema, as the editor picks it. */
function schemaFor(f, world) {
  if (typeof world.$schema === "string") {
    try {
      return JSON.parse(
        readFileSync(resolve(join(repo, dirname(f)), world.$schema), "utf8"),
      );
    } catch {
      // not a local file
    }
  }
  return publicSchema;
}

/** `after` differs from `before` only inside [start, end) of `before`. */
function onlyChanged(before, after, start, end) {
  const tail = before.length - end;
  assert.equal(
    after.slice(0, start),
    before.slice(0, start),
    "text before the edit changed",
  );
  assert.equal(
    after.slice(after.length - tail),
    before.slice(before.length - tail),
    "text after the edit changed",
  );
}

/** Leaves (numbers, strings, booleans) of a value, with their paths. */
function leaves(value, path = [], out = []) {
  if (Array.isArray(value))
    value.forEach((v, k) => leaves(v, [...path, k], out));
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) leaves(v, [...path, k], out);
  else out.push({ path, value });
  return out;
}

const at = (value, path) => path.reduce((v, k) => v?.[k], value);

test("the repo has world files to check", () => {
  assert.ok(files.length >= 40, `only ${files.length} world files`);
});

for (const f of files) {
  test(`round trip: ${f}`, () => {
    const text = read(f);
    const root = parseTree(text);
    const world = root.value;
    assert.deepEqual(
      world,
      JSON.parse(text),
      "parseTree reads what JSON.parse reads",
    );

    // opened and saved untouched: the same text, and setting a value to itself changes nothing
    assert.equal(applyOps(text, []), text);
    for (const { path, value } of leaves(world))
      assert.equal(
        applyOps(text, [{ op: "set", path, value }]),
        text,
        path.join("."),
      );

    // a changed leaf: only its own characters change, and changing it back gives the file back
    for (const { path, value } of leaves(world).slice(0, 40)) {
      const next =
        typeof value === "number"
          ? value + 1
          : typeof value === "boolean"
            ? !value
            : `${value}x`;
      const edit = setEdit(text, path, next);
      const after = applyEdit(text, edit);
      const node = parseTree(text);
      let n = node;
      for (const seg of path)
        n =
          n.kind === "object"
            ? n.props.findLast((p) => p.key === seg).value
            : n.items[seg];
      onlyChanged(text, after, n.start, n.end);
      assert.deepEqual(at(JSON.parse(after), path), next);
      assert.equal(
        applyOps(after, [{ op: "set", path, value }]),
        text,
        `${path.join(".")} back`,
      );
    }

    // a new key: the rest of the file is the same text, the new one is in the file's own line ending
    const added = applyOps(text, [
      { op: "set", path: ["label"], value: "added by the test" },
    ]);
    if (world.label === undefined) {
      assert.deepEqual(JSON.parse(added), {
        ...world,
        label: "added by the test",
      });
      const change = minimalEdit(text, added);
      assert.equal(change.start, change.end, "adding a key only inserts");
      if (text.includes("\r\n"))
        assert.ok(!/[^\r]\n/.test(added), "a CRLF file stays CRLF");
      // and removing it again gives the file back
      assert.equal(applyOps(added, [{ op: "remove", path: ["label"] }]), text);
    }

    // a block removed and put back at the end: same world, and only the peripherals list changed
    if (Array.isArray(world.peripherals) && world.peripherals.length) {
      const last = world.peripherals.length - 1;
      const removed = applyOps(text, [
        { op: "remove", path: ["peripherals", last] },
      ]);
      assert.deepEqual(
        JSON.parse(removed).peripherals,
        world.peripherals.slice(0, -1),
      );
      const back = applyOps(removed, [
        { op: "push", path: ["peripherals"], value: world.peripherals[last] },
      ]);
      assert.deepEqual(JSON.parse(back), world);
      const list = root.props.find((p) => p.key === "peripherals").value;
      onlyChanged(text, back, list.start, list.end);
      // the first one removed: the others keep their text
      const first = applyOps(text, [
        { op: "remove", path: ["peripherals", 0] },
      ]);
      assert.deepEqual(
        JSON.parse(first).peripherals,
        world.peripherals.slice(1),
      );
      if (list.items.length > 1)
        assert.ok(
          first.includes(text.slice(list.items[1].start, list.items[1].end)),
        );
    }

    // a peripheral added with the editor's own ops lands with the file's indentation
    const pushed = applyOps(text, [
      {
        op: "push",
        path: ["peripherals"],
        value: { name: "left", type: "speaker" },
      },
    ]);
    assert.deepEqual(JSON.parse(pushed).peripherals.at(-1), {
      name: "left",
      type: "speaker",
    });
    assert.ok(
      pushed.includes('{ "name": "left", "type": "speaker" }'),
      "a short object goes on one line, as Prettier writes it",
    );
  });

  test(`schema: ${f} is valid`, () => {
    const world = JSON.parse(read(f));
    assert.deepEqual(validate(schemaFor(f, world), world), []);
  });
}

test("the validator words problems as VS Code does and puts them on the right path", () => {
  const problems = (world) =>
    validate(publicSchema, world).map(
      (p) => `${p.path.join(".")}: ${p.message}`,
    );
  assert.deepEqual(problems({ periferals: [] }), [
    "periferals: Property periferals is not allowed.",
  ]);
  assert.deepEqual(problems({ monitors: [{ name: "top", blocksWide: 9 }] }), [
    "monitors.0.blocksWide: Value is above the maximum of 8.",
  ]);
  assert.deepEqual(problems({ monitors: [{ blocksWide: 2 }] }), [
    'monitors.0: Missing property "name".',
  ]);
  assert.deepEqual(
    problems({ peripherals: [{ name: "top", type: "modem", kind: "laser" }] }),
    [
      'peripherals.0.kind: Value is not accepted. Valid values: "wireless", "ender", "wired".',
    ],
  );
  assert.deepEqual(
    problems({
      peripherals: [{ name: "left", type: "minecraft:chest", size: "big" }],
    }),
    ['peripherals.0.size: Incorrect type. Expected "integer".'],
  );
  assert.deepEqual(
    problems({ peripherals: [{ name: "left", type: "speaker", volume: 3 }] }),
    ["peripherals.0.volume: Property volume is not allowed."],
  );
  assert.deepEqual(problems({ computerId: -1 }), [
    "computerId: Value is below the minimum of 0.",
  ]);
  assert.deepEqual(problems({ version: "1.19.2" }), [
    'version: Value is not accepted. Valid values: "1.18.2", "1.20.1", "1.21.1".',
  ]);
  assert.deepEqual(problems({ addons: 5 }), [
    'addons: Value is not accepted. Valid values: "all", "none", "advanced-peripherals", "mekanism", "mekanism-generators", "create", "create-additions", "toms-peripherals", "bigger-reactors", "extreme-reactors", "unlimited-peripheral-works", "metaphysics" and 28 more.',
  ]);
  assert.deepEqual(problems({ version: { mc: "1.20.1", cc: "2" } }), [
    'version.cc: Value is not accepted. Valid values: "1.101.3", "1.121.0".',
  ]);
  // a block of your own naming is a generic block
  assert.deepEqual(
    problems({
      peripherals: [
        { name: "m", type: "thermal:machine_furnace", size: 3, energy: 5 },
      ],
    }),
    [],
  );
});

test("each peripheral type gets its own fields from the schema", () => {
  const types = peripheralTypes(publicSchema).map((t) => t.type);
  assert.ok(types.length > 200, `${types.length} types`);
  for (const t of [
    "minecraft:chest",
    "modem",
    "playerDetector",
    "qioDashboard",
    "Create_Station",
    "tm_gpu",
    "BiggerReactors_Reactor",
  ])
    assert.ok(types.includes(t), t);
  const keys = (type) => peripheralFields(publicSchema, type).map((f) => f.key);
  assert.deepEqual(keys("modem").slice(0, 2), ["name", "type"]);
  for (const k of [
    "kind",
    "network",
    "block",
    "on",
    "localName",
    "x",
    "y",
    "z",
  ])
    assert.ok(keys("modem").includes(k), k);
  for (const k of ["size", "items", "tanks", "energy"])
    assert.ok(keys("minecraft:chest").includes(k), k);
  assert.ok(!keys("speaker").includes("size"));
  assert.ok(
    peripheralFields(publicSchema, "modem").find((f) => f.key === "name")
      .required,
  );
  // the schema of a value deep in a file
  assert.deepEqual(
    schemaAt(publicSchema, { peripherals: [{ type: "modem" }] }, [
      "peripherals",
      0,
      "kind",
    ]).enum,
    ["wireless", "ender", "wired"],
  );
  assert.equal(
    schemaAt(publicSchema, {}, ["monitors", 0, "blocksHigh"]).maximum,
    6,
  );
  // the top level
  const top = fieldsOf(publicSchema, publicSchema, {}).map((f) => f.key);
  for (const k of [
    "monitors",
    "addons",
    "version",
    "peripherals",
    "players",
    "turtle",
  ])
    assert.ok(top.includes(k), k);
});

test("edits keep the file's formatting: inline stays inline, a long object breaks like Prettier", () => {
  const text =
    '{\r\n  "addons": ["create"],\r\n  "peripherals": [{ "name": "top", "type": "modem" }]\r\n}\r\n';
  assert.equal(
    applyOps(text, [{ op: "push", path: ["addons"], value: "mekanism" }]),
    '{\r\n  "addons": ["create", "mekanism"],\r\n  "peripherals": [{ "name": "top", "type": "modem" }]\r\n}\r\n',
  );
  assert.equal(
    applyOps(text, [
      { op: "set", path: ["peripherals", 0, "kind"], value: "ender" },
    ]),
    '{\r\n  "addons": ["create"],\r\n  "peripherals": [{ "name": "top", "type": "modem", "kind": "ender" }]\r\n}\r\n',
  );
  assert.equal(
    applyOps(text, [
      { op: "set", path: ["position"], value: { x: 1, y: 64, z: 2 } },
    ]),
    '{\r\n  "addons": ["create"],\r\n  "peripherals": [{ "name": "top", "type": "modem" }],\r\n  "position": { "x": 1, "y": 64, "z": 2 }\r\n}\r\n',
  );
  const long = {
    name: "minecraft:chest_0",
    type: "minecraft:chest",
    size: 54,
    items: { 1: { name: "minecraft:iron_ingot", count: 32 } },
  };
  assert.equal(
    stringify(long, detectFormat("{\n  \n}"), "    "),
    '{\n      "name": "minecraft:chest_0",\n      "type": "minecraft:chest",\n      "size": 54,\n      "items": { "1": { "name": "minecraft:iron_ingot", "count": 32 } }\n    }',
  );
  // a path through missing objects makes them
  assert.deepEqual(
    JSON.parse(
      applyOps("{}\n", [{ op: "set", path: ["position", "x"], value: 5 }]),
    ),
    { position: { x: 5 } },
  );
  // an empty file becomes a world
  assert.equal(
    applyOps("", [{ op: "set", path: ["computerId"], value: 2 }]),
    '{ "computerId": 2 }\n',
  );
  // the only element removed leaves an empty list; a middle one takes its comma with it
  assert.equal(
    applyOps('{ "a": [1] }', [{ op: "remove", path: ["a", 0] }]),
    '{ "a": [] }',
  );
  assert.equal(
    applyOps('{ "a": [1, 2, 3] }', [{ op: "remove", path: ["a", 1] }]),
    '{ "a": [1, 3] }',
  );
  assert.equal(
    applyOps('{\n  "a": 1,\n  "b": 2\n}\n', [{ op: "remove", path: ["b"] }]),
    '{\n  "a": 1\n}\n',
  );
  assert.equal(removeEdit('{ "a": 1 }', ["nope"]).text, "");
  // comments survive edits elsewhere
  const commented = '{\n  // the side\n  "computerId": 1\n}\n';
  assert.equal(
    applyOps(commented, [{ op: "set", path: ["computerId"], value: 2 }]),
    '{\n  // the side\n  "computerId": 2\n}\n',
  );
});

test("the scene: sides, the network, the computer, free names", () => {
  const world = {
    computerId: 4,
    position: { x: 10, y: 70, z: -3 },
    monitors: [{ name: "top", blocksWide: 3 }],
    peripherals: [
      { name: "back", type: "modem", kind: "ender" },
      { name: "minecraft:chest_0", type: "minecraft:chest", x: 1, y: 64, z: 2 },
      { name: "left", type: "playerDetector" },
    ],
    players: [{ name: "Alice", x: 2, y: 64, z: 0 }],
  };
  const things = thingsOf(world);
  assert.deepEqual(
    things.map((t) => `${t.kind}:${t.name}:${t.side ?? "-"}`),
    [
      "monitor:top:top",
      "peripheral:back:back",
      "peripheral:minecraft:chest_0:-",
      "peripheral:left:left",
      "player:Alice:-",
    ],
  );
  assert.equal(things[1].modem, "ender");
  const sides = bySide(things);
  assert.equal(sides.top[0].type, "monitor");
  assert.equal(sides.right.length, 0);
  assert.equal(freeSide(world), "bottom");
  assert.equal(freeName(world, "minecraft:chest"), "minecraft:chest_1");
  assert.deepEqual(computerOf(world), {
    kind: "computer",
    advanced: true,
    id: 4,
    label: undefined,
    x: 10,
    y: 70,
    z: -3,
    dimension: "minecraft:overworld",
    at: "position",
  });
  assert.equal(computerOf({ turtle: { advanced: false } }).kind, "turtle");
  // a turtle stands at its own x/y/z, each falling back to the world's position
  const t = computerOf({
    position: { x: 1, y: 70, z: 1 },
    turtle: { x: 5, z: -2 },
  });
  assert.deepEqual([t.x, t.y, t.z, t.at], [5, 70, -2, "turtle"]);
  assert.equal(computerOf({ turtle: { advanced: false } }).advanced, false);
  assert.equal(computerOf({ kind: "pocket", advanced: false }).kind, "pocket");
});

const catalog = JSON.parse(
  (() => {
    try {
      return readFileSync(
        join(repo, "apps", "vscode", "schemas", "addons.json"),
        "utf8",
      );
    } catch {
      return "null";
    }
  })(),
) ?? {
  defaultMc: "1.18.2",
  addons: [
    {
      id: "advanced-peripherals",
      name: "Advanced Peripherals",
      versions: { "1.18.2": "a", "1.21.1": "b" },
      types: ["playerDetector"],
      worldKeys: ["ap"],
    },
    {
      id: "mekanism",
      name: "Mekanism",
      versions: { "1.18.2": "a" },
      types: ["qioDashboard"],
      worldKeys: ["mekanism"],
    },
    {
      id: "mekanism-generators",
      name: "Mekanism Generators",
      versions: { "1.18.2": "a" },
      types: ["solarGenerator"],
      requires: ["mekanism"],
    },
    {
      id: "bigger-reactors",
      name: "Bigger Reactors",
      versions: { "1.18.2": "a" },
      types: ["BiggerReactors_Reactor"],
    },
  ],
};

test("addons: on and off as the runner resolves them, and what that breaks", () => {
  const on = (world, mc = "1.18.2", fallback = "") => [
    ...addonsOn(world, catalog, mc, fallback),
  ];
  assert.ok(on({}).includes("mekanism"));
  assert.deepEqual(on({ addons: "none" }), []);
  assert.deepEqual(on({ addons: ["mekanism"] }), ["mekanism"]);
  assert.deepEqual(on({ addons: "mekanism, advanced-peripherals" }), [
    "mekanism",
    "advanced-peripherals",
  ]);
  assert.deepEqual(on({}, "1.18.2", "mekanism"), ["mekanism"]);
  assert.ok(
    !on({}, "1.21.1").includes("bigger-reactors"),
    "no Bigger Reactors on 1.21.1",
  );

  const problems = (world, mc = "1.18.2") =>
    worldProblems(world, catalog, mc).map(
      (p) => `${p.path.join(".")}: ${p.message}`,
    );
  assert.deepEqual(
    problems({
      addons: ["mekanism"],
      peripherals: [{ name: "left", type: "playerDetector" }],
    }),
    [
      'peripherals.0.type: playerDetector comes from Advanced Peripherals (addon "advanced-peripherals"), which is off in this world.',
    ],
  );
  assert.deepEqual(problems({ addons: ["mekanism-generators"] }), [
    "addons.0: Mekanism Generators needs Mekanism switched on too.",
  ]);
  assert.deepEqual(problems({ addons: "none", ap: {} }), [
    'ap: "ap" configures Advanced Peripherals (addon "advanced-peripherals"), which is off in this world.',
  ]);
  assert.match(
    problems({ version: "1.21.1", addons: ["bigger-reactors"] })[0],
    /^addons\.0: Bigger Reactors has no release for Minecraft 1\.21\.1/,
  );
  assert.deepEqual(
    problems({
      monitors: [{ name: "top" }],
      peripherals: [{ name: "top", type: "speaker" }],
    }),
    ["peripherals.0.name: Two blocks on the top side: monitor and speaker."],
  );
  // every world file in the repo is clean on its own version
  for (const f of files) {
    const world = JSON.parse(read(f));
    assert.deepEqual(problems(world, "1.18.2"), [], f);
  }
});

test("other computers: which modems reach which", () => {
  const n = (world) => neighbourOf("x.world.json", world);
  const ender = n({
    position: { x: 0, y: 64, z: 0 },
    peripherals: [{ name: "top", type: "modem", kind: "ender" }],
  });
  const far = n({
    position: { x: 900, y: 70, z: -300 },
    peripherals: [{ name: "top", type: "modem" }],
  });
  const near = n({
    position: { x: 10, y: 64, z: 0 },
    peripherals: [{ name: "top", type: "modem" }],
  });
  const wired = n({
    peripherals: [
      { name: "back", type: "modem", kind: "wired", network: "base" },
    ],
  });
  const wired2 = n({
    peripherals: [
      { name: "left", type: "modem", kind: "wired", network: "base" },
    ],
  });
  const none = n({});
  assert.equal(linkBetween(ender, far), "ender");
  assert.equal(linkBetween(far, ender), "ender");
  assert.equal(linkBetween(near, far), undefined);
  assert.equal(
    linkBetween(
      near,
      n({
        position: { x: 40, y: 64, z: 0 },
        peripherals: [{ name: "top", type: "modem" }],
      }),
    ),
    "wireless",
  );
  assert.equal(linkBetween(wired, wired2), "wired");
  assert.equal(linkBetween(wired, none), undefined);
  // the repo's linked worlds: a vault and two displays on ender modems
  const linked = ["linked-vault", "linked-display-1", "linked-display-2"].map(
    (f) => neighbourOf(f, JSON.parse(read(`worlds/${f}.json`))),
  );
  assert.equal(linkBetween(linked[0], linked[1]), "ender");
  assert.equal(linkBetween(linked[0], linked[2]), "ender");
});
