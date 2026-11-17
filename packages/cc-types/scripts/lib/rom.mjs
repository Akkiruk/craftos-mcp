// The Lua half of CC:Tweaked: read every documented API and module out of a ROM and write it as lua-language-server
// definitions. generate.mjs calls this.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { definition, docComments, moduleExports } from "./ldoc.mjs";
import { SUMMARIES } from "./summaries.mjs";

export const OLD = { cc: "1.101.3", mc: "1.18.2" };
export const NEW = { cc: "1.121.0", mc: "1.20.1 and 1.21.1" };

/** Things the doc comments do not say. */
const CLASS_EXTRAS = {
  Vector: {
    lines: [
      "---@field x number",
      "---@field y number",
      "---@field z number",
      "---@operator add(cc.Vector): cc.Vector",
      "---@operator sub(cc.Vector): cc.Vector",
      "---@operator mul(number): cc.Vector",
      "---@operator div(number): cc.Vector",
      "---@operator unm: cc.Vector",
    ],
  },
  Window: { parent: "cc.Redirect", dot: true },
  Doc: { lines: ["---@operator concat(cc.pretty.Doc|string): cc.pretty.Doc"] },
};
/** Global tables that also have every function of a class the hand-written files describe. */
const MODULE_PARENTS = { term: { type: "cc.Redirect", local: "Redirect" } };
/** A line for the modules the ROM only names: their description is in CC:Tweaked's Java source. Our own words. */
const MODULE_SUMMARY = {
  term: "Write text and draw on the computer's screen, or on whatever `term.redirect` points at.",
  fs: "Read, write and manage the files of the computer and its disks.",
  turtle:
    "Move a turtle, and have it dig, place, attack and handle items. Only turtles have it.",
};
const MODULE_EXTRAS = {
  "cc.expect": [
    "---@overload fun(index: integer, value: any, ...: string): any",
  ],
  // every Minecraft command is a function too: commands.say("hi")
  commands: ["---@field [string] fun(...: any): boolean, string[], integer?"],
};
const VALUE_TYPES = {
  "io.stdin": "cc.io.Handle",
  "io.stdout": "cc.io.Handle",
  "io.stderr": "cc.io.Handle",
  "textutils.empty_json_array": "table",
  "textutils.json_null": "table",
  "cc.pretty.empty": "cc.pretty.Doc",
  "cc.pretty.space": "cc.pretty.Doc",
  "cc.pretty.line": "cc.pretty.Doc",
  "cc.pretty.space_line": "cc.pretty.Doc",
  "turtle.native": "cc.turtle",
  "commands.native": "cc.commands",
  "commands.async": "table<string, fun(...: any): integer>",
  "http.checkURLAsync": "fun(url: string): boolean, string?",
};
/** Functions whose numbered return sets go with the parameter set of the same number. */
const NL = String.fromCharCode(10);
const TIED = new Set(["colors.rgb8", "colours.rgb8"]);
/**
 * Where the generated lines are right and still not what a program needs. Each takes the lines of one function and
 * returns them changed; it throws when the lines it expects are gone, so a new CC:Tweaked version cannot slip past.
 */
const PATCHES = {
  // Without a timeout it waits for ever and never returns nil. Only the call with a timeout is "maybe nil": it is the
  // overload, and the plain signature loses the timeout so a call with one can only match the overload.
  "rednet.receive": (lines) => {
    const out = lines.filter((l) => !l.startsWith("---@param timeout?"));
    const first = out.findIndex((l) => l.startsWith("---@return number?"));
    const last = out.length - 1;
    if (
      out.length !== lines.length - 1 ||
      first < 0 ||
      out[last] !== "function rednet.receive(protocol_filter, timeout) end"
    ) {
      throw new Error(
        "the rednet.receive patch in rom.mjs no longer fits what the ROM documents",
      );
    }
    out[first] = out[first].replace("---@return number?", "---@return number");
    out[last] = "function rednet.receive(protocol_filter) end";
    out.splice(
      last,
      0,
      "---@overload fun(protocol_filter: string|nil, timeout: number): number?, any, string?",
    );
    const link = out.findIndex((l) => l.startsWith("---[tweaked.cc]"));
    out.splice(
      link,
      0,
      "---A second argument, `timeout`, is the number of seconds to wait: then nil comes back when no message did.",
      "---",
    );
    return out;
  },
};
/** Module files in the ROM, besides rom/apis and rom/modules/main/cc. */
const PROGRAM_MODULES = [
  "rom/programs/shell.lua",
  "rom/programs/advanced/multishell.lua",
];

