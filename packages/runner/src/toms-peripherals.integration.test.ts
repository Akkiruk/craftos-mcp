import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  type SimCommand,
  type SimState,
  type TestRunResult,
  type WorldConfig,
  SessionManager,
  checkConfig,
  loadConfig,
  pixelScreens,
  runProgram,
  runTests,
  sendAndWait,
} from "./index.js";

/**
 * Tom's Peripherals 1.18.2-1.2.1, checked against behaviour read from the mod's source (1.18 branch commit 3b609fa
 * and the api branch commit 5dbf6fc) and the release jar. docs/toms-peripherals.md has the source for every rule.
 */
const base = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "tomsp-ws-"));
const agentWs = mkdtempSync(join(tmpdir(), "tomsp-agent-"));
const config = { ...base, workspaceDir: scratch };
const ready = checkConfig(config).length === 0;

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(agentWs, { recursive: true, force: true });
});

function put(name: string, content: string): void {
  const file = join(scratch, name);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
}

const PRELUDE = `
local function err(fn, ...)
  local ok, e = pcall(fn, ...)
  if ok then error("expected an error but the call succeeded", 2) end
  return (tostring(e):gsub("^pcall: ", ""):gsub("^[^:]*:%d+: ", ""))
end
local function sorted(t) table.sort(t) return t end
local function keys(t) local out = {} for k in pairs(t) do out[#out + 1] = k end table.sort(out) return out end
`;

async function lua(
  source: string,
  world: WorldConfig,
  name: string,
): Promise<TestRunResult> {
  put(name, PRELUDE + source);
  return runTests(config, { paths: [name], world, timeoutMs: 60000 }, 1);
}

function expectAllPassed(result: TestRunResult): void {
  const failures = result.files.flatMap((f) =>
    f.tests.filter((t) => !t.passed).map((t) => `${t.name}: ${t.error}`),
  );
  expect(failures).toEqual([]);
  expect(result.files.map((f) => f.status)).toEqual(["passed"]);
}

const gpuWorld = (
  width = 1,
  height = 1,
  extra: Record<string, unknown> = {},
): WorldConfig => ({
  peripherals: [
    { name: "gpu", type: "tm_gpu", monitor: { width, height }, ...extra },
  ],
});

// ───────────── method surface ─────────────

const surface = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./toms-peripherals-surface.json", import.meta.url)),
    "utf8",
  ),
) as {
  peripherals: Record<string, string[]>;
  listMethods: Record<string, string[]>;
  objects: Record<string, string[]>;
};

describe("method surface (no engine)", () => {
  it("every class's listMethods holds the jar's @LuaMethod names plus listMethods", () => {
    for (const [cls, names] of Object.entries(surface.listMethods)) {
      expect(names, cls).toContain("listMethods");
      expect(new Set(names).size, cls).toBe(names.length);
    }
    // the peripheral order is CC's HashMap(n) of the mod's names: the same names
    for (const [type, names] of Object.entries(surface.peripherals)) {
      const own =
        type === "tm_keyboard"
          ? ["setFireNativeEvents"]
          : surface.listMethods[type]!;
      expect([...names].sort(), type).toEqual([...own].sort());
    }
  });
});

describe.skipIf(!ready)("method surface", () => {
  it("each peripheral has these methods in this order, and its objects these", async () => {
    const result = await lua(
      `
local expected = ${JSON.stringify(surface.peripherals)
        .replace(/\[/g, "{")
        .replace(/\]/g, "}")
        .replace(/"(\w+)":/g, "$1 =")}
local listed = ${JSON.stringify(surface.listMethods)
        .replace(/\[/g, "{")
        .replace(/\]/g, "}")
        .replace(/"(\w+)":/g, "$1 =")}
local objects = ${JSON.stringify(surface.objects)
        .replace(/\[/g, "{")
        .replace(/\]/g, "}")
        .replace(/"(\w+)":/g, "$1 =")}
for ty, names in pairs(expected) do
  ccunit.test(ty, function()
    ccunit.eq(peripheral.getMethods("p_" .. ty), names)
    ccunit.eq({ peripheral.getType("p_" .. ty) }, { ty })
    ccunit.truthy(peripheral.find(ty), "find " .. ty)
    if listed[ty] then ccunit.eq({ peripheral.call("p_" .. ty, "listMethods") }, listed[ty]) end
  end)
end
ccunit.test("objects", function()
  local gpu = peripheral.wrap("p_tm_gpu")
  gpu.refreshSize()
  local img = gpu.newImage(2, 2)
  local got = {
    window = gpu.createWindow(1, 1, 4, 4), image = img, buffer = gpu.newBuffer(), rect = gpu.getBounds(),
    window3d = gpu.createWindow3D(1, 1, 4, 4), imageGpu = img.gpuDraw(),
  }
  for name, obj in pairs(got) do
    ccunit.eq(keys(obj), sorted({ table.unpack(objects[name]) }), name)
    ccunit.eq({ obj.listMethods() }, objects[name], name .. " listMethods")
  end
end)
`,
      {
        peripherals: [
          {
            name: "p_tm_gpu",
            type: "tm_gpu",
            monitor: { width: 1, height: 1 },
          },
          { name: "p_tm_keyboard", type: "tm_keyboard" },
          { name: "p_tm_rsPort", type: "tm_rsPort" },
          { name: "p_tm_wdt", type: "tm_wdt" },
        ],
      },
      "surface.test.lua",
    );
    expectAllPassed(result);
  }, 60000);
});

// ───────────── the GPU ─────────────

