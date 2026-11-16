"""Pull the block and item data a turtle needs out of the real game jars.

Reads the Minecraft 1.18.2 client jar, Forge, and every mod jar in the pack, and writes compact Lua tables, one file
per namespace plus the combined _recipes.lua, _cooking.lua and _tag_members.lua, to rom-overlay/rom/ccsim/turtle/data/
(or --out):

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

Usage:
  python -I tools/turtledata/extract.py                       # pack set into rom-overlay/rom/ccsim/turtle/data
  python -I tools/turtledata/extract.py --vanilla --out .public-data/turtle-data

Options (each also has an environment variable; the flag wins):
  --out DIR           output directory; every *.lua in it is deleted first (default rom-overlay/rom/ccsim/turtle/data)
  --instance DIR      the instance's minecraft dir, holding mods/ (TURTLEDATA_INSTANCE)
  --libraries DIR     launcher libraries dir (TURTLEDATA_LIBRARIES; default %APPDATA%\\PrismLauncher\\libraries)
  --client-jar JAR    minecraft-1.18.2-client.jar (TURTLEDATA_CLIENT_JAR; default under --libraries)
  --forge-jar JAR     forge-1.18.2-40.2.21-universal.jar, or the -client jar (TURTLEDATA_FORGE_JAR; default under
                      --libraries, universal first)
  --cc-jar JAR        cc-tweaked-1.18.2-1.101.3.jar, --vanilla only (TURTLEDATA_CC_JAR; default <instance>/mods/)

Java on PATH is needed for the vanilla block report (blocks.json); it runs on the client jar plus every jar under
--libraries except Forge, LWJGL and the launcher's own.
"""
import argparse
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
FORGE_VERSION = "1.18.2-40.2.21"
CC_JAR = "cc-tweaked-1.18.2-1.101.3.jar"

ID = re.compile(r"^[a-z0-9_.-]+:[a-z0-9_./-]+$")


def fail(message):
    sys.exit("extract.py: " + message)


def parse_args(argv):
    p = argparse.ArgumentParser(description="Regenerate the turtle block/item/tag/recipe/loot data from the game jars.")
    p.add_argument("--vanilla", action="store_true",
                   help="only vanilla, Forge and CC:Tweaked (the publishable set); no other mod jars")
    p.add_argument("--out", default=DEFAULT_OUT, help="output directory (default %(default)s)")
    p.add_argument("--instance", default=os.environ.get("TURTLEDATA_INSTANCE") or DEFAULT_INSTANCE,
                   help="instance minecraft dir holding mods/ (env TURTLEDATA_INSTANCE)")
    p.add_argument("--libraries", default=os.environ.get("TURTLEDATA_LIBRARIES") or DEFAULT_LIBS,
                   help="launcher libraries dir (env TURTLEDATA_LIBRARIES)")
    p.add_argument("--client-jar", default=os.environ.get("TURTLEDATA_CLIENT_JAR"),
                   help="minecraft 1.18.2 client jar (env TURTLEDATA_CLIENT_JAR)")
    p.add_argument("--forge-jar", default=os.environ.get("TURTLEDATA_FORGE_JAR"),
                   help="Forge " + FORGE_VERSION + " universal or client jar (env TURTLEDATA_FORGE_JAR)")
    p.add_argument("--cc-jar", default=os.environ.get("TURTLEDATA_CC_JAR"),
                   help="CC:Tweaked jar for --vanilla (env TURTLEDATA_CC_JAR)")
    args = p.parse_args(argv)

    if not os.path.isdir(args.libraries):
        fail("libraries dir not found: " + args.libraries + " (pass --libraries or set TURTLEDATA_LIBRARIES)")
    if not args.client_jar:
        args.client_jar = os.path.join(args.libraries, "com", "mojang", "minecraft", "1.18.2",
                                       "minecraft-1.18.2-client.jar")
    if not os.path.isfile(args.client_jar):
        fail("Minecraft client jar not found: " + args.client_jar + " (pass --client-jar or set TURTLEDATA_CLIENT_JAR)")
    if not args.forge_jar:
        forge_dir = os.path.join(args.libraries, "net", "minecraftforge", "forge", FORGE_VERSION)
        for name in ("forge-" + FORGE_VERSION + "-universal.jar", "forge-" + FORGE_VERSION + "-client.jar"):
            if os.path.isfile(os.path.join(forge_dir, name)):
                args.forge_jar = os.path.join(forge_dir, name)
                break
        else:
            fail("Forge " + FORGE_VERSION + " universal/client jar not found in " + forge_dir +
                 " (pass --forge-jar or set TURTLEDATA_FORGE_JAR)")
    elif not os.path.isfile(args.forge_jar):
        fail("Forge jar not found: " + args.forge_jar + " (pass --forge-jar or set TURTLEDATA_FORGE_JAR)")

    mods = os.path.join(args.instance, "mods")
    if args.vanilla:
        if not args.cc_jar:
            if not os.path.isdir(mods):
                fail("no mods dir at " + mods + " to find " + CC_JAR +
                     " in (pass --cc-jar / TURTLEDATA_CC_JAR, or --instance / TURTLEDATA_INSTANCE)")
            args.cc_jar = os.path.join(mods, CC_JAR)
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
            elif root == "data" and kind == "loot_tables" and rest.startswith("blocks/"):
                data = load_json(z.read(entry))
                if isinstance(data, dict):
                    loot[ns + ":" + rest[7:]] = data
            elif root == "data" and kind == "tags" and (rest.startswith("blocks/") or rest.startswith("items/")):
                group, path = rest.split("/", 1)
                data = load_json(z.read(entry))
                if isinstance(data, dict):
                    tag_files[group][ns + ":" + path].append(data)
            elif root == "data" and kind == "recipes":
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
    print(("vanilla" if args.vanilla else "pack") + " set -> " + out_dir)
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
