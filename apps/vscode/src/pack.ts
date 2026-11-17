// The pack a computer runs in: its Minecraft version and the addons (mods) that are on, as the settings, a world
// file and CRAFTOS_VERSION / CRAFTOS_ADDONS say them. Mirrors packages/runner/src/addons.ts resolveAddons and
// versions.ts resolveVersion closely enough for the pickers and the diagnostics; the server still has the last word.
//
// No vscode import: the unit tests load this file in plain Node.

export interface PackAddon {
  id: string;
  name: string;
  /** Minecraft version -> mod version; a version missing here has no release of the mod. */
  versions: Record<string, string>;
  /** Peripheral types it adds. */
  types: string[];
  /** Addons it needs switched on too. */
  requires: string[];
}

export interface PackData {
  /** The server's default Minecraft version (the newest). */
  newest: string;
  versions: { mc: string; cc: string }[];
  addons: PackAddon[];
}

/** The variables the craftos-mcp.addons and craftos-mcp.minecraftVersion settings add to craftos-mcp's environment. */
export function packEnv(s: {
  addons: string;
  mc: string;
}): Record<string, string> {
  const env: Record<string, string> = {};
  if (s.addons.trim()) env["CRAFTOS_ADDONS"] = s.addons.trim();
  if (s.mc.trim()) env["CRAFTOS_VERSION"] = s.mc.trim();
  return env;
}

/** The Minecraft version a computer runs: the world file's, else the setting, else the server's default. */
export function effectiveMc(
  data: PackData,
  setting: string,
  worldVersion?: unknown,
): string {
  const fromWorld =
    typeof worldVersion === "string"
      ? worldVersion
      : worldVersion &&
          typeof (worldVersion as { mc?: unknown }).mc === "string"
        ? (worldVersion as { mc: string }).mc
        : undefined;
  return fromWorld?.trim() || setting.trim() || data.newest;
}

export function ccFor(data: PackData, mc: string): string | undefined {
  return data.versions.find((v) => v.mc === mc)?.cc;
}

/** addons.ts normalise: "Advanced Peripherals", "advanced_peripherals" and "advancedperipherals" are one id. */
function normalise(data: PackData, raw: string): string {
  const flat = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  if (data.addons.some((a) => a.id === flat)) return flat;
  const squashed = flat.replace(/-/g, "");
  return (
    data.addons.find((a) => a.id.replace(/-/g, "") === squashed)?.id ?? flat
  );
}

export function addonsOn(data: PackData, mc: string): PackAddon[] {
  return data.addons.filter((a) => a.versions[mc] !== undefined);
}

/**
 * The addons that are on for a spec (`all`, `none`, ids by commas, or a world's list; empty or undefined is every
 * addon with a release on `mc`). `unknown`: ids that are no addon.
 */
export function enabledAddons(
  data: PackData,
  spec: string | readonly string[] | undefined,
  mc: string,
): { on: Set<string>; unknown: string[] } {
  const list =
    spec === undefined
      ? []
      : typeof spec === "string"
        ? spec.split(",")
        : [...spec];
  const trimmed = list.map((s) => String(s).trim()).filter((s) => s !== "");
  const every = () => new Set(addonsOn(data, mc).map((a) => a.id));
  // a world's empty list is "none"; an empty setting is "everything"
  if (trimmed.length === 0)
    return { on: Array.isArray(spec) ? new Set() : every(), unknown: [] };
  if (trimmed.length === 1 && trimmed[0]!.toLowerCase() === "all")
    return { on: every(), unknown: [] };
  if (trimmed.length === 1 && trimmed[0]!.toLowerCase() === "none")
    return { on: new Set(), unknown: [] };
  const ids = trimmed.map((s) => normalise(data, s));
  return {
    on: new Set(ids.filter((id) => data.addons.some((a) => a.id === id))),
    unknown: ids.filter((id) => !data.addons.some((a) => a.id === id)),
  };
}

/** The picked ids plus every addon they need (requires), in the emulator's order. */
export function withRequired(
  data: PackData,
  picked: Iterable<string>,
): string[] {
  const on = new Set(picked);
  for (let grew = true; grew; ) {
    grew = false;
    for (const id of [...on])
      for (const need of data.addons.find((a) => a.id === id)?.requires ?? [])
        if (!on.has(need)) {
          on.add(need);
          grew = true;
        }
  }
  return data.addons.filter((a) => on.has(a.id)).map((a) => a.id);
}

/**
 * The craftos-mcp.addons value for a checklist: "all" when every addon there is on `mc` is picked, "none" for none,
 * else the ids by commas.
 */
export function addonSpec(
  data: PackData,
  picked: Iterable<string>,
  mc: string,
): string {
  const ids = withRequired(data, picked);
  const available = addonsOn(data, mc).map((a) => a.id);
  if (ids.length === 0) return "none";
  if (
    available.length > 0 &&
    available.every((id) => ids.includes(id)) &&
    ids.every((id) => available.includes(id))
  )
    return "all";
  return ids.join(",");
}

/**
 * A new Minecraft version for a spec that lists addons: the ones with no release there come out (the server refuses
 * them). `dropped` names them for a message.
 */
export function specForVersion(
  data: PackData,
  spec: string,
  mc: string,
): { spec: string; dropped: PackAddon[] } {
  const words = spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (
    words.length === 0 ||
    (words.length === 1 && /^(all|none)$/i.test(words[0]!))
  )
    return { spec, dropped: [] };
  const { on } = enabledAddons(data, spec, mc);
  const dropped = data.addons.filter(
    (a) => on.has(a.id) && a.versions[mc] === undefined,
  );
  if (dropped.length === 0) return { spec, dropped };
  const kept = [...on].filter((id) => !dropped.some((d) => d.id === id));
  return {
    spec: kept.length ? withRequired(data, kept).join(",") : "none",
    dropped,
  };
}

/** How many addons are on out of the ones `mc` has a release of. */
export function addonCount(
  data: PackData,
  setting: { mc: string; addons: string },
): { on: number; available: number } {
  const mc = setting.mc || data.newest;
  const { on } = enabledAddons(data, setting.addons, mc);
  return {
    on: [...on].filter(
      (id) => data.addons.find((a) => a.id === id)?.versions[mc],
    ).length,
    available: addonsOn(data, mc).length,
  };
}

/** A pack in full, for a tooltip: "1.21.1 · 19/19 addons". */
export function packSummary(
  data: PackData,
  setting: { mc: string; addons: string },
): string {
  const { on, available } = addonCount(data, setting);
  return `${setting.mc || data.newest} · ${on}/${available} addons`;
}

/** A pack for the status bar: the version, and the addon count only once some are off ("1.21.1", "1.18.2 · 2/15 addons"). */
export function packLabel(
  data: PackData,
  setting: { mc: string; addons: string },
): string {
  const { on, available } = addonCount(data, setting);
  const mc = setting.mc || data.newest;
  return on === available ? mc : `${mc} · ${on}/${available} addons`;
}