describe.skipIf(!ready)("tm_gpu", () => {
  it("size, monitors, setSize and VRAM", async () => {
    const result = await lua(
      `
ccunit.test("no size until the monitors are looked for", function()
  local gpu = peripheral.wrap("gpu")
  ccunit.eq({ gpu.getSize() }, { 0, 0, 0, 0, 16 })
  ccunit.eq(gpu.fill(), true) -- nothing to fill
  ccunit.eq(gpu.getUsedMemory(), 0)
  ccunit.eq(gpu.getMaxMemory(), 16 * 1024 * 1024)
  gpu.refreshSize()
  ccunit.eq({ gpu.getSize() }, { 48, 32, 3, 2, 16 })
  ccunit.eq(gpu.getUsedMemory(), 48 * 32 * 4)
end)

ccunit.test("setSize", function()
  local gpu = peripheral.wrap("gpu")
  gpu.refreshSize()
  ccunit.eq(err(gpu.setSize, 15), "Bad Argument #1, (too small number (15) minimum value is 16 )")
  ccunit.eq(err(gpu.setSize, 65), "Bad Argument #1, (too big number (65) maximum value is 64 )")
  ccunit.eq(err(gpu.setSize, "x"), "Bad argument #1: (expected Number)")
  ccunit.eq(gpu.setSize(64.9), nil)
  ccunit.eq({ gpu.getSize() }, { 192, 128, 3, 2, 64 })
  ccunit.eq(gpu.getUsedMemory(), 192 * 128 * 4)
  gpu.setSize(16)
end)

ccunit.test("getBounds is a fixed rect", function()
  local gpu = peripheral.wrap("gpu")
  gpu.refreshSize()
  local r = gpu.getBounds()
  ccunit.eq({ r.getX(), r.getY(), r.getW(), r.getH() }, { 0, 0, 48, 32 })
  ccunit.eq(err(r.setW, 3), "Can't modify")
end)

ccunit.test("out of VRAM", function()
  local gpu = peripheral.wrap("gpu")
  gpu.refreshSize()
  local used = gpu.getUsedMemory()
  ccunit.eq(err(gpu.newImage, 2048, 2048), "Alloc failed: Out of VRAM")
  local big = gpu.newImage(2045, 2045)
  ccunit.eq(gpu.getUsedMemory(), used + 2045 * 2045 * 4)
  ccunit.eq(err(gpu.setSize, 64), "Realloc failed: Out of VRAM")
  ccunit.eq(err(gpu.newBuffer, 1000000), "Alloc failed: Out of VRAM")
  big.free()
  big.free() -- twice is fine
  ccunit.eq(gpu.getUsedMemory(), used)
  ccunit.eq(err(big.getWidth), "Error: Use after free")
  ccunit.eq(err(big.setRGB, 0, 0, 1), 'Java Exception: java.lang.NullPointerException: Cannot invoke "com.tom.peripherals.util.Image.setRGB(int, int, int)" because "this.image" is null')
end)
`,
      gpuWorld(3, 2),
      "gpu-size.test.lua",
    );
    expectAllPassed(result);
  }, 60000);

  it("a wall too big for the config breaks every call", async () => {
    const result = await lua(
      `
ccunit.test("too big", function()
  local gpu = peripheral.wrap("gpu")
  gpu.refreshSize()
  ccunit.eq(err(gpu.getSize), "Attached screen too big")
  ccunit.eq(err(gpu.refreshSize), "Attached screen too big")
  ccunit.eq(err(gpu.listMethods), "Attached screen too big")
end)
`,
      {
        ...gpuWorld(5, 1),
        tomsPeripherals: { maxScreenSize: 4 },
      } as WorldConfig, // an addon's world key
      "gpu-big.test.lua",
    );
    expectAllPassed(result);
  }, 60000);

  it("drawing: argument checks and their messages", async () => {
    const result = await lua(
      `
ccunit.test("rectangles and lines", function()
  local gpu = peripheral.wrap("gpu")
  gpu.refreshSize()
  ccunit.eq(err(gpu.filledRectangle, 1, 1, 2), "Too few arguments (expected x,y,width,height,[color])")
  ccunit.eq(err(gpu.filledRectangle, 0, 1, 2, 2), "Out of boundary")
  ccunit.eq(err(gpu.filledRectangle, 1, 18, 2, 2), "Out of boundary")
  ccunit.eq(gpu.filledRectangle(17, 17, 5, 5, 0xFF), true) -- starts just past the corner: draws nothing
  ccunit.eq(gpu.filledRectangle(1, 1, 99, 99), true)       -- clipped
  ccunit.eq(err(gpu.rectangle, "a", 1, 2, 2), "Bad argument #1: (expected Number)")
  ccunit.eq(err(gpu.fill, nil), "Bad argument #1: (expected Number)")
  ccunit.eq(gpu.fill(1, 2), true) -- neither 3 nor 4 numbers: the first is the colour
  ccunit.eq(gpu.fill(1, 2, 3), true)
  ccunit.eq(err(gpu.fill, 1, 2, "x"), "bad arguments: numbers expected")
  ccunit.eq(err(gpu.line, 1, 1, 1), "Too few arguments (expected x1,y1,x2,y2,[color])")
  ccunit.eq(err(gpu.line, 1, 1, 20, 1), "Index 16 out of bounds for length 16")
  ccunit.eq(err(gpu.lineS, 1, 1, 18, 1), "Out of bounds: x")
  ccunit.eq(err(gpu.lineS, 1, 0, 1, 1), "Out of bounds: y")
  ccunit.eq(gpu.lineS(1, 1, 17, 1), true) -- x 17 is allowed, and the last point is never drawn
  ccunit.eq(err(gpu.lineS, 17, 1, 1, 1), "Index 16 out of bounds for length 16")
end)

ccunit.test("text", function()
  local gpu = peripheral.wrap("gpu")
  gpu.refreshSize()
  ccunit.eq({ gpu.getFont() }, { "ascii", false })
  ccunit.eq(gpu.getTextLength("A"), 6)
  ccunit.eq(gpu.getTextLength("A A"), 6 + 6 + 6)
  ccunit.eq(gpu.getTextLength("i"), 2)
  ccunit.eq(gpu.getTextLength("AA", 2, 0), 20)
  ccunit.eq(gpu.getTextLength(5), gpu.getTextLength("5.0")) -- a number is read with Double.toString
  ccunit.eq(err(gpu.getTextLength), "Invalid Arguments, excepted (string text, [number size], [number padding])")
  ccunit.eq(err(gpu.drawText, 1, 1), "Too few arguments, excepted (number x,number y,String text, [number text_color], [number bg_color], [number size], [number padding])")
  ccunit.eq(err(gpu.drawText, "1", 1, "x"), "Invalid Arguments, excepted (number x,number y,String text, [number text_color], [number bg_color], [number size], [number padding])")
  ccunit.eq(err(gpu.drawText, 13, 1, "AB"), "Out of boundary x 12:24")
  ccunit.eq(err(gpu.drawText, 0, 1, "A"), "Out of boundary x -1:5")
  ccunit.eq(err(gpu.drawText, 1, 10, "A"), "Out of boundary y")
  ccunit.eq(err(gpu.drawText, 1, 1, "A", 0xFFFFFF, -1, 3), "Out of boundary x 0:18") -- the width counts the size
  ccunit.eq(gpu.drawText(1, 5, "A", 0xFFFFFF, -1, 2), true) -- 16 px tall from y 5: drawn until it runs off
  ccunit.eq(gpu.drawTextSmart(1, 1, "A"), true)            -- ascii at twice the size
  ccunit.eq(err(gpu.setFont, "nope"), "Font file not found")
  ccunit.eq(gpu.setFont("nope"), true)                       -- the second time it gets the empty MISSING font
  ccunit.eq({ gpu.getFont() }, { nil, false })
  ccunit.eq(err(gpu.drawText, 1, 1, "A"), 'Java Exception Thrown: java.lang.NullPointerException: Cannot invoke "String.indexOf(int)" because "this.selectedFont.chars2" is null')
  gpu.setFont("ascii")
  ccunit.eq(err(gpu.addNewChar, "a", 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), "Selected font is not modifiable")
  ccunit.eq(err(gpu.clearChars), "Selected font is not modifiable")
  ccunit.eq(gpu.freeChars(), 0)
  ccunit.eq(gpu.getFontDefaultCharID(), 63) -- the index of '?'
  ccunit.eq(err(gpu.drawChar, 1, 1, 300), "Java Exception Thrown: java.lang.ArrayIndexOutOfBoundsException: Index 299 out of bounds for length 256")
end)

ccunit.test("a custom font", function()
  local gpu = peripheral.wrap("gpu")
  gpu.refreshSize()
  gpu.setFont("unicode_page_e0")
  ccunit.eq({ gpu.getFont() }, { "unicode_page_e0", true })
  ccunit.eq(gpu.freeChars(), 256)
  local rows = {}
  for i = 1, 16 do rows[i] = 0xFF end
  ccunit.eq(gpu.addNewChar("x", 8, table.unpack(rows)), 1)
  ccunit.eq(err(gpu.addNewChar, "x", 8, table.unpack(rows)), "Character already exists in sprite")
  ccunit.eq(err(gpu.addNewChar, "xy", 8, table.unpack(rows)), "Bad Argument #1 a sigle character expected")
  ccunit.eq(err(gpu.addNewChar, "y", 8, 1), "Invalid arguments, expected (string char, number width, 16 x number char_data)")
  ccunit.eq(gpu.freeChars(), 255)
  ccunit.eq(gpu.getTextLength("x"), 9)
  ccunit.eq(gpu.getTextLength("q"), 9) -- not in the font: the default char, slot 0, which is now "x"
  ccunit.eq(err(gpu.setFontDefaultCharID, 0), "Bad Argument #1, (too small number (-1) minimum value is 1 )")
  ccunit.eq(err(gpu.setFontDefaultCharID, 300), "Bad Argument #1, (too big number (299) maximum value is 256 )")
  ccunit.eq(gpu.setFontDefaultCharID(2), true)
  ccunit.eq(gpu.getFontDefaultCharID(), 1)
  ccunit.eq(gpu.delChar("x"), true)
  ccunit.eq(err(gpu.delChar, "x"), "Character not found")
  ccunit.eq(gpu.clearChars(), true)
  ccunit.eq(gpu.freeChars(), 256)
  gpu.setFont("ascii")
end)
`,
      gpuWorld(1, 1),
      "gpu-args.test.lua",
    );
    expectAllPassed(result);
  }, 60000);

  it("images, buffers and windows", async () => {
    const result = await lua(
      `
ccunit.test("images", function()
  local gpu = peripheral.wrap("gpu")
  gpu.refreshSize()
  local img = gpu.newImage(3, 2)
  ccunit.eq({ img.getWidth(), img.getHeight() }, { 3, 2 })
  ccunit.eq(err(gpu.newImage, -1, 2), "Image size out of bounds")
  ccunit.eq(err(gpu.newImage, 1), "Invalid Arguments, excepted (number w,number h)")
  -- setRGB and getRGB add one to x and y (LuaImage: getInt(a, 0) + 1)
  img.setRGB(-1, -1, 0xFF112233)
  ccunit.eq(img.getRGB(-1, -1), -15654349) -- 0xFF112233 as a Java int
  ccunit.eq({ img.getAsBuffer() }, { -15654349, 0, 0, 0, 0, 0 })
  img.setRGB(2, -1, 5) -- x 3 is past the row: it lands on the next one
  ccunit.eq(select(4, img.getAsBuffer()), 5)
  ccunit.eq(err(img.setRGB, 2, 0, 5), "Java Exception: java.lang.ArrayIndexOutOfBoundsException: Index 6 out of bounds for length 6")
  ccunit.eq(img.ref():match("^ref:%x+$") ~= nil, true)
  local fromBuf = gpu.imageFromBuffer(2, 1, 2, 3, 4, 5)
  ccunit.eq({ fromBuf.getWidth(), fromBuf.getHeight() }, { 2, 2 })
  ccunit.eq(err(fromBuf.getAsBuffer), "Java Exception: java.lang.ArrayIndexOutOfBoundsException: Index 4 out of bounds for length 4")
  ccunit.eq(err(gpu.imageFromBuffer, 0, 1), "Java Exception Thrown: java.lang.ArithmeticException: / by zero")
  ccunit.eq(err(gpu.drawImage, 1, 1, "ref:nothing"), "Invalid reference")
  ccunit.eq(gpu.drawImage(-1, 15, img.ref()), true) -- clipped
  local draw = img.gpuDraw()
  ccunit.eq({ draw.getSize() }, { 3, 2 })
  draw.fill(0x80FF0000)
  ccunit.eq(img.getRGB(-1, -1), -2130771968) -- images keep the alpha
  img.free()
  ccunit.eq(err(draw.fill, 1), "Error: Use after free")
  ccunit.eq(err(gpu.drawImage, 1, 1, "x"), "Invalid reference")
end)

ccunit.test("buffers", function()
  local gpu = peripheral.wrap("gpu")
  gpu.refreshSize()
  local before = gpu.getUsedMemory()
  local b = gpu.newBuffer(4)
  ccunit.eq(gpu.getUsedMemory(), before + 4)
  b.write(1, 2, 300, -1)
  ccunit.eq({ b.length(), b.available() }, { 4, 4 })
  ccunit.eq({ b.read(2) }, { 1, 2 })
  ccunit.eq({ b.read(-1) }, { 44, 255 })
  ccunit.eq(err(b.read), "Index out of bounds")
  b.write(9)
  ccunit.eq(gpu.getUsedMemory(), before + 8) -- grew to twice the size
  ccunit.eq(err(b.write, "x"), "Bad argument #1-1: (expected Number)")
  b.free()
  ccunit.eq(err(b.length), "Error: Use after free")
  ccunit.eq(gpu.getUsedMemory(), before)
  ccunit.eq(err(gpu.decodeImage), "Invalid arguments: expected buffer or unpacked numbers")
  ccunit.eq(err(gpu.decodeImage, 1, 2, 3), "Could not load image: Image not of any known type, or corrupt")
  ccunit.eq(err(gpu.decodeImage, b.ref()), "Invalid reference")
end)

ccunit.test("windows", function()
  local gpu = peripheral.wrap("gpu")
  gpu.refreshSize()
  ccunit.eq(err(gpu.createWindow, 1, 1, 0, 4), "Out of boundary")
  ccunit.eq(err(gpu.createWindow, 1, 1, 4), "Too few arguments (expected x,y,width,height)")
  local win = gpu.createWindow(3, 4, 5, 6)
  ccunit.eq({ win.getSize() }, { 5, 6 })
  local r = win.getBounds()
  ccunit.eq({ r.getX(), r.getY(), r.getW(), r.getH() }, { 2, 3, 5, 6 })
  ccunit.eq(win.fill(0xFF), true)
  ccunit.eq(win.filledRectangle(1, 1, 50, 50, 0xFF), true)
  ccunit.eq(win.line(1, 1, 30, 30), true) -- a window drops what falls outside it
  r.setW(0)
  ccunit.eq(err(win.sync), "Invalid window size")
  ccunit.eq(err(r.setW, -1), "Width value is less than 0")
  r.setW(5)
  ccunit.eq(win.sync(), nil)
  ccunit.eq(win.decodeImage, nil) -- a window is a BaseGPU: no images
  ccunit.eq(win.setSize, nil)
  local sub = win.createWindow(1, 1, 2, 2)
  ccunit.eq({ sub.getSize() }, { 2, 2 })
end)

ccunit.test("3D: states and messages, a textured render", function()
  local gpu = peripheral.wrap("gpu")
  gpu.refreshSize()
  local gl = gpu.createWindow3D(1, 1, 16, 16)
  ccunit.eq(err(gl.glVertex, 1, 2, 3), "not building")
  ccunit.eq(err(gl.glVertex, 1, 2), "Too few arguments, expected: number x, number y, number z")
  ccunit.eq(err(gl.glEnd), "not building")
  ccunit.eq(err(gl.glBegin, 1), "Unknown build mode: 1")
  gl.glBegin()
  ccunit.eq(err(gl.glBegin), "Already building")
  gl.glVertex(0, 0, 1)
  ccunit.eq(err(gl.glEnd), "Incomplete triangle")
  ccunit.eq(err(gl.glBegin), "Already building") -- the failed glEnd left it building
  gl.glVertex(0, 1, 1) gl.glVertex(1, 1, 1)
  gl.glEnd()
  ccunit.eq(err(gl.glPopMatrix), "Java Exception: java.util.EmptyStackException")
  ccunit.eq(err(gl.glEnable, 1), "Bad argument #1: unknown GL state1")
  ccunit.eq(err(gl.glTexImage, 2, 1, 2), "No bound texture")
  ccunit.eq(err(gl.glRotate, 1, 2, 3), "Too few arguments, expected: number angle, number x, number y, number z")
  local id = gl.glGenTextures(2)
  ccunit.eq({ id, gl.glGenTextures() }, { 1, 3 })
  gl.glBindTexture(id)
  local tex = gpu.newImage(2, 2)
  tex.gpuDraw().fill(0xFF00FF00)
  gl.glTexImage(tex.ref())
  gl.glEnable(3553)
  gl.clear()
  gl.glFrustum(90, 0.1, 100)
  gl.glDirLight(0, 0, -1)
  gl.glPushMatrix()
  gl.glTranslate(0, 0, 1)
  gl.glBegin()
  gl.glVertex(-1, -1, 1) gl.glTexCoord(0, 0)
  gl.glVertex(-1, 1, 1) gl.glTexCoord(0, 1)
  gl.glVertex(1, 1, 1) gl.glTexCoord(1, 1)
  gl.glEnd()
  gl.glPopMatrix()
  ccunit.eq(gl.render(), nil)
  gl.glDeleteTextures(id)
  ccunit.eq(err(gl.glDeleteTextures), "Too few arguments: number texture ids...")
  ccunit.eq({ gl.getBounds().getW() }, { 16 })
end)
`,
      gpuWorld(1, 1),
      "gpu-objects.test.lua",
    );
    expectAllPassed(result);
  }, 60000);
});

