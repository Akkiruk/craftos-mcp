// Tiny DOM helpers for the World Editor webview: no framework, so the bundle stays small and the strict CSP holds
// (no inline styles in markup: colours come from classes, sizes through the CSSOM).

type Child =
  | Node
  | string
  | number
  | false
  | null
  | undefined
  | readonly Child[];
type Attrs = Record<
  string,
  string | number | boolean | undefined | null | EventListener
>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  setAttrs(el, attrs);
  append(el, children);
  return el;
}

const SVG = "http://www.w3.org/2000/svg";

export function s(
  tag: string,
  attrs: Attrs = {},
  ...children: Child[]
): SVGElement {
  const el = document.createElementNS(SVG, tag);
  setAttrs(el, attrs);
  append(el, children);
  return el;
}

function setAttrs(el: Element, attrs: Attrs): void {
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function")
      el.addEventListener(k.slice(2), v);
    else if (k === "class") el.setAttribute("class", String(v));
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
}

function append(el: Element, children: readonly Child[]): void {
  for (const c of children) {
    if (c === undefined || c === null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** Icon kinds, one per sort of block. */
export type IconKind =
  | "computer"
  | "turtle"
  | "pocket"
  | "monitor"
  | "modem"
  | "ender"
  | "wired"
  | "chest"
  | "fluid"
  | "energy"
  | "speaker"
  | "drive"
  | "redstone"
  | "sensor"
  | "player"
  | "block";

export function iconKind(type: string, modem?: string): IconKind {
  if (type === "monitor") return "monitor";
  if (type === "player") return "player";
  if (type === "modem")
    return modem === "ender" ? "ender" : modem === "wired" ? "wired" : "modem";
  const t = type.toLowerCase();
  if (/speaker|note_block|jukebox|sculkophone/.test(t)) return "speaker";
  if (/drive|disk|cassette|reel|tape|harddrive/.test(t)) return "drive";
  if (/redstone|rsport|relay|redrouter/.test(t)) return "redstone";
  if (
    /chest|barrel|shulker|hopper|dropper|dispenser|inventory|bin$|furnace|qio|bridge|pedestal|storage$/.test(
      t,
    ) &&
    !/fluid|energy/.test(t)
  )
    return "chest";
  if (/fluid|tank|pump|plenisher|valve/.test(t)) return "fluid";
  if (
    /energy|cube|battery|accumulator|generator|reactor|turbine|cable|motor|port|matrix|induction|laser/.test(
      t,
    )
  )
    return "energy";
  if (
    /detector|sensor|scanner|radar|geo|reader|chatbox|player|environment|finder|compass/.test(
      t,
    )
  )
    return "sensor";
  if (/computer|turtle/.test(t)) return "computer";
  return "block";
}

const PATHS: Record<IconKind, string> = {
  computer: "M3 3h18v14H3z M6 6h12v8H6z M8 20h8",
  pocket: "M7 2h10v20H7z M9 5h6v8H9z",
  turtle: "M4 6h16v12H4z M7 9h10v5H7z M2 10h2v4H2z M20 10h2v4h-2z",
  monitor: "M2 4h20v13H2z M9 21h6 M12 17v4",
  modem: "M12 20v-6 M8.5 10.5a5 5 0 0 1 7 0 M5.5 7.5a9 9 0 0 1 13 0 M10 20h4",
  ender:
    "M3 12c4-6 14-6 18 0c-4 6-14 6-18 0z M12 9.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5z",
  wired: "M4 12h6 M14 12h6 M10 8h4v8h-4z M2 10v4 M22 10v4",
  chest: "M3 6h18v14H3z M3 11h18 M10 9h4v4h-4z",
  fluid: "M12 3c4 5 6 8 6 11a6 6 0 0 1-12 0c0-3 2-6 6-11z",
  energy: "M13 2L5 14h6l-1 8l8-12h-6z",
  speaker: "M4 9h4l5-4v14l-5-4H4z M16 9a4 4 0 0 1 0 6 M18.5 6.5a8 8 0 0 1 0 11",
  drive: "M3 6h18v12H3z M7 14h6 M17 14h1",
  redstone: "M12 3v6 M9 9h6l-1 4h-4z M10 13l-3 8h10l-3-8",
  sensor:
    "M12 12m-8 0a8 8 0 1 0 16 0a8 8 0 1 0-16 0 M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0 M12 12l6-6",
  player:
    "M12 4a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7z M5 21c0-4 3-7 7-7s7 3 7 7",
  block: "M12 2l9 5v10l-9 5l-9-5V7z M3 7l9 5l9-5 M12 12v10",
};

export function icon(kind: IconKind, cls = ""): SVGElement {
  return s(
    "svg",
    {
      class: `icon icon-${kind} ${cls}`,
      viewBox: "0 0 24 24",
      "aria-hidden": "true",
      focusable: "false",
    },
    s("path", { d: PATHS[kind] }),
  );
}
