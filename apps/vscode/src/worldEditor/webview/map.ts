// The map: the world seen from above (x to the right, z down, north up), with the computer, every block and
// player that has a position, and the other computers of the folder. Drag a thing, or focus it and use the arrow
// keys (Shift: 10 blocks), to move it.
import type { JsonPath } from "../../../../../packages/world-editor/src/jsonDoc.ts";
import type {
  ComputerFacts,
  Neighbour,
  Thing,
} from "../../../../../packages/world-editor/src/model.ts";
import {
  icon,
  iconKind,
  s,
} from "../../../../../packages/world-editor/src/dom.ts";

export interface MapItem {
  readonly key: string;
  readonly label: string;
  readonly kind: "computer" | "thing" | "neighbour";
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly icon: ReturnType<typeof iconKind>;
  readonly selected: boolean;
  readonly problem?: boolean;
  /** Neighbours: how this computer reaches it, if it does. */
  readonly link?: string;
  readonly far?: boolean;
}

export interface MapCallbacks {
  select(item: MapItem): void;
  move(item: MapItem, x: number, z: number): void;
}

const W = 560;
const H = 280;
/** Things further than this from the computer go on the edge, with their distance. */
const NEAR = 40;

export function mapItems(
  computer: ComputerFacts,
  computerLabel: string,
  things: readonly Thing[],
  neighbours: readonly Neighbour[],
  links: readonly (string | undefined)[],
  selectedKey: string,
  keyOf: (path: JsonPath) => string,
  problemKeys: ReadonlySet<string>,
): MapItem[] {
  const items: MapItem[] = [
    {
      key: "computer",
      label: computerLabel,
      kind: "computer",
      x: computer.x,
      y: computer.y,
      z: computer.z,
      icon:
        computer.kind === "turtle"
          ? "turtle"
          : computer.kind === "pocket"
            ? "pocket"
            : "computer",
      selected: selectedKey === "computer",
    },
  ];
  for (const t of things) {
    if (t.x === undefined || t.z === undefined) continue;
    const key = keyOf(t.path);
    items.push({
      key,
      label: t.name || t.type,
      kind: "thing",
      x: t.x,
      y: t.y ?? computer.y,
      z: t.z,
      icon: iconKind(t.type, t.modem),
      selected: selectedKey === key,
      problem: problemKeys.has(key),
    });
  }
  neighbours.forEach((n, k) => {
    const far =
      Math.hypot(n.computer.x - computer.x, n.computer.z - computer.z) > NEAR ||
      n.computer.dimension !== computer.dimension;
    items.push({
      key: `neighbour:${n.file}`,
      label: n.file
        .split(/[\\/]/)
        .pop()!
        .replace(/\.world\.json$|\.json$/, ""),
      kind: "neighbour",
      x: n.computer.x,
      y: n.computer.y,
      z: n.computer.z,
      icon:
        n.computer.kind === "turtle"
          ? "turtle"
          : n.computer.kind === "pocket"
            ? "pocket"
            : "computer",
      selected: selectedKey === `neighbour:${n.file}`,
      link: links[k],
      far,
    });
  });
  return items;
}