// ───────────── pixels: a known drawing, compared pixel by pixel ─────────────

/** Run a program, keep its runtime, hand back its pixel screens (the PPMs the GPU writes) and what `inspect` reads. */
async function drawProgram<T = undefined>(
  source: string,
  world: WorldConfig,
  name: string,
  screenshots = false,
  inspect?: (resultsDir: string) => T,
) {
  put(name, source);
  const result = await runProgram(config, {
    program: name,
    world,
    timeoutMs: 60000,
    keepRuntime: true,
    screenshots,
  });
  try {
    const resultsDir = join(result.runtimeDir!, "results");
    return {
      result,
      screens: pixelScreens(resultsDir),
      extra: inspect?.(resultsDir),
    };
  } finally {
    rmSync(result.runtimeDir!, { recursive: true, force: true });
  }
}

class Canvas {
  readonly px: number[];
  constructor(
    readonly w: number,
    readonly h: number,
    fill = 0,
  ) {
    this.px = new Array<number>(w * h).fill(fill);
  }
  set(x: number, y: number, c: number): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h)
      throw new Error(`off canvas ${x},${y}`);
    this.px[y * this.w + x] = c & 0xffffff;
  }
  /** BaseGPU.line: Bresenham, both ends drawn */
  line(x0: number, y0: number, x1: number, y1: number, c: number): void {
    const dx = Math.abs(x1 - x0);
    const sx = x0 < x1 ? 1 : -1;
    const dy = -Math.abs(y1 - y0);
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.set(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }
}