const KEYWORDS = new Set(
  "and break do else elseif end false for function goto if in local nil not or repeat return then true until while".split(
    " ",
  ),
);
const isName = (s) => /^[A-Za-z_]\w*$/.test(s) && !KEYWORDS.has(s);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".lua")) out.push(full);
  }
  return out;
}

/** Version string -> comparable number list. "1.80pr1.6" -> [1, 80, 1, 6]. */
const version = (s) => (s.match(/\d+/g) ?? []).map(Number);
function newer(a, b) {
  const x = version(a);
  const y = version(b);
  for (let i = 0; i < 3; i++)
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

/** Read one ROM into { [moduleName]: module }. */
export function readRom(romDir, warn) {
  const files = [
    ...walk(join(romDir, "rom", "apis")),
    ...walk(join(romDir, "rom", "modules", "main", "cc")).filter(
      (f) => !/[\\/]internal[\\/]/.test(f),
    ),
    ...PROGRAM_MODULES.map((f) => join(romDir, f)).filter(existsSync),
  ];
  const modules = {};
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const short = file
      .slice(romDir.length + 1)
      .split("\\")
      .join("/");
    const comments = docComments(source, (what) => warn(`${short}: ${what}`));
    const isModule = short.includes("/modules/");
    let head = comments.find((c) => c.doc.module);
    // a module without @module is named after its path (cc/audio/dfpwm.lua), and its first comment describes it
    if (
      !head &&
      isModule &&
      comments[0] &&
      !/^(local\s+)?function\b/.test(comments[0].code)
    ) {
      head = comments[0];
      head.doc.module = short
        .replace(/^.*\/modules\/main\//, "")
        .replace(/\.lua$/, "")
        .split("/")
        .join(".");
    }
    if (!head) continue;
    const name = head.doc.module;
    const exported = isModule ? moduleExports(source) : undefined;
    const mod = {
      name,
      file: short,
      isModule,
      doc: head.doc,
      functions: {},
      values: {},
      classes: {},
    };
    const locals = {};
    let current;
    for (const { doc, code, indent, expects, returnsValue } of comments) {
      if (doc === head.doc || doc.local) continue;
      if (doc.type) {
        current = { name: doc.type, doc, methods: {} };
        mod.classes[doc.type] = current;
        continue;
      }
      const def = definition(code);
      if (!def) continue;
      const last = def.path[def.path.length - 1];
      // a member of the class being described
      if (current && indent > 0) {
        const owner = def.path.length === 2 ? def.path[0] : undefined;
        if (
          def.kind === "function" &&
          (def.path.length === 1 ||
            owner.toLowerCase() === current.name.toLowerCase())
        ) {
          current.methods[last] = {
            name: last,
            doc,
            args: def.args,
            expects,
            returnsValue,
          };
          continue;
        }
      }
      if (def.kind === "function" && def.local && def.path.length === 1)
        locals[last] = {
          name: last,
          doc,
          args: def.args,
          expects,
          returnsValue,
        };
      let names = [];
      if (isModule) {
        if (def.path.length === 1)
          names = Object.keys(exported).filter((k) => exported[k] === last);
      } else if (
        def.path.length === 1
          ? !def.local && indent === 0
          : def.path[0] === name
      )
        names = [last];
      for (const n of names) {
        if (def.kind === "function")
          mod.functions[n] = {
            name: n,
            doc,
            args: def.args,
            expects,
            returnsValue,
          };
        else mod.values[n] = { name: n, doc, value: def.value };
      }
    }
    // a second name for a documented function: `serialise = serialize`
    if (!isModule) {
      for (const m of source.matchAll(
        /^([A-Za-z_]\w*) *= *([A-Za-z_]\w*) *(?:--.*)?$/gm,
      )) {
        const target = mod.functions[m[2]] ?? locals[m[2]];
        if (target && !mod.functions[m[1]] && !mod.values[m[1]])
          mod.functions[m[1]] = { ...target, name: m[1] };
      }
    }
    modules[name] = mod;
  }
  return modules;
}

// ===== writing =====

function comment(text) {
  return text
    .split("\n")
    .map((l) => (l ? `---${l}` : "---"))
    .join("\n");
}

function unionType(types) {
  const flat = [
    ...new Set(
      types.flatMap((t) =>
        t.includes("fun(") || t.includes("{") || t.includes("<")
          ? [t]
          : t.split("|"),
      ),
    ),
  ];
  if (flat.includes("any")) return "any";
  if (flat.includes("true") && flat.includes("false"))
    (flat.splice(flat.indexOf("true"), 1, "boolean"),
      flat.splice(flat.indexOf("false"), 1));
  const rest = flat.filter((t) => t !== "nil");
  if (rest.length === flat.length) return rest.join("|");
  if (rest.length === 0) return "nil";
  if (rest.length === 1 && !rest[0].includes("fun(")) return `${rest[0]}?`;
  return `${rest.join("|")}|nil`;
}

function groupsOf(list) {
  const ids = [...new Set(list.map((x) => x.group))].sort((a, b) => a - b);
  return ids.map((id) => list.filter((x) => x.group === id));
}

/**
 * Return sets merged by position. The first value says which set it is (a handle, or nil), so only it takes the nil
 * of a shorter set: `local x, y, z = gps.locate() if x then use(y, z) end` must not ask for a nil check on y and z,
 * which the language server cannot tie to x. A value the first set does not have at all is optional.
 */
function mergeReturns(sets) {
  if (sets.length === 0) return [];
  const width = Math.max(...sets.map((s) => s.length));
  const out = [];
  for (let i = 0; i < width; i++) {
    const here = sets.map((s) => s[i]);
    const types = here
      .filter((r, set) => r || i === 0 || set === 0)
      .map((r) => (r ? r.type : "nil"));
    out.push({
      type: unionType(types),
      vararg: here.some((r) => r?.vararg),
      // the comment's text is read for this one hint and not kept
      values: here.some((r) => r && /\bvalues\b/.test(r.desc)),
    });
  }
  return out;
}

function paramList(params) {
  return params
    .map((p) =>
      p.name === "..."
        ? `...: ${p.type}`
        : `${p.name}${p.opt ? "?" : ""}: ${p.type}`,
    )
    .join(", ");
}

/**
 * One function as annotation lines plus its `function x.y() end` line. `target`: "fs.find" or "Vector:add".
 * `ctx`: { url, note[] }.
 */
export function renderFunction(target, fn, ctx) {
  const doc = fn.doc;
  const lines = [];
  const isMethod = target.includes(":");
  let sets = groupsOf(doc.params).map((set) =>
    set.filter((p) => !(isMethod && p.name === "self")),
  );
  let args = [...fn.args];
  if (isMethod && args[0] === "self") args.shift();
  let main = sets[0] ?? [];
  // the code's own check says nil is fine: optional, whatever the doc comment says
  if (sets.length <= 1 && main.length === args.length) {
    main = main.map((p, i) =>
      ((fn.expects ?? {})[args[i]] ?? []).includes("nil")
        ? { ...p, opt: true }
        : p,
    );
  }
  if (main.length === 0 && args.length > 0 && sets.length <= 1) {
    main = args.map((a) => ({ name: a, type: "any", opt: true, desc: "" }));
  } else if (sets.length <= 1) {
    // arguments the code takes and the docs do not mention: optional, so a call that passes them is not flagged
    for (let i = main.length; i < args.length; i++) {
      if (!main.some((p) => p.name === args[i]))
        main.push({ name: args[i], type: "any", opt: true, desc: "" });
    }
  }
  // A parameter after an optional one can be left out too, whatever its doc comment says: the call is positional.
  // (Window.reposition documents new_width as optional and new_height not.)
  const trailing = (set) => {
    let optional = false;
    return set.map((p) => {
      optional ||= p.opt;
      return optional && !p.opt && p.name !== "..." ? { ...p, opt: true } : p;
    });
  };
  main = trailing(main);
  sets = sets.map(trailing);
  const returnSets = groupsOf(doc.returns);
  const tied = ctx.tied && sets.length > 1 && returnSets.length === sets.length;
  const returns = tied ? returnSets[0] : mergeReturns(returnSets);

  // None of the doc comment's own text goes out: it is CC:Tweaked's. The line is ours (summaries.mjs), the rest
  // is names, types and versions, and the link leads to the real documentation.
  if (ctx.summary) lines.push(comment(ctx.summary));
  const notes = [...(ctx.notes ?? [])];
  if (doc.throws.length) notes.push("Can throw: see the page below.");
  if (ctx.url) notes.push(`[tweaked.cc](${ctx.url})`);
  if (notes.length) {
    if (lines.length) lines.push("---");
    lines.push(comment(notes.join("\n\n")));
  }
  if (doc.deprecated || ctx.deprecated) {
    lines.push(`---@deprecated${ctx.deprecated ? " " + ctx.deprecated : ""}`);
  }
  const names = [];
  for (const p of main) {
    const desc = p.default !== undefined ? `Default: ${p.default}.` : "";
    if (p.name === "...") {
      lines.push(`---@param ... ${p.type}${desc ? " " + desc : ""}`);
      names.push("...");
    } else {
      const name = isName(p.name) ? p.name : `${p.name}_`;
      lines.push(
        `---@param ${name}${p.opt ? "?" : ""} ${p.type}${desc ? " " + desc : ""}`,
      );
      names.push(name);
    }
  }
  returns.forEach((r, i) => {
    // an untyped last "@return The return values of ..." is as many values as there are
    const says = r.values ?? /\bvalues\b/.test(r.desc ?? "");
    const many =
      r.vararg || (r.type === "any" && i === returns.length - 1 && says);
    lines.push(`---@return ${r.type}${many ? " ..." : ""}`);
  });
  // no @treturn in the doc comment, but the code returns something
  if (returns.length === 0 && doc.returns.length === 0 && fn.returnsValue)
    lines.push("---@return any ...");
  sets.slice(1).forEach((set, index) => {
    const rets = tied ? returnSets[index + 1] : returns;
    const ret = rets
      .map((r) => (r.vararg ? `...${r.type}` : r.type))
      .join(", ");
    lines.push(`---@overload fun(${paramList(set)})${ret ? ": " + ret : ""}`);
  });
  lines.push(`function ${target}(${names.join(", ")}) end`);
  return lines.join("\n");
}

/**
 * peripheral.find: what it returns depends on the type asked for, so every type we know is an overload. A type we
 * do not know, or one only known when the program runs, gives `any`.
 */
const FIND_FIRST = "";
function renderFind(fn, url, overloads) {
  const byType = new Map();
  for (const o of overloads)
    for (const t of o.types) byType.set(t, [...(byType.get(t) ?? []), o.type]);
  const byClass = new Map();
  for (const [t, classes] of byType) {
    const key = [...new Set(classes)].join("|");
    byClass.set(key, [...(byClass.get(key) ?? []), t]);
  }
  const lines = [comment(SUMMARIES["peripheral.find"]), "---"];
  lines.push(
    "---The peripheral types this library knows give their own class. Any other type gives `any`.",
    "---",
    "---Nothing is returned when no such peripheral is attached, so check the first value before using it. It is not",
    "---typed as optional (CC:Tweaked documents it as `table...`), which keeps every later use free of nil warnings.",
    "---",
    `---[tweaked.cc](${url})`,
  );
  lines.push("---@param ty string The peripheral type, such as `monitor`.");
  lines.push(
    "---@param filter? fun(name: string, wrapped: table): boolean Called for each one found; only those it returns true for are kept.",
  );
  lines.push("---@return any ... # Each one found, wrapped.");
  for (const [cls, types] of byClass) {
    const literal = types.map((t) => JSON.stringify(t)).join("|");
    const wrapped = cls.includes("|") ? `(${cls})` : cls;
    // FIND_FIRST: "" as CC:Tweaked documents it; "?" to have lua-language-server ask for a nil check at every use
    lines.push(
      `---@overload fun(ty: ${literal}, filter?: fun(name: string, wrapped: ${cls}): boolean): ${wrapped}${FIND_FIRST}, ${wrapped}?, ${wrapped}?, ${wrapped}?`,
    );
  }
  lines.push("function peripheral.find(ty, filter) end");
  return lines.join("\n");
}

function valueType(key, value) {
  if (VALUE_TYPES[key]) return VALUE_TYPES[key];
  if (/^(0x[0-9a-fA-F]+|\d+)$/.test(value)) return "integer";
  if (/^\d*\.\d+$/.test(value)) return "number";
  return "any";
}

/**
 * Write the modules of the new ROM. `old`: the same modules read from the old ROM. `runtime`: what the emulator has,
 * { old: globals, new: globals, oldModules, newModules } (name -> field -> type). `handWritten`: Set of "module.name"
 * the hand-written files define. Returns { files: { path: text }, counts }.
 */
export function writeRom(modules, old, runtime, handWritten, options, warn) {
  const files = {};
  const counts = {
    modules: 0,
    functions: 0,
    classes: 0,
    methods: 0,
    values: 0,
    filled: [],
    unsummarised: [],
  };
  const names = new Set([...Object.keys(modules), ...Object.keys(old)]);
  for (const name of [...names].sort()) {
    if (name === "colours" || name === "cc.require") continue;
    const mod = modules[name] ?? old[name];
    const before = old[name];
    const isModule = mod.isModule;
    const base = isModule ? "library" : "module";
    const page = `https://tweaked.cc/${base}/${name}.html`;
    const local = isModule ? name.split(".").pop() : name;
    const className = `cc.${name.replace(/^cc\./, "")}`;
    const out = [`---@meta${isModule ? " " + name : ""}`, "", HEADER, ""];

    // was a function there on the old version? the emulator knows; for an API it does not load, the old ROM does
    const runtimeOld = isModule ? runtime.oldModules[name] : runtime.old[name];
    const runtimeNew = isModule ? runtime.newModules[name] : runtime.new[name];
    const has = Object.hasOwn;
    const inOld = (f) =>
      runtimeOld
        ? has(runtimeOld, f)
        : !!(before && (has(before.functions, f) || has(before.values, f)));
    const inNew = (f) =>
      runtimeNew
        ? has(runtimeNew, f)
        : !!(
            modules[name] &&
            (has(modules[name].functions, f) || has(modules[name].values, f))
          );
    // the version a function arrived in, or its whole module did, when that is after the old version
    const since = (doc) =>
      [doc.since, mod.doc.since].find((v) => v && newer(v, OLD.cc));
    const versionNotes = (doc, isOld, isNew) => {
      const notes = [];
      let deprecated;
      if (!isOld) {
        notes.push(
          `**Not in CC:Tweaked ${OLD.cc}** (Minecraft ${OLD.mc})${since(doc) ? `: added in ${since(doc)}` : ""}.`,
        );
      }
      if (!isNew)
        deprecated = `Removed by CC:Tweaked ${NEW.cc} (Minecraft ${NEW.mc}).`;
      // which versions changed it is a fact; what they changed is CC:Tweaked's text, and on the linked page
      const later = doc.changed
        .map((c) => c.split(/\s/)[0])
        .filter((v) => newer(v, OLD.cc));
      if (later.length)
        notes.push(
          `Changed in ${[...new Set(later)].join(", ")}, after CC:Tweaked ${OLD.cc}: see the page below.`,
        );
      return { notes, deprecated };
    };
    /** Our line for a name (summaries.mjs). A name without one is counted, so it gets written. */
    const summary = (key) => {
      const text =
        SUMMARIES[key] ?? SUMMARIES[key.replace(/^colours\b/, "colors")];
      if (!text) counts.unsummarised.push(key);
      return text;
    };

    const body = [];
    const fieldLines = [];
    const parent = MODULE_PARENTS[name];
    const all = {
      ...(before?.functions ?? {}),
      ...(modules[name]?.functions ?? {}),
    };
    const allValues = {
      ...(before?.values ?? {}),
      ...(modules[name]?.values ?? {}),
    };
    const done = new Set();

    for (const key of Object.keys(allValues)) {
      const v = allValues[key];
      if (handWritten.has(`${name}.${key}`) || !isName(key)) continue;
      done.add(key);
      const { notes, deprecated } = versionNotes(v.doc, inOld(key), inNew(key));
      const type = valueType(`${name}.${key}`, v.value);
      const lines = [];
      // the sixteen colours need no line each; everything else gets one
      const text =
        name === "colors" && type === "integer"
          ? undefined
          : summary(`${name}.${key}`);
      if (text) lines.push(comment(text), "---");
      notes.push(`[tweaked.cc](${page}#v:${key})`);
      lines.push(comment(notes.join("\n\n")));
      if (deprecated) lines.push(`---@deprecated ${deprecated}`);
      if (type === "integer" && /^(0x[0-9a-fA-F]+|\d+)$/.test(v.value))
        lines.push(`${local}.${key} = ${v.value}`);
      else lines.push(`---@type ${type}`, `${local}.${key} = nil`);
      body.push(lines.join("\n"));
      counts.values++;
    }
    for (const key of Object.keys(all)) {
      if (handWritten.has(`${name}.${key}`) || !isName(key)) continue;
      done.add(key);
      const fn = all[key];
      const { notes, deprecated } = versionNotes(
        fn.doc,
        inOld(key),
        inNew(key),
      );
      if (name === "peripheral" && key === "find" && options.findOverloads) {
        body.push(renderFind(fn, `${page}#v:${key}`, options.findOverloads));
        counts.functions++;
        continue;
      }
      const rendered = renderFunction(`${local}.${key}`, fn, {
        url: `${page}#v:${key}`,
        summary: summary(`${name}.${key}`),
        notes,
        deprecated,
        tied: TIED.has(`${name}.${key}`),
      });
      const patch = PATCHES[`${name}.${key}`];
      body.push(patch ? patch(rendered.split(NL)).join(NL) : rendered);
      counts.functions++;
    }
    // what is there when it runs and no doc comment describes
    for (const [key, type] of Object.entries({
      ...(runtimeOld ?? {}),
      ...(runtimeNew ?? {}),
    })) {
      if (done.has(key) || handWritten.has(`${name}.${key}`)) continue;
      if (parent && handWritten.has(`${parent.local}.${key}`)) continue;
      const only = !inOld(key)
        ? ` Not in CC:Tweaked ${OLD.cc}.`
        : !inNew(key)
          ? ` Not in CC:Tweaked ${NEW.cc}.`
          : "";
      if (type === "function") {
        if (!isName(key)) continue;
        const text =
          SUMMARIES[`${name}.${key}`] ?? "Has no doc comment in the ROM.";
        body.push(
          `---${text}${only}\n---\n---[tweaked.cc](${page}#v:${key})\n---@param ... any\n---@return any ...\nfunction ${local}.${key}(...) end`,
        );
      } else {
        const t =
          type === "number"
            ? name === "keys" || name === "colors"
              ? "integer"
              : "number"
            : typeof type === "string"
              ? type
              : "table";
        fieldLines.push(
          `---@field ${isName(key) ? key : `["${key}"]`} ${t}${only ? " " + only.trim() : ""}`,
        );
      }
      counts.filled.push(`${name}.${key}`);
    }

    out.push(
      comment(MODULE_SUMMARY[name] ?? summary(name) ?? `The \`${name}\` API.`),
      "---",
    );
    if (!before)
      out.push(
        `---**Not in CC:Tweaked ${OLD.cc}** (Minecraft ${OLD.mc})${since(mod.doc) ? `: added in ${since(mod.doc)}` : ""}.`,
        "---",
      );
    if (!modules[name])
      out.push(
        `---**Removed by CC:Tweaked ${NEW.cc}** (Minecraft ${NEW.mc}).`,
        "---",
      );
    out.push(`---[tweaked.cc](${page})`);
    out.push(
      `---@class ${className}${parent ? ": " + parent.type : ""}`,
      ...fieldLines,
      ...(MODULE_EXTRAS[name] ?? []),
    );
    out.push(isModule ? `local ${local} = {}` : `${local} = {}`, "");
    out.push(body.join("\n\n"), "");

    const classes = {
      ...(before?.classes ?? {}),
      ...(modules[name]?.classes ?? {}),
    };
    for (const cls of Object.values(classes)) {
      const extra = CLASS_EXTRAS[cls.name] ?? {};
      const type = `cc.${isModule ? name.replace(/^cc\./, "") + "." : name === "io" ? "io." : ""}${cls.name}`;
      out.push(
        comment(
          summary(`${name}.${cls.name}`) ?? `A \`${cls.name}\` of \`${name}\`.`,
        ),
        "---",
        `---[tweaked.cc](${page}#ty:${cls.name})`,
      );
      out.push(
        `---@class ${type}${extra.parent ? ": " + extra.parent : ""}`,
        ...(extra.lines ?? []),
      );
      out.push(`local ${cls.name} = {}`, "");
      const oldMethods = before?.classes[cls.name]?.methods ?? {};
      const newMethods = modules[name]?.classes[cls.name]?.methods ?? {};
      const blocks = [];
      for (const [key, fn] of Object.entries({
        ...oldMethods,
        ...newMethods,
      })) {
        if (!isName(key)) continue;
        const { notes, deprecated } = versionNotes(
          fn.doc,
          !before || has(oldMethods, key),
          has(newMethods, key),
        );
        const self = fn.args[0] === "self";
        blocks.push(
          renderFunction(
            `${cls.name}${self && !extra.dot ? ":" : "."}${key}`,
            fn,
            {
              url: `${page}#ty:${cls.name}:${key}`,
              summary: summary(`${name}.${cls.name}:${key}`),
              notes,
              deprecated,
            },
          ),
        );
        counts.methods++;
      }
      out.push(blocks.join("\n\n"), "");
      counts.classes++;
    }
    if (isModule) out.push(`return ${local}`, "");
    files[`${name.split(".").join("/")}.lua`] = out.join("\n");
    counts.modules++;

    if (name === "colors") {
      // colours: the same table with British names
      const text = files["colors.lua"]
        .replace(`---${SUMMARIES.colors}`, `---${SUMMARIES.colours}`)
        .replace("---@class cc.colors", "---@class cc.colours")
        .replace(/^colors\b/gm, "colours")
        .replace(/^function colors\./gm, "function colours.")
        .replace(/^colours\.gray\b/gm, "colours.grey")
        .replace(/^colours\.lightGray\b/gm, "colours.lightGrey")
        .replace(/module\/colors\.html/g, "module/colours.html")
        .replace(/#v:gray\b/g, "#v:grey")
        .replace(/#v:lightGray\b/g, "#v:lightGrey");
      files["colours.lua"] = text;
      counts.modules++;
    }
  }
  if (!modules.colors) warn("no colors module in the ROM");
  return { files, counts };
}

export const HEADER =
  "-- Generated by packages/cc-types/scripts/generate.mjs. Names, types and versions are read from the doc comments of\n" +
  "-- the CC:Tweaked ROM; none of their text is copied. Each description is ours (scripts/lib/summaries.mjs) and each\n" +
  "-- entry links to its page on tweaked.cc. Do not edit: change the script and run it again.";