export function renderMap(
  items: readonly MapItem[],
  cb: MapCallbacks,
): SVGElement {
  const centre = items[0]!;
  const near = items.filter((i) => !i.far);
  let minX = Math.min(...near.map((i) => i.x)) - 3;
  let maxX = Math.max(...near.map((i) => i.x)) + 3;
  let minZ = Math.min(...near.map((i) => i.z)) - 3;
  let maxZ = Math.max(...near.map((i) => i.z)) + 3;
  // at least 12 blocks across, centred
  const grow = (lo: number, hi: number, min: number): [number, number] => {
    const span = hi - lo;
    return span >= min
      ? [lo, hi]
      : [lo - (min - span) / 2, hi + (min - span) / 2];
  };
  [minX, maxX] = grow(minX, maxX, 14);
  [minZ, maxZ] = grow(minZ, maxZ, 9);
  const pad = 28;
  const scale = Math.min(
    (W - 2 * pad) / (maxX - minX),
    (H - 2 * pad) / (maxZ - minZ),
    26,
  );
  const cx = (W - (maxX - minX) * scale) / 2 - minX * scale;
  const cz = (H - (maxZ - minZ) * scale) / 2 - minZ * scale;
  const px = (x: number): number => cx + x * scale;
  const pz = (z: number): number => cz + z * scale;

  const svg = s("svg", {
    class: "map",
    viewBox: `0 0 ${W} ${H}`,
    role: "group",
    "aria-label":
      "Map from above: x to the right, z down. Arrow keys move the focused thing.",
  }) as SVGSVGElement;

  // block grid, with every 8th line stronger
  const grid = s("g", { class: "grid", "aria-hidden": "true" });
  const step = scale < 8 ? 8 : 1;
  for (let x = Math.ceil((0 - cx) / scale / step) * step; px(x) <= W; x += step)
    grid.append(
      s("line", {
        x1: px(x - 0.5),
        y1: 0,
        x2: px(x - 0.5),
        y2: H,
        class: x % 8 === 0 ? "major" : "",
      }),
    );
  for (let z = Math.ceil((0 - cz) / scale / step) * step; pz(z) <= H; z += step)
    grid.append(
      s("line", {
        x1: 0,
        y1: pz(z - 0.5),
        x2: W,
        y2: pz(z - 0.5),
        class: z % 8 === 0 ? "major" : "",
      }),
    );
  svg.append(grid);
  svg.append(
    s(
      "text",
      {
        x: W - 6,
        y: 14,
        class: "compass",
        "text-anchor": "end",
        "aria-hidden": "true",
      },
      "N ↑",
    ),
  );

  // where a far neighbour sits on the edge, in its direction
  const edge = (i: MapItem): [number, number] => {
    const dx = i.x - centre.x;
    const dz = i.z - centre.z;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len;
    const uz = dz / len;
    const ox = px(centre.x);
    const oz = pz(centre.z);
    const t = Math.min(
      ux ? (ux > 0 ? W - 18 - ox : 18 - ox) / ux : Infinity,
      uz ? (uz > 0 ? H - 18 - oz : 18 - oz) / uz : Infinity,
    );
    return [ox + ux * t, oz + uz * t];
  };
  const placeOf = (i: MapItem): [number, number] =>
    i.far ? edge(i) : [px(i.x), pz(i.z)];

  for (const i of items)
    if (i.kind === "neighbour" && i.link) {
      const [x2, y2] = placeOf(i);
      svg.append(
        s("line", {
          x1: px(centre.x),
          y1: pz(centre.z),
          x2,
          y2,
          class: `link link-${i.link}`,
          "aria-hidden": "true",
        }),
      );
    }

  const size = Math.max(12, Math.min(scale, 22));
  // things on one block fan out a little, so each can be seen and grabbed; the computer is drawn last, on top
  const seen = new Map<string, number>();
  const order = [...items.slice(1), items[0]!];
  for (const i of order) {
    const [bx, by] = placeOf(i);
    const spot = `${Math.round(bx)},${Math.round(by)}`;
    const n = i.kind === "computer" ? 0 : (seen.get(spot) ?? 0);
    if (i.kind !== "computer") seen.set(spot, n + 1);
    const shift =
      i.kind === "computer" || !(i.x === centre.x && i.z === centre.z)
        ? n * 6
        : (n + 1) * 7;
    const [x, y] = [bx + shift, by - shift];
    const distance = Math.round(
      Math.hypot(i.x - centre.x, i.y - centre.y, i.z - centre.z),
    );
    const label = `${i.label}: x ${i.x}, y ${i.y}, z ${i.z}${i.kind === "neighbour" ? `, ${distance} blocks away${i.link ? `, reached by ${i.link} modem` : ", not reached"}` : ""}`;
    const g = s(
      "g",
      {
        class: `item item-${i.kind}${i.selected ? " selected" : ""}${i.problem ? " problem" : ""}${i.far ? " far" : ""}`,
        transform: `translate(${x} ${y})`,
        tabindex: 0,
        role: "button",
        "aria-label": label,
        "aria-pressed": i.selected ? "true" : "false",
        "data-key": `map:${i.key}`,
      },
      s("title", {}, label),
      s("rect", {
        x: -size / 2,
        y: -size / 2,
        width: size,
        height: size,
        rx: i.kind === "computer" ? 3 : 2,
        class: "body",
      }),
    );
    const ic = icon(i.icon, "map-icon");
    const inner = size * 0.72;
    ic.setAttribute("x", String(-inner / 2));
    ic.setAttribute("y", String(-inner / 2));
    ic.setAttribute("width", String(inner));
    ic.setAttribute("height", String(inner));
    g.append(ic);
    if (i.kind !== "thing" || i.selected)
      g.append(
        s(
          "text",
          // near an edge the label runs inward
          {
            y: size / 2 + 11,
            "text-anchor": x > W - 70 ? "end" : x < 70 ? "start" : "middle",
            x: x > W - 70 ? size / 2 : x < 70 ? -size / 2 : 0,
            class: "label",
          },
          i.far ? `${i.label} · ${distance} blocks` : i.label,
        ),
      );
    attachDrag(svg, g, i, cb, scale, x, y);
    svg.append(g);
  }
  return svg;
}

