// Forms made from the world schema: one field per property, the widget picked from its schema (a list for enums, a
// number box, a checkbox list...), its description under it and the schema's problems in red. Anything the
// schema shapes too freely for a widget (item maps, tank lists, unions) gets a JSON box.
import type { EditOp, JsonPath } from "../jsonDoc.ts";
import {
  type Field,
  type Problem,
  type Schema,
  deref,
  fieldsOf,
  starterValue,
} from "../schema.ts";
import { h } from "./dom.ts";

export interface FormContext {
  readonly root: Schema;
  edit(ops: EditOp[]): void;
  /** Problems at this path or below it. */
  problemsAt(path: JsonPath, exact?: boolean): readonly Problem[];
}

export interface FormOptions {
  /** Keys drawn elsewhere. */
  readonly skip?: ReadonlySet<string>;
  /** Keys with a widget of their own. */
  readonly custom?: Readonly<
    Record<
      string,
      (path: JsonPath, value: unknown, field: Field) => HTMLElement
    >
  >;
  /** Show every field when there are at most this many, else only those set plus an "Add a setting" list. */
  readonly showAllUpTo?: number;
  readonly depth?: number;
}

export const keyOf = (path: JsonPath): string => JSON.stringify(path);

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** The first sentence of a description, for the line under a field (the whole one is its tooltip). */
export function firstSentence(text: string): string {
  const plain = text.replace(/\s+/g, " ").trim();
  const m = /^(.{20,}?[.!?])(\s|$)/.exec(plain);
  return m ? m[1]! : plain;
}

