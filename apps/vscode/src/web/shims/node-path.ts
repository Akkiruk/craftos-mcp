// node:path for the web bundle: the runner code only joins paths it never opens in the browser.
export function join(...parts: string[]): string {
  return parts.filter(Boolean).join("/").replace(/\/+/g, "/");
}