function rgbOf(screen: {
  width: number;
  height: number;
  rgba: Uint8Array;
}): number[] {
  const out: number[] = [];
  for (let i = 0; i < screen.width * screen.height; i++) {
    out.push(
      (screen.rgba[i * 4]! << 16) |
        (screen.rgba[i * 4 + 1]! << 8) |
        screen.rgba[i * 4 + 2]!,
    );
  }
  return out;
}

const TRIANGLE = `
local gpu = peripheral.wrap("gpu")
gpu.refreshSize()
gpu.setSize(32)
local gl = gpu.createWindow3D(1, 1, 32, 32)
assert(select("#", gl.getConstants()) == 0, "GLConstants has no runtime-visible @Const: nothing")
gl.glFrustum(90, 0.1, 100)
gl.glDirLight(0, 0, -1)
gl.glColor(255, 0, 0)
gl.glBegin()
gl.glVertex(-1, -1, 2); gl.glVertex(-1, 1, 2); gl.glVertex(1, 1, 2)
`;

describe.skipIf(!ready)("tm_gpu pixels", () => {
  it("fill, rectangles, lines, text, buffers and images land on the exact pixels", async () => {
    const { result, screens } = await drawProgram(
      `
local gpu = peripheral.wrap("gpu")
gpu.refreshSize()
gpu.fill(0x102030)
gpu.filledRectangle(2, 3, 4, 2, 0xFF0000)
gpu.rectangle(9, 1, 5, 4, 0x00FF00)
gpu.line(1, 16, 16, 9, 0x0000FF)
gpu.lineS(1, 1, 4, 4, 0xFFFF00)
gpu.drawText(2, 7, "A", 0xFFFFFF, 0x000000)
gpu.drawBuffer(14, 13, 2, 1, 0xFF00FF, 0x00FFFF, 0xFFFFFF, 0x808080)
local img = gpu.newImage(2, 2)
img.setRGB(-1, -1, 0xFFABCDEF) -- (0, 0): setRGB adds one
img.setRGB(0, -1, 0x123456)
img.setRGB(-1, 0, 0x654321)
gpu.drawImage(15, 15, img.ref())
gpu.sync()
gpu.fill(0xFFFFFF) -- after the sync: not on the monitor
`,
      gpuWorld(1, 1),
      "draw.lua",
    );
    expect(result.status).toBe("completed");
    expect(screens.map((s) => [s.peripheral, s.width, s.height])).toEqual([
      ["gpu", 16, 16],
    ]);
    const c = new Canvas(16, 16, 0x102030);
    for (let x = 1; x <= 4; x++)
      for (let y = 2; y <= 3; y++) c.set(x, y, 0xff0000);
    for (let x = 8; x <= 12; x++)
      for (let y = 0; y <= 3; y++)
        if (x === 8 || x === 12 || y === 0 || y === 3) c.set(x, y, 0x00ff00);
    c.line(0, 15, 15, 8, 0x0000ff);
    // lineS stops one short of the end
    for (const [x, y] of [
      [0, 0],
      [0, 1],
      [1, 1],
      [1, 2],
      [2, 2],
      [2, 3],
    ] as const)
      c.set(x, y, 0xffff00);
    const A = [14, 17, 31, 17, 17, 17, 17, 0]; // ascii.bin glyph 'A', width 5, then 1 column of padding
    for (let j = 0; j < 8; j++)
      for (let k = 0; k < 6; k++)
        c.set(1 + k, 6 + j, k < 5 && A[j]! & (1 << k) ? 0xffffff : 0);
    c.set(13, 12, 0xff00ff);
    c.set(14, 12, 0x00ffff);
    c.set(13, 13, 0xffffff);
    c.set(14, 13, 0x808080);
    c.set(14, 14, 0xabcdef);
    c.set(15, 14, 0x123456);
    c.set(14, 15, 0x654321);
    c.set(15, 15, 0);
    expect(rgbOf(screens[0]!)).toEqual(c.px);
  }, 60000);

  it("a wall of monitors is one picture; setSize, windows and text sizes", async () => {
    const { result, screens } = await drawProgram(
      `
local gpu = peripheral.wrap("gpu")
gpu.refreshSize()
gpu.setSize(20)
local w, h = gpu.getSize()
assert(w == 40 and h == 40, w .. "x" .. h)
gpu.fill(0)
gpu.filledRectangle(19, 19, 4, 4, 0x00FF00) -- across all four blocks
local win = gpu.createWindow(31, 1, 10, 5)
win.fill(0xFF0000)
win.filledRectangle(1, 1, 2, 2, 0x0000FF)
win.sync()
gpu.drawText(1, 30, "i", 0xFFFFFF, -1, 2) -- 'i' at twice the size, no background
gpu.sync()
`,
      gpuWorld(2, 2),
      "wall.lua",
    );
    expect(result.status).toBe("completed");
    expect(screens.map((s) => [s.width, s.height])).toEqual([[40, 40]]);
    const c = new Canvas(40, 40, 0);
    for (let x = 18; x < 22; x++)
      for (let y = 18; y < 22; y++) c.set(x, y, 0x00ff00);
    for (let x = 30; x < 40; x++)
      for (let y = 0; y < 5; y++) c.set(x, y, 0xff0000);
    for (let x = 30; x < 32; x++)
      for (let y = 0; y < 2; y++) c.set(x, y, 0x0000ff);
    // 'i' (width 1) at size 2 from y 29: the 16 px glyph runs off the bottom at y 40, and drawText stops there
    // (the IndexOutOfBoundsException is caught) after drawing (0, 39) of the 2x2 block it was in
    const I = [1, 0, 1, 1, 1, 1, 1, 0];
    try {
      for (let j = 0; j < 8; j++)
        if (I[j])
          for (let a = 0; a < 2; a++)
            for (let b = 0; b < 2; b++) c.set(a, 29 + j * 2 + b, 0xffffff);
    } catch {
      // off the canvas: where the GPU stops too
    }
    expect(rgbOf(screens[0]!)).toEqual(c.px);
  }, 60000);

  it("screenshots include the GPU's monitors as a PNG", async () => {
    const { result } = await drawProgram(
      `
local gpu = peripheral.wrap("gpu")
gpu.refreshSize()
gpu.fill(0x336699)
gpu.sync()
`,
      gpuWorld(1, 1),
      "shot.lua",
      true,
    );
    const shot = result.screens.find((s) => s.pixels);
    expect(shot).toMatchObject({
      peripheral: "gpu",
      width: 16,
      height: 16,
      lines: [],
    });
    expect(Buffer.from(shot!.png!, "base64").subarray(1, 4).toString()).toBe(
      "PNG",
    );
    expect(shot!.pixels!.hash).toMatch(/^[0-9a-f]{16}$/);
  }, 60000);

  it("no picture until the first sync", async () => {
    const { screens } = await drawProgram(
      `
local gpu = peripheral.wrap("gpu")
gpu.refreshSize()
gpu.fill(0xFFFFFF)
`,
      gpuWorld(1, 1),
      "nosync.lua",
    );
    expect(screens).toEqual([]);
  }, 60000);

  it("3D: a lit triangle draws inside its bounds, a back face draws nothing, renders repeat", async () => {
    const one = await drawProgram(
      `${TRIANGLE}gl.glEnd()\ngl.render()\ngl.sync()\ngpu.sync()\n`,
      gpuWorld(1, 1),
      "tri.lua",
    );
    expect(one.result.status).toBe("completed");
    const px = rgbOf(one.screens[0]!);
    // tan(45 degrees) is 0.9999999999999999 in doubles, so -1 projects to 7.999999999999998 and (int) makes it 7:
    // the corners land on (7,7) (7,24) (24,24). Triangle.textureTriangle fills rows 7..24 from x 7 up to the long
    // edge (x = row, exclusive); the flat lower half has no height. Lit straight on: full red.
    const c = new Canvas(32, 32, 0);
    for (let i = 7; i <= 24; i++)
      for (let j = 7; j < i; j++) c.set(j, i, 0xff0000);
    expect(px).toEqual(c.px);
    // the same triangle again, plus its back face (culled): the same picture
    const two = await drawProgram(
      `${TRIANGLE}gl.glVertex(-1, -1, 2); gl.glVertex(1, 1, 2); gl.glVertex(-1, 1, 2)\ngl.glEnd()\ngl.render()\ngl.sync()\ngpu.sync()\n`,
      gpuWorld(1, 1),
      "tri2.lua",
    );
    expect(rgbOf(two.screens[0]!)).toEqual(px);
  }, 60000);
});

