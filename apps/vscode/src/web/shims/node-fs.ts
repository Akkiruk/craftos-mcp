// node:fs for the web bundle: packages/runner's world.ts imports it for loading named worlds, which the browser never
// does. Nothing here is on the browser's path; a call means some runner code needs a real file system.
export function existsSync(): boolean {
  return false;
}
export function readFileSync(path: string): never {
  throw new Error(`no file system in the browser (read ${path})`);
}
