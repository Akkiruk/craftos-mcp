// The JSON Schema of world files (schemas/world.schema.json), generated from the TypeScript types that describe them:
// WorldFile in world.ts and PeripheralTypeMap in world-peripherals.ts, read with the TypeScript compiler, JSDoc and
// all. Addon ids, peripheral types and Minecraft versions come from addons.ts and versions.ts. The schema is built
// from the public view of the source (scripts/strip-private.mjs), so it never holds a field the public copy lacks.
//
// The schema files are file snapshots: after changing a world type, regenerate them with
//
//   npx vitest run packages/runner/src/world-schema.test.ts -u
//
// The tests also validate every world file in the repo against the schema its "$schema" names.
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { ADDONS } from "./addons.js";
import { VERSIONS } from "./versions.js";
import { loadNamedWorld, worldJson } from "./world.js";

const SRC = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(SRC, "../../..");
const SCHEMAS = join(REPO, "schemas");
/** Where other editors find the public schema: main of the public repository. */
const PUBLIC_URL =
  "https://raw.githubusercontent.com/Akkiruk/craftos-mcp/main/schemas/world.schema.json";

const { stripPrivate } = (await import(
  pathToFileURL(join(REPO, "scripts", "strip-private.mjs")).href
)) as { stripPrivate: (text: string, path: string) => string };

type Schema = Record<string, unknown>;
const SIDES = ["top", "bottom", "left", "right", "front", "back"];

// ---------------------------------------------------------------------------------------------------------------
// The generator: TypeScript types to JSON Schema draft-07 (the draft every editor's JSON support knows).

interface Built {
  schema: Schema;
  /** Properties with no description, as Type.property. */
  undocumented: string[];
  /** Keys of PeripheralTypeMap. */
  peripheralTypes: string[];
  /** Properties of WorldConfig. */
  worldKeys: string[];
}

