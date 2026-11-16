"""Pull the block and item data a turtle needs out of the real game jars.

Reads the Minecraft client jar, Forge, and every mod jar in the pack, and writes compact Lua tables, one file per
namespace plus the combined _recipes.lua, _cooking.lua and _tag_members.lua, to rom-overlay/rom/ccsim/turtle/data/
(1.18.2) or rom-overlay/rom/ccsim/turtle/data/<mc>/ (any other Minecraft version), or --out:

  names.lua       id -> English display name (assets/<ns>/lang/en_us.json)
  blocks.lua      every block id, with its state properties and their values (assets/<ns>/blockstates)
  items.lua       every item id (item models, lang keys, loot table outputs, recipe outputs)
  loot.lua        block loot tables (data/<ns>/loot_tables/blocks), kept as JSON-shaped Lua tables
  block_tags.lua  block id -> its tags, fully resolved (nested #tags and "replace" honoured)
  item_tags.lua   item id -> its tags
  recipes.lua     crafting_shaped / crafting_shapeless recipes, for turtle.craft

The pack's CraftTweaker and KubeJS scripts change some recipes at runtime; those changes are not in the jars
(docs/conformance/emulator-vs-real-deviations.md).

Two data sets:

  pack (default)  vanilla + Forge + every jar in <instance>/mods. Mod data is All Rights Reserved: private repo only.
  --vanilla       vanilla + Forge + the CC:Tweaked jar only, safe to publish. Use with --out so it does not
                  overwrite the pack set.

Minecraft versions (--mc, the MC table below):

  1.18.2 (default)  Forge 40.2.21 and CC:Tweaked 1.101.3, from the launcher's libraries and the pack instance. The block
                    report comes from the client jar run on the launcher's libraries.
  1.20.1            Forge 47.4.28 and CC:Tweaked 1.121.0 (forge). Vanilla only (there is no 1.20.1 pack instance), so
                    --vanilla is implied unless --instance is given. The jars are read from --jars; --download fetches
                    them there first: the client and server jars from Mojang's version manifest (sha1 checked), Forge's
                    universal jar from its maven and CC:Tweaked from Modrinth (both hash checked). The block report
                    comes from the server jar's bundler, so no launcher libraries are needed.

Usage:
  python -I tools/turtledata/extract.py                       # pack set into rom-overlay/rom/ccsim/turtle/data
  python -I tools/turtledata/extract.py --vanilla --out .public-data/turtle-data
  python -I tools/turtledata/extract.py --mc 1.20.1 --jars <scratch dir> --download
  python -I tools/turtledata/extract.py --mc 1.20.1 --jars <scratch dir> --out .public-data/turtle-data/1.20.1

Options (each also has an environment variable; the flag wins):
  --mc VERSION        Minecraft version, 1.18.2 or 1.20.1 (TURTLEDATA_MC; default 1.18.2)
  --jars DIR          a folder holding the version's jars under their own names (TURTLEDATA_JARS; looked in before
                      --libraries and the instance); --download fills it
  --download          fetch the jars --jars lacks (1.20.1 only)
  --out DIR           output directory; every *.lua in it is deleted first (default rom-overlay/rom/ccsim/turtle/data,
                      or its <mc>/ folder)
  --instance DIR      the instance's minecraft dir, holding mods/ (TURTLEDATA_INSTANCE)
  --libraries DIR     launcher libraries dir (TURTLEDATA_LIBRARIES; default %APPDATA%\\PrismLauncher\\libraries)
  --client-jar JAR    minecraft-<mc>-client.jar (TURTLEDATA_CLIENT_JAR; default in --jars, then under --libraries)
  --server-jar JAR    minecraft-<mc>-server.jar, 1.20.1 only (TURTLEDATA_SERVER_JAR; default in --jars)
  --forge-jar JAR     forge-<mc>-<forge>-universal.jar, or the -client jar (TURTLEDATA_FORGE_JAR; default in --jars,
                      then under --libraries, universal first)
  --cc-jar JAR        the version's CC:Tweaked jar, --vanilla only (TURTLEDATA_CC_JAR; default in --jars, then
                      <instance>/mods/)

Java on PATH is needed for the vanilla block report (blocks.json). On 1.18.2 it runs on the client jar plus every jar
under --libraries except Forge, LWJGL and the launcher's own; on 1.20.1 on the server jar alone.

Data formats: 1.20.1 keeps 1.18.2's folders (loot_tables, recipes, tags/blocks, tags/items) and JSON shapes; its
recipes add "category" and "show_notification", which are ignored, and its smithing recipes (smithing_transform,
smithing_trim) are not crafting recipes, so they are skipped like 1.18.2's smithing. 1.21 renames the folders to the
singular and gives recipe results components: the MC table's "folders" is where that goes.
"""
import argparse
import hashlib
import json
import os
import re
import sys
import zipfile
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
DEFAULT_OUT = os.path.join(REPO, "rom-overlay", "rom", "ccsim", "turtle", "data")
PRISM = os.path.join(os.environ.get("APPDATA", ""), "PrismLauncher")
DEFAULT_LIBS = os.path.join(PRISM, "libraries")
DEFAULT_INSTANCE = ""  # no default: pass --instance (or --cc-jar with --vanilla)

