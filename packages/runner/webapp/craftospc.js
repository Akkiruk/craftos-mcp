// "From CraftOS-PC" in the browser app: bring a person's CraftOS-PC computers over and start them. The server side is
// packages/runner/src/craftospc-webapp.ts (/api/craftos-pc). It builds its own dialog; index.html only has the button
// (#craftospc-open) and loads this file after app.js, whose poll() and select() it calls once a computer starts.
"use strict";

(() => {
  const h = (tag, props = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids) if (kid != null) e.append(kid);
    return e;
  };
  const call = async (path, json) => {
    const res = await fetch(
      path,
      json === undefined
        ? {}
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(json),
          },
    );
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: text };
    }
    if (!res.ok) {
      const error = new Error(body.error || `HTTP ${res.status}`);
      error.body = body;
      throw error;
    }
    return body;
  };
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  const dlg = h("dialog", {
    id: "craftospc-dlg",
    class: "cpc",
    "aria-labelledby": "cpc-title",
  });
  const folder = h("input", {
    id: "cpc-folder",
    placeholder: "where CraftOS-PC keeps its data",
    spellcheck: "false",
  });
  const out = h("input", { id: "cpc-out", spellcheck: "false" });
  const found = h("div", { class: "cpc-list", id: "cpc-found" });
  const status = h("div", { class: "cpc-status", role: "status" });
  const project = h("div", { class: "cpc-list", id: "cpc-project" });
  const projectHead = h("h3", { text: "Your computers here" });
  const bring = h("button", {
    type: "button",
    class: "btn primary",
    id: "cpc-bring",
    text: "Bring them over",
  });

  dlg.append(
    h(
      "div",
      { class: "cpc-body" },
      h("h2", {
        id: "cpc-title",
        text: "Bring your computers over from CraftOS-PC",
      }),
      h(
        "p",
        { class: "cpc-lead" },
        "Each computer's files, its label, colour and screen size, and the peripherals its startup attaches come across. ",
        "Your CraftOS-PC folder is only read, never changed.",
      ),
      h(
        "label",
        {},
        "CraftOS-PC folder",
        h(
          "span",
          { class: "cpc-row" },
          folder,
          h("button", {
            type: "button",
            class: "btn",
            onclick: () => look(),
            text: "Look",
          }),
        ),
      ),
      found,
      h("label", {}, "Put the project in", out),
      h("div", { class: "actions cpc-actions" }, status, bring),
      projectHead,
      project,
      h(
        "p",
        { class: "cpc-foot" },
        "What is different here: computers behave as on a real server, so a monitor is a block you place (",
        h("code", { text: "attach top monitor" }),
        " still works and says so), and nothing can mount a folder of your PC. ",
        h("a", {
          href: "https://github.com/Akkiruk/craftos-mcp#coming-from-craftos-pc",
          target: "_blank",
          rel: "noopener",
          text: "Coming from CraftOS-PC",
        }),
      ),
      h(
        "div",
        { class: "actions" },
        h("button", {
          type: "button",
          class: "btn",
          onclick: () => dlg.close(),
          text: "Close",
        }),
      ),
    ),
  );
  document.body.append(dlg);

  let preview = null;

  function computerLine(c) {
    const bits = [plural(c.files, "file")];
    if (c.isColor === false) bits.push("no colour");
    if (c.width && (c.width !== 51 || c.height !== 19))
      bits.push(`${c.width}x${c.height}`);
    if (c.attaches && c.attaches.length)
      bits.push(c.attaches.map((a) => `${a.type} on ${a.side}`).join(", "));
    return bits.join(" · ");
  }
  const nameOf = (c) => `computer ${c.id}${c.label ? ` "${c.label}"` : ""}`;

  async function look() {
    status.textContent = "";
    found.replaceChildren(h("div", { class: "cpc-dim", text: "Looking..." }));
    try {
      const q = folder.value.trim()
        ? `?folder=${encodeURIComponent(folder.value.trim())}`
        : "";
      preview = await call(`/api/craftos-pc${q}`);
    } catch (error) {
      found.replaceChildren(h("div", { class: "error", text: error.message }));
      bring.disabled = true;
      return;
    }
    if (!folder.value.trim() && preview.folder) folder.value = preview.folder;
    if (!out.value.trim()) out.value = preview.defaultOut;
    if (!preview.found) {
      found.replaceChildren(
        h(
          "div",
          { class: "cpc-dim" },
          preview.folder
            ? `No CraftOS-PC data in ${preview.folder}.`
            : "No CraftOS-PC data found on this computer.",
          ` CraftOS-PC keeps it in ${preview.looked.join(" or ")}: type where yours is and press Look.`,
        ),
      );
      bring.disabled = true;
      return;
    }
    if (!preview.computers.length) {
      found.replaceChildren(
        h("div", {
          class: "cpc-dim",
          text: "That CraftOS-PC folder has no computers yet.",
        }),
      );
      bring.disabled = true;
      return;
    }
    found.replaceChildren(
      ...preview.computers.map((c) =>
        h(
          "label",
          { class: "check cpc-item" },
          h("input", { type: "checkbox", value: String(c.id), checked: true }),
          h("span", { class: "cpc-name", text: nameOf(c) }),
          h("span", { class: "cpc-dim", text: computerLine(c) }),
        ),
      ),
      ...preview.notes.map((n) => h("div", { class: "cpc-note", text: n })),
    );
    bring.disabled = false;
  }

  async function doImport(force) {
    const ids = [...found.querySelectorAll("input[type=checkbox]")]
      .filter((i) => i.checked)
      .map((i) => Number(i.value));
    if (!ids.length) {
      status.textContent = "Tick at least one computer.";
      return;
    }
    bring.disabled = true;
    status.textContent = "Copying...";
    try {
      const made = await call("/api/craftos-pc/import", {
        folder: folder.value.trim() || undefined,
        out: out.value.trim() || undefined,
        ids,
        force,
      });
      status.textContent = `Brought ${plural(made.computers.length, "computer")} over into ${made.project}.`;
      showProject(made, made.notes);
    } catch (error) {
      status.replaceChildren(
        h("span", { class: "error", text: error.message }),
      );
      if (error.body && error.body.exists)
        status.append(
          " ",
          h("button", {
            type: "button",
            class: "btn danger",
            onclick: () => doImport(true),
            text: "Replace it",
          }),
        );
    } finally {
      bring.disabled = false;
    }
  }
  bring.addEventListener("click", () => doImport(false));

  function showProject(data, notes = []) {
    projectHead.hidden = project.hidden = !data.computers.length;
    project.replaceChildren(
      h("div", { class: "cpc-dim", text: data.project }),
      ...data.computers.map((c) =>
        h(
          "div",
          { class: "cpc-item cpc-start" },
          h("span", { class: "cpc-name", text: nameOf(c) }),
          h("span", { class: "cpc-dim", text: plural(c.files, "file") }),
          h("span", { class: "grow" }),
          h("button", {
            type: "button",
            class: "btn primary",
            onclick: (e) => start(c, e.currentTarget),
            text: "Start",
          }),
        ),
      ),
      ...notes.map((n) => h("div", { class: "cpc-note", text: n })),
    );
  }

  async function start(c, button) {
    button.disabled = true;
    try {
      const made = await call("/api/sessions", c.start);
      dlg.close();
      if (typeof poll === "function") await poll(true);
      if (typeof select === "function" && made.ids && made.ids[0])
        select(made.ids[0]);
    } catch (error) {
      status.replaceChildren(
        h("span", { class: "error", text: `${nameOf(c)}: ${error.message}` }),
      );
    } finally {
      button.disabled = false;
    }
  }

  async function open() {
    dlg.showModal();
    status.textContent = "";
    projectHead.hidden = project.hidden = true;
    await look();
    try {
      showProject(await call("/api/craftos-pc/project"));
    } catch {
      // nothing imported yet
    }
  }

  const button = document.getElementById("craftospc-open");
  if (button) button.addEventListener("click", open);
  // for the desktop app's home screen, and tests
  window.craftosPc = { open };
})();
