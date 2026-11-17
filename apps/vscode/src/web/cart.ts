// A one-computer cart (web/README.md, "Cart format") for a program: its folder's files, the world from the
// *.world.json next to it, and the boot script the desktop app would give the same computer (packages/runner: the
// world as ccsim reads it, engine peripherals, monitors, then the program).
import {
  monitorSetupLua,
  luaString,
  type MonitorSpec,
} from "../../../../packages/runner/src/lua";
import {
  type WorldConfig,
  enginePeripheralLua,
  terminalSize,
  worldJson,
} from "../../../../packages/runner/src/world";

/** The only version the browser engine and its ROM (CC:Tweaked 1.101.3) run. */
export const WEB_MC = "1.18.2";

export type CartFile = string | { base64: string };

export interface CartComputer {
  name: string;
  id: number;
  advanced: boolean;
  files: Record<string, CartFile>;
  world: string;
  boot: string;
  monitors: {
    name: string;
    blocksWide: number;
    blocksHigh: number;
    textScale?: number;
  }[];
  screens: string[];
  terminal: "show" | "hide";
  config: Record<string, unknown>;
}

export interface Cart {
  format: 1;
  id: string;
  title: string;
  kind: "shell";
  keyboard: true;
  actions: [];
  computers: CartComputer[];
}

export interface CartInput {
  /** The program, relative to the computer's root, with forward slashes. */
  program: string;
  /** The computer's files, by path relative to its root. */
  files: Record<string, CartFile>;
  /** The parsed *.world.json, if there is one. */
  world?: Record<string, unknown>;
  /** craftos-mcp.addons (CRAFTOS_ADDONS). */
  addons?: string;
}

export interface BuiltCart {
  cart: Cart;
  /** Things the browser does differently from the desktop for this world, one line each. */
  notes: string[];
}

/** CRAFTOS_ADDONS and the like for the runner code while `fn` runs (addons.ts reads process.env). */
function withEnv<T>(env: Record<string, string>, fn: () => T): T {
  // `process` is Node's in the tests and shims/globals.ts's in the web bundle
  const saved = Object.fromEntries(
    Object.keys(env).map((k) => [k, process.env[k]]),
  );
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
}

export function buildCart(input: CartInput): BuiltCart {
  const notes: string[] = [];
  const {
    monitors: rawMonitors,
    $schema: _schema,
    ...rest
  } = input.world ?? {};
  const world = rest as WorldConfig & Record<string, unknown>;
  if (
    world.version !== undefined &&
    String(world.version) !== WEB_MC &&
    !String(world.version).startsWith(`${WEB_MC}`)
  ) {
    notes.push(
      `the world asks for Minecraft ${JSON.stringify(world.version)}; in the browser every computer runs ${WEB_MC} (CC:Tweaked 1.101.3)`,
    );
  }
  world.version = WEB_MC;
  if (world.turtle)
    notes.push(
      "turtles need the desktop emulator (their block data is not in the browser ROM)",
    );
  if (world.http) notes.push("http is off in the browser engine");
  const monitors = (
    Array.isArray(rawMonitors) ? rawMonitors : []
  ) as MonitorSpec[];
  const computerId =
    typeof world.computerId === "number" ? world.computerId : 0;
  const json = withEnv(
    input.addons ? { CRAFTOS_ADDONS: input.addons } : {},
    () => worldJson(world),
  );
  const size = terminalSize(world);
  const advanced = !(
    world.advanced === false ||
    (world.turtle && !(world.turtle as { advanced?: boolean }).advanced) ||
    (typeof (world.placed as { block?: string } | undefined)?.block ===
      "string" &&
      (world.placed as { block: string }).block.endsWith("_normal"))
  );
  const boot = [
    enginePeripheralLua(world),
    monitorSetupLua(monitors),
    `shell.run(${luaString(input.program)})`,
  ]
    .filter(Boolean)
    .join("\n");
  const name = input.program.replace(/^.*\//, "").replace(/\.lua$/i, "");
  return {
    cart: {
      format: 1,
      id: name,
      title: input.program,
      kind: "shell",
      keyboard: true,
      actions: [],
      computers: [
        {
          name,
          id: computerId,
          advanced,
          files: input.files,
          world: json,
          boot: `${boot}\n`,
          monitors: monitors.map((m) => ({
            name: m.name,
            blocksWide: m.blocksWide ?? 1,
            blocksHigh: m.blocksHigh ?? 1,
            ...(m.textScale !== undefined && { textScale: m.textScale }),
          })),
          // monitors first, as the app lays them out, then the terminal
          screens: [...monitors.map((m) => `monitor:${m.name}`), "terminal"],
          terminal: "show",
          config: {
            ...(world.motd !== true && {
              default_computer_settings: "motd.enable=false",
            }),
            ...(size && {
              defaultWidth: size.width,
              defaultHeight: size.height,
            }),
          },
        },
      ],
    },
    notes,
  };
}
