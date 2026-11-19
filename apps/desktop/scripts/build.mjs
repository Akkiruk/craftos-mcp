// Build the CraftOS desktop installer for the platform this runs on.
//
//   node apps/desktop/scripts/build.mjs [--tarball <craftos-mcp-x.y.z.tgz>] [--engine <folder> | --engine-zip <zip>]
//                                       [--out <folder>] [--version <x.y.z>] [--dir]
//
// What goes into the installer:
//   - Electron (its own runtime: nobody needs Node, npm or a terminal) and this app (src/, ui/)
//   - craftos/  the npm package, unpacked, with its dependencies installed: the same files `npx craftos-mcp` runs.
//               --tarball names one that is built already; without it, scripts/pack-npm.mjs packs this repository
//               (a public export, as in CI).
//   - engine/   this platform's engine: --engine names its folder (default engine/build of this repository), or
//               --engine-zip a release's engine zip (craftos-mcp-v<version>-<platform>.zip)
// Never CC:Tweaked's ROM: its license does not allow shipping it, so the app builds it on first run from the official
// jar, as `craftos-mcp setup` does.
//
// Windows: an NSIS installer (per user, no admin, Start-menu and desktop shortcut "CraftOS"), with latest.yml and a
// .blockmap for the app's own updates. macOS: a .dmg for the architecture of this machine, signed ad hoc (not by a
// paid Apple developer id). Linux: an AppImage (with latest-linux.yml) and a .deb.
// --dir stops at the unpacked app (no installer): quick, for trying things.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(APP, "..", "..");
const WINDOWS = process.platform === "win32";
const MAC = process.platform === "darwin";
/** The GitHub repository the releases are on: where the installed app looks for its updates. */
const RELEASES = "Akkiruk/craftos-mcp";

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (!value) fail(`${name} needs a value`);
  args.splice(at, 2);
  return value;
};
const flag = (name) => {
  const at = args.indexOf(name);
  if (at >= 0) args.splice(at, 1);
  return at >= 0;
};
function fail(message) {
  console.error(message);
  process.exit(2);
}

let tarball = option("--tarball");
let engineDir = resolve(option("--engine") ?? join(REPO, "engine", "build"));
const engineZip = option("--engine-zip");
const outDir = resolve(option("--out") ?? join(APP, "release"));
const versionOption = option("--version");
const dirOnly = flag("--dir");
if (args.length) fail(`unknown argument ${args[0]}`);

function run(command, argv, cwd) {
  // npm is a .cmd on Windows: it needs a shell
  const [file, list] =
    WINDOWS && command === "npm"
      ? ["cmd.exe", ["/d", "/s", "/c", ["npm", ...argv].join(" ")]]
      : [command, argv];
  const result = spawnSync(file, list, { cwd, stdio: "inherit" });
  if (result.status !== 0)
    fail(`${command} ${argv.join(" ")} failed in ${cwd}`);
}

const STAGE = mkdtempSync(join(tmpdir(), "craftos-desktop-"));
process.on("exit", () => rmSync(STAGE, { recursive: true, force: true }));

// ---- the npm package, unpacked, with its dependencies ----
if (!tarball) {
  const packed = join(STAGE, "npm");
  run(
    process.execPath,
    [
      join(REPO, "scripts", "pack-npm.mjs"),
      REPO,
      "--out",
      packed,
      ...(versionOption ? ["--version", versionOption] : []),
    ],
    REPO,
  );
  tarball = join(
    packed,
    readdirSync(packed).find((f) => f.endsWith(".tgz")),
  );
}
tarball = resolve(tarball);
if (!existsSync(tarball)) fail(`no such file: ${tarball}`);
// Windows' own tar (bsdtar) takes C:\ paths; Git Bash's reads the C: as a host name
const tar = WINDOWS
  ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
  : "tar";
run(tar, ["-xzf", tarball, "-C", STAGE], STAGE);
const PAYLOAD = join(STAGE, "package");
const version = JSON.parse(
  readFileSync(join(PAYLOAD, "craftos-package.json"), "utf8"),
).version;
console.log(`craftos-mcp ${version} from ${tarball}`);
run(
  "npm",
  ["install", "--omit=dev", "--no-audit", "--no-fund", "--ignore-scripts"],
  PAYLOAD,
);

function walk(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) found.push(...walk(full));
    else found.push(full);
  }
  return found;
}
// No CC:Tweaked files, ever.
const banned = walk(PAYLOAD).filter(
  (f) => /\.jar$/i.test(f) || /[\\/]bios\.lua$/.test(f),
);
if (banned.length || existsSync(join(PAYLOAD, "rom")))
  fail(`CC:Tweaked files in the app: ${banned.join(", ") || "rom/"}`);

// ---- this platform's engine ----
if (engineZip) {
  const { extractZip } = await import(
    pathToFileURL(join(REPO, "scripts", "setup.mjs")).href
  );
  const unzipped = join(STAGE, "engine-zip");
  extractZip(readFileSync(resolve(engineZip)), unzipped, ["engine/build/"]);
  engineDir = join(unzipped, "engine", "build");
}
const exe = WINDOWS ? "craftos.exe" : "craftos";
if (!existsSync(join(engineDir, exe)))
  fail(
    `no engine at ${join(engineDir, exe)}: build it (engine/build.cmd or engine/build.sh), or pass --engine <folder>`,
  );
