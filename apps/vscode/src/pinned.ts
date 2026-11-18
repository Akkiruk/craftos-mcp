// The pinned craftos-mcp, downloaded once into the extension's global storage and run with node, so nothing needs
// npx (it stays the fallback). What goes in is src/pinnedLock.ts: NPM_PACKAGE and every package it depends on, each
// tarball from the npm registry checked against the integrity hash the registry gave for it when the lock was made
// (pin-lock.mjs). Shipping the lock costs the .vsix a few kilobytes; shipping the packages would cost megabytes.
// No vscode import, so the unit tests load it in plain Node.
//
//   <store>/<x.y.z>/node_modules/...   the packages, laid out as npm would
//   <store>/<x.y.z>/pinned.json        written last: { spec, bin }; without it the folder does not count
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";

export interface PinnedPackage {
  /** Where it goes, as in a package-lock: node_modules/a, node_modules/a/node_modules/b. */
  readonly path: string;
  readonly version: string;
  /** The registry's tarball URL. */
  readonly resolved: string;
  /** The registry's Subresource Integrity hash: sha512-<base64>. */
  readonly integrity: string;
}

export interface PinnedLock {
  /** craftos-mcp@x.y.z: NPM_PACKAGE. */
  readonly spec: string;
  /** The bin script inside the package. */
  readonly bin: string;
  readonly packages: readonly PinnedPackage[];
}

const MARKER = "pinned.json";

function versionOf(spec: string): string | undefined {
  return /^craftos-mcp@(\d+\.\d+\.\d+)$/.exec(spec)?.[1];
}

/** The bin script of `spec` when it is installed in `store`, else undefined. */
export function pinnedBin(
  store: string | undefined,
  spec: string,
): string | undefined {
  const version = versionOf(spec);
  if (!store || !version) return undefined;
  const root = join(store, version);
  try {
    const marker = JSON.parse(readFileSync(join(root, MARKER), "utf8")) as {
      spec?: string;
      bin?: string;
    };
    if (marker.spec !== spec || typeof marker.bin !== "string")
      return undefined;
    const file = join(root, "node_modules", "craftos-mcp", marker.bin);
    return existsSync(file) ? file : undefined;
  } catch {
    return undefined;
  }
}

/** Whether `data` matches a Subresource Integrity string (any of its sha256/384/512 hashes). */
export function matchesIntegrity(data: Buffer, integrity: string): boolean {
  for (const part of integrity.trim().split(/\s+/)) {
    const m = /^(sha256|sha384|sha512)-([A-Za-z0-9+/=]+)$/.exec(part);
    if (m && createHash(m[1]!).update(data).digest("base64") === m[2])
      return true;
  }
  return false;
}

export interface TarEntry {
  readonly name: string;
  /** "0" a file, "5" a folder, anything else is skipped by extractTgz. */
  readonly type: string;
  readonly data: Buffer;
}

const field = (h: Buffer, start: number, end: number): string => {
  const raw = h.subarray(start, end);
  const nul = raw.indexOf(0);
  return raw.subarray(0, nul < 0 ? raw.length : nul).toString("utf8");
};

/** The entries of a tar archive (ustar, with pax and GNU long names), as npm packs them. */
export function* readTar(buf: Buffer): Generator<TarEntry> {
  let offset = 0;
  let longName: string | undefined;
  let paxPath: string | undefined;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) return;
    const sizeField = header.subarray(124, 136);
    if (sizeField[0]! & 0x80)
      throw new Error("tar: a file too big for this reader");
    const size = parseInt(field(header, 124, 136).trim() || "0", 8);
    if (!Number.isFinite(size) || size < 0)
      throw new Error("tar: a bad header");
    const typeByte = header[156]!;
    const type = typeByte === 0 ? "0" : String.fromCharCode(typeByte);
    let name = field(header, 0, 100);
    if (field(header, 257, 263).startsWith("ustar")) {
      const prefix = field(header, 345, 500);
      if (prefix) name = `${prefix}/${name}`;
    }
    const start = offset + 512;
    if (start + size > buf.length) throw new Error("tar: cut short");
    const data = buf.subarray(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;
    if (type === "x") {
      // pax records: "<length> path=<name>\n"
      for (const line of data.toString("utf8").split("\n")) {
        const m = /^\d+ path=(.*)$/.exec(line);
        if (m) paxPath = m[1];
      }
      continue;
    }
    if (type === "g") continue;
    if (type === "L") {
      longName = field(data, 0, data.length);
      continue;
    }
    yield { name: longName ?? paxPath ?? name, type, data };
    longName = undefined;
    paxPath = undefined;
  }
}

