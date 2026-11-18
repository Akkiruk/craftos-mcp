// The Add list: a search box over every block type, grouped by mod, used with the keyboard (arrows, Enter, Escape)
// or the mouse. It redraws its own list as the person types, so the editor around it does not have to.
import { type TypeEntry, customEntry, matchTypes } from "./catalog.ts";
import { h, icon, iconKind } from "./dom.ts";
import { firstSentence } from "./form.ts";
import type { Side } from "./schema.ts";

/** What the list shows; kept by the caller so a redraw of the page keeps the search. */
export interface PickerState {
  side?: Side;
  filter: string;
  active: number;
}

export interface PickerOptions {
  readonly state: PickerState;
  readonly types: readonly TypeEntry[];
  /** Addon ids that are on in this world: a mod's group says when it is off. */
  readonly addonsOn: ReadonlySet<string>;
  pick(entry: TypeEntry, side?: Side): void;
  close(): void;
  /** The title; default "Put on the <side> side" or "Add a block, monitor or player". */
  readonly title?: string;
  /** The line under the list. */
  readonly hint?: string;
}

export function renderPicker(o: PickerOptions): HTMLElement {
  const a = o.state;
  const listEl = h("ul", {
    id: "add-list",
    class: "options",
    role: "listbox",
    "aria-label": "Block types",
  });
  let entries: TypeEntry[] = [];
  const search = h("input", {
    type: "search",
    placeholder: `Search ${Math.floor(o.types.length / 10) * 10}+ block types: chest, modem, playerDetector, mekanism...`,
    value: a.filter,
    "data-key": "add:search",
    "aria-label": "Search block types",
    "aria-controls": "add-list",
    role: "combobox",
    "aria-expanded": "true",
    "aria-autocomplete": "list",
    autocomplete: "off",
    spellcheck: "false",
  });

  const setActive = (k: number, scroll: boolean): void => {
    a.active = Math.max(0, Math.min(entries.length - 1, k));
    for (const el of Array.from(listEl.querySelectorAll(".option.active"))) {
      el.classList.remove("active");
      el.setAttribute("aria-selected", "false");
    }
    const el = listEl.querySelector<HTMLElement>(`#add-${a.active}`);
    if (el) {
      el.classList.add("active");
      el.setAttribute("aria-selected", "true");
      search.setAttribute("aria-activedescendant", el.id);
      if (scroll) el.scrollIntoView({ block: "nearest" });
    } else search.removeAttribute("aria-activedescendant");
  };

  const fill = (): void => {
    const list = matchTypes(o.types, a.filter, !!a.side);
    const custom = customEntry(list, a.filter);
    entries = custom ? [...list, custom] : list;
    a.active = Math.max(0, Math.min(a.active, entries.length - 1));
    let group = "";
    const items: HTMLElement[] = [];
    entries.forEach((t, k) => {
      if (t.group !== group) {
        group = t.group;
        const off = t.addon && !o.addonsOn.has(t.addon);
        items.push(
          h(
            "li",
            { class: "group-head", role: "presentation" },
            group,
            off ? h("span", { class: "badge off" }, "off in this world") : null,
          ),
        );
      }
      items.push(
        h(
          "li",
          {
            id: `add-${k}`,
            role: "option",
            class: `option${k === a.active ? " active" : ""}`,
            "aria-selected": k === a.active ? "true" : "false",
            onclick: () => o.pick(t, a.side),
            onmousemove: () => {
              if (a.active !== k) setActive(k, false);
            },
          },
          t.target === "monitor"
            ? icon("monitor")
            : t.target === "player"
              ? icon("player")
              : icon(
                  iconKind(
                    t.type,
                    (t.preset?.["kind"] as string | undefined) ??
                      (t.type === "modem" ? "wireless" : undefined),
                  ),
                ),
          h(
            "span",
            { class: "option-main" },
            h(
              "span",
              { class: "option-label" },
              t.label,
              t.label !== t.type &&
                t.target === "peripheral" &&
                t.type !== "modem"
                ? h("span", { class: "option-type" }, ` ${t.type}`)
                : null,
            ),
            t.description
              ? h(
                  "span",
                  { class: "option-desc" },
                  firstSentence(t.description),
                )
              : null,
          ),
        ),
      );
    });
    listEl.replaceChildren(
      ...(items.length
        ? items
        : [h("li", { class: "hint" }, "Nothing matches.")]),
    );
    setActive(a.active, false);
  };

  search.addEventListener("input", () => {
    a.filter = search.value;
    a.active = 0;
    fill();
    listEl.scrollTop = 0;
  });
  search.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive(a.active + (e.key === "ArrowDown" ? 1 : -1), true);
    } else if (e.key === "PageDown" || e.key === "PageUp") {
      e.preventDefault();
      setActive(a.active + (e.key === "PageDown" ? 8 : -8), true);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = entries[a.active];
      if (pick) o.pick(pick, a.side);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      o.close();
    }
  });
  fill();

  const title =
    o.title ??
    (a.side ? `Put on the ${a.side} side` : "Add a block, monitor or player");
  const hint =
    o.hint ??
    (a.side
      ? "It goes on that side; whatever was there moves to the network."
      : "Monitors and modems take a free side; other blocks go on the network, named like minecraft:chest_0.");
  return h(
    "div",
    {
      class: "overlay",
      onclick: (e: Event) => {
        if (e.target === e.currentTarget) o.close();
      },
    },
    h(
      "div",
      {
        class: "dialog",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": title,
        // Tab stays in the dialog: the search box and the close button
        onkeydown: (e: Event) => {
          const k = e as KeyboardEvent;
          if (k.key === "Escape") {
            k.preventDefault();
            o.close();
            return;
          }
          if (k.key !== "Tab") return;
          const dialog = k.currentTarget as HTMLElement;
          const stops = Array.from(
            dialog.querySelectorAll<HTMLElement>("input, button"),
          );
          const i = stops.indexOf(document.activeElement as HTMLElement);
          k.preventDefault();
          stops[
            (i + (k.shiftKey ? -1 : 1) + stops.length) % stops.length
          ]?.focus();
        },
      },
      h(
        "div",
        { class: "dialog-head" },
        h("h2", {}, title),
        h(
          "button",
          {
            class: "icon-button",
            "aria-label": "Close",
            title: "Close (Escape)",
            onclick: () => o.close(),
          },
          "×",
        ),
      ),
      search,
      listEl,
      h("p", { class: "hint" }, hint),
    ),
  );
}
