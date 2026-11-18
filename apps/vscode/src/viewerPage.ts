// The MCP server's live viewer (apps/mcp-server/src/viewer.ts: the browser app over the sessions the agent drives)
// in a panel: where it is, and the page that frames it. The server says where on stderr, `craftos viewer: <url>`;
// the port is CRAFTOS_VIEWER_PORT (7878), or a free one when that was taken.
//
// No vscode import: the unit tests load this file in plain Node.

/** The viewer's URL from a line of the server's stderr, or undefined. */
export function readViewerLine(line: string): string | undefined {
  const m =
    /^craftos viewer: (http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/?)\s*$/.exec(
      line.trim(),
    );
  return m?.[1];
}

const attr = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/** The webview page: the viewer, full size, in a frame (the webview's CSP lets that one origin in and nothing else). */
export function viewerHtml(url: string, cspSource: string): string {
  const origin = new URL(url).origin;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${attr(origin)}; style-src ${attr(cspSource)} 'unsafe-inline';">
<title>Agent's Computers</title>
<style>html, body, iframe { margin: 0; padding: 0; border: 0; width: 100%; height: 100%; overflow: hidden; }</style>
</head>
<body><iframe src="${attr(url)}" title="craftos-mcp viewer" allow="clipboard-read; clipboard-write"></iframe></body>
</html>`;
}
