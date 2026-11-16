import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { type KeyName, Keys, renderPng } from "@craftos-agent/rawterm";
import {
  type ScreenCapture,
  type SessionManager,
  TERMINATE_HOLD_MS,
  holdKey,
} from "@craftos-agent/runner";

export interface ViewerOptions {
  readonly port: number;
  readonly sessions: SessionManager;
  /** Screens from the most recent craftos_run, so one-shot runs can be inspected too. */
  readonly lastRun: () =>
    | { label: string; screens: ScreenCapture[] }
    | undefined;
}

const PAGE = /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CraftOS Viewer</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--card:#f3f3f5;--line:#d8d8de;--accent:#2563eb}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#ececf0;--card:#1f1f23;--line:#33333a;--accent:#6ea0ff}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.4 system-ui,sans-serif;padding:16px}
h1{font-size:18px;margin:0 0 12px}h2{font-size:14px;margin:0 0 8px}
.empty{color:#888}
.session{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;margin-bottom:16px}
.windows{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start}
figure{margin:0}figcaption{font-size:12px;color:#888;margin-bottom:4px}
img{image-rendering:pixelated;display:block;border:1px solid var(--line);max-width:100%;cursor:pointer}
form{display:flex;gap:8px;margin-top:10px}
input{flex:1;padding:6px 8px;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px;font:inherit}
button{padding:6px 12px;border:1px solid var(--line);background:var(--bg);color:var(--fg);border-radius:6px;cursor:pointer}
button:hover{border-color:var(--accent)}
</style></head><body>
<h1>CraftOS Viewer</h1>
<div id="root"></div>
<script>
const SCALE=3,MARGIN=2,CW=6,CH=9;
let stamp=0;
async function post(path,body){await fetch(path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});}
function win(src,label,onClick){
  const f=document.createElement("figure");
  const c=document.createElement("figcaption");c.textContent=label;f.append(c);
  const i=document.createElement("img");i.src=src+"?t="+stamp;
  if(onClick)i.addEventListener("click",e=>{const r=i.getBoundingClientRect();const px=(e.clientX-r.left)*(i.naturalWidth/r.width)/SCALE;const py=(e.clientY-r.top)*(i.naturalHeight/r.height)/SCALE;onClick(Math.floor((px-MARGIN)/CW)+1,Math.floor((py-MARGIN)/CH)+1)});
  f.append(i);return f;
}
function render(data){
  const root=document.getElementById("root");
  const active=document.activeElement;
  if(active&&active.tagName==="INPUT")return refreshImages();
  root.replaceChildren();
  if(!data.sessions.length&&!data.lastRun)root.innerHTML='<p class="empty">No sessions yet. Create one with the craftos_session_create tool.</p>';
  for(const s of data.sessions){
    const box=document.createElement("div");box.className="session";
    box.innerHTML="<h2>Session "+s.id+(s.running?"":" (stopped)")+"</h2>";
    const row=document.createElement("div");row.className="windows";
    for(const w of s.windows){
      row.append(win("/api/sessions/"+s.id+"/window/"+w.id+".png",w.peripheral?("monitor "+w.peripheral+" "+w.width+"x"+w.height):("terminal "+w.width+"x"+w.height),w.peripheral?((x,y)=>post("/api/sessions/"+s.id+"/touch",{monitor:w.peripheral,x,y})):null));
    }
    box.append(row);
    const form=document.createElement("form");
    form.innerHTML='<input placeholder="type a command and press Enter" autocomplete="off"><button type="button" data-k="ctrlT">Ctrl+T</button>';
    form.addEventListener("submit",async e=>{e.preventDefault();const input=form.querySelector("input");await post("/api/sessions/"+s.id+"/type",{text:input.value,enter:true});input.value="";});
    form.querySelector("button").addEventListener("click",()=>post("/api/sessions/"+s.id+"/key",{key:"t",ctrl:true}));
    box.append(form);root.append(box);
  }
  if(data.lastRun){
    const box=document.createElement("div");box.className="session";
    box.innerHTML="<h2>Last run: "+data.lastRun.label+"</h2>";
    const row=document.createElement("div");row.className="windows";
    data.lastRun.windows.forEach(w=>row.append(win("/api/last-run/"+w.window+".png",w.peripheral?("monitor "+w.peripheral):"terminal",null)));
    box.append(row);root.append(box);
  }
}
function refreshImages(){stamp++;for(const i of document.querySelectorAll("img")){i.src=i.src.replace(/\\?t=\\d+$/,"")+"?t="+stamp;}}
let last="";
async function tick(){
  try{
    const data=await (await fetch("/api/sessions")).json();
    const shape=JSON.stringify(data);
    if(shape!==last){last=shape;stamp++;render(data);}else refreshImages();
  }catch{}
  setTimeout(tick,500);
}
tick();
</script></body></html>`;

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(body ? (JSON.parse(body) as Record<string, unknown>) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function send(
  res: ServerResponse,
  status: number,
  type: string,
  body: string | Buffer,
): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

/**
 * Local-only web viewer. Binds to loopback, rejects cross-site requests, and
 * only drives sessions created through the MCP tools.
 */
export function startViewer(options: ViewerOptions): Server {
  const { sessions } = options;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host)
        return send(res, 403, "text/plain", "forbidden");

      if (req.method === "GET" && url.pathname === "/")
        return send(res, 200, "text/html; charset=utf-8", PAGE);

      if (req.method === "GET" && url.pathname === "/api/sessions") {
        const lastRun = options.lastRun();
        return send(
          res,
          200,
          "application/json",
          JSON.stringify({
            sessions: sessions.list(),
            lastRun: lastRun
              ? {
                  label: lastRun.label,
                  windows: lastRun.screens.map((s) => ({
                    window: s.window,
                    peripheral: s.peripheral ?? null,
                  })),
                }
              : null,
          }),
        );
      }

      let match = /^\/api\/last-run\/(\d+)\.png$/.exec(url.pathname);
      if (req.method === "GET" && match) {
        const screen = options
          .lastRun()
          ?.screens.find((s) => s.window === Number(match![1]));
        if (!screen?.png) return send(res, 404, "text/plain", "no screenshot");
        return send(res, 200, "image/png", Buffer.from(screen.png, "base64"));
      }

      match = /^\/api\/sessions\/([\w-]+)\/window\/(\d+)\.png$/.exec(
        url.pathname,
      );
      if (req.method === "GET" && match) {
        const raw = sessions.get(match[1]!).handle.session;
        const state = raw.allWindows().find((w) => w.id === Number(match![2]));
        if (!state?.frame)
          return send(res, 404, "text/plain", "window has no frame yet");
        return send(
          res,
          200,
          "image/png",
          renderPng(state.frame, { scale: 3 }),
        );
      }

      match = /^\/api\/sessions\/([\w-]+)\/(touch|type|key)$/.exec(
        url.pathname,
      );
      if (req.method === "POST" && match) {
        const raw = sessions.get(match[1]!).handle.session;
        const body = await readJson(req);
        if (match[2] === "touch") {
          raw.touchMonitor(
            String(body["monitor"]),
            Number(body["x"]),
            Number(body["y"]),
          );
        } else if (match[2] === "type") {
          raw.char(String(body["text"] ?? ""));
          if (body["enter"] !== false) raw.tap(Keys.enter);
        } else {
          const key = String(body["key"]);
          if (!(key in Keys))
            return send(res, 400, "text/plain", `unknown key ${key}`);
          if (body["ctrl"] && key === "t") {
            // a tap of ctrl+t does nothing in the game: the button holds it for the second CC needs
            await holdKey(sessions.get(match[1]!).handle, key, {
              ms: TERMINATE_HOLD_MS,
              ctrl: true,
            });
          } else {
            if (body["ctrl"]) raw.key("leftCtrl");
            raw.tap(key as KeyName);
            if (body["ctrl"]) raw.key("leftCtrl", { up: true });
          }
        }
        return send(res, 200, "application/json", "{}");
      }

      send(res, 404, "text/plain", "not found");
    } catch (error) {
      send(
        res,
        500,
        "text/plain",
        error instanceof Error ? error.message : String(error),
      );
    }
  });
  server.on("error", (error) =>
    process.stderr.write(`viewer: ${error.message}\n`),
  );
  server.listen(options.port, "127.0.0.1", () => {
    process.stderr.write(`craftos viewer: http://127.0.0.1:${options.port}/\n`);
  });
  return server;
}