/**
 * Unpack an npm tarball into `dest`: its top folder (package/) dropped, files only. A path that climbs out of `dest`
 * is refused. Returns how many files it wrote.
 */
export function extractTgz(tgz: Buffer, dest: string): number {
  const root = resolve(dest);
  let files = 0;
  for (const entry of readTar(gunzipSync(tgz))) {
    if (entry.type !== "0" && entry.type !== "7") continue;
    const parts = entry.name
      .split(/[\\/]+/)
      .filter(Boolean)
      .slice(1);
    if (!parts.length) continue;
    if (
      isAbsolute(entry.name) ||
      parts.some((p) => p === ".." || p.includes(":"))
    )
      throw new Error(`tar: unsafe path ${entry.name}`);
    const file = resolve(root, ...parts);
    if (!file.startsWith(root + sep))
      throw new Error(`tar: unsafe path ${entry.name}`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, entry.data);
    files++;
  }
  return files;
}

/** What a download answers (the part of fetch's Response this uses). */
export interface Fetched {
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface InstallOptions {
  readonly fetch?: (url: string) => Promise<Fetched>;
  readonly log?: (line: string) => void;
  /** Downloads at once. */
  readonly parallel?: number;
}

/**
 * Download and unpack every package of `lock` into <store>/<version>, each checked against its integrity hash, and
 * return the bin script. Nothing counts until all of it is in (the folder is built aside and renamed); another
 * window doing the same at once is fine. Other versions in the store are removed afterwards.
 */
export async function installPinned(
  store: string,
  lock: PinnedLock,
  options: InstallOptions = {},
): Promise<string> {
  const version = versionOf(lock.spec);
  if (!version) throw new Error(`not a pinned craftos-mcp: ${lock.spec}`);
  const done = pinnedBin(store, lock.spec);
  if (done) return done;
  const get =
    options.fetch ??
    ((url: string) =>
      fetch(url, { headers: { "User-Agent": "craftos-mcp-vscode" } }));
  const part = join(store, `${version}.part-${randomBytes(4).toString("hex")}`);
  mkdirSync(part, { recursive: true });
  try {
    const queue = [...lock.packages];
    let bytes = 0;
    const worker = async (): Promise<void> => {
      for (let p = queue.shift(); p; p = queue.shift()) {
        const res = await get(p.resolved).catch((error: Error) => {
          throw new Error(
            `could not download ${p.path.replace(/^.*node_modules\//, "")}: ${error.message}`,
          );
        });
        if (!res.ok) throw new Error(`${p.resolved}: HTTP ${res.status}`);
        const data = Buffer.from(await res.arrayBuffer());
        if (!matchesIntegrity(data, p.integrity))
          throw new Error(
            `${p.resolved} does not match its integrity hash from the npm registry: not installed`,
          );
        bytes += data.length;
        extractTgz(data, join(part, ...p.path.split("/")));
      }
    };
    await Promise.all(
      Array.from({ length: Math.max(1, options.parallel ?? 8) }, worker),
    );
    if (!existsSync(join(part, "node_modules", "craftos-mcp", lock.bin)))
      throw new Error(`${lock.spec} has no ${lock.bin}`);
    writeFileSync(
      join(part, MARKER),
      `${JSON.stringify({ spec: lock.spec, bin: lock.bin })}\n`,
    );
    const final = join(store, version);
    // another window may have got there first: its copy stays (it may be running)
    if (!pinnedBin(store, lock.spec)) {
      rmSync(final, { recursive: true, force: true });
      try {
        renameSync(part, final);
      } catch (error) {
        if (!pinnedBin(store, lock.spec)) throw error;
      }
    }
    options.log?.(
      `${lock.spec}: ${lock.packages.length} packages, ${(bytes / 1024 / 1024).toFixed(1)} MB, in ${final}`,
    );
  } finally {
    rmSync(part, { recursive: true, force: true });
  }
  // older versions go (a .part folder may be another window's install in progress: left alone)
  for (const name of readdirSync(store))
    if (name !== version && /^\d+\.\d+\.\d+$/.test(name))
      rmSync(join(store, name), { recursive: true, force: true });
  const bin = pinnedBin(store, lock.spec);
  if (!bin) throw new Error(`${lock.spec} did not install`);
  return bin;
}
