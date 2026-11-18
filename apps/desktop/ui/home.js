// The home screen: recent projects on the side, the open project in the middle (Minecraft version, program, mods,
// Run and Run tests), and the running computer (the emulator's own page) in the same window after Run.
"use strict";

const api = window.craftos;
const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, "");
    else if (value !== false && value != null) node.setAttribute(key, value);
  }
  node.append(...children.filter((c) => c != null));
  return node;
};

let app; // what the app told us at start: versions, mods, settings
let project = null; // the open project
let busy = false;
let runningDir = null;

// ───────────────────────── recent projects ─────────────────────────

function renderRecents(list) {
  app.recents = list;
  $("#no-recents").hidden = list.length > 0;
  $("#recents").replaceChildren(
    ...list.map((r) =>
      el(
        "li",
        {
          class: [
            r.missing ? "missing" : "",
            project && project.dir === r.dir ? "current" : "",
          ].join(" "),
        },
        el(
          "button",
          {
            class: "pick",
            title: r.missing ? `${r.dir} is not there any more` : r.dir,
            onclick: () => openProject(r.dir),
          },
          el("b", { text: r.name }),
          // the end of a long path is the part that tells folders apart
          el("small", {}, el("bdi", { text: r.dir })),
        ),
        el("button", {
          class: "forget",
          title: "Take this off the list (the folder stays)",
          "aria-label": `Take ${r.name} off the list`,
          text: "×",
          onclick: async () =>
            renderRecents(await api.call("recents:remove", r.dir)),
        }),
      ),
    ),
  );
}

// ───────────────────────── the project ─────────────────────────

function showProblem(message) {
  $("#p-errors").hidden = !message;
  $("#p-errors").textContent = message ?? "";
}

function setBusy(text) {
  busy = Boolean(text);
  $("#p-status").hidden = !busy;
  $("#p-status").textContent = text ?? "";
  for (const id of ["#run", "#tests", "#r-tests", "#r-restart"])
    $(id).disabled = busy;
}

async function openProject(dir, remember = true) {
  try {
    project = await api.call("project:read", dir, remember);
  } catch (error) {
    project = null;
    $("#project").hidden = true;
    $("#welcome").hidden = false;
    renderRecents(await api.call("recents:list"));
    alert(
      `${error.message}\n\nIf the folder moved, open it again from its new place.`,
    );
    return;
  }
  $("#p-saved").textContent = project.hasFile
    ? "Your choices are kept in craftos.json in this folder."
    : "Your choices are saved to craftos.json in this folder when you change one or press Run.";
  renderProject();
  renderRecents(await api.call("recents:list"));
}

function modsFor(mc) {
  return app.catalog.addons.filter((a) => a.versions[mc] !== undefined);
}

function renderProject() {
  $("#welcome").hidden = true;
  $("#project").hidden = false;
  $("#p-name").textContent = project.name;
  $("#p-path").textContent = project.dir;
  showProblem(
    project.errors.length
      ? `craftos.json has a problem:\n${project.errors.join("\n")}`
      : "",
  );

  $("#versions").replaceChildren(
    ...app.catalog.versions.map((v) => {
      const on = v.mc === project.minecraft;
      return el(
        "label",
        { class: `version${on ? " on" : ""}` },
        el("input", {
          type: "radio",
          name: "mc",
          value: v.mc,
          checked: on,
          onchange: () => save({ minecraft: v.mc }),
        }),
        el(
          "span",
          {},
          el("b", { text: `Minecraft ${v.mc}` }),
          el("small", { text: `CC:Tweaked ${v.cc}` }),
        ),
      );
    }),
  );

  const program = $("#program");
  program.replaceChildren(
    el("option", { value: "", text: "No program: open the computer's prompt" }),
    ...project.programs.map((p) => el("option", { value: p, text: p })),
  );
  program.value = project.run;

  $("#tests").textContent = project.tests.length
    ? `Run tests (${project.tests.length} ${project.tests.length === 1 ? "file" : "files"})`
    : "Run tests";
  renderMods();
}