function buildSchema(publicView: boolean): Built {
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2023,
    lib: ["lib.es2023.d.ts"],
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const ours = (file: string) =>
    resolve(file).toLowerCase().startsWith(SRC.toLowerCase());
  const readFile = host.readFile.bind(host);
  host.readFile = (file) => {
    const text = readFile(file);
    return text !== undefined && publicView && ours(file)
      ? stripPrivate(text, file)
      : text;
  };
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (file, language, onError, create) => {
    if (!ours(file)) return getSourceFile(file, language, onError, create);
    const text = host.readFile(file);
    return text === undefined
      ? undefined
      : ts.createSourceFile(file, text, language);
  };
  const files = ["world.ts", "world-peripherals.ts"].map((f) => join(SRC, f));
  const program = ts.createProgram(files, options, host);
  const checker = program.getTypeChecker();

  const exported = (file: string, name: string): ts.Type => {
    const source = program.getSourceFile(join(SRC, file))!;
    const symbol = checker
      .getExportsOfModule(checker.getSymbolAtLocation(source)!)
      .find((s) => s.name === name);
    if (!symbol) throw new Error(`${file} exports no ${name}`);
    return checker.getDeclaredTypeOfSymbol(symbol);
  };

  const definitions: Record<string, Schema> = {};
  const defNames = new Map<ts.Type, string>();
  const used = new Set<string>();
  const undocumented: string[] = [];
  const ref = (name: string): Schema => ({ $ref: `#/definitions/${name}` });

  const declaredHere = (symbol: ts.Symbol | undefined) =>
    !!symbol?.declarations?.some((d) => ours(d.getSourceFile().fileName));

  const docOf = (symbol: ts.Symbol | undefined): string =>
    symbol
      ? ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim()
      : "";

  /** The interface that declares a property, for OVERRIDES and messages. */
  function ownerOf(p: ts.Symbol): string | undefined {
    const parent = p.declarations?.[0]?.parent;
    return parent && ts.isInterfaceDeclaration(parent)
      ? parent.name.text
      : undefined;
  }

  /**
   * The alias a property is declared with, when the checker forgets it (an alias of Partial<Record<...>> resolves to
   * a type whose alias is Partial).
   */
  function aliasHint(p: ts.Symbol): string | undefined {
    const decl = p.valueDeclaration;
    const node =
      decl && (ts.isPropertySignature(decl) || ts.isPropertyDeclaration(decl))
        ? decl.type
        : undefined;
    if (!node || !ts.isTypeReferenceNode(node) || node.typeArguments)
      return undefined;
    const symbol = checker.getSymbolAtLocation(node.typeName);
    return symbol &&
      symbol.flags & ts.SymbolFlags.TypeAlias &&
      declaredHere(symbol)
      ? symbol.name
      : undefined;
  }

  /** A named type of ours gets a definition: its name, with type arguments when it has some. */
  function defName(type: ts.Type): string | undefined {
    const alias = type.aliasSymbol;
    if (alias && declaredHere(alias)) {
      const args = (type.aliasTypeArguments ?? []).map((a) =>
        checker
          .typeToString(a)
          .replace(/[^\w]+/g, "_")
          .replace(/^_|_$/g, ""),
      );
      return [alias.name, ...args].join("_");
    }
    if (
      type.flags & ts.TypeFlags.Object &&
      (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Interface &&
      declaredHere(type.symbol)
    )
      return type.symbol.name;
    return undefined;
  }

  /** The description a type carries itself (an interface's or alias's own JSDoc). */
  function typeDoc(type: ts.Type): string {
    return (docOf(type.aliasSymbol) || docOf(type.symbol)).replace(/\s+/g, " ");
  }

  function withoutUndefined(type: ts.Type): ts.Type[] {
    const parts = type.isUnion() ? type.types : [type];
    return parts.filter((t) => !(t.flags & ts.TypeFlags.Undefined));
  }

  function convert(type: ts.Type, where: string, hint?: string): Schema {
    const defined = withoutUndefined(type);
    if (defined.length === 1 && defined[0] !== type)
      return convert(defined[0]!, where, hint);
    const name = defName(type) ?? hint;
    // literal unions stay inline unless they are long (colours, side modes): those get a definition
    const long = type.isUnion() && type.types.length >= 8;
    if (name && (!isPrimitiveLike(type) || long)) {
      if (!defNames.has(type)) {
        let unique = name;
        for (let n = 2; used.has(unique); n++) unique = `${name}${n}`;
        used.add(unique);
        defNames.set(type, unique);
        definitions[unique] = {}; // placeholder: breaks cycles
        const body = convertBody(type, unique);
        const doc = typeDoc(type);
        definitions[unique] = doc ? { description: doc, ...body } : body;
        // the same alias met as two type objects (a tuple, say) is still one definition
        if (
          unique !== name &&
          JSON.stringify(definitions[unique]) ===
            JSON.stringify(definitions[name])
        ) {
          delete definitions[unique];
          used.delete(unique);
          defNames.set(type, name);
        }
      }
      return ref(defNames.get(type)!);
    }
    return convertBody(type, where);
  }

  function isPrimitiveLike(type: ts.Type): boolean {
    return withoutUndefined(type).every(
      (t) =>
        !!(
          t.flags &
          (ts.TypeFlags.StringLike |
            ts.TypeFlags.NumberLike |
            ts.TypeFlags.BooleanLike)
        ) && !(t.flags & ts.TypeFlags.Object),
    );
  }

  function convertBody(type: ts.Type, where: string): Schema {
    const parts = withoutUndefined(type);
    if (parts.length !== 1 || type.isUnion()) return convertUnion(parts, where);
    const t = parts[0]!;
    const f = t.flags;
    if (f & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return {};
    if (f & ts.TypeFlags.Null) return { type: "null" };
    if (f & ts.TypeFlags.StringLiteral)
      return { const: (t as ts.StringLiteralType).value };
    if (f & ts.TypeFlags.NumberLiteral)
      return { const: (t as ts.NumberLiteralType).value };
    if (f & ts.TypeFlags.BooleanLiteral)
      return { const: checker.typeToString(t) === "true" };
    if (f & (ts.TypeFlags.String | ts.TypeFlags.TemplateLiteral))
      return { type: "string" };
    if (f & ts.TypeFlags.Number) return { type: "number" };
    if (f & ts.TypeFlags.Boolean) return { type: "boolean" };
    if (
      t.isIntersection() &&
      t.types.some((p) => p.flags & ts.TypeFlags.String)
    )
      return { type: "string" }; // string & {}: any string, after the suggested ones
    if (checker.isTupleType(t)) {
      const target = (t as ts.TupleTypeReference).target;
      const items = checker
        .getTypeArguments(t as ts.TypeReference)
        .map((e, i) => convert(e, `${where}[${i}]`));
      return {
        type: "array",
        items,
        minItems: target.minLength,
        maxItems: items.length,
        additionalItems: false,
      };
    }
    if (checker.isArrayType(t)) {
      const element = checker.getTypeArguments(t as ts.TypeReference)[0]!;
      return { type: "array", items: convert(element, `${where}[]`) };
    }
    if (f & ts.TypeFlags.Object || t.isIntersection())
      return convertObject(t, where);
    throw new Error(`${where}: no schema for ${checker.typeToString(t)}`);
  }

  function literalValue(t: ts.Type): string | number | boolean | undefined {
    if (t.flags & ts.TypeFlags.StringLiteral)
      return (t as ts.StringLiteralType).value;
    if (t.flags & ts.TypeFlags.NumberLiteral)
      return (t as ts.NumberLiteralType).value;
    if (t.flags & ts.TypeFlags.BooleanLiteral)
      return checker.typeToString(t) === "true";
    return undefined;
  }

  function convertUnion(parts: ts.Type[], where: string): Schema {
    let literals = parts.map(literalValue).filter((v) => v !== undefined);
    const others = parts.filter((t) => literalValue(t) === undefined);
    const branches: Schema[] = [];
    // true | false is boolean
    if (literals.includes(true) && literals.includes(false)) {
      literals = literals.filter((v) => typeof v !== "boolean");
      branches.push({ type: "boolean" });
    }
    if (literals.length > 0) branches.unshift({ enum: literals });
    const objects = others.filter(
      (t) =>
        t.flags & ts.TypeFlags.Object &&
        !checker.isArrayType(t) &&
        !checker.isTupleType(t),
    );
    const discriminant =
      objects.length > 1 ? discriminantOf(objects) : undefined;
    for (const t of others) {
      if (discriminant && objects.includes(t)) continue;
      branches.push(convert(t, where));
    }
    if (discriminant)
      branches.push(discriminated(objects, discriminant, where));
    const merged = mergeStringBranches(branches);
    return merged.length === 1 ? merged[0]! : { anyOf: merged };
  }

  /** `{enum: [...]}` next to `{type: "string"}` stays (the enum is the suggestions); two enums merge. */
  function mergeStringBranches(branches: Schema[]): Schema[] {
    const enums = branches.filter(
      (b) => Object.keys(b).length === 1 && Array.isArray(b["enum"]),
    );
    if (enums.length < 2) return branches;
    const all = enums.flatMap((b) => b["enum"] as unknown[]);
    return [
      { enum: [...new Set(all)] },
      ...branches.filter((b) => !enums.includes(b)),
    ];
  }

  /** A property every member has, required, with literal values: the members' tag. */
  function discriminantOf(members: ts.Type[]): string | undefined {
    const first = checker.getPropertiesOfType(members[0]!);
    return first
      .map((p) => p.name)
      .find((name) =>
        members.every((m) => {
          const p = checker.getPropertyOfType(m, name);
          if (!p || p.flags & ts.SymbolFlags.Optional) return false;
          const values = withoutUndefined(checker.getTypeOfSymbol(p));
          return values.every((v) => literalValue(v) !== undefined);
        }),
      );
  }

  function discriminated(
    members: ts.Type[],
    tag: string,
    where: string,
  ): Schema {
    const valuesOf = (m: ts.Type) =>
      withoutUndefined(
        checker.getTypeOfSymbol(checker.getPropertyOfType(m, tag)!),
      ).map(literalValue);
    return {
      type: "object",
      required: [tag],
      properties: { [tag]: { enum: members.flatMap(valuesOf) } },
      allOf: members.map((m) => ({
        if: { properties: { [tag]: { enum: valuesOf(m) } }, required: [tag] },
        then: convert(m, where),
      })),
    };
  }

  function convertObject(type: ts.Type, where: string): Schema {
    const typeName = defName(type) ?? where;
    const properties: Record<string, Schema> = {};
    const required: string[] = [];
    for (const p of checker.getPropertiesOfType(type)) {
      const path = `${ownerOf(p) ?? typeName}.${p.name}`;
      const propType = checker.getTypeOfSymbol(p);
      const override = OVERRIDES[path];
      let schema = override
        ? override(p)
        : convert(propType, path, aliasHint(p));
      schema = annotate(schema, p, propType, path);
      properties[p.name] = schema;
      if (!(p.flags & ts.SymbolFlags.Optional)) required.push(p.name);
    }
    const out: Schema = { type: "object" };
    if (Object.keys(properties).length > 0) out["properties"] = properties;
    if (required.length > 0) out["required"] = required;
    const index = checker
      .getIndexInfosOfType(type)
      .find((i) => i.keyType.flags & ts.TypeFlags.String);
    if (!index) out["additionalProperties"] = false;
    else {
      const value = withoutUndefined(index.type);
      const open =
        value.length === 1 &&
        value[0]!.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown);
      if (!open) {
        const jsdoc = index.declaration
          ? ts.getJSDocCommentsAndTags(index.declaration).find(ts.isJSDoc)
          : undefined;
        const doc = ts.getTextOfJSDocComment(jsdoc?.comment) ?? "";
        const item = convert(index.type, `${typeName}[key]`);
        out["additionalProperties"] = doc
          ? { description: doc, ...wrap(item) }
          : item;
      }
    }
    return out;
  }

  /** A `$ref` with siblings: draft-07 ignores the siblings, so put the reference under allOf. */
  function wrap(schema: Schema): Schema {
    return "$ref" in schema ? { allOf: [schema] } : schema;
  }

  /** Description, default, examples and bounds from a property's JSDoc. */
  function annotate(
    schema: Schema,
    p: ts.Symbol,
    propType: ts.Type,
    path: string,
  ): Schema {
    let description = docOf(p);
    const extra: Schema = {};
    const notes: string[] = [];
    for (const tag of p.getJsDocTags(checker)) {
      const text = ts.displayPartsToString(tag.text).trim();
      const json = parseJson(text);
      switch (tag.name) {
        case "default":
          if (json.ok) extra["default"] = json.value;
          else notes.push(`Default: ${text}.`);
          break;
        case "example":
          ((extra["examples"] ??= []) as unknown[]).push(
            json.ok ? json.value : text,
          );
          break;
        case "minimum":
        case "maximum":
          extra[tag.name] = Number(text);
          break;
        case "integer":
          extra["type"] = "integer";
          break;
        default:
          throw new Error(`${path}: unknown JSDoc tag @${tag.name}`);
      }
    }
    if (!description) {
      const own = withoutUndefined(propType);
      description = own.length === 1 ? typeDoc(own[0]!) : typeDoc(propType);
    }
    description = [description, ...notes]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    // a key of a mapped type (Record<"north" | ..., V>) has no declaration of its own: its name says what it is
    if (!description && declaredHere(p)) undocumented.push(path);
    const out: Schema = { ...wrap(schema) };
    if (extra["type"] === "integer") {
      if (out["type"] !== "number")
        throw new Error(`${path}: @integer on a non-number`);
      out["type"] = "integer";
    }
    delete extra["type"];
    const head: Schema = {};
    if (description) {
      head["description"] = description;
      if (/[`*]/.test(description)) head["markdownDescription"] = description;
    }
    return { ...head, ...out, ...extra };
  }

  // ---- the special cases: what plain types cannot say ----

  const mcs = VERSIONS.map((v) => v.mc);
  const addonIds = ADDONS.map((a) => a.id);
  // ids are [a-z-]: nothing to escape (editors read patterns as unicode regexes, where an escaped "-" is an error)
  const idList = `(?:${addonIds.join("|")})`;
  const peripheralMap = exported("world-peripherals.ts", "PeripheralTypeMap");
  const peripheralTypes = checker
    .getPropertiesOfType(peripheralMap)
    .map((p) => p.name);
  const base = exported("world-peripherals.ts", "PeripheralBase");

  const OVERRIDES: Record<string, (p: ts.Symbol) => Schema> = {
    "WorldConfig.version": () => ({
      anyOf: [
        {
          enum: mcs,
          enumDescriptions: VERSIONS.map(
            (v) => `Minecraft ${v.mc}, CC:Tweaked ${v.cc}`,
          ),
        },
        {
          type: "object",
          required: ["mc"],
          properties: {
            mc: { description: "Minecraft version.", enum: mcs },
            cc: {
              description:
                "CC:Tweaked version; must be the one this Minecraft version has.",
              enum: [...new Set(VERSIONS.map((v) => v.cc))],
            },
            loader: {
              description: "Mod loader. Default: the version's first.",
              enum: [...new Set(VERSIONS.flatMap((v) => v.loaders))],
            },
          },
          additionalProperties: false,
        },
      ],
    }),
    "WorldConfig.addons": () => ({
      anyOf: [
        {
          enum: ["all", "none", ...addonIds],
          enumDescriptions: [
            "Every addon that has a release for the world's Minecraft version.",
            "Only CC:Tweaked.",
            ...ADDONS.map((a) => a.name),
          ],
        },
        { type: "array", items: { enum: addonIds }, uniqueItems: true },
        {
          type: "string",
          description: "Addon ids separated by commas.",
          pattern: `^\\s*${idList}(?:\\s*,\\s*${idList})*\\s*$`,
        },
      ],
    }),
    "WorldConfig.peripherals": () => ({
      type: "array",
      items: ref(peripheralDef(true)),
    }),
    "BlockSpec.peripheral": () => ref(peripheralDef(false)),
  };

  /** A peripheral entry: name, type and position, then the fields its type takes (PeripheralTypeMap). */
  function peripheralDef(named: boolean): string {
    const name = named ? "Peripheral" : "BlockPeripheral";
    if (!definitions[name])
      definitions[name] = {
        description: named
          ? "A peripheral: its name, its type, and the fields that type takes."
          : "A virtual peripheral a turtle next to the block sees (as in `peripherals`, without a name).",
        required: named ? ["name", "type"] : ["type"],
        allOf: [ref(peripheralFieldsDef())],
      };
    return name;
  }

  /** What every peripheral entry is, named or not. */
  function peripheralFieldsDef(): string {
    const name = "PeripheralEntry";
    if (definitions[name]) return name;
    definitions[name] = {};
    const baseSchema = convertObject(base, "PeripheralBase");
    const baseProps = baseSchema["properties"] as Record<string, Schema>;
    const branches: Schema[] = [];
    const typeDocs: string[] = [];
    for (const p of checker.getPropertiesOfType(peripheralMap)) {
      const spec = checker.getTypeOfSymbol(p);
      const specName = defName(spec) ?? p.name;
      const fieldsDef = `${specName.replace(/[^\w]/g, "_")}Fields`;
      if (!definitions[fieldsDef]) {
        definitions[fieldsDef] = {};
        const fields = convertObject(spec, specName);
        const props = {
          ...(fields["properties"] as Record<string, Schema> | undefined),
        };
        // the base fields belong to every entry; a spec that names one again (modem's name) keeps its own
        for (const key of Object.keys(baseProps)) props[key] ??= {};
        const doc = typeDoc(spec);
        definitions[fieldsDef] = {
          ...(doc ? { description: doc } : {}),
          type: "object",
          properties: props,
          ...("additionalProperties" in fields
            ? { additionalProperties: fields["additionalProperties"] }
            : {}),
        };
      }
      const addon = ADDONS.find((a) => a.types.includes(p.name));
      typeDocs.push(
        [typeDoc(spec), addon ? `(${addon.name})` : ""]
          .filter(Boolean)
          .join(" "),
      );
      branches.push({
        if: { properties: { type: { const: p.name } }, required: ["type"] },
        then: ref(fieldsDef),
      });
    }
    // any other type: a generic block (inventory, tank, battery), open to the fields of your own fixtures
    const generic = exported("world-peripherals.ts", "GenericStorageSpec");
    const genericFields = convertObject(generic, "GenericStorageSpec");
    branches.push({
      if: {
        properties: { type: { not: { enum: peripheralTypes } } },
        required: ["type"],
      },
      then: { properties: genericFields["properties"] as Schema },
    });
    baseProps["type"] = {
      ...baseProps["type"],
      anyOf: [
        { enum: peripheralTypes, enumDescriptions: typeDocs },
        { type: "string" },
      ],
    };
    delete baseProps["type"]!["type"];
    definitions[name] = {
      type: "object",
      properties: baseProps,
      allOf: branches,
    };
    return name;
  }

  // ---- go ----
  const world = exported("world.ts", "WorldFile");
  const root = convertObject(world, "WorldConfig");
  const worldKeys = checker
    .getPropertiesOfType(exported("world.ts", "WorldConfig"))
    .map((p) => p.name);
  const sorted = Object.fromEntries(
    Object.entries(definitions).sort(([a], [b]) => a.localeCompare(b)),
  );
  const schema: Schema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    ...(publicView ? { $id: PUBLIC_URL } : {}),
    title: "craftos-mcp world",
    description: typeDoc(world),
    ...root,
    definitions: sorted,
  };
  return { schema, undocumented, peripheralTypes, worldKeys };
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// A small draft-07 validator for the keywords the generator writes (no validator library in the tree).

const KNOWN = new Set([
  "$schema",
  "$id",
  "$ref",
  "title",
  "description",
  "markdownDescription",
  "enumDescriptions",
  "default",
  "examples",
  "definitions",
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "additionalItems",
  "minItems",
  "maxItems",
  "uniqueItems",
  "anyOf",
  "allOf",
  "if",
  "then",
  "not",
  "minimum",
  "maximum",
  "pattern",
]);

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number")
    return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function validate(
  schema: Schema | boolean,
  value: unknown,
  root: Schema,
  at = "$",
): string[] {
  if (schema === true) return [];
  if (schema === false) return [`${at}: not allowed`];
  for (const key of Object.keys(schema))
    if (!KNOWN.has(key))
      throw new Error(`schema keyword the validator does not know: ${key}`);
  const errors: string[] = [];
  const sub = (s: unknown, v: unknown, path: string) =>
    validate(s as Schema, v, root, path);
  if (typeof schema["$ref"] === "string") {
    const name = (schema["$ref"] as string).replace("#/definitions/", "");
    const target = (root["definitions"] as Record<string, Schema>)[name];
    if (!target) return [`${at}: no definition ${name}`];
    errors.push(...sub(target, value, at));
  }
  if (schema["type"] !== undefined) {
    const actual = typeOf(value);
    const ok =
      schema["type"] === actual ||
      (schema["type"] === "number" && actual === "integer");
    if (!ok)
      return [
        ...errors,
        `${at}: expected ${String(schema["type"])}, got ${actual}`,
      ];
  }
  if (
    Array.isArray(schema["enum"]) &&
    !(schema["enum"] as unknown[]).includes(value)
  )
    errors.push(
      `${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema["enum"]).slice(0, 200)}`,
    );
  if ("const" in schema && schema["const"] !== value)
    errors.push(`${at}: expected ${JSON.stringify(schema["const"])}`);
  if (typeof value === "number") {
    if (typeof schema["minimum"] === "number" && value < schema["minimum"])
      errors.push(`${at}: below ${schema["minimum"]}`);
    if (typeof schema["maximum"] === "number" && value > schema["maximum"])
      errors.push(`${at}: above ${schema["maximum"]}`);
  }
  if (
    typeof value === "string" &&
    typeof schema["pattern"] === "string" &&
    !new RegExp(schema["pattern"], "u").test(value)
  )
    errors.push(`${at}: does not match ${schema["pattern"]}`);
  if (typeOf(value) === "object") {
    const object = value as Record<string, unknown>;
    const props = (schema["properties"] ?? {}) as Record<string, Schema>;
    for (const key of (schema["required"] ?? []) as string[])
      if (!(key in object)) errors.push(`${at}: missing ${key}`);
    for (const [key, v] of Object.entries(object)) {
      if (key in props) errors.push(...sub(props[key], v, `${at}.${key}`));
      else if (schema["additionalProperties"] !== undefined)
        errors.push(...sub(schema["additionalProperties"], v, `${at}.${key}`));
    }
  }
  if (Array.isArray(value)) {
    const items = schema["items"];
    if (Array.isArray(items)) {
      value.forEach((v, i) => {
        if (i < items.length) errors.push(...sub(items[i], v, `${at}[${i}]`));
        else if (schema["additionalItems"] === false)
          errors.push(`${at}[${i}]: too many items`);
      });
    } else if (items !== undefined)
      value.forEach((v, i) => errors.push(...sub(items, v, `${at}[${i}]`)));
    if (
      typeof schema["minItems"] === "number" &&
      value.length < schema["minItems"]
    )
      errors.push(`${at}: fewer than ${schema["minItems"]} items`);
    if (
      typeof schema["maxItems"] === "number" &&
      value.length > schema["maxItems"]
    )
      errors.push(`${at}: more than ${schema["maxItems"]} items`);
    if (
      schema["uniqueItems"] === true &&
      new Set(value.map((v) => JSON.stringify(v))).size !== value.length
    )
      errors.push(`${at}: items repeat`);
  }
  for (const s of (schema["allOf"] ?? []) as Schema[])
    errors.push(...sub(s, value, at));
  if (Array.isArray(schema["anyOf"])) {
    const results = (schema["anyOf"] as Schema[]).map((s) => sub(s, value, at));
    if (!results.some((r) => r.length === 0))
      errors.push(
        results.reduce((a, b) => (a.length <= b.length ? a : b)).join("; ") ||
          `${at}: matches no branch`,
      );
  }
  if (
    schema["if"] !== undefined &&
    sub(schema["if"], value, at).length === 0 &&
    schema["then"] !== undefined
  )
    errors.push(...sub(schema["then"], value, at));
  if (schema["not"] !== undefined && sub(schema["not"], value, at).length === 0)
    errors.push(`${at}: matches what it must not`);
  return errors;
}

// ---------------------------------------------------------------------------------------------------------------

const built: Record<string, Built> = { "world.schema.json": buildSchema(true) };
const fallback = Object.keys(built).at(-1)!;

/** Every world file: `*.world.json` anywhere in the workspace, and `worlds/*.json`. */
function worldFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".world.json")) found.push(full);
    }
  };
  walk(join(REPO, "workspace"));
  for (const name of readdirSync(join(REPO, "worlds")))
    if (name.endsWith(".json")) found.push(join(REPO, "worlds", name));
  return found.sort();
}

