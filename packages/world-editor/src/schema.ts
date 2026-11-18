// The world schema (schemas/world.schema.json, generated from the runner's world types) as the editor uses it: the
// fields of each peripheral type, and a validator for the draft-07 subset the schema is written in, so the editor's
// errors are the schema's. No vscode here.
import type { JsonPath } from "./jsonDoc.ts";

export interface Schema {
  readonly $ref?: string;
  readonly type?: string | readonly string[];
  readonly description?: string;
  readonly markdownDescription?: string;
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly additionalProperties?: boolean | Schema;
  readonly required?: readonly string[];
  readonly items?: Schema | readonly Schema[];
  readonly additionalItems?: boolean | Schema;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
  readonly enum?: readonly unknown[];
  readonly enumDescriptions?: readonly string[];
  readonly const?: unknown;
  readonly anyOf?: readonly Schema[];
  readonly allOf?: readonly Schema[];
  readonly not?: Schema;
  readonly if?: Schema;
  readonly then?: Schema;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly pattern?: string;
  readonly default?: unknown;
  readonly examples?: readonly unknown[];
  readonly definitions?: Readonly<Record<string, Schema>>;
}

export interface Problem {
  readonly path: JsonPath;
  readonly message: string;
}

export const SIDES = [
  "top",
  "bottom",
  "left",
  "right",
  "front",
  "back",
] as const;
export type Side = (typeof SIDES)[number];
export const isSide = (name: unknown): name is Side =>
  SIDES.includes(name as Side);

export function deref(root: Schema, s: Schema | undefined): Schema | undefined {
  let cur = s;
  for (let n = 0; cur?.$ref && n < 32; n++) {
    const name = cur.$ref.replace(/^#\/definitions\//, "");
    cur = root.definitions?.[name];
  }
  return cur;
}

const typeOf = (v: unknown): string =>
  v === null
    ? "null"
    : Array.isArray(v)
      ? "array"
      : Number.isInteger(v)
        ? "integer"
        : typeof v;

function typeMatches(want: string, v: unknown): boolean {
  const got = typeOf(v);
  return want === got || (want === "number" && got === "integer");
}

const show = (v: unknown): string => JSON.stringify(v);

/** Problems with `value` against `schema`, worded as VS Code's JSON language service words them. */
export function validate(
  root: Schema,
  value: unknown,
  schema: Schema = root,
  path: JsonPath = [],
): Problem[] {
  const s = deref(root, schema);
  if (!s) return [];
  const out: Problem[] = [];
  const at = (message: string, p: JsonPath = path): void =>
    void out.push({ path: p, message });

  if (s.type !== undefined) {
    const types = typeof s.type === "string" ? [s.type] : s.type;
    if (!types.some((t) => typeMatches(t, value))) {
      at(`Incorrect type. Expected "${types.join(" | ")}".`);
      return out;
    }
  }
  if (s.enum && !s.enum.some((e) => show(e) === show(value)))
    at(`Value is not accepted. Valid values: ${listOf(s.enum)}.`);
  if ("const" in s && show(s.const) !== show(value))
    at(`Value must be ${show(s.const)}.`);
  if (typeof value === "number") {
    if (s.minimum !== undefined && value < s.minimum)
      at(`Value is below the minimum of ${s.minimum}.`);
    if (s.maximum !== undefined && value > s.maximum)
      at(`Value is above the maximum of ${s.maximum}.`);
  }
  if (
    typeof value === "string" &&
    s.pattern &&
    !new RegExp(s.pattern, "u").test(value)
  )
    at(`String does not match the pattern of "${s.pattern}".`);

  if (Array.isArray(value)) {
    if (s.minItems !== undefined && value.length < s.minItems)
      at(`Array has too few items. Expected ${s.minItems} or more.`);
    if (s.maxItems !== undefined && value.length > s.maxItems)
      at(`Array has too many items. Expected ${s.maxItems} or fewer.`);
    if (s.uniqueItems && new Set(value.map(show)).size !== value.length)
      at("Array has duplicate items.");
    if (Array.isArray(s.items)) {
      const tuple = s.items as readonly Schema[];
      value.forEach((v, k) => {
        if (k < tuple.length)
          out.push(...validate(root, v, tuple[k]!, [...path, k]));
        else if (s.additionalItems === false)
          at("Array has too many items according to schema.", [...path, k]);
        else if (s.additionalItems && typeof s.additionalItems === "object")
          out.push(...validate(root, v, s.additionalItems, [...path, k]));
      });
    } else if (s.items)
      value.forEach((v, k) =>
        out.push(...validate(root, v, s.items as Schema, [...path, k])),
      );
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const r of s.required ?? [])
      if (!(r in obj)) at(`Missing property "${r}".`);
    for (const [k, v] of Object.entries(obj)) {
      const p = s.properties?.[k];
      if (p) out.push(...validate(root, v, p, [...path, k]));
      else if (s.additionalProperties === false)
        at(`Property ${k} is not allowed.`, [...path, k]);
      else if (
        s.additionalProperties &&
        typeof s.additionalProperties === "object"
      )
        out.push(...validate(root, v, s.additionalProperties, [...path, k]));
    }
  }

  for (const sub of s.allOf ?? [])
    out.push(...validate(root, value, sub, path));
  if (s.anyOf) {
    const results = s.anyOf.map((sub) => validate(root, value, sub, path));
    if (!results.some((r) => !r.length)) {
      // a branch that only objects to something inside the value says best what is wrong; then the one branch of
      // the value's own type; else a list of the forms
      const typed = results.filter(
        (r) =>
          !r.some(
            (p) =>
              p.message.startsWith("Incorrect type") &&
              p.path.length === path.length,
          ),
      );
      const inside = typed.filter((r) =>
        r.every((p) => p.path.length > path.length),
      );
      const fewest = (list: Problem[][]): Problem[] =>
        list.reduce((a, b) => (b.length < a.length ? b : a));
      if (inside.length) out.push(...fewest(inside));
      else if (typed.length === 1) out.push(...typed[0]!);
      else
        at(
          `Value does not match any of the allowed forms${enumHint(root, s.anyOf)}.`,
        );
    }
  }
  if (s.not && !validate(root, value, s.not, path).length)
    at("Matches a schema that is not allowed.");
  if (s.if) {
    if (!validate(root, value, s.if, path).length) {
      if (s.then) out.push(...validate(root, value, s.then, path));
    }
  }
  return out;
}

