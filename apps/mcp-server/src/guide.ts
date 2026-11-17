// What the server tells every client up front (the MCP `instructions` field) and the longer guide behind
// craftos_help / craftos://guide. Distilled from the cc-tweaked-dev skill (scripts/public/.claude/skills), so agents
// without the skill (Copilot, Cursor, plain `npx craftos-mcp serve`) get the same habits. Keep INSTRUCTIONS short:
// clients put it in every conversation.
import { DEFAULT_MC, VERSIONS } from "@craftos-mcp/runner";

const versions = VERSIONS.map((v) => `${v.mc} (CC:Tweaked ${v.cc})`).join(", ");
const defaultCc = VERSIONS.find((v) => v.mc === DEFAULT_MC)?.cc ?? "";

export const INSTRUCTIONS = [
  `craftos-mcp runs ComputerCraft (CC:Tweaked) computers headless, with no Minecraft: Minecraft ${versions}; default ${DEFAULT_MC} (CC:Tweaked ${defaultCc}), world.version picks another.`,
  "Loop: write the program in the workspace (it is copied to the computer's root), craftos_run it, then lock it in with *.test.lua files run by craftos_test (global ccunit: test, eq, neq, near, contains, truthy, raises, skip, and run/screen/touch to drive a program and read its screens).",
  "craftos_run returns the status, the screens' text and, when the program failed, error {message, file, line}. A program that never exits ends as timed_out with its screens captured: that is normal for UIs.",
  "Interactive work: craftos_session_create, then prefer data over pictures: craftos_ui (rectangles, text, what it waits for), craftos_act / craftos_script (input that waits until consumed), craftos_expect (assert). Use craftos_screenshot only to see how something looks.",
  'Peripherals: monitors go in `monitors`; everything else (chests, modems, Advanced Peripherals, Mekanism, Create, turtles and their block world, players) goes in `world`. A world is checked before boot; craftos_help {topic:"world"} has every field. Saved worlds load with worldFile (a name in worlds/ or a workspace *.world.json).',
  'A big workspace (a repo root) is slow to copy onto every computer: give world.deploy [{from:"src"}] to copy only that folder.',
  "timeScale (e.g. 20) makes sleep() and timers run faster; craftos_advance jumps the clock; world.seed pins math.random.",
  "The Lua VM follows the version: 1.18.2 is Lua 5.1 semantics with no goto; 1.20.1 and 1.21.1 are Lua 5.2 with goto. os.shutdown(code) ending a run with that status is an emulator extra, not CC:Tweaked.",
  "craftos_info lists the versions, addons and anything missing; check it first if a tool fails.",
].join("\n");

export const CCUNIT_GUIDE = `ccunit, the global in every *.test.lua file (craftos_test, craftos-mcp test):

ccunit.test(name, fn [, {timeout = seconds}])   one test; with timeout it fails instead of hanging the file
ccunit.skip(name)                                 listed as skipped
ccunit.eq(actual, expected [, message])          deep equality for tables
ccunit.neq(actual, unexpected [, message])
ccunit.near(actual, expected [, within])         numbers, default within 1e-6
ccunit.contains(haystack, needle)                text in a string (plain), a value in a list, or text on a screen line
ccunit.truthy(value [, message])
ccunit.raises(fn [, pattern])

Driving a program from a test:
local r = ccunit.run("door.lua", { args = {"open"}, seconds = 2 })   -- or script = function() ... end
ccunit.contains(r.screen, "Door open")         -- the terminal's lines
ccunit.contains(ccunit.screen("top"), "OPEN")  -- a monitor's lines (attach it with "monitors")
ccunit.run("menu.lua", { script = function()
  sleep(0.2); ccunit.touch("top", 3, 2); sleep(0.2)
end })

Each file runs in its own fresh computer. Results stream as each test ends, so a hanging test is named in the
result and the tests before it are kept.`;

export const GUIDE = `${INSTRUCTIONS}

Cheapest way to check a UI (fewest tokens):
- craftos_labels once per program: name a button by its colour ({DOUBLE:{color:"#f15c5c"}}), save it, load it later.
- craftos_script runs a whole scenario in one call (touch {name}, key, text, expect, sim, advance, seed, settle) and
  returns only the failing step with the nearest matches.
- craftos_expect checks rectangles, text, what the program waits on, or a sim value by path.
- craftos_ui {delta:true} after an action returns only what changed; craftos_trace says what the program was handed
  and printed, plus errors.

Facts that bite:
- Advanced Peripherals and inventory methods wait a server tick and drop events that arrive meanwhile.
- The event queue holds 256 events. The terminal is 51x19; output that scrolls off is not captured.
- Wireless modems reach 64 blocks low down, up to 384 at the top of the world; ender modems reach everything.
- rednet numbers messages with math.random: computers on one network need different seeds.
- Key codes are GLFW (keys.enter = 257). Code that never yields is aborted after 7 s, like CC.
- Chests indexed beyond 27 slots need size: 54.

${CCUNIT_GUIDE}`;