describe("world schema", () => {
  for (const [file, { schema, undocumented }] of Object.entries(built)) {
    it(`${file} is up to date (regenerate with vitest -u)`, async () => {
      await expect(`${JSON.stringify(schema, null, 2)}\n`).toMatchFileSnapshot(
        join(SCHEMAS, file),
      );
    });
    it(`${file} describes every property`, () => {
      expect(undocumented).toEqual([]);
    });
  }

  const { peripheralTypes, worldKeys } = built[fallback]!;
  it("knows every peripheral type and world key of every addon", () => {
    for (const addon of ADDONS) {
      expect(peripheralTypes, addon.id).toEqual(
        expect.arrayContaining([...addon.types]),
      );
      expect(worldKeys, addon.id).toEqual(
        expect.arrayContaining([...(addon.worldKeys ?? [])]),
      );
    }
  });

  const files = worldFiles();
  it("finds the world files", () => {
    expect(files.length).toBeGreaterThan(10);
  });
  for (const file of files) {
    const name = relative(REPO, file).split("\\").join("/");
    it(`validates ${name}`, () => {
      const world = JSON.parse(readFileSync(file, "utf8")) as Record<
        string,
        unknown
      >;
      const chosen =
        typeof world["$schema"] === "string"
          ? basename(world["$schema"])
          : fallback;
      expect(
        Object.keys(built),
        `${name}: $schema names no schema here`,
      ).toContain(chosen);
      if (typeof world["$schema"] === "string")
        expect(
          resolve(dirname(file), world["$schema"]),
          `${name}: $schema is not a path to schemas/`,
        ).toBe(join(SCHEMAS, chosen));
      expect(
        validate(built[chosen]!.schema, world, built[chosen]!.schema),
      ).toEqual([]);
    });
  }

  const schema = built["world.schema.json"]!.schema;
  const check = (world: unknown) => validate(schema, world, schema);
  it("refuses mistakes", () => {
    expect(check({ peripheral: [] })).not.toEqual([]); // typo of a top-level key
    expect(check({ turtle: { facing: "up" } })).not.toEqual([]);
    expect(check({ version: "1.19.2" })).not.toEqual([]);
    expect(check({ addons: ["mekansim"] })).not.toEqual([]);
    expect(check({ addons: "create,nope" })).not.toEqual([]);
    expect(
      check({ peripherals: [{ name: "back", type: "modem", knd: "ender" }] }),
    ).not.toEqual([]);
    expect(
      check({ peripherals: [{ name: "back", type: "modem", kind: "laser" }] }),
    ).not.toEqual([]);
    expect(check({ peripherals: [{ type: "modem" }] })).not.toEqual([]);
    expect(check({ monitors: [{ name: "top", blocksWide: 9 }] })).not.toEqual(
      [],
    );
    expect(
      check({
        mekanism: { multiblocks: { r: { kind: "fission", fuell: 1 } } },
      }),
    ).not.toEqual([]);
  });
  it("takes what the runner takes", () => {
    expect(check({ $schema: "../schemas/world.schema.json" })).toEqual([]);
    expect(check({ addons: "create, mekanism" })).toEqual([]);
    expect(
      check({ addons: "all", version: { mc: "1.20.1", loader: "fabric" } }),
    ).toEqual([]);
    expect(
      check({
        peripherals: [
          // a block of your own naming with inventory, tank and energy fields, plus fixture fields of its own
          {
            name: "thermal_0",
            type: "thermal:machine_furnace",
            size: 3,
            energy: 10,
            custom: { a: 1 },
          },
          { name: "top", type: "modem", kind: "ender" },
          { name: "left", type: "speaker" },
          { name: "drive_0", type: "drive" },
        ],
        monitors: [
          { name: "right", blocksWide: 8, blocksHigh: 6, textScale: 0.5 },
        ],
      }),
    ).toEqual([]);
  });
});

describe("$schema in world files", () => {
  it("is not passed to the computer", () => {
    const world = { $schema: "../schemas/world.schema.json", computerId: 3 };
    const sim = JSON.parse(worldJson(world as never)) as Record<
      string,
      unknown
    >;
    expect(sim).not.toHaveProperty("$schema");
    expect(sim["computerId"]).toBe(3);
  });
  it("is dropped by loadNamedWorld", () => {
    const dir = mkdtempSync(join(tmpdir(), "world-schema-"));
    try {
      writeFileSync(
        join(dir, "w.json"),
        JSON.stringify({ $schema: "x", label: "hi" }),
      );
      expect(loadNamedWorld(dir, "w")).toEqual({ label: "hi" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
