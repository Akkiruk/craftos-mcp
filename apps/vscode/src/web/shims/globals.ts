// The two Node globals packages/runner's world code touches, for the web bundle (esbuild.mjs injects this file):
// process.env (addons.ts and versions.ts read CRAFTOS_ADDONS and CRAFTOS_VERSION) and Buffer.from(text, "utf8")
// (lua.ts quotes characters past Latin-1 as their UTF-8 bytes).
const encoder = new TextEncoder();
export const process = { env: {} as Record<string, string | undefined> };
export const Buffer = { from: (text: string) => encoder.encode(text) };
