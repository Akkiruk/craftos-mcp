import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import {
  type BlockWorldHost,
  isBlockWorld,
  startInBlockWorld,
} from "./blockworld.js";
import type { RunnerConfig } from "./config.js";
import {
  type DebugLink,
  type EngineHandle,
  type ScreenCapture,
  type StagedRun,
  captureScreens,
  discardStaged,
  makeRuntimeDir,
  stageEngine,
  startEngine,
} from "./engine.js";
import { type MonitorSpec, monitorSetupLua } from "./lua.js";
import {
  ComputerNetwork,
  type NetworkSpec,
  linkedWorlds,
  seedEconomy,
} from "./network.js";
import type { WorldConfig } from "./world.js";

export interface Session {
  readonly id: string;
  readonly handle: EngineHandle;
  readonly createdAt: number;
  /** A turtle's world: the host that shares its blocks and starts the computers it places (blockworld.ts). */
  readonly blockWorld?: { network: ComputerNetwork; host: BlockWorldHost };
}

/** Linked computers: ordinary sessions, by name, plus the network joining them. */
export interface LinkedNetwork {
  readonly network: ComputerNetwork;
  readonly computers: Record<string, Session>;
}

export interface SessionSummary {
  readonly id: string;
  readonly running: boolean;
  readonly exitCode: number | null | undefined;
  readonly windows: {
    id: number;
    peripheral: string | undefined;
    width: number;
    height: number;
  }[];
}

/** What is in front once a computer has booted: the shell prompt, or a program started from startup.lua. */
export type FrontOfScreen = "shell" | "program";

const hasPrompt = (raw: Session["handle"]["session"]): boolean =>
  raw.screen(0)?.lines.some((l) => l.includes(">")) ?? false;

/**
 * Wait until the computer has booted. A plain shell shows its ">" prompt. A computer whose startup.lua runs a
 * program that never returns never shows one, so it counts as booted once something has been on screen for
 * `graceMs` with no prompt: the program is then in front.
 */
export function waitForBoot(
  raw: Session["handle"]["session"],
  timeoutMs = 20000,
  graceMs = 2500,
): Promise<FrontOfScreen> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let firstText: number | undefined;
    const done = (): void => {
      clearInterval(timer);
      raw.off("exit", onExit);
    };
    const onExit = (): void => {
      done();
      reject(new Error("engine exited before the computer booted"));
    };
    const check = (): void => {
      const now = Date.now();
      if (hasPrompt(raw)) {
        done();
        return resolve("shell");
      }
      const text = raw.screen(0)?.lines.some((l) => l.trim() !== "");
      if (text) firstText ??= now;
      if (firstText !== undefined && now - firstText >= graceMs) {
        done();
        return resolve("program");
      }
      if (now - started >= timeoutMs) {
        done();
        reject(new Error(`timed out after ${timeoutMs}ms waiting for boot`));
      }
    };
    const timer = setInterval(check, 100);
    raw.on("exit", onExit);
    check();
  });
}

