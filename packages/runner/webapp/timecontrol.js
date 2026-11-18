// The app's time controls: a bar along the bottom of the window to pause, step, speed up or jump the clock of every
// computer, the world's time of day, and world snapshots. The server side is packages/runner/src/webapp-time.ts.
// Plain JS, no build step; app.js's `current` (the computer in front) is read when it is there.
"use strict";

(() => {
  const SPEEDS = [1, 2, 5, 10, "max"];
  // Computer time (os.clock, sleep, timers) is real time; a Minecraft day (os.time, os.day) is 20 minutes of it.
  const JUMPS = [
    {
      label: "+1 min",
      amount: "1m",
      said: "1 minute",
      title:
        "Jump ahead 1 minute of computer time (os.clock, sleep): a twentieth of a Minecraft day",
    },
    {
      label: "+1 MC day",
      amount: "1d",
      said: "1 Minecraft day",
      title:
        "Jump ahead one Minecraft day: 20 minutes of computer time, once round the in-game clock (os.time)",
    },
    {
      label: "+1 hour",
      amount: "1h",
      said: "1 hour",
      title:
        "Jump ahead 1 real hour of computer time (os.clock, sleep): three Minecraft days",
    },
  ];
  const KEYS = [
    ["Alt+P", "pause or resume"],
    ["Alt+.", "one tick (paused)"],
    ["Alt+]", "faster"],
    ["Alt+[", "slower"],
    ["Alt+\\", "normal speed"],
    ["Alt+J", "a minute ahead"],
    ["Alt+N", "a Minecraft day (20 minutes) ahead"],
    ["Alt+H", "an hour (3 Minecraft days) ahead"],
    ["Alt+S", "snapshots"],
  ];

  const make = (tag, props = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids) if (kid != null) e.append(kid);
    return e;
  };

  async function call(path, options = {}) {
    const init = { ...options };
    if (options.json !== undefined) {
      init.method = init.method || "POST";
      init.headers = { "content-type": "application/json" };
      init.body = JSON.stringify(options.json);
    }
    const res = await fetch(path, init);
    const type = res.headers.get("content-type") || "";
    const body = type.includes("json") ? await res.json() : await res.text();
    if (!res.ok)
      throw new Error(typeof body === "string" ? body : JSON.stringify(body));
    return body;
  }

  const front = () => {
    try {
      // eslint-disable-next-line no-undef
      return typeof current === "string" && current !== "lastrun"
        ? current
        : "";
    } catch {
      return "";
    }
  };

  // ───────────────────────── the bar ─────────────────────────

  const icon = (name) => {
    const paths = {
      pause: "M5 3h3v10H5zM10 3h3v10h-3z",
      play: "M5 3l9 5-9 5z",
      step: "M3 3l7 5-7 5zM11 3h2v10h-2z",
      sun: "M8 3.5a4.5 4.5 0 100 9 4.5 4.5 0 000-9zM7.25 0h1.5v2h-1.5zM7.25 14h1.5v2h-1.5zM0 7.25h2v1.5H0zM14 7.25h2v1.5h-2z",
      moon: "M10 2a6 6 0 104 10A5 5 0 0110 2z",
    };
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("tc-icon");
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", paths[name]);
    svg.append(p);
    return svg;
  };

  const playBtn = make("button", {
    class: "btn tc-play",
    id: "tc-play",
    title: "Pause every computer and the world clock (Alt+P)",
    onclick: () => act({ action: "toggle" }),
  });
  const stepBtn = make(
    "button",
    {
      class: "btn",
      id: "tc-step",
      title:
        "One tick (1/20 s): the timers due in it fire, then everything stops again (Alt+.)",
      onclick: () => act({ action: "step", ticks: 1 }),
    },
    icon("step"),
    make("span", { class: "tc-label", text: "Step" }),
  );
  const speedBox = make("div", {
    class: "tc-seg",
    role: "group",
    "aria-label": "Clock speed",
  });
  for (const s of SPEEDS) {
    speedBox.append(
      make("button", {
        class: "tc-speed",
        "data-speed": String(s),
        text: s === "max" ? "Max" : `${s}x`,
        title:
          s === "max"
            ? "As fast as possible: whenever every computer is waiting, the clock skips to the next timer"
            : s === 1
              ? "Normal speed (Alt+\\)"
              : `${s} times faster`,
        onclick: () => act({ action: "speed", speed: s }),
      }),
    );
  }
  const jumpBox = make("div", {
    class: "tc-seg",
    role: "group",
    "aria-label": "Jump ahead",
  });
  for (const j of JUMPS)
    jumpBox.append(
      make("button", {
        class: "tc-jump",
        text: j.label,
        title: `${j.title}. The timers on the way fire in order and the programs run between them.`,
        onclick: () => act({ action: "jump", amount: j.amount }),
      }),
    );
  const jumpMore = make("button", {
    class: "tc-jump",
    text: "...",
    title: "Jump ahead by any amount, or set the time of day",
    onclick: () => openJump(),
  });
  jumpBox.append(jumpMore);

  const timeIcon = make("span", { class: "tc-sky" });
  const timeText = make("span", {
    class: "tc-time",
    id: "tc-time",
    text: "--",
  });
  const stateText = make("span", { class: "pill tc-state", id: "tc-state" });
  const msg = make("span", { class: "tc-msg", id: "tc-msg", role: "status" });
  const snapBtn = make("button", {
    class: "btn",
    id: "tc-snapshots",
    text: "Snapshots",
    title: "Save the whole world, or put it back as it was (Alt+S)",
    onclick: () => openSnapshots(),
  });
  const keysBtn = make("button", {
    class: "btn ghost tc-keys",
    text: "Keys",
    title: KEYS.map(([k, v]) => `${k}  ${v}`).join("\n"),
    onclick: () => say(KEYS.map(([k, v]) => `${k} ${v}`).join(" · "), 8000),
  });

  const bar = make(
    "div",
    {
      class: "timebar",
      id: "timebar",
      role: "toolbar",
      "aria-label": "Time controls",
    },
    playBtn,
    stepBtn,
    make("span", { class: "tc-sep" }),
    make("span", { class: "tc-cap", text: "Speed" }),
    speedBox,
    make("span", { class: "tc-sep" }),
    make("span", { class: "tc-cap", text: "Jump" }),
    jumpBox,
    make("span", { class: "tc-grow" }),
    msg,
    make(
      "span",
      { class: "tc-clock", title: "The world's time of day (os.time, os.day)" },
      timeIcon,
      timeText,
    ),
    stateText,
    snapBtn,
    keysBtn,
  );

  // ───────────────────────── state ─────────────────────────

  let clock = null;
  let busy = false;
  let msgTimer = null;

  function say(text, ms = 4000, bad = false) {
    msg.textContent = text;
    msg.classList.toggle("bad", bad);
    clearTimeout(msgTimer);
    if (ms) msgTimer = setTimeout(() => (msg.textContent = ""), ms);
  }

  function render() {
    const none = !clock || clock.computers.length === 0;
    const paused = !!clock?.paused;
    playBtn.replaceChildren(
      icon(paused ? "play" : "pause"),
      make("span", { class: "tc-label", text: paused ? "Resume" : "Pause" }),
    );
    playBtn.title = paused
      ? "Run every computer and the world clock again (Alt+P)"
      : "Pause every computer and the world clock (Alt+P)";
    playBtn.classList.toggle("primary", paused);
    playBtn.setAttribute("aria-pressed", String(paused));
    for (const b of [
      playBtn,
      stepBtn,
      ...speedBox.children,
      ...jumpBox.children,
    ])
      b.disabled = none || busy;
    for (const b of speedBox.children) {
      const on = clock && String(clock.speed) === b.dataset.speed;
      b.classList.toggle("on", !!on);
      b.setAttribute("aria-pressed", String(!!on));
    }
    if (none) {
      timeText.textContent = "No computers";
      stateText.textContent = "";
      stateText.hidden = true;
      timeIcon.replaceChildren();
      return;
    }
    timeText.textContent = clock.time ?? "--";
    const hour = /(\d\d):/.exec(clock.time ?? "")?.[1];
    const day = hour !== undefined && Number(hour) >= 6 && Number(hour) < 18;
    timeIcon.replaceChildren(icon(day ? "sun" : "moon"));
    timeIcon.className = `tc-sky ${day ? "day" : "night"}`;
    stateText.hidden = false;
    stateText.className = "pill tc-state";
    if (paused) {
      stateText.textContent = clock.stopped ? "Paused" : "Pausing...";
      stateText.title = clock.stopped
        ? "Every computer is stopped and the clock stands still"
        : "A computer is finishing what it was doing; it stops at its next wait";
      stateText.classList.add("paused");
    } else if (clock.speed === "max") {
      stateText.textContent = "Max speed";
      stateText.title = "Idle time is skipped";
      stateText.classList.add("fast");
    } else if (clock.speed !== 1) {
      stateText.textContent = `${clock.speed}x`;
      stateText.title = `The clock runs ${clock.speed} times faster`;
      stateText.classList.add("fast");
    } else {
      stateText.textContent = "Running";
      stateText.title = "The clock runs at normal speed";
    }
  }

  async function poll() {
    try {
      clock = await call(`/api/clock?front=${encodeURIComponent(front())}`);
    } catch {
      clock = null;
    }
    render();
  }

  async function act(body) {
    if (busy) return;
    busy = true;
    render();
    try {
      clock = await call("/api/clock", { json: body });
      if (body.action === "jump")
        say(
          `Jumped ahead ${JUMPS.find((j) => j.amount === body.amount)?.said ?? body.amount}`,
        );
      if (body.action === "time") say(`Time of day set`);
    } catch (error) {
      say(error.message, 6000, true);
    } finally {
      busy = false;
      render();
    }
  }

  function changeSpeed(dir) {
    if (!clock) return;
    const at = SPEEDS.findIndex((s) => String(s) === String(clock.speed));
    const next =
      SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, (at < 0 ? 0 : at) + dir))];
    if (String(next) !== String(clock.speed))
      act({ action: "speed", speed: next });
  }

  // ───────────────────────── jump by any amount ─────────────────────────

  const jumpDlg = make(
    "dialog",
    { id: "tc-jump-dlg", class: "tc-dlg" },
    make(
      "form",
      { method: "dialog" },
      make("h2", { text: "Jump ahead" }),
      make(
        "label",
        {},
        "How far ",
        make("span", {
          class: "sub",
          text: "90s, 5m, 2h, 1d (a Minecraft day is 20 minutes), 40t (ticks)",
        }),
        make("input", {
          id: "tc-jump-amount",
          value: "10m",
          autocomplete: "off",
        }),
      ),
      make(
        "label",
        {},
        "Or set the time of day ",
        make("span", {
          class: "sub",
          text: "e.g. 06:00 for morning, 18:00 for dusk; the clock moves forward to it",
        }),
        make("input", {
          id: "tc-time-of-day",
          placeholder: "18:00",
          autocomplete: "off",
        }),
      ),
      make(
        "div",
        { class: "actions" },
        make("button", {
          type: "button",
          class: "btn",
          text: "Cancel",
          onclick: () => jumpDlg.close(),
        }),
        make("button", {
          type: "submit",
          class: "btn primary",
          text: "Go",
          id: "tc-jump-go",
        }),
      ),
    ),
  );
  jumpDlg.querySelector("form").addEventListener("submit", (e) => {
    e.preventDefault();
    const tod = jumpDlg.querySelector("#tc-time-of-day").value.trim();
    const amount = jumpDlg.querySelector("#tc-jump-amount").value.trim();
    jumpDlg.close();
    if (tod) act({ action: "time", amount: tod });
    else if (amount) act({ action: "jump", amount });
  });
  function openJump() {
    jumpDlg.querySelector("#tc-time-of-day").value = "";
    jumpDlg.showModal();
    jumpDlg.querySelector("#tc-jump-amount").select();
  }

  // ───────────────────────── snapshots ─────────────────────────

  const snapList = make("ul", { class: "tc-snaps", id: "tc-snaps" });
  const snapName = make("input", {
    id: "tc-snap-name",
    placeholder: "name, e.g. before the big test",
    maxlength: "64",
    autocomplete: "off",
  });
  const snapMsg = make("div", {
    class: "msg",
    id: "tc-snap-msg",
    role: "status",
  });
  const importInput = make("input", {
    type: "file",
    accept: ".craftos-world",
    hidden: true,
  });
  const snapDlg = make(
    "dialog",
    { id: "tc-snap-dlg", class: "tc-dlg tc-snap-dlg" },
    make(
      "form",
      { method: "dialog" },
      make(
        "h2",
        {},
        "World snapshots",
        make("span", { class: "grow" }),
        make("button", {
          type: "button",
          class: "btn ghost",
          text: "Close",
          onclick: () => snapDlg.close(),
        }),
      ),
      make("p", {
        class: "sub",
        text: "A snapshot keeps the whole world: every computer's files and label, players, items, chat, peripherals, a turtle's blocks and the time of day. Restoring puts it all back and reboots the computers into it.",
      }),
      make(
        "div",
        { class: "row" },
        snapName,
        make("button", {
          type: "submit",
          class: "btn primary",
          id: "tc-snap-save",
          text: "Save now",
        }),
      ),
      snapMsg,
      snapList,
      make(
        "div",
        { class: "row" },
        make("button", {
          type: "button",
          class: "btn",
          text: "Import a file...",
          title: "Take in a .craftos-world file someone shared",
          onclick: () => importInput.click(),
        }),
        importInput,
      ),
    ),
  );

  const snapSay = (text, bad = false) => {
    snapMsg.textContent = text;
    snapMsg.classList.toggle("bad", bad);
  };

  const when = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
  };
  const size = (n) =>
    n > 1e6
      ? `${(n / 1e6).toFixed(1)} MB`
      : `${Math.max(1, Math.round(n / 1e3))} KB`;

  /** Where a restore keeps a copy of the project files it overwrites or removes (the server says). */
  let backupsDir = "";

  async function loadSnapshots() {
    let list = [];
    try {
      const got = await call("/api/snapshots");
      list = got.snapshots;
      backupsDir = got.backups ?? "";
    } catch (error) {
      snapSay(error.message, true);
    }
    snapList.replaceChildren(
      ...(list.length
        ? list.map((s) =>
            make(
              "li",
              { class: "tc-snap" },
              make(
                "div",
                { class: "tc-snap-text" },
                make("b", { text: s.name }),
                make("span", {
                  class: "sub",
                  text: [
                    when(s.createdAt),
                    s.time,
                    s.computers.map((c) => c.name).join(", "),
                    size(s.bytes),
                  ]
                    .filter(Boolean)
                    .join(" · "),
                }),
              ),
              make("button", {
                type: "button",
                class: "btn primary",
                text: "Restore",
                title:
                  "Put the world back as it was then; the computers reboot into it",
                onclick: () => restore(s.name, s.folders ?? []),
              }),
              make("a", {
                class: "btn",
                text: "Export",
                title: "Download it as a file to share",
                href: `/api/snapshots/${encodeURIComponent(s.name)}/file`,
                download: `${s.name}.craftos-world`,
              }),
              make("button", {
                type: "button",
                class: "btn danger",
                text: "Delete",
                onclick: () => remove(s.name),
              }),
            ),
          )
        : [
            make("li", {
              class: "sub tc-none",
              text: "No snapshots yet. Name one above and save it.",
            }),
          ]),
    );
  }

  snapDlg.querySelector("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = snapName.value.trim() || defaultName();
    snapSay("Saving...");
    try {
      const saved = await call("/api/snapshots", { json: { name } });
      snapSay(
        `Saved "${saved.name}" (${saved.computers.length} computer${saved.computers.length === 1 ? "" : "s"}).`,
      );
      snapName.value = "";
      say(`Saved snapshot "${saved.name}"`);
    } catch (error) {
      snapSay(error.message, true);
    }
    loadSnapshots();
  });

  function defaultName() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `snapshot ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
  }

  async function restore(name, folders = []) {
    // a computer on the project folder itself: the restore changes the person's real files, so it says so first
    const files = folders.length
      ? `\n\nThis also puts the files in ${folders.join(" and ")} back as they were then: files changed since are written back, and files made since are removed.${backupsDir ? ` A copy of each file it overwrites or removes goes to ${backupsDir} first.` : ""}`
      : "";
    if (
      !confirm(
        `Restore "${name}"?\n\nEvery computer goes back to how it was then and reboots. Computers you made after it are closed.${files}`,
      )
    )
      return;
    snapSay(`Restoring "${name}"...`);
    try {
      const r = await call(
        `/api/snapshots/${encodeURIComponent(name)}/restore`,
        { method: "POST" },
      );
      const bits = [
        `${r.restored.length} computer${r.restored.length === 1 ? "" : "s"} restored`,
      ];
      if (r.made.length) bits.push(`${r.made.length} made again`);
      if (r.closed.length) bits.push(`${r.closed.length} closed`);
      for (const f of r.folders ?? []) {
        const n = f.written.length + f.removed.length;
        bits.push(
          n
            ? `${f.written.length} file${f.written.length === 1 ? "" : "s"} put back and ${f.removed.length} removed in ${f.dir}${f.backup ? ` (copies in ${f.backup})` : ""}`
            : `the files in ${f.dir} were as they were`,
        );
      }
      snapSay(`Restored "${name}": ${bits.join(", ")}.`);
      say(`Restored "${name}"`);
    } catch (error) {
      snapSay(error.message, true);
    }
    poll();
  }

  async function remove(name) {
    if (!confirm(`Delete the snapshot "${name}"? This cannot be undone.`))
      return;
    try {
      await call(`/api/snapshots/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      snapSay(`Deleted "${name}".`);
    } catch (error) {
      snapSay(error.message, true);
    }
    loadSnapshots();
  }

  importInput.addEventListener("change", async () => {
    const file = importInput.files?.[0];
    importInput.value = "";
    if (!file) return;
    snapSay(`Importing ${file.name}...`);
    try {
      const res = await fetch("/api/snapshots/import", {
        method: "POST",
        body: file,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(text);
      const info = JSON.parse(text);
      snapSay(`Imported "${info.name}". Restore it to load the world.`);
    } catch (error) {
      snapSay(error.message, true);
    }
    loadSnapshots();
  });

  function openSnapshots() {
    snapSay("");
    loadSnapshots();
    snapDlg.showModal();
    snapName.focus();
  }

  // ───────────────────────── keys ─────────────────────────

  window.addEventListener(
    "keydown",
    (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const code = e.code;
      const run = {
        KeyP: () => act({ action: "toggle" }),
        Period: () => act({ action: "step", ticks: 1 }),
        BracketRight: () => changeSpeed(1),
        BracketLeft: () => changeSpeed(-1),
        Backslash: () => act({ action: "speed", speed: 1 }),
        KeyJ: () => act({ action: "jump", amount: "1m" }),
        KeyH: () => act({ action: "jump", amount: "1h" }),
        KeyN: () => act({ action: "jump", amount: "1d" }),
        KeyS: () => (snapDlg.open ? snapDlg.close() : openSnapshots()),
      }[code];
      if (!run) return;
      // the clock's keys never reach the computer, nor the browser's menus
      e.preventDefault();
      e.stopPropagation();
      if (code !== "KeyS" && (!clock || clock.computers.length === 0)) return;
      run();
    },
    true,
  );

  document.body.append(bar, jumpDlg, snapDlg);
  document.body.classList.add("has-timebar");
  render();
  poll();
  setInterval(poll, 500);
})();