// ───────────── PNG against LWJGL 3.2.2's stb ─────────────

const stb = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./toms-peripherals-stb.json", import.meta.url)),
    "utf8",
  ),
) as {
  encode: {
    A: { hex: string };
    B: { sha1: string; length: number };
    C: { sha1: string; length: number };
  };
  decode: Record<
    string,
    {
      png: string;
      width?: number;
      height?: number;
      argb?: number[];
      error?: string;
    }
  >;
};

describe.skipIf(!ready)("tm_gpu PNG (decodeImage, saveImage)", () => {
  it("decodes every PNG kind as stb does, with stb's errors", async () => {
    const cases = Object.entries(stb.decode)
      .map(([label, d]) => {
        const bytes = [...Buffer.from(d.png, "base64")].join(",");
        const check = d.error
          ? `ccunit.eq(err(gpu.decodeImage, table.unpack(bytes)), "Could not load image: ${d.error}")`
          : `local img = gpu.decodeImage(table.unpack(bytes))
  ccunit.eq({ img.getWidth(), img.getHeight() }, { ${d.width}, ${d.height} })
  ccunit.eq({ img.getAsBuffer() }, { ${d.argb!.join(",")} })`;
        return `ccunit.test("${label}", function()
  local gpu = peripheral.wrap("gpu")
  local bytes = { ${bytes} }
  ${check}
end)`;
      })
      .join("\n");
    const result = await lua(cases, gpuWorld(1, 1), "png-decode.test.lua");
    expectAllPassed(result);
  }, 60000);

  it("saveImage writes stb_image_write's bytes; they decode back", async () => {
    const { result, extra } = await drawProgram(
      `
local gpu = peripheral.wrap("gpu")
local seed = 7
local function lcg() seed = (seed * 75 + 74) % 65537 return seed end
local function i32(n) n = n % 4294967296 if n >= 2147483648 then n = n - 4294967296 end return n end
local function save(name, w, h, color)
  local img = gpu.newImage(w, h)
  for y = 0, h - 1 do for x = 0, w - 1 do img.setRGB(x - 1, y - 1, color(x, y)) end end
  local buf = img.saveImage()
  local bytes = { buf.read(-1) }
  local f = fs.open("/results/" .. name, "wb")
  for i = 1, #bytes, 2000 do f.write(string.char(table.unpack(bytes, i, math.min(i + 1999, #bytes)))) end
  f.close()
  return img
end
save("A.png", 4, 3, function(x, y) return i32((255 - x * 40) * 16777216 + x * 60 * 65536 + y * 80 * 256 + x * y * 20) end)
save("B.png", 24, 16, function(x, y) return i32(0xFF000000 + ((math.floor(x / 4) % 2 == 0) and 0xFF0000 or 0x00FF00) + y * 16) end)
seed = 7
local img = save("C.png", 40, 30, function()
  local a = lcg() % 256 local b = lcg() % 65536 local c = lcg() % 256
  return i32(a * 16777216 + b * 256 + c)
end)
local back = gpu.decodeImage(img.saveImage().ref())
local a, b = { img.getAsBuffer() }, { back.getAsBuffer() }
assert(#a == #b and #a == 1200)
for i = 1, #a do assert(a[i] == b[i], "pixel " .. i) end
`,
      gpuWorld(1, 1),
      "save.lua",
      false,
      (dir) => ({
        A: existsSync(join(dir, "A.png"))
          ? readFileSync(join(dir, "A.png")).toString("hex")
          : "",
        B: existsSync(join(dir, "B.png"))
          ? readFileSync(join(dir, "B.png"))
          : Buffer.alloc(0),
        C: existsSync(join(dir, "C.png"))
          ? readFileSync(join(dir, "C.png"))
          : Buffer.alloc(0),
      }),
    );
    expect(result.status).toBe("completed");
    const sha1 = (b: Buffer): string =>
      createHash("sha1").update(b).digest("hex");
    expect(extra!.A).toBe(stb.encode.A.hex);
    expect([extra!.B.length, sha1(extra!.B)]).toEqual([
      stb.encode.B.length,
      stb.encode.B.sha1,
    ]);
    expect([extra!.C.length, sha1(extra!.C)]).toEqual([
      stb.encode.C.length,
      stb.encode.C.sha1,
    ]);
  }, 60000);
});