/** Interactive computers that stay alive between tool calls. */
export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  /** Economies of the networks this manager started, removed with the last of their computers. */
  private readonly economies: string[] = [];

  constructor(private readonly config: RunnerConfig) {}

  /**
   * A new session; `staged` is a folder stageEngine already copied its files into (createAsync). `debug`: a debug
   * adapter the computer's engine connects to before it boots.
   */
  create(
    monitors: readonly MonitorSpec[] = [],
    timeScale = 1,
    world?: WorldConfig,
    staged?: StagedRun,
    debug?: DebugLink,
  ): Session {
    const boot = monitorSetupLua(monitors);
    // a world with blocks gets its host, as craftos_run does: what the turtle places can boot
    const blocks =
      world && isBlockWorld(world)
        ? startInBlockWorld(this.config, boot, {
            label: "session",
            timeScale,
            world,
            ...(debug && { debug }),
          })
        : undefined;
    const handle =
      blocks?.handle ??
      startEngine(this.config, boot, {
        label: "session",
        timeScale,
        world,
        ...(staged && { staged }),
        ...(debug && { debug }),
      });
    const session: Session = {
      id: randomUUID().slice(0, 8),
      handle,
      createdAt: Date.now(),
      ...(blocks && {
        blockWorld: { network: blocks.network, host: blocks.host },
      }),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  /** create, with the workspace copied without blocking (the MCP server stays free for other clients). */
  async createAsync(
    monitors: readonly MonitorSpec[] = [],
    timeScale = 1,
    world?: WorldConfig,
    signal?: AbortSignal,
  ): Promise<Session> {
    if (world && isBlockWorld(world))
      return this.create(monitors, timeScale, world);
    const staged = await stageEngine(this.config, {
      label: "session",
      ...(world && { world }),
      ...(signal && { signal }),
    });
    try {
      return this.create(monitors, timeScale, world, staged);
    } catch (error) {
      discardStaged(staged);
      throw error;
    }
  }

  /** createNetwork, with every computer's files copied without blocking. */
  async createNetworkAsync(
    spec: NetworkSpec,
    signal?: AbortSignal,
  ): Promise<LinkedNetwork> {
    const worlds = linkedWorlds(spec.computers, spec.wired);
    const staged: StagedRun[] = [];
    try {
      for (const [index, computer] of spec.computers.entries()) {
        const config = computer.workspaceDir
          ? { ...this.config, workspaceDir: computer.workspaceDir }
          : this.config;
        staged.push(
          await stageEngine(config, {
            label: "session",
            world: worlds[index]!,
            ...(signal && { signal }),
          }),
        );
      }
      return this.createNetwork(spec, staged);
    } catch (error) {
      for (const s of staged) discardStaged(s);
      throw error;
    }
  }

  /**
   * Start several computers on one network, each a full session with its own ccsim world. Their
   * modems reach each other by the real rules, so rednet from the unmodified ROM just works.
   */
  createNetwork(
    spec: NetworkSpec,
    staged?: readonly StagedRun[],
  ): LinkedNetwork {
    const worlds = linkedWorlds(spec.computers, spec.wired);
    // One server, one economy: every computer's balances and ledger are the same ones (seedEconomy)
    const economyDir = makeRuntimeDir(this.config, "economy");
    this.economies.push(economyDir);
    seedEconomy(economyDir, worlds);
    const network = new ComputerNetwork(spec.wired, economyDir);
    const computers: Record<string, Session> = {};
    spec.computers.forEach((computer, index) => {
      const world = worlds[index]!;
      const name = computer.name ?? String(world.computerId);
      if (computers[name])
        throw new Error(`two computers on one network are named ${name}`);
      const config = computer.workspaceDir
        ? { ...this.config, workspaceDir: computer.workspaceDir }
        : this.config;
      const handle = startEngine(
        config,
        monitorSetupLua(computer.monitors ?? []),
        {
          label: "session",
          timeScale: computer.timeScale ?? spec.timeScale ?? 1,
          world,
          economyDir,
          ...(staged?.[index] && { staged: staged[index] }),
        },
      );
      const session: Session = {
        id: randomUUID().slice(0, 8),
        handle,
        createdAt: Date.now(),
      };
      this.sessions.set(session.id, session);
      computers[name] = session;
      network.add(name, handle, world);
    });
    return { network, computers };
  }

  get(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) {
      const live = [...this.sessions.keys()];
      throw new Error(
        `no such session: ${id}. ` +
          (live.length
            ? `Live sessions: ${live.join(", ")}.`
            : "No session is running.") +
          " Sessions end when the server restarts; craftos_session_create starts a new one.",
      );
    }
    return session;
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()].map((s) => this.summarize(s));
  }

  summarize(session: Session): SessionSummary {
    const raw = session.handle.session;
    return {
      id: session.id,
      running: raw.running,
      exitCode: raw.exitInfo?.code,
      windows: raw.allWindows().map((w) => ({
        id: w.id,
        peripheral: w.peripheral,
        width: w.frame?.width ?? 0,
        height: w.frame?.height ?? 0,
      })),
    };
  }

  screens(
    id: string,
    options: { png?: boolean; scale?: number } = {},
  ): ScreenCapture[] {
    const { handle } = this.get(id);
    return captureScreens(handle.session, {
      ...options,
      resultsDir: handle.resultsDir,
    });
  }

  async destroy(id: string): Promise<void> {
    const session = this.get(id);
    this.sessions.delete(id);
    await session.handle.session.stop();
    if (session.blockWorld) {
      session.blockWorld.network.close();
      await session.blockWorld.host.dispose();
    }
    session.handle.dispose();
  }

  async destroyAll(): Promise<void> {
    await Promise.all(
      [...this.sessions.keys()].map((id) =>
        this.destroy(id).catch(() => undefined),
      ),
    );
    for (const dir of this.economies.splice(0))
      rmSync(dir, { recursive: true, force: true });
  }
}
