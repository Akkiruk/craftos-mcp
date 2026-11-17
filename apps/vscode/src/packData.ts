// The versions and addons esbuild.mjs read from packages/runner at build time (pack-data.mjs).
import type { PackData } from "./pack.ts";

declare const __CRAFTOS_PACK__: PackData | undefined;

export const PACK: PackData =
  typeof __CRAFTOS_PACK__ !== "undefined"
    ? __CRAFTOS_PACK__
    : { newest: "", versions: [], addons: [] };