# Data folder names under data/<ns>/: 1.18.2 to 1.20.6 (1.21 makes them singular)
PLURAL = {"loot": "loot_tables", "recipes": "recipes", "block_tags": "blocks", "item_tags": "items"}

# Per Minecraft version: Forge, the CC:Tweaked jar (packages/runner/src/versions.ts has the same pins), the data
# folder layout, how the block report is made, where the set goes, and whether the owner has a pack for it.
MC = {
    "1.18.2": {
        "forge": "1.18.2-40.2.21",
        "cc_jar": "cc-tweaked-1.18.2-1.101.3.jar",
        "folders": PLURAL,
        "reports": "classpath",
        "out": DEFAULT_OUT,
        "pack": True,
    },
    "1.20.1": {
        "forge": "1.20.1-47.4.28",
        "cc_jar": "cc-tweaked-1.20.1-forge-1.121.0.jar",
        "folders": PLURAL,
        "reports": "server",
        "out": os.path.join(DEFAULT_OUT, "1.20.1"),
        "pack": False,
        # CC:Tweaked's own blocks are not in the vanilla server the map colours are read from: ModRegistry.Blocks
        # (MapColor.STONE 0x707070, GOLD 0xFAEE4D, WOOD 0x8F7748; the command computer and the cable's item have
        # none of their own: NONE, and Block.byItem(wired_modem) is the cable)
        "map_colours": {
            "computercraft:computer_normal": 0x707070, "computercraft:computer_advanced": 0xFAEE4D,
            "computercraft:computer_command": 0,
            "computercraft:turtle_normal": 0x707070, "computercraft:turtle_advanced": 0xFAEE4D,
            "computercraft:speaker": 0x707070, "computercraft:disk_drive": 0x707070, "computercraft:printer": 0x707070,
            "computercraft:monitor_normal": 0x707070, "computercraft:monitor_advanced": 0xFAEE4D,
            "computercraft:wireless_modem_normal": 0x707070, "computercraft:wireless_modem_advanced": 0xFAEE4D,
            "computercraft:wired_modem_full": 0x707070, "computercraft:cable": 0x707070,
            "computercraft:lectern": 0x8F7748, "computercraft:redstone_relay": 0x707070,
        },
        "downloads": {
            "forge": ("https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.4.28/"
                      "forge-1.20.1-47.4.28-universal.jar", "sha1", "1c2208dc1db2a61ddb6d5dcbe8eae4fd44629e9d"),
            "cc": ("https://cdn.modrinth.com/data/gu7yAYhd/versions/Qm9iIIEY/cc-tweaked-1.20.1-forge-1.121.0.jar",
                   "sha512", "6ebe4c1e8e6165cb97f071a5a54acd942c234ae62d36330369fdae4bf720a93e99b84e833385f0f103e8fb"
                   "03425ed20c9f9122411f0008e8ac9efa24b719522d"),
        },
    },
}
MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"
FORGE_VERSION = MC["1.18.2"]["forge"]
CC_JAR = MC["1.18.2"]["cc_jar"]

ID = re.compile(r"^[a-z0-9_.-]+:[a-z0-9_./-]+$")


def fail(message):
    sys.exit("extract.py: " + message)