/** A description's text with its `code` spans as <code>, not as backticks. */
export function withCode(text: string): (string | HTMLElement)[] {
  return text
    .split(/`([^`]+)`/)
    .map((part, i) => (i % 2 ? h("code", {}, part) : part))
    .filter((part) => part !== "");
}

/** Without the backticks, for a tooltip. */
const plain = (text: string): string => text.replace(/`([^`]+)`/g, "$1");

function typesOf(s: Schema): string[] {
  return s.type === undefined
    ? []
    : typeof s.type === "string"
      ? [s.type]
      : [...s.type];
}

/** Enum values, when the schema is a plain choice (directly or as an anyOf of enums). */
function choices(
  root: Schema,
  s: Schema,
): { values: unknown[]; free: boolean; descriptions: string[] } | undefined {
  if (s.enum)
    return {
      values: [...s.enum],
      free: false,
      descriptions: [...(s.enumDescriptions ?? [])],
    };
  if (!s.anyOf) return undefined;
  const values: unknown[] = [];
  const descriptions: string[] = [];
  let free = false;
  for (const raw of s.anyOf) {
    const sub = deref(root, raw);
    if (!sub) continue;
    if (sub.enum) {
      sub.enum.forEach((v, k) => {
        values.push(v);
        descriptions.push(sub.enumDescriptions?.[k] ?? "");
      });
    } else if ("const" in sub) values.push(sub.const);
    else if (
      typesOf(sub).length === 1 &&
      typesOf(sub)[0] === "string" &&
      !sub.pattern
    )
      free = true;
    else return undefined;
  }
  return values.length ? { values, free, descriptions } : undefined;
}

/** The plain type of a schema, through allOf wrappers ({ description, allOf: [{ $ref }] }). */
function flatten(root: Schema, raw: Schema | undefined): Schema {
  let s = deref(root, raw) ?? {};
  for (
    let n = 0;
    n < 6 &&
    !s.type &&
    !s.enum &&
    !s.anyOf &&
    !s.properties &&
    s.allOf?.length === 1;
    n++
  )
    s = {
      ...deref(root, s.allOf[0]),
      description: s.description ?? deref(root, s.allOf[0])?.description,
    };
  return s;
}

let uid = 0;

export function renderField(
  ctx: FormContext,
  path: JsonPath,
  field: Field,
  value: unknown,
  depth = 0,
): HTMLElement {
  const s = flatten(ctx.root, field.schema);
  const present = value !== undefined;
  const id = `f${uid++}`;
  const problems = ctx.problemsAt(path);
  const set = (v: unknown): void =>
    ctx.edit([
      v === undefined ? { op: "remove", path } : { op: "set", path, value: v },
    ]);
  const desc =
    s.description ?? deref(ctx.root, field.schema)?.description ?? "";
  const def = s.default !== undefined ? s.default : undefined;
  const types = typesOf(s);
  const choice = choices(ctx.root, s);
  const key = keyOf(path);
  let widget: HTMLElement;

  if (
    choice &&
    !choice.free &&
    choice.values.every((v) => typeof v !== "object")
  ) {
    const select = h(
      "select",
      {
        id,
        "data-key": key,
        "aria-invalid": problems.length ? "true" : undefined,
      },
      h(
        "option",
        { value: "" },
        def !== undefined
          ? `default (${String(def)})`
          : field.required
            ? "choose..."
            : "not set",
      ),
      choice.values.map((v, k) =>
        h(
          "option",
          {
            value: JSON.stringify(v),
            selected: present && JSON.stringify(v) === JSON.stringify(value),
            title: choice.descriptions[k] || undefined,
          },
          String(v),
        ),
      ),
    );
    if (
      present &&
      !choice.values.some((v) => JSON.stringify(v) === JSON.stringify(value))
    )
      select.append(
        h(
          "option",
          { value: JSON.stringify(value), selected: true },
          `${String(value)} (not allowed)`,
        ),
      );
    select.addEventListener("change", () =>
      set(select.value === "" ? undefined : JSON.parse(select.value)),
    );
    widget = select;
  } else if (choice?.free || (types.length === 1 && types[0] === "string")) {
    const list = choice ? `${id}-list` : undefined;
    const input = h("input", {
      id,
      type: "text",
      "data-key": key,
      value:
        typeof value === "string"
          ? value
          : present
            ? JSON.stringify(value)
            : "",
      placeholder:
        def !== undefined
          ? String(def)
          : ((s.examples?.[0] as string | undefined) ?? ""),
      list,
      spellcheck: "false",
      "aria-invalid": problems.length ? "true" : undefined,
    });
    input.addEventListener("change", () =>
      set(input.value === "" && !field.required ? undefined : input.value),
    );
    widget = h(
      "div",
      { class: "grow" },
      input,
      choice
        ? h(
            "datalist",
            { id: list },
            choice.values.map((v) => h("option", { value: String(v) })),
          )
        : null,
    );
  } else if (types.length === 1 && types[0] === "boolean") {
    const select = h(
      "select",
      {
        id,
        "data-key": key,
        "aria-invalid": problems.length ? "true" : undefined,
      },
      h(
        "option",
        { value: "" },
        def !== undefined ? `default (${String(def)})` : "not set",
      ),
      h("option", { value: "true", selected: value === true }, "true"),
      h("option", { value: "false", selected: value === false }, "false"),
    );
    if (present && typeof value !== "boolean")
      select.append(
        h(
          "option",
          { value: JSON.stringify(value), selected: true },
          `${JSON.stringify(value)} (not a boolean)`,
        ),
      );
    select.addEventListener("change", () =>
      set(select.value === "" ? undefined : JSON.parse(select.value)),
    );
    widget = select;
  } else if (
    types.length &&
    types.every((t) => t === "number" || t === "integer")
  ) {
    const input = h("input", {
      id,
      type: "number",
      "data-key": key,
      value: typeof value === "number" ? String(value) : "",
      placeholder: def !== undefined ? String(def) : "",
      min: s.minimum,
      max: s.maximum,
      step: types.includes("integer") ? 1 : "any",
      "aria-invalid": problems.length ? "true" : undefined,
    });
    input.addEventListener("change", () => {
      if (input.value === "") return set(field.required ? 0 : undefined);
      const n = Number(input.value);
      if (Number.isFinite(n)) set(n);
    });
    widget = input;
  } else if (
    types.length === 1 &&
    types[0] === "object" &&
    s.properties &&
    !s.anyOf &&
    depth < 3 &&
    (isObj(value) || !present)
  ) {
    return renderNested(ctx, path, field, s, value, depth, problems);
  } else {
    widget = jsonBox(ctx, id, key, path, value, field, problems);
  }

  return h(
    "div",
    {
      class: `field${problems.length ? " has-problem" : ""}${present ? " is-set" : ""}`,
    },
    h(
      "div",
      { class: "field-row" },
      h(
        "label",
        { for: id, title: plain(desc) || undefined },
        field.key,
        field.required
          ? h("span", { class: "req", title: "required" }, " *")
          : null,
      ),
      widget,
      present && !field.required
        ? h(
            "button",
            {
              class: "icon-button clear",
              title: `Remove ${field.key}`,
              "aria-label": `Remove ${field.key}`,
              onclick: () => set(undefined),
            },
            "×",
          )
        : h("span", { class: "icon-button-space" }),
    ),
    desc
      ? h(
          "div",
          { class: "field-desc", title: plain(desc) },
          withCode(firstSentence(desc)),
        )
      : null,
    problemList(problems, path),
  );
}

function problemList(
  problems: readonly Problem[],
  path: JsonPath,
): HTMLElement | null {
  if (!problems.length) return null;
  return h(
    "ul",
    { class: "field-problems", role: "alert" },
    problems.slice(0, 6).map((p) => {
      const below = p.path.slice(path.length).join(".");
      return h("li", {}, below ? `${below}: ${p.message}` : p.message);
    }),
  );
}

function jsonBox(
  ctx: FormContext,
  id: string,
  key: string,
  path: JsonPath,
  value: unknown,
  field: Field,
  problems: readonly Problem[],
): HTMLElement {
  const text = value === undefined ? "" : JSON.stringify(value, null, 2);
  const area = h("textarea", {
    id,
    "data-key": key,
    rows: Math.min(12, Math.max(2, text.split("\n").length)),
    spellcheck: "false",
    placeholder: JSON.stringify(starterValue(ctx.root, field.schema)),
    "aria-invalid": problems.length ? "true" : undefined,
  });
  area.value = text;
  const note = h("div", { class: "json-error", role: "status" });
  area.addEventListener("change", () => {
    if (area.value.trim() === "") return ctx.edit([{ op: "remove", path }]);
    try {
      ctx.edit([{ op: "set", path, value: JSON.parse(area.value) }]);
      note.textContent = "";
    } catch (error) {
      note.textContent = `Not JSON yet: ${(error as Error).message}`;
    }
  });
  return h("div", { class: "grow json-wrap" }, area, note);
}

function renderNested(
  ctx: FormContext,
  path: JsonPath,
  field: Field,
  s: Schema,
  value: unknown,
  depth: number,
  problems: readonly Problem[],
): HTMLElement {
  const present = value !== undefined;
  const desc = s.description ?? "";
  const body = present
    ? renderObject(ctx, path, s, value, { depth: depth + 1, showAllUpTo: 10 })
    : h(
        "button",
        {
          class: "secondary small",
          onclick: () => ctx.edit([{ op: "set", path, value: {} }]),
        },
        `Add ${field.key}`,
      );
  const details = h(
    "details",
    {
      class: `nested${problems.length ? " has-problem" : ""}`,
      open: present || problems.length > 0,
    },
    h(
      "summary",
      { title: desc || undefined },
      h("span", { class: "nested-key" }, field.key),
      field.required ? h("span", { class: "req" }, " *") : null,
      present ? null : h("span", { class: "muted" }, " not set"),
      present && !field.required
        ? h(
            "button",
            {
              class: "icon-button clear",
              title: `Remove ${field.key}`,
              "aria-label": `Remove ${field.key}`,
              onclick: (e: Event) => {
                e.preventDefault();
                ctx.edit([{ op: "remove", path }]);
              },
            },
            "×",
          )
        : null,
    ),
    desc
      ? h(
          "div",
          { class: "field-desc", title: plain(desc) },
          withCode(firstSentence(desc)),
        )
      : null,
    body,
    problemList(ctx.problemsAt(path, true), path),
  );
  return details;
}

/** A form for an object: its fields, set ones first in file order when the list is long. */
export function renderObject(
  ctx: FormContext,
  path: JsonPath,
  schema: Schema | undefined,
  value: unknown,
  opts: FormOptions = {},
): HTMLElement {
  const obj = isObj(value) ? value : {};
  const fields = fieldsOf(ctx.root, schema, obj).filter(
    (f) => !opts.skip?.has(f.key),
  );
  const known = new Set(fields.map((f) => f.key));
  const extra = Object.keys(obj).filter(
    (k) => !known.has(k) && !opts.skip?.has(k),
  );
  const showAll = fields.length <= (opts.showAllUpTo ?? 14);
  const shown = showAll
    ? fields
    : fields.filter((f) => f.key in obj || f.required);
  const hidden = showAll
    ? []
    : fields.filter((f) => !(f.key in obj) && !f.required);
  const depth = opts.depth ?? 0;

  const rows = shown.map((f) => {
    const custom = opts.custom?.[f.key];
    return custom
      ? custom([...path, f.key], obj[f.key], f)
      : renderField(ctx, [...path, f.key], f, obj[f.key], depth);
  });
  // keys the schema does not know (a typo, usually): right after the ones with a widget of their own, where they show
  const at = shown.filter((f) => opts.custom?.[f.key]).length;
  rows.splice(
    at,
    0,
    ...extra.map((k) =>
      renderField(
        ctx,
        [...path, k],
        { key: k, schema: {}, required: false },
        obj[k],
        depth,
      ),
    ),
  );

  let adder: HTMLElement | null = null;
  if (hidden.length) {
    const select = h(
      "select",
      { "aria-label": "Add a setting", "data-key": `${keyOf(path)}+add` },
      h("option", { value: "" }, `Add a setting (${hidden.length} more)...`),
      hidden.map((f) =>
        h(
          "option",
          { value: f.key, title: deref(ctx.root, f.schema)?.description ?? "" },
          f.key,
        ),
      ),
    );
    select.addEventListener("change", () => {
      const f = hidden.find((x) => x.key === select.value);
      if (f)
        ctx.edit([
          {
            op: "set",
            path: [...path, f.key],
            value: starterValue(ctx.root, f.schema),
          },
        ]);
    });
    adder = h("div", { class: "adder" }, select);
  }
  return h("div", { class: "form" }, rows, adder);
}
