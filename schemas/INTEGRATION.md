# World file schema

`world.schema.json` is a JSON Schema (draft-07) for craftos-mcp world files: `<name>.world.json` next to a program,
and the files in `worlds/`. With it an editor completes keys and values (peripheral types, addon ids, Minecraft
versions, sides, modes), shows what each field does on hover, and marks typos and bad values.

It is generated, never edited by hand. The source of truth is the TypeScript that describes worlds:

- `WorldFile` and `WorldConfig` in `packages/runner/src/world.ts` (and `MonitorSpec` in `lua.ts`);
- `PeripheralTypeMap` in `packages/runner/src/world-peripherals.ts`: every peripheral type and the fields it takes;
- the addon ids and peripheral types in `addons.ts`, the Minecraft versions in `versions.ts`.

`packages/runner/src/world-schema.test.ts` builds the schema from them with the TypeScript compiler (JSDoc becomes the
descriptions, `@default` and `@example` the defaults and examples) and fails when the file here is out of date, when a
field has no description, when an addon has a peripheral type or world key the schema lacks, or when a world file in
the repository does not validate. After changing a world type:

```sh
npx vitest run packages/runner/src/world-schema.test.ts -u
```

## In a world file

The runner ignores a `$schema` key, so any world file can name its schema:

```json
{
  "$schema": "https://raw.githubusercontent.com/Akkiruk/craftos-mcp/main/schemas/world.schema.json",
  "addons": ["advanced-peripherals"],
  "peripherals": [{ "name": "left", "type": "playerDetector" }]
}
```

The worlds in this repository use a relative path (`../schemas/world.schema.json`), so they follow the schema of the
checkout they are in.

## VS Code extension

`apps/vscode` should ship the schema and register it for `*.world.json`:

1. In `package.json`, next to `snippets` under `contributes`:

   ```json
   "jsonValidation": [
     {
       "fileMatch": "*.world.json",
       "url": "./schemas/world.schema.json"
     }
   ]
   ```

2. Copy the schema into the extension when it builds, e.g. at the top of `esbuild.mjs`:

   ```js
   import { cpSync, mkdirSync } from "node:fs";

   mkdirSync("schemas", { recursive: true });
   cpSync("../../schemas/world.schema.json", "schemas/world.schema.json");
   ```

3. Package it: add `!schemas/world.schema.json` to `.vscodeignore`, and `schemas/` to the extension's `.gitignore`
   (the copy is build output; this folder is the original).

`fileMatch` matches the file name, so it covers worlds in any folder. Files in `worlds/` are named `<name>.json`; they
carry `$schema` instead.

## Other editors

The schema's stable address is main of the public repository:

```text
https://raw.githubusercontent.com/Akkiruk/craftos-mcp/main/schemas/world.schema.json
```

- **VS Code without the extension**, or any editor using the VS Code JSON language server: the `json.schemas` setting,
  `[{ "fileMatch": ["*.world.json"], "url": "<the address above>" }]`.
- **JetBrains IDEs**: Settings, Languages & Frameworks, Schemas and DTDs, JSON Schema Mappings: add the address with
  the file pattern `*.world.json`.
- **Neovim, Helix, Zed** and others with a JSON language server: map `*.world.json` to the address in its schema
  settings, or put `$schema` in the file.

Later, the schema can go into the [SchemaStore](https://www.schemastore.org) catalog (a pull request to
SchemaStore/schemastore adding a `catalog.json` entry with the address above and `"fileMatch": ["*.world.json"]`).
Every editor that reads the catalog then picks it up with no setup. SchemaStore may ask for a narrower match than
`*.world.json`, since the name is generic.
