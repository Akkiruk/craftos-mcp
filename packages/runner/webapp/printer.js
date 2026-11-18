// Printers: the page each printer is printing and the pages it printed, as paper, under the computer's screens.
// What it shows is the sim state's peripherals.<name> for every printer (rom/ccsim/printer.lua): the page in the
// printer, its ink and paper, and every page that came out (the newest first). app.js says which computer is shown
// (the craftos:select event); nothing here touches app.js.
(() => {
  const HEX = "0123456789abcdef";
  // CC:Tweaked's 16 colours, by blit character
  const COLOURS = [
    "#f0f0f0",
    "#f2b233",
    "#e57fd8",
    "#99b2f2",
    "#dede6c",
    "#7fcc19",
    "#f2b2cc",
    "#4c4c4c",
    "#999999",
    "#4c99b2",
    "#b266e5",
    "#3366cc",
    "#7f664c",
    "#57a64e",
    "#cc4c4c",
    "#111111",
  ];
  const DYE_NAMES = {
    white: "white",
    orange: "orange",
    magenta: "magenta",
    light_blue: "light blue",
    yellow: "yellow",
    lime: "lime",
    pink: "pink",
    gray: "grey",
    light_gray: "light grey",
    cyan: "cyan",
    purple: "purple",
    blue: "blue",
    brown: "brown",
    green: "green",
    red: "red",
    black: "black",
  };

  let current = null;
  let shape = "";
  /** which printed page each printer shows large: name -> index into printed, or -1 for the one being printed */
  const picked = new Map();

  const box = document.createElement("div");
  box.id = "printer-box";
  box.hidden = true;
  const anchor =
    document.getElementById("pixels-box") ??
    document.getElementById("monitors-box");
  anchor?.after(box);

  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const k of kids) if (k != null) e.append(k);
    return e;
  };

  /** A sheet of paper: the page's 21 lines, each letter in its ink's colour. */
  function sheet(page, { small = false, title = "" } = {}) {
    const paper = el("div", {
      class: `pp-paper${small ? " small" : ""}`,
      role: "img",
    });
    paper.setAttribute(
      "aria-label",
      `${title ? `${title}: ` : ""}${
        page.text
          .map((l) => l.trimEnd())
          .filter(Boolean)
          .join(" / ") || "a blank page"
      }`,
    );
    page.text.forEach((line, y) => {
      const row = el("div", { class: "pp-line" });
      const colours = page.colours?.[y] ?? "";
      let run = "";
      let runColour = null;
      const flush = () => {
        if (!run) return;
        row.append(
          el("span", {
            style: `color:${COLOURS[HEX.indexOf(runColour)] ?? COLOURS[15]}`,
            text: run,
          }),
        );
        run = "";
      };
      for (let x = 0; x < line.length; x++) {
        const c = colours[x] ?? "f";
        if (c !== runColour) flush();
        runColour = c;
        run += line[x];
      }
      flush();
      paper.append(row);
    });
    return paper;
  }

  function dyeWords(name) {
    const m = /^minecraft:([a-z_]+)_dye$/.exec(name ?? "");
    return m ? `${DYE_NAMES[m[1]] ?? m[1]} ink` : "ink";
  }

  function render(printers) {
    box.hidden = printers.length === 0;
    if (box.hidden) return box.replaceChildren();
    const cards = printers.map(([name, p]) => {
      const printed = Array.isArray(p.printed) ? p.printed : [];
      let pick = picked.get(name);
      if (pick === undefined || pick >= printed.length)
        pick = p.printing ? -1 : printed.length - 1;
      const big =
        pick === -1
          ? { title: p.title, text: p.page ?? [], colours: p.colours ?? [] }
          : printed[pick];
      const status = p.printing
        ? `printing a page${p.title ? `, "${p.title}"` : ""}`
        : printed.length
          ? "idle"
          : "nothing printed yet";
      const levels = `${p.ink ?? 0} ${dyeWords(p.inkColour)}, ${p.paper ?? 0} paper`;
      const thumbs = [];
      if (p.printing)
        thumbs.push(
          el(
            "button",
            {
              class: `pp-thumb${pick === -1 ? " on" : ""}`,
              title: "The page in the printer now",
              onclick: () => (picked.set(name, -1), draw(true)),
            },
            sheet(
              { text: p.page ?? [], colours: p.colours ?? [] },
              { small: true },
            ),
            el("span", { text: "in the printer" }),
          ),
        );
      for (let i = printed.length - 1; i >= 0; i--) {
        const page = printed[i];
        thumbs.push(
          el(
            "button",
            {
              class: `pp-thumb${pick === i ? " on" : ""}`,
              title: page.title
                ? `Page ${i + 1}: ${page.title}`
                : `Page ${i + 1}`,
              onclick: () => (picked.set(name, i), draw(true)),
            },
            sheet(page, { small: true }),
            el("span", { text: page.title || `page ${i + 1}` }),
          ),
        );
      }
      return el(
        "figure",
        { class: "screen pp-printer" },
        el(
          "figcaption",
          {},
          el("b", { text: name }),
          ` printer · ${status} · ${levels}`,
        ),
        el(
          "div",
          { class: "pp-body" },
          big
            ? el(
                "div",
                { class: "pp-big" },
                el("div", {
                  class: "pp-title",
                  text:
                    pick === -1
                      ? `In the printer${big.title ? `: ${big.title}` : ""}`
                      : `Page ${pick + 1} of ${printed.length}${big.title ? `: ${big.title}` : ""}`,
                }),
                sheet(big, { title: big.title }),
              )
            : el("div", {
                class: "pp-empty",
                text: "No page yet. A program prints with newPage(), write() and endPage().",
              }),
          thumbs.length ? el("div", { class: "pp-thumbs" }, ...thumbs) : null,
        ),
      );
    });
    box.replaceChildren(
      el(
        "h2",
        {},
        "Printers ",
        el("span", {
          class: "sub",
          text: "the pages they printed, newest first",
        }),
      ),
      el("div", { class: "grid" }, ...cards),
    );
  }

  let last = [];
  function draw(force) {
    const s = JSON.stringify(last);
    if (!force && s === shape) return;
    shape = s;
    render(last);
  }

  async function poll() {
    if (!current || current === "lastrun") {
      if (!box.hidden) {
        last = [];
        draw(true);
      }
      return;
    }
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(current)}/state`,
      );
      if (!res.ok) return;
      const state = await res.json();
      const peripherals = state.peripherals ?? {};
      last = Object.entries(peripherals)
        .filter(
          ([, p]) =>
            p &&
            typeof p === "object" &&
            Array.isArray(p.page) &&
            "printing" in p,
        )
        .sort(([a], [b]) => a.localeCompare(b));
      draw(false);
    } catch {
      // the computer is starting or going
    }
  }

  document.addEventListener("craftos:select", (e) => {
    current = e.detail?.id ?? null;
    picked.clear();
    last = [];
    draw(true);
    poll();
  });
  setInterval(poll, 1000);
})();