/** Up to 12 values, then how many more. */
function listOf(values: readonly unknown[]): string {
  const more = values.length - 12;
  return `${values.slice(0, 12).map(show).join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}

function enumHint(root: Schema, subs: readonly Schema[]): string {
  const values = subs.flatMap((sub) => deref(root, sub)?.enum ?? []);
  return values.length ? `: ${listOf(values)}` : "";
}

/** A field of a form: its name, schema, and whether it must be there. */
export interface Field {
  readonly key: string;
  readonly schema: Schema;
  readonly required: boolean;
}

/** The properties a schema allows (through $ref, allOf and if/then that `value` meets), in schema order. */
export function fieldsOf(
  root: Schema,
  schema: Schema | undefined,
  value: unknown = {},
): Field[] {
  const fields = new Map<string, Field>();
  const required = new Set<string>();
  const walk = (raw: Schema | undefined, depth: number): void => {
    const s = deref(root, raw);
    if (!s || depth > 8) return;
    for (const r of s.required ?? []) required.add(r);
    for (const [key, sub] of Object.entries(s.properties ?? {})) {
      const known = fields.get(key);
      // `{}` placeholders (name, type, x, ... in each type's fields) keep the description found first
      if (!known || isEmpty(deref(root, known.schema)))
        fields.set(key, { key, schema: sub, required: false });
    }
    for (const sub of s.allOf ?? []) walk(sub, depth + 1);
    if (s.if && s.then && !validate(root, value, s.if).length)
      walk(s.then, depth + 1);
  };
  walk(schema, 0);
  return [...fields.values()].map((f) => ({
    ...f,
    required: required.has(f.key),
  }));
}

const isEmpty = (s: Schema | undefined): boolean =>
  !s || Object.keys(s).length === 0;

/** The schema of the value at `path` in a document whose root is `value`, following each step's fields. */
export function schemaAt(
  root: Schema,
  value: unknown,
  path: JsonPath,
): Schema | undefined {
  let s: Schema | undefined = root;
  let v: unknown = value;
  for (const seg of path) {
    s = deref(root, s);
    if (!s) return undefined;
    if (typeof seg === "number") {
      const items = s.items ?? itemsOfAnyOf(root, s);
      s = Array.isArray(items)
        ? (items as readonly Schema[])[seg]
        : (items as Schema | undefined);
      v = Array.isArray(v) ? v[seg] : undefined;
    } else {
      const field = fieldsOf(root, s, v).find((f) => f.key === seg);
      s =
        field?.schema ??
        (typeof s.additionalProperties === "object"
          ? s.additionalProperties
          : undefined);
      v =
        v && typeof v === "object"
          ? (v as Record<string, unknown>)[seg]
          : undefined;
    }
  }
  return s;
}

function itemsOfAnyOf(
  root: Schema,
  s: Schema,
): Schema | readonly Schema[] | undefined {
  for (const sub of [...(s.anyOf ?? []), ...(s.allOf ?? [])]) {
    const d = deref(root, sub);
    if (d?.items) return d.items;
  }
  return undefined;
}

/** A peripheral type the schema knows, with its description. */
export interface PeripheralType {
  readonly type: string;
  readonly description: string;
}

export function peripheralTypes(root: Schema): PeripheralType[] {
  const typeSchema = deref(root, root.definitions?.["PeripheralEntry"])
    ?.properties?.["type"];
  const list = typeSchema?.anyOf?.find((a) => a.enum);
  return (list?.enum ?? []).map((t, k) => ({
    type: String(t),
    description: list?.enumDescriptions?.[k] ?? "",
  }));
}

/** The fields one peripheral type takes (name, type and the position first). */
export function peripheralFields(root: Schema, type: string): Field[] {
  return fieldsOf(root, root.definitions?.["Peripheral"], { type });
}

/** A short description: the first sentence of the schema's own. */
export function describe(s: Schema | undefined): string {
  return s?.description ?? "";
}

/** A value to start a new field with: its default, else an empty value of its type. */
export function starterValue(
  root: Schema,
  schema: Schema | undefined,
): unknown {
  const s = deref(root, schema);
  if (!s) return "";
  if (s.default !== undefined) return s.default;
  if ("const" in s) return s.const;
  if (s.enum?.length) return s.enum[0];
  const t = typeof s.type === "string" ? s.type : s.type?.[0];
  if (t === "number" || t === "integer") return s.minimum ?? 0;
  if (t === "boolean") return false;
  if (t === "array") return [];
  if (t === "object") return {};
  if (t === "string") return "";
  for (const sub of [...(s.allOf ?? []), ...(s.anyOf ?? [])]) {
    const v = starterValue(root, sub);
    if (v !== "") return v;
  }
  return "";
}
