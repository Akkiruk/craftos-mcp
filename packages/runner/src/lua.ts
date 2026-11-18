/** Quote a JS string as a Lua string literal (byte-safe for latin1 content). */
export function luaString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (code < 32 || code === 127)
      out += `\\${String(code).padStart(3, "0")}`;
    else if (code > 255) {
      for (const byte of Buffer.from(ch, "utf8"))
        out += `\\${String(byte).padStart(3, "0")}`;
    } else out += ch;
  }
  return out + '"';
}

/** A monitor wall next to the computer, emulated by the engine. */
export interface MonitorSpec {
  /**
   * Peripheral side/name, e.g. "top" or "monitor_0".
   * @example "top"
   */
  readonly name:
    | "top"
    | "bottom"
    | "left"
    | "right"
    | "front"
    | "back"
    | (string & {});
  /** Width in blocks, like a real monitor wall (1 block is 7 characters at scale 1). @default 1 @integer @minimum 1 @maximum 8 */
  readonly blocksWide?: number;
  /** Height in blocks (1 block is 5 characters at scale 1). @default 1 @integer @minimum 1 @maximum 6 */
  readonly blocksHigh?: number;
  /** Text scale at the start, 0.5 to 5 in steps of 0.5. @default 1 @minimum 0.5 @maximum 5 */
  readonly textScale?: number;
  /** false: a normal monitor, which shows greys only, says isColour() is false and takes no touches. @default true */
  readonly advanced?: boolean;
}

/** Largest monitor in blocks: term_sizes.monitor in the modpack's computercraft-server.toml. */
export const MONITOR_LIMIT = { width: 8, height: 6 } as const;

/** Lua that attaches the requested monitors before the program starts. */
export function monitorSetupLua(monitors: readonly MonitorSpec[]): string {
  const setup = monitors
    .map((m) => {
      const wide = m.blocksWide ?? 1;
      const high = m.blocksHigh ?? 1;
      if (wide > MONITOR_LIMIT.width || high > MONITOR_LIMIT.height)
        throw new Error(
          `monitor "${m.name}" is ${wide}x${high} blocks; a monitor wall is at most ${MONITOR_LIMIT.width}x${MONITOR_LIMIT.height} blocks (wide x high)`,
        );
      // The boot script runs again after a reboot. A monitor is a block in the world: it keeps its text scale, palette
      // and contents across a reboot of the computer, so the starting scale only applies the first time. So does its
      // size: a wall grown while the computer ran (the browser app's world panel) keeps it.
      const lines = [
        `do`,
        `  local fresh = periphemu.create(${luaString(m.name)}, "monitor")`,
        `  if peripheral.__ccsimNamed then peripheral.__ccsimNamed(${luaString(m.name)}${m.advanced === false ? ", { normal = true }" : ""}) end`,
        `  local m = peripheral.wrap(${luaString(m.name)})`,
        `  if fresh then m.setBlockSize(${m.blocksWide ?? 1}, ${m.blocksHigh ?? 1}) end`,
      ];
      if (m.textScale !== undefined)
        lines.push(
          `  if fresh then m.setTextScale(${m.textScale}, "ccsim_boot") end`,
        );
      lines.push(`end`);
      return lines.join("\n");
    })
    .join("\n");
  // Setup is done: from here on scripts see the plain CC:Tweaked surface (no periphemu, term graphics, ...).
  return `${setup}\nif emulator then emulator.hide() end`;
}

/**
 * The startup script runs inside a multishell tab whose window may not have
 * been drawn to the real screen yet; force it out before the computer stops.
 */
export const REDRAW_TERMINAL_LUA = [
  "do",
  "  local t = term.current()",
  "  if t.redraw then t.setVisible(true) t.redraw() end",
  "end",
].join("\n");
