// A static server for web/dist with the headers the player needs (cross-origin isolation), and a small library page
// at / (web/src/dev.html) for trying carts by hand:
//
//   node web/serve.mjs [port] [--credentialless]
//
// COEP is require-corp unless --credentialless is given (web/README.md explains the difference).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = dirname(fileURLToPath(import.meta.url));
const ROOT = join(WEB, "dist");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".css": "text/css; charset=utf-8",
};

export function startServer(port = 8787, { coep = "require-corp" } = {}) {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file =
      path === "/" ? join(WEB, "src", "dev.html") : normalize(join(ROOT, path));
    if (path !== "/" && !file.startsWith(ROOT + sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": coep,
        "Cross-Origin-Resource-Policy": "same-origin",
        "Cache-Control": "no-store",
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () => resolve(server)),
  );
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === normalize(process.argv[1])
) {
  const port = Number(
    process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 8787,
  );
  const coep = process.argv.includes("--credentialless")
    ? "credentialless"
    : "require-corp";
  await startServer(port, { coep });
  console.log(`http://127.0.0.1:${port}/  (web/dist, COEP ${coep})`);
}