function attachDrag(
  svg: SVGSVGElement,
  g: SVGElement,
  item: MapItem,
  cb: MapCallbacks,
  scale: number,
  x0: number,
  y0: number,
): void {
  let start: { x: number; y: number } | undefined;
  let moved = false;
  // where it is now: key presses faster than the redraw add up instead of starting from the old place
  const at = { x: item.x, z: item.z };
  const moveTo = (x: number, z: number): void => {
    g.setAttribute(
      "transform",
      `translate(${x0 + (x - item.x) * scale} ${y0 + (z - item.z) * scale})`,
    );
    at.x = x;
    at.z = z;
    cb.move(item, x, z);
  };
  const toSvg = (e: PointerEvent): { x: number; y: number } => {
    const m = svg.getScreenCTM();
    if (!m) return { x: e.clientX, y: e.clientY };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  };
  const blocks = (e: PointerEvent): { dx: number; dz: number } => {
    const p = toSvg(e);
    return {
      dx: Math.round((p.x - start!.x) / scale),
      dz: Math.round((p.y - start!.y) / scale),
    };
  };
  g.addEventListener("pointerdown", (e: Event) => {
    const pe = e as PointerEvent;
    if (pe.button !== 0) return;
    start = toSvg(pe);
    moved = false;
    g.setPointerCapture(pe.pointerId);
  });
  g.addEventListener("pointermove", (e: Event) => {
    if (!start || item.far) return;
    const { dx, dz } = blocks(e as PointerEvent);
    if (dx || dz) moved = true;
    g.setAttribute(
      "transform",
      `translate(${x0 + dx * scale} ${y0 + dz * scale})`,
    );
  });
  g.addEventListener("pointerup", (e: Event) => {
    if (!start) return;
    const { dx, dz } = blocks(e as PointerEvent);
    start = undefined;
    if (moved && (dx || dz) && !item.far) moveTo(at.x + dx, at.z + dz);
    else cb.select(item);
  });
  g.addEventListener("keydown", (e: Event) => {
    const k = e as KeyboardEvent;
    const n = k.shiftKey ? 10 : 1;
    const d: Record<string, [number, number]> = {
      ArrowLeft: [-n, 0],
      ArrowRight: [n, 0],
      ArrowUp: [0, -n],
      ArrowDown: [0, n],
    };
    if (k.key === "Enter" || k.key === " ") {
      k.preventDefault();
      cb.select(item);
    } else if (d[k.key]) {
      k.preventDefault();
      moveTo(at.x + d[k.key]![0], at.z + d[k.key]![1]);
    }
  });
}
