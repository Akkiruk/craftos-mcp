/**
 * Mobs with a computer in them: androids and drones. A world with one of these keys makes the computer that mob, the
 * way `turtle` makes it a turtle. The mob stands in the block world (`blocks`, `fills`, `ground`, `entities`,
 * `items`) and its addon gives it its API (rom-overlay/rom/ccsim/mob.lua and ccsim/addons/<addon>/).
 *
 * This file holds what the runner needs to know before the computer boots: its screen. The world fields of each mob
 * are typed in world-peripherals.ts.
 */

export interface MobComputer {
  /** The world key that made it. */
  key: string;
  width: number;
  height: number;
  /** false: a normal computer, without colour. */
  colour: boolean;
}

type MobWorld = { [key: string]: unknown } | undefined;

const MOBS: Record<
  string,
  (spec: Record<string, unknown>) => Omit<MobComputer, "key">
> = {
  // AndroidComputerContainer.createComputer: the turtle's terminal, and the family of the android
  android: (spec) => ({
    width: 39,
    height: 13,
    colour: spec["type"] === "advanced" || spec["type"] === "command",
  }),
  // CC: Drones 0.0.1, DroneEntity.createOrUpkeepComputer: ComputerFamily.NORMAL at the computer's size
  drone: () => ({ width: 51, height: 19, colour: false }),
  // CC: Drones+ 0.2.0: ComputerFamily.ADVANCED, no terminal size given
  dronePlus: () => ({ width: 51, height: 19, colour: true }),
  // AC-Drones alpha 7, ComputerDroneEntity.createComputer: ComputerFamily.ADVANCED at the turtle's terminal size
  acDrone: () => ({ width: 39, height: 13, colour: true }),
};

/** World keys that make the computer a mob. */
export const MOB_KEYS: readonly string[] = Object.keys(MOBS);

/** The computer inside the mob a world describes, or undefined when the world has none. */
export function mobComputer(world: MobWorld): MobComputer | undefined {
  if (!world || world["turtle"] || world["placed"]) return undefined;
  for (const key of MOB_KEYS) {
    const spec = world[key];
    if (spec && typeof spec === "object")
      return { key, ...MOBS[key]!(spec as Record<string, unknown>) };
  }
  return undefined;
}