function renderMods() {
  const mc = project.minecraft;
  const filter = $("#mods-filter").value.trim().toLowerCase();
  const on = new Set(project.addons);
  const available = modsFor(mc);
  $("#mods-count").textContent = `${on.size} of ${available.length} on`;
  const matches = (a) =>
    !filter || `${a.name} ${a.id} ${a.summary}`.toLowerCase().includes(filter);
  const name = (id) => app.catalog.addons.find((a) => a.id === id)?.name ?? id;
  const rows = [];
  for (const a of app.catalog.addons.filter(matches)) {
    const has = a.versions[mc] !== undefined;
    const needs = a.requires.length
      ? ` Needs ${a.requires.map(name).join(" and ")}.`
      : "";
    rows.push({
      has,
      node: el(
        "li",
        { class: has ? "" : "off" },
        el(
          "label",
          {},
          el("input", {
            type: "checkbox",
            value: a.id,
            checked: has && on.has(a.id),
            disabled: !has,
            onchange: (e) => toggleMod(a.id, e.target.checked),
          }),
          el(
            "span",
            {},
            el("b", { text: a.name }),
            el("span", {
              class: "ver",
              text: has
                ? a.simulates && a.simulates !== a.versions[mc].split(" ")[0]
                  ? `${a.versions[mc]}, acts as ${a.simulates}`
                  : a.versions[mc]
                : `not made for Minecraft ${mc} (it has ${Object.keys(a.versions).join(", ")})`,
            }),
          ),
          el("small", { text: `${a.summary}${needs}` }),
        ),
      ),
    });
  }
  // the mods this Minecraft version has first
  rows.sort((x, y) => Number(y.has) - Number(x.has));
  $("#mods").replaceChildren(
    ...(rows.length
      ? rows.map((r) => r.node)
      : [el("li", { class: "none", text: "No mod matches that." })]),
  );
}

function toggleMod(id, checked) {
  const byId = new Map(app.catalog.addons.map((a) => [a.id, a]));
  const on = new Set(project.addons);
  if (checked) {
    // a mod that needs another one switches that on too
    const add = (x) => {
      on.add(x);
      for (const need of byId.get(x)?.requires ?? []) add(need);
    };
    add(id);
  } else {
    // and switching a mod off switches off the ones that need it
    const drop = (x) => {
      on.delete(x);
      for (const a of app.catalog.addons)
        if (a.requires.includes(x) && on.has(a.id)) drop(a.id);
    };
    drop(id);
  }
  return save({ addons: [...on] });
}

async function save(change) {
  try {
    project = await api.call("project:save", project.dir, change);
    $("#p-saved").textContent = "Saved to craftos.json in this folder.";
    renderProject();
  } catch (error) {
    showProblem(error.message);
    await openProject(project.dir, false).catch(() => {});
    showProblem(error.message);
  }
}

// ───────────────────────── run ─────────────────────────

function showRunning(url) {
  runningDir = project.dir;
  $("#r-name").textContent = project.name;
  $("#r-info").textContent =
    `Minecraft ${project.minecraft} · ${project.addons.length} ${project.addons.length === 1 ? "mod" : "mods"}` +
    (project.run ? ` · ${project.run}` : "");
  $("#frame").src = url;
  $("#home").hidden = true;
  $("#running").hidden = false;
  $("#frame").focus();
}

async function run() {
  if (!project || busy) return;
  showProblem("");
  setBusy("Starting");
  try {
    const started = await api.call("run:start", project.dir);
    project = started.project;
    showRunning(started.url);
  } catch (error) {
    showProblem(`Could not start: ${error.message}`);
  } finally {
    setBusy("");
  }
}

async function goHome(message) {
  $("#running").hidden = true;
  $("#home").hidden = false;
  $("#frame").src = "about:blank";
  runningDir = null;
  await api.call("run:stop").catch(() => {});
  if (project) await openProject(project.dir, false);
  if (message) showProblem(message);
}

// ───────────────────────── tests ─────────────────────────