const ENGINE = join(STAGE, "engine");
mkdirSync(ENGINE);
for (const name of readdirSync(engineDir)) {
  if (name !== exe && !/\.(dll|dylib)$|\.so(\.\d+)*$/.test(name)) continue;
  // a link to a library (libx.so.1 -> libx.so.1.2) becomes the file itself: every packer copes with plain files
  cpSync(join(engineDir, name), join(ENGINE, name), { dereference: true });
}
if (!WINDOWS) chmodSync(join(ENGINE, exe), 0o755);
console.log(`engine: ${readdirSync(ENGINE).length} files from ${engineDir}`);

// ---- the installer ----
const [owner, repo] = RELEASES.split("/");
/** The app's program on Windows (CraftOS-Desktop.exe); the Start-menu entry and the window still say CraftOS. */
const WINDOWS_EXE = "CraftOS-Desktop";
const config = {
  appId: "io.github.craftos-mcp.desktop",
  productName: "CraftOS",
  copyright: "MIT license. CC:Tweaked is not part of this app.",
  directories: { output: outDir, buildResources: join(APP, "build") },
  files: [
    "package.json",
    "src/**/*",
    "!src/**/*.test.ts",
    "ui/**/*",
    "build/icon.png",
  ],
  extraResources: [
    { from: PAYLOAD, to: "craftos", filter: ["**/*"] },
    { from: ENGINE, to: "engine", filter: ["**/*"] },
  ],
  extraMetadata: { version },
  asar: true,
  // Chromium's other languages are 40 MB the app never shows
  electronLanguages: ["en", "en-US"],
  publish: [{ provider: "github", owner, repo }],
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    icon: join(APP, "build", "icon.ico"),
    // Not CraftOS.exe. Before it installs, updates or uninstalls, the installer closes "the app" by the name of its
    // program, Windows compares names without case, and the engine is craftos.exe: under that name it closed every
    // running engine on the machine (an MCP server's computers, a test run). check.mjs keeps a craftos.exe running
    // through an install and an uninstall to see this stays fixed.
    executableName: WINDOWS_EXE,
    // Signed with Azure Artifact Signing when release.yml gives the account (after an azure/login): unsigned, Smart
    // App Control refuses to start the app and SmartScreen warns about the installer.
    ...(process.env.CRAFTOS_SIGN_ENDPOINT
      ? {
          azureSignOptions: {
            publisherName: process.env.CRAFTOS_SIGN_PUBLISHER,
            endpoint: process.env.CRAFTOS_SIGN_ENDPOINT,
            codeSigningAccountName: process.env.CRAFTOS_SIGN_ACCOUNT,
            certificateProfileName: process.env.CRAFTOS_SIGN_PROFILE,
          },
          // the engine and its DLLs too (signed already in the zip; this keeps them signed if that ever changes)
          signExts: [".dll"],
        }
      : {}),
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    shortcutName: "CraftOS",
    createStartMenuShortcut: true,
    createDesktopShortcut: true,
    runAfterFinish: true,
    artifactName: "CraftOS-${version}-windows-x64-setup.${ext}",
  },
  mac: {
    target: [{ target: "dmg", arch: [process.arch] }],
    category: "public.app-category.developer-tools",
    icon: join(APP, "build", "icon.png"),
    // no paid Apple developer id: signed ad hoc below, so Apple silicon will run it at all
    identity: null,
    artifactName: "CraftOS-${version}-macos-${arch}.${ext}",
  },
  dmg: { sign: false },
  linux: {
    target: [
      { target: "AppImage", arch: ["x64"] },
      { target: "deb", arch: ["x64"] },
    ],
    category: "Development",
    icon: join(APP, "build", "icon.png"),
    maintainer: "craftos-mcp contributors <noreply@github.com>",
    synopsis: "CC:Tweaked emulator",
  },
  appImage: { artifactName: "CraftOS-${version}-linux-x64.${ext}" },
  deb: { artifactName: "CraftOS-${version}-linux-x64.${ext}" },
  afterPack: async (context) => {
    if (context.electronPlatformName !== "darwin") return;
    const app = join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
    );
    const engine = join(app, "Contents", "Resources", "engine");
    for (const name of readdirSync(engine))
      run("codesign", ["--force", "--sign", "-", join(engine, name)], app);
    run("codesign", ["--force", "--deep", "--sign", "-", app], app);
    run("codesign", ["--verify", "--deep", "--verbose=2", app], app);
  },
};

const { build } = await import("electron-builder");
const made = await build({
  projectDir: APP,
  config,
  publish: "never",
  ...(dirOnly && { dir: true }),
});

// ---- check ----
const want = dirOnly
  ? []
  : WINDOWS
    ? [/-windows-x64-setup\.exe$/, /-setup\.exe\.blockmap$/, /^latest\.yml$/]
    : MAC
      ? [new RegExp(`-macos-${process.arch}\\.dmg$`)]
      : [/-linux-x64\.AppImage$/, /-linux-x64\.deb$/, /^latest-linux\.yml$/];
const files = readdirSync(outDir).filter((f) =>
  statSync(join(outDir, f)).isFile(),
);
for (const re of want)
  if (!files.some((f) => re.test(f)))
    fail(`the build left no ${re} in ${outDir} (it has: ${files.join(", ")})`);
console.log(`\nCraftOS ${version}:`);
for (const file of made.length ? made : files)
  if (existsSync(file) && statSync(file).isFile())
    console.log(
      `  ${file}  ${(statSync(file).size / 1024 / 1024).toFixed(1)} MB`,
    );