def parse_args(argv):
    p = argparse.ArgumentParser(description="Regenerate the turtle block/item/tag/recipe/loot data from the game jars.")
    p.add_argument("--mc", default=os.environ.get("TURTLEDATA_MC") or "1.18.2", choices=sorted(MC),
                   help="Minecraft version (env TURTLEDATA_MC; default 1.18.2)")
    p.add_argument("--vanilla", action="store_true",
                   help="only vanilla, Forge and CC:Tweaked (the publishable set); no other mod jars")
    p.add_argument("--out", default=None, help="output directory (default rom-overlay/rom/ccsim/turtle/data[/<mc>])")
    p.add_argument("--jars", default=os.environ.get("TURTLEDATA_JARS"),
                   help="folder holding the version's jars under their own names (env TURTLEDATA_JARS)")
    p.add_argument("--download", action="store_true", help="fetch the jars --jars lacks (1.20.1 only)")
    p.add_argument("--instance", default=os.environ.get("TURTLEDATA_INSTANCE"),
                   help="instance minecraft dir holding mods/ (env TURTLEDATA_INSTANCE)")
    p.add_argument("--libraries", default=os.environ.get("TURTLEDATA_LIBRARIES") or DEFAULT_LIBS,
                   help="launcher libraries dir (env TURTLEDATA_LIBRARIES)")
    p.add_argument("--client-jar", default=os.environ.get("TURTLEDATA_CLIENT_JAR"),
                   help="minecraft client jar (env TURTLEDATA_CLIENT_JAR)")
    p.add_argument("--server-jar", default=os.environ.get("TURTLEDATA_SERVER_JAR"),
                   help="minecraft server jar, 1.20.1 only (env TURTLEDATA_SERVER_JAR)")
    p.add_argument("--forge-jar", default=os.environ.get("TURTLEDATA_FORGE_JAR"),
                   help="Forge universal or client jar (env TURTLEDATA_FORGE_JAR)")
    p.add_argument("--cc-jar", default=os.environ.get("TURTLEDATA_CC_JAR"),
                   help="CC:Tweaked jar for --vanilla (env TURTLEDATA_CC_JAR)")
    args = p.parse_args(argv)
    info = MC[args.mc]
    args.info = info
    forge_version, cc_name = info["forge"], info["cc_jar"]
    if args.out is None:
        args.out = info["out"]
    if not info["pack"] and not args.instance and not args.vanilla:
        print("no " + args.mc + " pack instance: making the vanilla set (--vanilla)")
        args.vanilla = True
    if not args.instance:
        args.instance = DEFAULT_INSTANCE
    if args.download:
        if not args.jars:
            fail("--download needs --jars (the folder to download into)")
        download(args.mc, args.jars)

    def in_jars(name):
        path = os.path.join(args.jars, name) if args.jars else None
        return path if path and os.path.isfile(path) else None

    client_name = "minecraft-" + args.mc + "-client.jar"
    if not args.client_jar:
        args.client_jar = in_jars(client_name)
    if info["reports"] == "classpath" or not args.client_jar:
        if not os.path.isdir(args.libraries):
            fail("libraries dir not found: " + args.libraries + " (pass --libraries or set TURTLEDATA_LIBRARIES)")
    if not args.client_jar:
        args.client_jar = os.path.join(args.libraries, "com", "mojang", "minecraft", args.mc, client_name)
    if not os.path.isfile(args.client_jar):
        fail("Minecraft client jar not found: " + args.client_jar + " (pass --client-jar or set TURTLEDATA_CLIENT_JAR"
             + (", or --jars with --download)" if info.get("downloads") else ")"))
    if info["reports"] == "server":
        args.server_jar = args.server_jar or in_jars("minecraft-" + args.mc + "-server.jar")
        if not args.server_jar or not os.path.isfile(args.server_jar):
            fail("Minecraft " + args.mc + " server jar not found (pass --server-jar, or --jars with --download)")
        name = "minecraft-" + args.mc + "-server-mappings.txt"
        args.mappings = in_jars(name) or os.path.join(os.path.dirname(os.path.abspath(args.server_jar)), name)
    if not args.forge_jar:
        for name in ("forge-" + forge_version + "-universal.jar", "forge-" + forge_version + "-client.jar"):
            if in_jars(name):
                args.forge_jar = in_jars(name)
                break
    if not args.forge_jar:
        forge_dir = os.path.join(args.libraries, "net", "minecraftforge", "forge", forge_version)
        for name in ("forge-" + forge_version + "-universal.jar", "forge-" + forge_version + "-client.jar"):
            if os.path.isfile(os.path.join(forge_dir, name)):
                args.forge_jar = os.path.join(forge_dir, name)
                break
        else:
            fail("Forge " + forge_version + " universal/client jar not found in " + forge_dir +
                 " (pass --forge-jar or set TURTLEDATA_FORGE_JAR)")
    elif not os.path.isfile(args.forge_jar):
        fail("Forge jar not found: " + args.forge_jar + " (pass --forge-jar or set TURTLEDATA_FORGE_JAR)")

    mods = os.path.join(args.instance, "mods")
    if args.vanilla:
        if not args.cc_jar:
            args.cc_jar = in_jars(cc_name)
        if not args.cc_jar:
            if not os.path.isdir(mods):
                fail("no mods dir at " + mods + " to find " + cc_name +
                     " in (pass --cc-jar / TURTLEDATA_CC_JAR, or --instance / TURTLEDATA_INSTANCE)")
            args.cc_jar = os.path.join(mods, cc_name)
        if not os.path.isfile(args.cc_jar):
            fail("CC:Tweaked jar not found: " + args.cc_jar + " (pass --cc-jar or set TURTLEDATA_CC_JAR)")
    elif not os.path.isdir(mods):
        fail("no mods dir at " + mods + " (pass --instance or set TURTLEDATA_INSTANCE to the instance's minecraft dir)")
    return args


def jars(args):
    found = [args.client_jar, args.forge_jar]
    if args.vanilla:
        found.append(args.cc_jar)
        return found
    mods = os.path.join(args.instance, "mods")
    for name in sorted(os.listdir(mods)):
        if name.endswith(".jar"):
            found.append(os.path.join(mods, name))
    return found