function renderTests(answer) {
  const body = $("#t-body");
  if (!answer.ok) {
    $("#t-title").textContent = "Tests";
    body.replaceChildren(el("p", { class: "problem", text: answer.message }));
    return;
  }
  const { passed, failed, skipped = 0, files } = answer.result;
  $("#t-title").textContent = failed
    ? "Tests: some failed"
    : "Tests: all passed";
  const parts = [`${passed} passed`];
  if (failed) parts.push(`${failed} failed`);
  if (skipped) parts.push(`${skipped} skipped`);
  body.replaceChildren(
    el("div", {
      class: `summary ${failed ? "fail" : "pass"}`,
      text: `${failed ? "✗" : "✓"} ${parts.join(", ")}`,
    }),
    ...files.map((f) => {
      const ok = f.status === "passed";
      const how =
        f.status === "timed_out"
          ? " (took too long and was stopped)"
          : f.status === "crashed"
            ? " (the file stopped with an error)"
            : "";
      return el(
        "details",
        { open: !ok },
        el(
          "summary",
          {},
          el("span", { class: "mark", text: ok ? "✓" : "✗" }),
          `${f.file}${how}`,
          el("span", {
            class: "hint",
            text: `  ${f.tests.length} test${f.tests.length === 1 ? "" : "s"}, ${f.durationMs} ms`,
          }),
        ),
        ...f.tests.flatMap((t) => [
          el("div", {
            class: `t ${t.passed ? "" : "fail"}`,
            text: `${t.skipped ? "–" : t.passed ? "✓" : "✗"} ${t.name}`,
          }),
          !t.passed && t.error ? el("pre", { text: t.error }) : null,
        ]),
        !ok && !f.tests.some((t) => !t.passed) && f.terminal
          ? el("pre", { text: f.terminal.join("\n").trim() })
          : null,
      );
    }),
  );
}

async function tests() {
  if (!project || busy) return;
  const dialog = $("#tests-dialog");
  $("#t-title").textContent = "Tests";
  $("#t-body").replaceChildren(
    el("p", { class: "status", id: "t-status", text: "Running the tests" }),
  );
  $("#t-again").disabled = true;
  if (!dialog.open) dialog.showModal();
  setBusy("Running the tests");
  try {
    renderTests(await api.call("tests:run", project.dir));
  } catch (error) {
    renderTests({ ok: false, message: error.message });
  } finally {
    setBusy("");
    $("#t-again").disabled = false;
  }
}

// ───────────────────────── new project ─────────────────────────

function openNew() {
  $("#n-name").value = "";
  $("#n-error").hidden = true;
  if (!$("#n-parent").value)
    $("#n-parent").value =
      `${app.documents}${app.platform === "win32" ? "\\" : "/"}CraftOS`;
  $("#new-dialog").showModal();
  $("#n-name").focus();
}

async function createNew(event) {
  event.preventDefault();
  try {
    const dir = await api.call("project:create", {
      parent: $("#n-parent").value,
      name: $("#n-name").value,
      minecraft: project?.minecraft,
    });
    $("#new-dialog").close();
    await openProject(dir);
  } catch (error) {
    $("#n-error").hidden = false;
    $("#n-error").textContent = error.message;
  }
}

// ───────────────────────── settings and updates ─────────────────────────

function renderUpdate(update) {
  app.update = update;
  const text = {
    downloading: `Version ${update.version} is downloading.`,
    ready: `Version ${update.version} is ready.`,
    available: `Version ${update.version} is out.`,
  }[update.state];
  $("#update").hidden = !text;
  $("#update-text").textContent = text ?? "";
  $("#update-act").hidden = update.state === "downloading";
  $("#update-act").textContent =
    update.state === "ready" ? "Restart to update" : "Get it";
  $("#s-update-state").textContent =
    {
      checking: "Looking",
      none: "You have the newest version.",
      dev: "Updates work in the installed app.",
      failed: `Could not look: ${update.message ?? "no answer"}`,
    }[update.state] ??
    text ??
    "";
}