// ───────────── keyboard, redstone port, watchdog: methods ─────────────

describe.skipIf(!ready)("tm_keyboard, tm_rsPort, tm_wdt methods", () => {
  it("arguments, messages and values", async () => {
    const result = await lua(
      `
ccunit.test("keyboard", function()
  local kb = peripheral.wrap("kb")
  ccunit.eq(err(kb.setFireNativeEvents), "Bad argument #1: (expected Boolean)")
  ccunit.eq(err(kb.setFireNativeEvents, 1), "Bad argument #1: (expected Boolean)")
  ccunit.eq(kb.setFireNativeEvents(true), nil)
end)

ccunit.test("redstone port", function()
  local rs = peripheral.wrap("rs")
  ccunit.eq({ rs.getSides() }, { "down", "up", "north", "south", "west", "east" })
  ccunit.eq(rs.getAnalogInput("north"), 9)
  ccunit.eq(rs.getAnalogueInput("NORTH"), 9)
  ccunit.eq(rs.getInput("north"), true)
  ccunit.eq(rs.getInput("up"), false)
  ccunit.eq(rs.getBundledInput("west"), 5)
  ccunit.eq(rs.testBundledInput("west", 4), true)
  ccunit.eq(rs.testBundledInput("west", 6), false)
  ccunit.eq(err(rs.getInput), "Too few arguments (expected direction)")
  ccunit.eq(err(rs.getInput, "left"), "Bad argument #1: expected one of: up, down, north, south, east, west")
  ccunit.eq(err(rs.setOutput, "up"), "Too few arguments (expected direction, value)")
  ccunit.eq(err(rs.setOutput, "left", 1), "Bad argument #2 (expected Boolean)") -- the value is checked first
  ccunit.eq(err(rs.setAnalogOutput, "up", 16), "Bad argument #2: Expected number in range 0-15")
  ccunit.eq(err(rs.setAnalogOutput, "up", true), "Bad argument #2 (expected Number)")
  ccunit.eq(err(rs.testBundledInput, "up"), "Too few arguments (expected direction, mask)")
  rs.setOutput("up", true)
  ccunit.eq({ rs.getOutput("up"), rs.getAnalogOutput("up") }, { true, 15 })
  rs.setAnalogueOutput("south", 4.7)
  ccunit.eq(rs.getAnalogueOutput("south"), 4)
  rs.setBundledOutput("east", 12)
  ccunit.eq(rs.getBundledOutput("east"), 12)
end)

ccunit.test("watchdog", function()
  local wdt = peripheral.wrap("wdt")
  ccunit.eq({ wdt.isEnabled(), wdt.getTimeout() }, { false, 0 })
  ccunit.eq(err(wdt.setEnabled), "Too few arguments (expected enable)")
  ccunit.eq(err(wdt.setEnabled, "yes"), "Bad argument #1: (expected Boolean)")
  ccunit.eq(err(wdt.setTimeout), "Too few arguments (expected enable)")
  ccunit.eq(err(wdt.setTimeout, 19), "Bad argument #1 (expected value must be larger than 20 ticks)")
  wdt.setTimeout(400)
  ccunit.eq(wdt.getTimeout(), 400)
  wdt.setEnabled(true)
  ccunit.eq(wdt.isEnabled(), true)
  ccunit.eq(err(wdt.setTimeout, 100), "Can't edit timeout value while the timer is enabled")
  wdt.reset()
  wdt.setEnabled(false)
end)
`,
      {
        peripherals: [
          { name: "kb", type: "tm_keyboard" },
          {
            name: "rs",
            type: "tm_rsPort",
            inputs: { north: 9 },
            bundledInputs: { west: 5 },
          },
          { name: "wdt", type: "tm_wdt" },
        ],
      },
      "others.test.lua",
    );
    expectAllPassed(result);
  }, 60000);

  it("return counts are Java's: none for void, one for a getter, the array's length for Object[]", async () => {
    const result = await lua(
      `
local function n(...) return select("#", ...) end
ccunit.test("void methods return no value, getters exactly one", function()
  local kb, rs, wdt, gpu = peripheral.wrap("kb"), peripheral.wrap("rs"), peripheral.wrap("wdt"), peripheral.wrap("gpu")
  ccunit.eq(n(kb.setFireNativeEvents(true)), 0)
  ccunit.eq(n(rs.setOutput("up", true)), 0)
  ccunit.eq(n(rs.setAnalogOutput("up", 3)), 0)
  ccunit.eq(n(rs.getInput("up")), 1)
  ccunit.eq(n(rs.getBundledInput("up")), 1)
  ccunit.eq(n(rs.getSides()), 6)
  ccunit.eq(n(wdt.setTimeout(400)), 0)
  ccunit.eq(n(wdt.reset()), 0)
  ccunit.eq(n(wdt.isEnabled()), 1)
  ccunit.eq(n(wdt.getTimeout()), 1)
  ccunit.eq(n(gpu.setSize(16)), 0)
  ccunit.eq(n(gpu.refreshSize()), 0)
  ccunit.eq(n(gpu.sync()), 0)
  ccunit.eq(n(gpu.fill(0xFF000000)), 1)
  ccunit.eq(n(gpu.getUsedMemory()), 1)
  ccunit.eq(n(gpu.getSize()), 5) -- width, height, maxX, maxY, size
  ccunit.eq(n(gpu.getFont()), 2)
  local b = gpu.newBuffer(4)
  ccunit.eq(n(b.write(1, 2)), 0)
  ccunit.eq(n(b.length()), 1)
  ccunit.eq(n(b.read(2)), 2)
  ccunit.eq(n(b.read(0)), 0)
  ccunit.eq(n(b.ref()), 1)
  ccunit.eq(n(b.free()), 0)
  local img = gpu.newImage(2, 2)
  ccunit.eq(n(img.setRGB(0, 0, 5)), 0)
  ccunit.eq(n(img.getRGB(0, 0)), 1)
  ccunit.eq(n(img.getAsBuffer()), 4)
  ccunit.eq(n(img.gpuDraw()), 1)
  ccunit.eq(n(img.free()), 0)
  local r = gpu.getBounds()
  ccunit.eq(n(r.getX()), 1)
end)
`,
      {
        peripherals: [
          { name: "kb", type: "tm_keyboard" },
          { name: "rs", type: "tm_rsPort" },
          { name: "wdt", type: "tm_wdt" },
          { name: "gpu", type: "tm_gpu", monitor: { width: 1, height: 1 } },
        ],
      },
      "returns.test.lua",
    );
    expectAllPassed(result);
  }, 60000);
});