def fetch(url):
    import urllib.request
    req = urllib.request.Request(url, headers={"User-Agent": "turtledata-extract"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return r.read()


def download(mc, folder):
    """Fetch the client and server jars (Mojang's version manifest, sha1 checked), Forge and CC:Tweaked (pinned
    hashes) into folder, skipping the ones already there with the right hash. The jars are only read as data."""
    info = MC[mc]
    if not info.get("downloads"):
        fail("--download is not set up for " + mc + ": pass the jars")
    os.makedirs(folder, exist_ok=True)

    def get(name, url, algo, digest):
        path = os.path.join(folder, name)
        if os.path.isfile(path):
            with open(path, "rb") as f:
                if hashlib.new(algo, f.read()).hexdigest() == digest:
                    return
        print("downloading " + url)
        body = fetch(url)
        if hashlib.new(algo, body).hexdigest() != digest:
            fail(name + ": " + algo + " mismatch from " + url)
        with open(path, "wb") as f:
            f.write(body)

    manifest = json.loads(fetch(MANIFEST))
    entry = next((v for v in manifest.get("versions", []) if v.get("id") == mc), None)
    if not entry:
        fail("Minecraft " + mc + " is not in Mojang's version manifest")
    version = json.loads(fetch(entry["url"]))
    for side in ("client", "server"):
        d = version["downloads"][side]
        get("minecraft-" + mc + "-" + side + ".jar", d["url"], "sha1", d["sha1"])
    # Mojang's own name mappings, only to find the game's map colours and compostables by name (server_extras)
    d = version["downloads"]["server_mappings"]
    get("minecraft-" + mc + "-server-mappings.txt", d["url"], "sha1", d["sha1"])
    url, algo, digest = info["downloads"]["forge"]
    get("forge-" + info["forge"] + "-universal.jar", url, algo, digest)
    url, algo, digest = info["downloads"]["cc"]
    get(info["cc_jar"], url, algo, digest)


def server_reports(server_jar, mappings=None):
    """The block report from the server jar's bundler (1.18 and later ship the data generator there with its
    libraries): java -DbundlerMainClass=net.minecraft.data.Main -jar server.jar --reports. With Mojang's mappings, also
    what only the game's code knows (server_extras): (blocks, registries, extras)."""
    import shutil
    import subprocess
    import tempfile
    java = shutil.which("java")
    if not java:
        print("java not found: block properties come from blockstate files only")
        return None, None, None
    out = tempfile.mkdtemp(prefix="mcreports-")
    try:
        subprocess.run([java, "-DbundlerMainClass=net.minecraft.data.Main", "-jar", os.path.abspath(server_jar),
                        "--reports", "--output", os.path.join(out, "generated")],
                       cwd=out, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=600)
        with open(os.path.join(out, "generated", "reports", "blocks.json"), encoding="utf-8") as f:
            blocks = json.load(f)
        with open(os.path.join(out, "generated", "reports", "registries.json"), encoding="utf-8") as f:
            registries = json.load(f)
        extras = None
        if mappings and os.path.isfile(mappings):
            try:
                extras = server_extras(java, out, mappings)
            except Exception as e:
                print("map colours and compostables not read (" + str(e) + ")")
        elif mappings is not None:
            print("no server mappings (" + str(mappings) + "): no map colours or compostables; --download fetches them")
        return blocks, registries, extras
    except Exception as e:
        print("data generator failed (" + str(e) + "): block properties come from blockstate files only")
        return None, None, None
    finally:
        shutil.rmtree(out, ignore_errors=True)


# Read by server_extras through reflection: every block state's map colour (BlockStateBase.getMapColor on an empty
# level at 0,0,0, as CC:Tweaked 1.121.0's DetailHelpers.fillMapColour asks for an item's block) and ComposterBlock's
# COMPOSTABLES. The @names@ are filled from Mojang's mappings, since the jar's own names are obfuscated.
EXTRAS_JAVA = r"""
import java.lang.reflect.*;
import java.util.*;
import java.io.*;

public class TurtleDataExtras {
    static Method m(Class<?> c, String name, Class<?>... p) throws Exception {
        for (Class<?> k = c; k != null; k = k.getSuperclass()) {
            try { Method x = k.getDeclaredMethod(name, p); x.setAccessible(true); return x; } catch (NoSuchMethodException e) {}
        }
        throw new NoSuchMethodException(c + "." + name);
    }
    static Object f(Class<?> c, String name, Object o) throws Exception {
        Field x = c.getDeclaredField(name); x.setAccessible(true); return x.get(o);
    }
    static String q(String s) { return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""; }

    public static void main(String[] a) throws Exception {
        m(Class.forName("@SC@"), "@SC_detect@").invoke(null);
        m(Class.forName("@BS@"), "@BS_boot@").invoke(null);
        Class<?> bir = Class.forName("@BIR@");
        Object blocks = f(bir, "@BIR_BLOCK@", null), items = f(bir, "@BIR_ITEM@", null);
        Method getKey = m(Class.forName("@REG@"), "@REG_getKey@", Object.class);
        Class<?> bp = Class.forName("@BP@"), mc = Class.forName("@MC@");
        Method stateDef = m(Class.forName("@BLK@"), "@BLK_states@");
        Method possible = m(Class.forName("@SD@"), "@SD_states@");
        Method mapColor = m(Class.forName("@BSB@"), "@BSB_map@", Class.forName("@BG@"), bp);
        Object level = f(Class.forName("@EBG@"), "@EBG_I@", null), zero = f(bp, "@BP_ZERO@", null);
        StringBuilder out = new StringBuilder("{\"mapColours\":{");
        String sep = "";
        for (Object block : (Iterable<?>) blocks) {
            out.append(sep).append(q(getKey.invoke(blocks, block).toString())).append(":{");
            sep = ",";
            String sep2 = "";
            for (Object st : (List<?>) possible.invoke(stateDef.invoke(block))) {
                int col = (int) f(mc, "@MC_col@", mapColor.invoke(st, level, zero));
                String s = st.toString();
                int i = s.indexOf('[');
                out.append(sep2).append(q(i < 0 ? "" : s.substring(i + 1, s.length() - 1))).append(':').append(col);
                sep2 = ",";
            }
            out.append('}');
        }
        out.append("},\"compostables\":{");
        Method asItem = m(Class.forName("@IL@"), "@IL_as@");
        sep = "";
        for (Map.Entry<?, ?> e : ((Map<?, ?>) f(Class.forName("@CB@"), "@CB_C@", null)).entrySet()) {
            out.append(sep).append(q(getKey.invoke(items, asItem.invoke(e.getKey())).toString())).append(':')
                .append(Float.floatToIntBits(((Number) e.getValue()).floatValue()));
            sep = ",";
        }
        out.append("}}");
        try (Writer w = new OutputStreamWriter(new FileOutputStream(a[0]), "UTF-8")) { w.write(out.toString()); }
    }
}
"""


def obf_names(mappings):
    """The obfuscated names EXTRAS_JAVA needs, from Mojang's ProGuard-format mappings."""
    classes, members, cur = {}, {}, None
    with open(mappings, encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line or line.startswith("#"):
                continue
            if not line.startswith(" "):
                m = re.match(r"(\S+) -> (\S+):", line)
                cur = m.group(1)
                classes[cur], members[cur] = m.group(2), []
            else:
                members[cur].append(line.strip())

    def method(c, name, params=""):
        for line in members[c]:
            m = re.match(r"(?:\d+:\d+:)?\S+ (\S+)\(([^)]*)\)(?::\d+:\d+)? -> (\S+)", line)
            if m and m.group(1) == name and m.group(2) == params:
                return m.group(3)
        raise KeyError(c + "." + name)

    def field(c, name):
        for line in members[c]:
            m = re.match(r"\S+ (\S+) -> (\S+)$", line)
            if m and m.group(1) == name:
                return m.group(2)
        raise KeyError(c + "." + name)

    p = "net.minecraft."
    reg, blk, sd = p + "core.registries.BuiltInRegistries", p + "world.level.block.Block", \
        p + "world.level.block.state.StateDefinition"
    bsb = p + "world.level.block.state.BlockBehaviour$BlockStateBase"
    return {
        "SC": classes[p + "SharedConstants"], "SC_detect": method(p + "SharedConstants", "tryDetectVersion"),
        "BS": classes[p + "server.Bootstrap"], "BS_boot": method(p + "server.Bootstrap", "bootStrap"),
        "BIR": classes[reg], "BIR_BLOCK": field(reg, "BLOCK"), "BIR_ITEM": field(reg, "ITEM"),
        "REG": classes[p + "core.Registry"], "REG_getKey": method(p + "core.Registry", "getKey", "java.lang.Object"),
        "BLK": classes[blk], "BLK_states": method(blk, "getStateDefinition"),
        "SD": classes[sd], "SD_states": method(sd, "getPossibleStates"),
        "BSB": classes[bsb],
        "BSB_map": method(bsb, "getMapColor", "net.minecraft.world.level.BlockGetter,net.minecraft.core.BlockPos"),
        "BG": classes[p + "world.level.BlockGetter"],
        "BP": classes[p + "core.BlockPos"], "BP_ZERO": field(p + "core.BlockPos", "ZERO"),
        "MC": classes[p + "world.level.material.MapColor"], "MC_col": field(p + "world.level.material.MapColor", "col"),
        "EBG": classes[p + "world.level.EmptyBlockGetter"], "EBG_I": field(p + "world.level.EmptyBlockGetter", "INSTANCE"),
        "CB": classes[p + "world.level.block.ComposterBlock"],
        "CB_C": field(p + "world.level.block.ComposterBlock", "COMPOSTABLES"),
        "IL": classes[p + "world.level.ItemLike"], "IL_as": method(p + "world.level.ItemLike", "asItem"),
    }


def server_extras(java, run_dir, mappings):
    """Run EXTRAS_JAVA on the server the bundler unpacked into run_dir: {"mapColours": {id: {stateKey: rgb}},
    "compostables": {id: chance}}. The chance is the game's float, kept exact."""
    import struct
    import subprocess
    src = EXTRAS_JAVA
    names = obf_names(mappings)
    for key in sorted(names, key=len, reverse=True):
        src = src.replace("@" + key + "@", names[key])
    java_file = os.path.join(run_dir, "TurtleDataExtras.java")
    with open(java_file, "w", encoding="utf-8") as f:
        f.write(src)
    cp = []
    for root, _, files in os.walk(os.path.join(run_dir, "versions")):
        cp += [os.path.join(root, f) for f in files if f.endswith(".jar")]
    for root, _, files in os.walk(os.path.join(run_dir, "libraries")):
        cp += [os.path.join(root, f) for f in sorted(files) if f.endswith(".jar")]
    result = os.path.join(run_dir, "extras.json")
    subprocess.run([java, "-cp", os.pathsep.join(cp), java_file, result], cwd=run_dir, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=600)
    with open(result, encoding="utf-8") as f:
        extras = json.load(f)
    extras["compostables"] = {k: struct.unpack(">f", struct.pack(">i", v))[0]
                              for k, v in extras["compostables"].items()}
    return extras


def map_colour_entry(states):
    """One block's map colours, compact: the colour when every state shares it, else {by, default, values} where
    `by` are the fewest state properties that decide it and values maps their values ("x" or "head,true") to it."""
    colours = set(states.values())
    if len(colours) == 1:
        return colours.pop()
    parsed = []
    for key, col in states.items():
        props = dict(pair.split("=", 1) for pair in key.split(",")) if key else {}
        parsed.append((props, col))
    names = sorted(parsed[0][0])
    from itertools import combinations
    for size in range(1, len(names) + 1):
        for by in combinations(names, size):
            values, ok = {}, True
            for props, col in parsed:
                k = ",".join(props[n] for n in by)
                if values.setdefault(k, col) != col:
                    ok = False
                    break
            if ok:
                default = max(colours, key=lambda c: sum(1 for _, x in parsed if x == c))
                return {"by": list(by), "default": default,
                        "values": {k: v for k, v in sorted(values.items()) if v != default}}
    return None


def vanilla_reports(client_jar, libs):
    """Run Minecraft's own data generator (net.minecraft.data.Main --reports) from the client jar: blocks.json has every
    vanilla block's real properties and default state, registries.json every item. None when Java is missing."""
    import shutil
    import subprocess
    import tempfile
    java = shutil.which("java")
    if not java:
        print("java not found: block properties come from blockstate files only")
        return None, None
    skip = re.compile(r"forge|minecraftforge|[\\/]com[\\/]mojang[\\/]minecraft[\\/]|lwjgl|fmlloader|cpw|modlauncher|natives")
    cp = [client_jar]
    for root, _, files in os.walk(libs):
        for f in files:
            path = os.path.join(root, f)
            if f.endswith(".jar") and not skip.search(path):
                cp.append(path)
    out = tempfile.mkdtemp(prefix="mcreports-")
    try:
        subprocess.run([java, "-cp", os.pathsep.join(cp), "net.minecraft.data.Main", "--reports", "--output", out],
                       cwd=out, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=600)
        with open(os.path.join(out, "reports", "blocks.json"), encoding="utf-8") as f:
            blocks = json.load(f)
        with open(os.path.join(out, "reports", "registries.json"), encoding="utf-8") as f:
            registries = json.load(f)
        return blocks, registries
    except Exception as e:
        print("data generator failed (" + str(e) + "): block properties come from blockstate files only")
        return None, None
    finally:
        shutil.rmtree(out, ignore_errors=True)


def load_json(data):
    try:
        text = data.decode("utf-8-sig")
        # some mods ship JSON with comments or trailing commas
        text = re.sub(r"^\s*//.*$", "", text, flags=re.M)
        text = re.sub(r",(\s*[}\]])", r"\1", text)
        return json.loads(text)
    except Exception:
        return None


def main():
    args = parse_args(sys.argv[1:])
    out_dir = os.path.abspath(args.out)
    names = {}
    blocks = {}            # id -> {prop: [values]}
    items = set()
    loot = {}
    tag_files = {"blocks": defaultdict(list), "items": defaultdict(list)}  # tag -> [json, ...] in load order
    recipes = {}
    cooking = {}
    folders = args.info["folders"]
    tag_groups = {folders["block_tags"]: "blocks", folders["item_tags"]: "items"}

    for jar in jars(args):
        try:
            z = zipfile.ZipFile(jar)
        except Exception:
            continue
        for entry in z.namelist():
            if not entry.endswith(".json"):
                continue
            parts = entry.split("/")
            if len(parts) < 4:
                continue
            root, ns, kind = parts[0], parts[1], parts[2]
            rest = "/".join(parts[3:])[:-5]
            if root == "assets" and kind == "lang" and rest == "en_us":
                data = load_json(z.read(entry))
                if isinstance(data, dict):
                    for key, value in data.items():
                        m = re.match(r"^(block|item)\.([a-z0-9_.-]+)\.([a-z0-9_./-]+)$", key)
                        if m and isinstance(value, str):
                            ident = m.group(2) + ":" + m.group(3)
                            # an item name wins over the block name only when there is no block name
                            if m.group(1) == "block" or ident not in names:
                                names[ident] = value
                            if m.group(1) == "item":
                                items.add(ident)
            elif root == "assets" and kind == "blockstates" and "/" not in rest:
                data = load_json(z.read(entry))
                ident = ns + ":" + rest
                props = defaultdict(set)
                if isinstance(data, dict):
                    keys = []
                    if isinstance(data.get("variants"), dict):
                        keys = list(data["variants"].keys())
                    for key in keys:
                        for pair in key.split(","):
                            if "=" in pair:
                                k, v = pair.split("=", 1)
                                props[k].add(v)
                    for part in data.get("multipart", []) or []:
                        when = part.get("when") if isinstance(part, dict) else None
                        conds = []
                        if isinstance(when, dict):
                            if "OR" in when and isinstance(when["OR"], list):
                                conds = [c for c in when["OR"] if isinstance(c, dict)]
                            else:
                                conds = [when]
                        for c in conds:
                            for k, v in c.items():
                                for one in str(v).split("|"):
                                    props[k].add(one)
                blocks[ident] = {k: sorted(v) for k, v in props.items()}
            elif root == "assets" and kind == "models" and rest.startswith("item/") and "/" not in rest[5:]:
                items.add(ns + ":" + rest[5:])
            elif root == "data" and kind == folders["loot"] and rest.startswith("blocks/"):
                data = load_json(z.read(entry))
                if isinstance(data, dict):
                    loot[ns + ":" + rest[7:]] = data
            elif root == "data" and kind == "tags" and rest.split("/", 1)[0] in tag_groups and "/" in rest:
                group, path = rest.split("/", 1)
                data = load_json(z.read(entry))
                if isinstance(data, dict):
                    tag_files[tag_groups[group]][ns + ":" + path].append(data)
            elif root == "data" and kind == folders["recipes"]:
                data = load_json(z.read(entry))
                if isinstance(data, dict):
                    recipe = crafting_recipe(data)
                    if recipe:
                        recipes[ns + ":" + rest] = recipe
                    cook = cooking_recipe(data)
                    if cook:
                        cooking[ns + ":" + rest] = cook

    # Vanilla: the real properties and default states, and the real item registry, over the model-file guesses
    defaults = {}
    extras = None
    if args.info["reports"] == "server":
        report, registries, extras = server_reports(args.server_jar, args.mappings)
    else:
        report, registries = vanilla_reports(args.client_jar, args.libraries)
    if report:
        for ident, info in report.items():
            blocks[ident] = {k: list(v) for k, v in (info.get("properties") or {}).items()}
            for st in info.get("states", []):
                if st.get("default"):
                    defaults[ident] = st.get("properties") or {}
    if registries:
        vanilla_items = set((registries.get("minecraft:item") or {}).get("entries", {}).keys())
        items = {i for i in items if not i.startswith("minecraft:")} | vanilla_items

    for data in loot.values():
        for out in loot_outputs(data):
            if not out.startswith("minecraft:") or not registries:
                items.add(out)
    for recipe in recipes.values():
        items.add(recipe["result"]["item"])
    # a block with an item model is also an item; a block alone (fire, water) is not
    items = {i for i in items if ID.match(i)}

    block_tags = resolve_tags(tag_files["blocks"])
    item_tags = resolve_tags(tag_files["items"])

    # One file per namespace, so a turtle that only meets vanilla blocks loads only minecraft.lua
    sections = {
        "names": names,
        "blocks": blocks,
        "defaults": defaults,
        "items": {i: True for i in items},
        "loot": loot,
        "blockTags": invert(block_tags),
        "itemTags": invert(item_tags),
    }
    # Map colours (CC:Tweaked 1.121.0's item and block details have them): only from the server's code, so only
    # where server_extras ran; a set without them keeps exactly the sections it always had
    if extras:
        colours = {ident: map_colour_entry(states) for ident, states in extras["mapColours"].items()}
        colours.update(args.info.get("map_colours", {}))
        sections["mapColours"] = {k: v for k, v in colours.items() if v is not None}
    by_ns = defaultdict(lambda: {k: {} for k in sections})
    for section, table in sections.items():
        for ident, value in table.items():
            by_ns[ident.split(":", 1)[0]][section][ident] = value
    if os.path.isdir(out_dir):
        for old in os.listdir(out_dir):
            if old.endswith(".lua"):
                os.remove(os.path.join(out_dir, old))
    os.makedirs(out_dir, exist_ok=True)
    for ns, data in by_ns.items():
        write_sections(os.path.join(out_dir, ns + ".lua"), data)
    write_sections(os.path.join(out_dir, "_recipes.lua"), {"recipes": recipes})
    write_sections(os.path.join(out_dir, "_cooking.lua"), {"cooking": cooking})
    # Tag members, for recipe ingredients given as a tag
    write_sections(os.path.join(out_dir, "_tag_members.lua"), {"items": {t: sorted(m) for t, m in item_tags.items()}})
    if extras:
        # ComposterBlock.COMPOSTABLES: item id -> the chance one item raises the level
        write_sections(os.path.join(out_dir, "_compostables.lua"), {"compostables": extras["compostables"]})
    print("Minecraft " + args.mc + " " + ("vanilla" if args.vanilla else "pack") + " set -> " + out_dir)
    print(f"{len(blocks)} blocks, {len(items)} items, {len(names)} names, {len(loot)} loot tables, "
          f"{len(block_tags)} block tags, {len(item_tags)} item tags, {len(recipes)} crafting recipes")


def crafting_recipe(data):
    """A shaped or shapeless crafting recipe, unwrapped from forge:conditional; None for anything else."""
    if data.get("type") == "forge:conditional" and isinstance(data.get("recipes"), list) and data["recipes"]:
        first = data["recipes"][0]
        data = first.get("recipe") if isinstance(first, dict) else None
        if not isinstance(data, dict):
            return None
    kind = data.get("type")
    result = data.get("result")
    if isinstance(result, str):
        result = {"item": result}
    if not isinstance(result, dict) or not isinstance(result.get("item"), str):
        return None
    out = {"item": result["item"], "count": int(result.get("count", 1))}
    if isinstance(result.get("nbt"), (dict, str)):
        out["nbt"] = result["nbt"] if isinstance(result["nbt"], str) else json.dumps(result["nbt"])
    if kind == "minecraft:crafting_shaped":
        pattern = data.get("pattern")
        key = data.get("key")
        if not isinstance(pattern, list) or not isinstance(key, dict):
            return None
        return {"type": "shaped", "pattern": pattern, "key": {k: ingredient(v) for k, v in key.items()}, "result": out}
    if kind == "minecraft:crafting_shapeless":
        ings = data.get("ingredients")
        if not isinstance(ings, list):
            return None
        return {"type": "shapeless", "ingredients": [ingredient(v) for v in ings], "result": out}
    return None


def cooking_recipe(data):
    """A smelting, blasting, smoking or campfire cooking recipe: {type, ingredient, result, time}; None for anything else."""
    kind = data.get("type")
    short = {"minecraft:smelting": "smelting", "minecraft:blasting": "blasting", "minecraft:smoking": "smoking",
             "minecraft:campfire_cooking": "campfire_cooking"}.get(kind)
    result = data.get("result")
    if isinstance(result, dict):
        result = result.get("item")
    if not short or not isinstance(result, str) or "ingredient" not in data:
        return None
    default = {"smelting": 200, "blasting": 100, "smoking": 100, "campfire_cooking": 600}[short]
    return {"type": short, "ingredient": ingredient(data["ingredient"]), "result": result,
            "time": int(data.get("cookingtime", default))}


def ingredient(value):
    """An ingredient as a list of alternatives, each {"item": id} or {"tag": id}."""
    alts = value if isinstance(value, list) else [value]
    out = []
    for alt in alts:
        if isinstance(alt, dict):
            if isinstance(alt.get("item"), str):
                out.append({"item": alt["item"]})
            elif isinstance(alt.get("tag"), str):
                out.append({"tag": alt["tag"]})
    return out


def loot_outputs(node):
    if isinstance(node, dict):
        if node.get("type") == "minecraft:item" and isinstance(node.get("name"), str):
            yield node["name"]
        for v in node.values():
            yield from loot_outputs(v)
    elif isinstance(node, list):
        for v in node:
            yield from loot_outputs(v)


def resolve_tags(files):
    raw = {}
    for tag, datas in files.items():
        values = []
        for data in datas:
            if data.get("replace") is True:
                values = []
            for v in data.get("values", []) or []:
                if isinstance(v, dict):
                    v = v.get("id")
                if isinstance(v, str):
                    values.append(v)
        raw[tag] = values
    resolved = {}

    def members(tag, seen):
        if tag in resolved:
            return resolved[tag]
        if tag in seen:
            return set()
        seen.add(tag)
        out = set()
        for v in raw.get(tag, []):
            if v.startswith("#"):
                out |= members(v[1:], seen)
            elif ID.match(v):
                out.add(v)
        resolved[tag] = out
        return out

    for tag in raw:
        members(tag, set())
    return resolved


def invert(tags):
    by_id = defaultdict(list)
    for tag, ids in tags.items():
        for ident in ids:
            by_id[ident].append(tag)
    return {k: sorted(v) for k, v in sorted(by_id.items())}


def lua(value, out):
    if value is None:
        out.append("nil")
    elif value is True:
        out.append("true")
    elif value is False:
        out.append("false")
    elif isinstance(value, (int, float)):
        out.append(repr(value) if isinstance(value, float) else str(value))
    elif isinstance(value, str):
        out.append(json.dumps(value, ensure_ascii=False))
    elif isinstance(value, list):
        out.append("{")
        for v in value:
            lua(v, out)
            out.append(",")
        out.append("}")
    elif isinstance(value, dict):
        out.append("{")
        for k, v in value.items():
            if isinstance(k, str) and re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", k) and k not in LUA_KEYWORDS:
                out.append(k + "=")
            else:
                out.append("[" + json.dumps(str(k), ensure_ascii=False) + "]=")
            lua(v, out)
            out.append(",")
        out.append("}")
    else:
        out.append(json.dumps(str(value)))


LUA_KEYWORDS = {"and", "break", "do", "else", "elseif", "end", "false", "for", "function", "goto", "if", "in",
                "local", "nil", "not", "or", "repeat", "return", "then", "true", "until", "while"}


def write_sections(path, sections):
    # one entry per line, so a diff of a regenerated file stays readable
    lines = ["-- generated by tools/turtledata/extract.py from the game jars; do not edit", "return {"]
    for section in sorted(sections):
        lines.append(section + "={")
        value = sections[section]
        for k in sorted(value):
            out = []
            lua(value[k], out)
            lines.append("[" + json.dumps(k, ensure_ascii=False) + "]=" + "".join(out) + ",")
        lines.append("},")
    lines.append("}")
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