function openSettings() {
  $("#s-theme").value = app.settings.theme;
  $("#s-update").checked = app.settings.autoUpdate;
  $("#s-all-state").textContent = "";
  $("#s-all").hidden = !app.packaged;
  $("#s-about").textContent =
    `CraftOS ${app.version}. CC:Tweaked is by SquidDev and dan200; this app is not part of it.`;
  $("#settings-dialog").showModal();
}

async function setSetting(change) {
  app.settings = await api.call("settings:set", change);
}

// ───────────────────────── start ─────────────────────────

async function pickAndOpen() {
  const dir = await api.call("project:pick");
  if (dir) await openProject(dir);
}

async function init() {
  app = await api.call("state");
  $("#version").textContent = app.version === "0.0.0" ? "" : `v${app.version}`;
  renderRecents(app.recents);
  renderUpdate(app.update);

  $("#open").onclick = $("#welcome-open").onclick = pickAndOpen;
  $("#new").onclick = $("#welcome-new").onclick = openNew;
  $("#p-path").onclick = () => api.call("open:folder", project.dir);
  $("#run").onclick = run;
  $("#tests").onclick = $("#r-tests").onclick = $("#t-again").onclick = tests;
  $("#t-close").onclick = () => $("#tests-dialog").close();
  $("#program").onchange = (e) => save({ run: e.target.value });
  $("#mods-filter").oninput = renderMods;
  $("#mods-all").onclick = () =>
    save({ addons: modsFor(project.minecraft).map((a) => a.id) });
  $("#mods-none").onclick = () => save({ addons: [] });
  $("#back").onclick = () => goHome();
  $("#r-restart").onclick = async () => {
    setBusy("Starting");
    try {
      const started = await api.call("run:start", project.dir);
      project = started.project;
      showRunning(started.url);
    } catch (error) {
      await goHome(`Could not start: ${error.message}`);
    } finally {
      setBusy("");
    }
  };

  $("#new-form").onsubmit = createNew;
  $("#n-cancel").onclick = () => $("#new-dialog").close();
  $("#n-pick").onclick = async () => {
    const dir = await api.call("project:pick");
    if (dir) $("#n-parent").value = dir;
  };

  $("#settings-open").onclick = openSettings;
  $("#s-close").onclick = () => $("#settings-dialog").close();
  $("#s-theme").onchange = (e) => setSetting({ theme: e.target.value });
  $("#s-update").onchange = (e) => setSetting({ autoUpdate: e.target.checked });
  $("#s-check").onclick = () => api.call("update:check");
  $("#s-all").onclick = async () => {
    $("#s-all").disabled = true;
    $("#s-all-state").textContent = "Getting them (a minute or two)";
    const answer = await api
      .call("setup:all")
      .catch((error) => ({ message: error.message }));
    $("#s-all-state").textContent = answer.message;
    $("#s-all").disabled = false;
  };
  $("#update-act").onclick = () => api.call("update:install");

  api.on("progress", (line) => {
    if (!line) return;
    if (busy) $("#p-status").textContent = line;
    const t = document.getElementById("t-status");
    if (t) t.textContent = line;
    if ($("#settings-dialog").open && $("#s-all").disabled)
      $("#s-all-state").textContent = line;
  });
  api.on("update", renderUpdate);
  api.on("stopped", ({ dir }) => {
    if (runningDir === dir && !busy) void goHome("The emulator stopped.");
  });
  // files change while the app is in the background: a new program shows up in the list on the way back
  window.addEventListener("focus", () => {
    if (
      project &&
      !busy &&
      !$("#home").hidden &&
      !document.querySelector("dialog[open]")
    )
      void api
        .call("project:read", project.dir, false)
        .then((fresh) => {
          project = fresh;
          renderProject();
        })
        .catch(() => {});
  });

  if (app.running) {
    await openProject(app.running.dir, false);
    if (project) showRunning(app.running.url);
  } else if (app.startWith) await openProject(app.startWith);
}

init().catch((error) => {
  document.body.textContent = `CraftOS could not start: ${error.message}`;
});