// ───────────── events and the clock: a session with an agent ─────────────

const AGENT = `
local boots = 1
if fs.exists("/results/boots") then local h = fs.open("/results/boots", "r") boots = tonumber(h.readAll()) + 1 h.close() end
local h = fs.open("/results/boots", "w") h.write(tostring(boots)) h.close()
local log = {}
local function flush()
  local f = fs.open("/results/tm_log.tmp", "w") f.write(textutils.serialiseJSON(log)) f.close()
  if fs.exists("/results/tm_log.json") then fs.delete("/results/tm_log.json") end
  fs.move("/results/tm_log.tmp", "/results/tm_log.json")
end
flush()
while true do
  local ev = table.pack(os.pullEventRaw())
  if ev[1] == "test_exec" then
    local chunk, e = load(ev[3], "=remote", "t", _G)
    local results = chunk and table.pack(pcall(chunk)) or { false, e, n = 2 }
    local reply = {}
    for i = 1, results.n do reply[i] = results[i] == nil and textutils.json_null or results[i] end
    local out = fs.open("/results/rc_" .. ev[2] .. ".tmp", "w")
    out.write(textutils.serialiseJSON(reply))
    out.close()
    fs.move("/results/rc_" .. ev[2] .. ".tmp", "/results/rc_" .. ev[2] .. ".dat")
  elseif ev[1] ~= "timer" and ev[1] ~= "task_complete" then
    local e = {}
    for i = 1, ev.n do e[i] = ev[i] == nil and textutils.json_null or ev[i] end
    log[#log + 1] = e
    flush()
  end
end
`;
writeFileSync(join(agentWs, "startup.lua"), AGENT);

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

interface Agent {
  exec(code: string): Promise<unknown[]>;
  /** The addon's commands are not in SimCommand's union: the sim takes any { cmd } its handlers know. */
  cmd(c: { cmd: string; [key: string]: unknown }): Promise<void>;
  events(): unknown[][];
  state(): SimState;
  boots(): number;
  waitFor(test: () => boolean, what: string): Promise<void>;
}

async function withAgent(
  world: WorldConfig,
  run: (a: Agent) => Promise<void>,
): Promise<void> {
  const manager = new SessionManager({ ...config, workspaceDir: agentWs });
  const s = manager.create([], 1, world);
  const dir = s.handle.resultsDir;
  const read = (name: string): string | undefined => {
    try {
      return readFileSync(join(dir, name), "utf8");
    } catch {
      return undefined;
    }
  };
  const waitFor = async (test: () => boolean, what: string): Promise<void> => {
    const end = Date.now() + 15000;
    while (!test()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(10);
    }
  };
  let request = 0;
  const agent: Agent = {
    async exec(code) {
      const id = ++request;
      s.handle.session.event("test_exec", id, code);
      await waitFor(
        () => existsSync(join(dir, `rc_${id}.dat`)),
        `answer ${id}`,
      );
      const [ok, ...results] = JSON.parse(read(`rc_${id}.dat`)!) as [
        boolean,
        ...unknown[],
      ];
      if (!ok) throw new Error(String(results[0]));
      return results;
    },
    async cmd(c) {
      expect(await sendAndWait(s.handle, c as unknown as SimCommand)).toBe(
        true,
      );
      await sleep(30);
    },
    events: () => {
      const text = read("tm_log.json");
      return text ? (JSON.parse(text) as unknown[][]) : [];
    },
    state: () => s.handle.readState()!,
    boots: () => Number(read("boots") ?? 0),
    waitFor,
  };
  try {
    await waitFor(() => existsSync(join(dir, "tm_log.json")), "the agent");
    await run(agent);
  } finally {
    await manager.destroyAll();
  }
}

/** Events as the program saw them, without trailing nils (JSON nulls). */
function trimmed(events: unknown[][]): unknown[][] {
  return events.map((e) => {
    const out = [...e];
    while (out.length > 0 && out[out.length - 1] === null) out.pop();
    return out;
  });
}

describe.skipIf(!ready)("monitor touches and pointer events", () => {
  it("tm_monitor_touch: nothing before the monitors know the GPU, block corners before a sync, pixels after", async () => {
    await withAgent(gpuWorld(2, 1), async (a) => {
      await a.cmd({ cmd: "tmTouch", x: 5, y: 5 });
      await a.exec(`peripheral.call("gpu", "refreshSize")`);
      await a.cmd({ cmd: "tmTouch", x: 5, y: 5 });
      await a.cmd({ cmd: "tmTouch", x: 21, y: 5 });
      await a.exec(`peripheral.call("gpu", "sync")`);
      await a.cmd({ cmd: "tmTouch", x: 20, y: 7, sneak: true });
      await a.exec(`peripheral.call("gpu", "setSize", 32)`);
      // the monitors still have width 16 from the last sync: pixel 40 of 64 is block 1, half way -> 8 of 16
      await a.cmd({ cmd: "tmTouch", x: 49, y: 2 });
      await a.cmd({
        cmd: "tmMonitorEvent",
        event: "mouse_click",
        x: 3,
        y: 4,
        param: 1,
      });
      await a.cmd({ cmd: "tmMonitorEvent", event: "mouse_move", x: 3, y: 4 });
      await a.waitFor(() => a.events().length >= 6, "six events");
      expect(trimmed(a.events())).toEqual([
        ["tm_monitor_touch", "gpu", 1, 1, false],
        ["tm_monitor_touch", "gpu", 17, 1, false],
        ["tm_monitor_touch", "gpu", 20, 7, true],
        ["tm_monitor_touch", "gpu", 32 + 8 + 1, 1, false],
        ["tm_monitor_mouse_click", "gpu", 2, 2, 1],
        ["tm_monitor_mouse_move", "gpu", 2, 2],
      ]);
      const gpu = a.state().peripherals!["gpu"] as Record<string, unknown>;
      expect(gpu).toMatchObject({
        width: 64,
        height: 32,
        size: 32,
        display: { width: 32, height: 16, frames: 1 },
      });
    });
  }, 60000);

  it("a rebuilt wall needs refreshSize; a reload starts over", async () => {
    await withAgent(gpuWorld(1, 1), async (a) => {
      await a.exec(`peripheral.call("gpu", "refreshSize")`);
      await a.cmd({ cmd: "tmSetMonitors", width: 3, height: 2 });
      expect(await a.exec(`return peripheral.call("gpu", "getSize")`)).toEqual([
        16, 16, 1, 1, 16,
      ]);
      await a.exec(`peripheral.call("gpu", "refreshSize")`);
      expect(await a.exec(`return peripheral.call("gpu", "getSize")`)).toEqual([
        48, 32, 3, 2, 16,
      ]);
      await a.cmd({ cmd: "tmReloadGpu" });
      expect(await a.exec(`return peripheral.call("gpu", "getSize")`)).toEqual([
        0, 0, 0, 0, 16,
      ]);
    });
  }, 60000);
});

