// The bridge between the home screen (ui/home.js) and the app (main.mjs): named calls and a few events, nothing else.
const { contextBridge, ipcRenderer } = require("electron");

const CALLS = [
  "state",
  "project:pick",
  "project:read",
  "project:save",
  "project:create",
  "recents:list",
  "recents:remove",
  "run:start",
  "run:stop",
  "tests:run",
  "settings:set",
  "setup:all",
  "update:check",
  "update:install",
  "open:folder",
  "open:file",
  "open:link",
];
const EVENTS = ["progress", "update", "stopped"];

contextBridge.exposeInMainWorld("craftos", {
  /** Call the app; resolves with the value or rejects with an Error that has the message to show. */
  async call(name, ...args) {
    if (!CALLS.includes(name)) throw new Error(`unknown call ${name}`);
    const answer = await ipcRenderer.invoke(name, ...args);
    if (!answer.ok) throw new Error(answer.error);
    return answer.value;
  },
  on(name, listener) {
    if (!EVENTS.includes(name)) throw new Error(`unknown event ${name}`);
    ipcRenderer.on(name, (_event, payload) => listener(payload));
  },
});
