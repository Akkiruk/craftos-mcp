import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  type BlockWorldHost,
  isBlockWorld,
  startInBlockWorld,
} from "./blockworld.js";
import type { RunnerConfig } from "./config.js";
import {
  type EngineHandle,
  type ScreenCapture,
  captureScreens,
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

  create(
    monitors: readonly MonitorSpec[] = [],
    timeScale = 1,
    world?: WorldConfig,
  ): Session {
    const boot = monitorSetupLua(monitors);
    // a world with blocks gets its host, as craftos_run does: what the turtle places can boot
    const blocks =
      world && isBlockWorld(world)
        ? startInBlockWorld(this.config, boot, {
            label: "session",
            timeScale,
            world,
          })
        : undefined;
    const handle =
      blocks?.handle ??
      startEngine(this.config, boot, {
        label: "session",
        timeScale,
        world,
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

  /**
   * Start several computers on one network, each a full session with its own ccsim world. Their
   * modems reach each other by the real rules, so rednet from the unmodified ROM just works.
   */
  createNetwork(spec: NetworkSpec): LinkedNetwork {
    const worlds = linkedWorlds(spec.computers, spec.wired);
    // One server, one economy: every computer's balances and ledger are the same ones (seedEconomy)
    mkdirSync(this.config.runtimeDir, { recursive: true });
    const economyDir = mkdtempSync(join(this.config.runtimeDir, "economy-"));
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
    if (!session) throw new Error(`no such session: ${id}`);
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