describe.skipIf(!ready)("keyboard events", () => {
  it("tm_keyboard_* with the name, native events once asked, the dongle's portable events", async () => {
    await withAgent(
      {
        peripherals: [
          { name: "kb", type: "tm_keyboard" },
          { name: "dongle", type: "tm_keyboard", dongle: true },
        ],
      },
      async (a) => {
        await a.cmd({ cmd: "tmChar", peripheral: "kb", char: "a" });
        await a.cmd({ cmd: "tmKey", peripheral: "kb", key: "enter" });
        await a.cmd({ cmd: "tmPortable", peripheral: "kb", connected: true }); // not a dongle: nothing
        await a.cmd({
          cmd: "tmPortable",
          peripheral: "dongle",
          connected: true,
        });
        await a.cmd({
          cmd: "tmPortable",
          peripheral: "dongle",
          connected: false,
          id: 42,
        });
        await a.exec(`peripheral.call("kb", "setFireNativeEvents", true)`);
        await a.cmd({ cmd: "tmKey", peripheral: "kb", key: 65, repeat: true });
        await a.cmd({ cmd: "tmKeyUp", peripheral: "kb", key: 65 });
        await a.cmd({ cmd: "tmPaste", peripheral: "kb", text: "hello" });
        await a.cmd({ cmd: "tmType", peripheral: "kb", text: "hi" });
        await a.cmd({
          cmd: "tmKeyboardEvent",
          peripheral: "kb",
          event: "terminate",
        });
        await a.waitFor(() => a.events().length >= 10, "ten events");
        expect(trimmed(a.events())).toEqual([
          ["tm_keyboard_char", "kb", "a"],
          ["tm_keyboard_key", "kb", 257, false],
          ["tm_keyboard_portable_connect", "dongle", 0],
          ["tm_keyboard_portable_disconnect", "dongle", 42],
          ["key", 65, true],
          ["key_up", 65],
          ["paste", "hello"],
          ["char", "h"],
          ["char", "i"],
          ["terminate"],
        ]);
      },
    );
  }, 60000);
});

describe.skipIf(!ready)("redstone port and watchdog on the clock", () => {
  it("outputs reach the world on the next tick; an input change queues tm_redstone", async () => {
    await withAgent(
      { peripherals: [{ name: "rs", type: "tm_rsPort" }] },
      async (a) => {
        await a.exec(`peripheral.call("rs", "setOutput", "north", true)`);
        await a.cmd({ cmd: "advance", seconds: 0.1 });
        const rs = a.state().peripherals!["rs"] as {
          outputs: Record<string, number>;
        };
        expect(rs.outputs.north).toBe(15);
        await a.cmd({
          cmd: "tmSetRedstoneInput",
          peripheral: "rs",
          side: "east",
          level: 7,
        });
        await a.cmd({ cmd: "advance", seconds: 0.1 });
        await a.waitFor(() => a.events().length >= 1, "tm_redstone");
        expect(a.events()).toEqual([["tm_redstone", "rs"]]);
        expect(
          await a.exec(
            `return peripheral.call("rs", "getAnalogInput", "east")`,
          ),
        ).toEqual([7]);
      },
    );
  }, 60000);

  it("the watchdog restarts the computer when it runs out, and keeps its settings", async () => {
    await withAgent(
      { peripherals: [{ name: "wdt", type: "tm_wdt" }] },
      async (a) => {
        expect(a.boots()).toBe(1);
        await a.exec(
          `peripheral.call("wdt", "setTimeout", 20) peripheral.call("wdt", "setEnabled", true)`,
        );
        await a.cmd({ cmd: "advance", seconds: 0.5 });
        await a.exec(`peripheral.call("wdt", "reset")`);
        await a.cmd({ cmd: "advance", seconds: 0.7 }); // 1.2 s after enabling, 0.7 after the reset: still alive
        expect(a.boots()).toBe(1);
        await a.cmd({ cmd: "advance", seconds: 0.5 }); // 21 ticks after the reset
        await a.waitFor(() => a.boots() === 2, "the restart");
        await sleep(300); // the agent is back in its loop
        expect(
          await a.exec(
            `return peripheral.call("wdt", "isEnabled"), peripheral.call("wdt", "getTimeout")`,
          ),
        ).toEqual([false, 20]);
        expect(a.state().peripherals!["wdt"]).toMatchObject({
          enabled: false,
          timeout: 20,
          fired: 1,
        });
      },
    );
  }, 60000);
});

// ───────────── the addon switched off, the demo world ─────────────

describe.skipIf(!ready)("addon off", () => {
  it("a world with a Tom's Peripherals block fails cleanly when the addon is off", async () => {
    put("off.lua", "print('never')");
    await expect(
      runProgram(config, {
        program: "off.lua",
        world: { addons: "none", ...gpuWorld(1, 1) },
        timeoutMs: 20000,
      }),
    ).rejects.toThrow(/toms-peripherals/);
  }, 60000);
});

describe.skipIf(!ready)("demo world", () => {
  it("loads, and every peripheral answers", async () => {
    const demo = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(
            "../../../worlds/toms-peripherals-demo.json",
            import.meta.url,
          ),
        ),
        "utf8",
      ),
    ) as WorldConfig;
    const result = await lua(
      `
ccunit.test("demo", function()
  local gpu = peripheral.find("tm_gpu")
  gpu.refreshSize()
  ccunit.eq(select(3, gpu.getSize()), 2)
  ccunit.truthy(peripheral.find("tm_keyboard"))
  ccunit.eq(peripheral.find("tm_rsPort").getAnalogInput("north"), 15)
  ccunit.eq(peripheral.find("tm_wdt").getTimeout(), 200)
end)
`,
      demo,
      "demo.test.lua",
    );
    expectAllPassed(result);
  }, 60000);
});
