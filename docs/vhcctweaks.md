# Simulated server: vhcctweaks and Advanced Peripherals

[vhcctweaks](https://github.com/Akkiruk/vhcctweaks) ([releases](https://github.com/Akkiruk/vhcctweaks/releases)) is a
server-side Forge mod for Vault Hunters on Minecraft 1.18.2. It gives ComputerCraft computers APIs that plain CC:Tweaked
does not have: `ccvault` (player token balances, transfers a player approves in chat, the computer's host), `vhcc` (a
sandboxed file store per computer), filesystem lockdown, linked ender modems, batch inventory methods and watches, and
changes to a few Advanced Peripherals methods. The emulator simulates it in Lua (`rom-overlay/rom/ccsim/`), loaded at
boot from `rom/startup.lua`. Everything is driven by a **world** that you pass to `craftos_run`, `craftos_test` or
`craftos_session_create`.

Sources of truth: [Akkiruk/vhcctweaks](https://github.com/Akkiruk/vhcctweaks)
(`CCVaultAPI`, `SessionAuthManager`, `TransferService`, `TransactionLedger`,
`VHCCTweaksAPI`, lockdown classes, chat box mixins) and its release specs as of this writing.

## Switching it on

vhcctweaks is the addon `vhcctweaks`, and an opt-in one: `"all"` and the default list leave it out, because it changes
plain CC:Tweaked and Advanced Peripherals. It only exists on Minecraft 1.18.2, so the world needs `"version": "1.18.2"`.
Then either name it in the addons (`world.addons`, `"addons"` in `craftos.json`, or `CRAFTOS_ADDONS`, for example
`"all,vhcctweaks"`), which gives 2.2.36, or pick the release with `world.vhcctweaks`:

| `world.vhcctweaks` | What the computer gets                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `"2.2.36"`         | The current release: ccvault, vhcc, lockdown, linked ender modems, batch methods, watches |
| `"2.2.37"`         | 2.2.36 plus the 2.2.37 API (below), modelled from the mod's spec                          |
| `"2.2.35"`         | The release before 2.2.36, without links, batch methods, watches or allowances            |
| `false`            | No vhcctweaks, whatever the addons say                                                    |

```json
{
  "version": "1.18.2",
  "vhcctweaks": "2.2.36",
  "players": [{ "name": "Steve", "balance": 500 }],
  "host": "Steve"
}
```

**Linked computers run in real time.** Ender modem links and remote peripherals depend on timing: on a slow or busy
machine (many emulated computers at once) a linked-peripheral call can time out, stall or behave inconsistently. The
MCP server, the command line and the VS Code extension say so once when a world uses them.

A linked monitor call (and any other computer-thread method of a linked peripheral) costs 30 ms here, as in game: set
`"linkLatency"` in the world, or `CRAFTOS_LINK_LATENCY`, to another number of ms, or `"fast"` for none. Inventory
methods wait for the server tick either way.

## How faithful it is

- **2.2.36 and 2.2.35** were written from the mod's Java source and spec and checked against the real mod in the game:
  `ccvault`, `vhcc`, lockdown, links and the inventory methods give the mod's answers, errors and timing (one server
  tick for main-thread calls, the economy thread for money). What is not emulated is listed at the end of this page.
- **2.2.37** follows the 2.2.37 API spec and Java, not measurements in the game, and some of it is the emulator's own:
  `identify` rolls a seeded, plausible piece that keeps the level and rarity rules, not Vault Hunters' roll (a world's
  `identifiesTo` pins the result); Gear Score, Gear Power and the Temper ladder are not computed, the world gives the
  scores and the emulator works out the rest; container items are known by item id (Sophisticated Backpacks, shulker
  boxes, vault barrels, or any item with `itemHandler`) and their nbt hashes are the emulator's own; skills and stats
  are listed as the world gives them. Each part below says what is the world's and what is worked out.
- Vault Hunters itself is not simulated: `vaultData` on an item is whatever the world says.

## The world

```jsonc
{
  "players": [
    { "name": "Steve", "balance": 5000 },
    { "name": "Alice", "balance": 800, "x": 1, "y": 64, "z": 0 },
  ],
  "host": "Steve", // computer owner ("host")
  "interacting": "Alice", // player using the computer ("player")
  "autoApprove": true, // clicking [APPROVE] happens immediately
  "economyAvailable": true, // false = Dog's PlayerShops missing
  "computerId": 0,
  "kind": "block", // "pocket" computers do not claim ownership
  "position": { "x": 100, "y": 70, "z": -40 }, // where the computer stands, for its modems
  "vhccStore": "shop", // persistent vhcc_data shared between runs
  "peripherals": [
    {
      "name": "chest_0",
      "type": "minecraft:chest",
      "size": 54,
      "items": {
        "1": {
          "name": "the_vault:gear",
          "count": 1,
          "vaultData": { "rarity": "EPIC" },
        },
      },
    },
    { "name": "playerDetector_0", "type": "playerDetector" },
    { "name": "chatBox_0", "type": "chatBox" },
    { "name": "speaker_0", "type": "speaker" },
  ],
}
```

During an interactive session `craftos_sim_command` changes the world:
`interact`, `approve`, `revoke`, `reboot`, `setBalance`, `addPlayer`, `join`, `leave`,
`setPlayerPos`, `setComputerPos`, `setHost`, `setEconomy`, `chat`, `playerClick`, `setItem`, `unload`, `load`.
`craftos_sim_state` (and the `sim` field of `craftos_run`) returns balances, the
ledger, the chat messages the server sent (including the `[APPROVE]` prompt and its
`/ccvault approve <nonce>` command) and inventory contents. Commands take effect when
the program next waits for an event.

## `ccvault` (complete)

All 17 functions the mod registers: `forgetHost`, `setTerminalLock`, `isTerminalLocked`, `isAvailable`, `requestAuth`, `isAuthenticated`,
`getBalance`, `getPlayerBalance`, `transfer`, `getPlayerName`, `getHostName`,
`claimHost`, `getComputerId`, `getSessionInfo`, `transferSelf`, `verifyTransaction`,
`getTransactionHistory`.

Behaviour follows the source, including: which problems raise errors and which return
`nil, message`; the exact messages; the 30 s interaction freshness window; auth sessions
that expire after 10 idle minutes and are cleared when the player leaves; single-use
12-character nonces that expire after 60 s; the 1,000,000 per-transfer cap; history
returned oldest first and capped at 50; `transferSelf` moving no money.

Known deviations:

- Messages use `-` where the mod uses an em dash.
- The mod README mentions rate limits and `transfersRemaining`, but the source has
  neither, so neither exists here.
- Write-ahead-log crash recovery and the on-disk ledger are not modelled; the ledger
  lives in memory for the run (and is returned in `sim`).
- Transaction ids have the real shape (`<hex ms>-<12 hex>`, `sim-<hex ms>-<8 hex>` for
  self-play) but are random.

Sessions are per player per computer. `"player:Name"` works for `getBalance` and `transfer`, and
needs that player online, approved here and touching within the window. A monitor touch queues
`vhcc_touch` with the player's name immediately before `monitor_touch`: `interact` before a touch changes who touches. Computers have no owner
until one is claimed: `claimHost` returns `nil, "confirm the host claim in chat"` and `interact` offers an
unowned computer in chat; `autoApprove` clicks either. The first `getPlayerBalance` for an unseen offline
name answers `try again`.

## `vhcc` (complete)

Each computer has a private folder under the store, `computers/<id>`, with a disk allowance
(`config.maxBytesPerComputer`, 16 MB; every file and folder costs at least 4 KB).

All 14 functions (`rcReply` is below; `isAvailable`, `getBasePath`, `write`, `append`, `read`, `exists`,
`isDir`, `getSize`, `list`, `makeDir`, `delete`, `move`, `copy`) with the same path
validation (no `..`, no absolute paths, segment character set and length, depth 16),
1 MB write limit and error messages. Data lives in a host folder; name a `vhccStore`
to keep it between runs, otherwise each run starts empty.

## Filesystem lockdown

If the computer root contains `vhcc_lockdown.txt`, writes to the root drive are refused
with `/path: Access denied` unless the path is allowed (`allow-exact`, `allow-prefix`,
`allow-suffix`) or the unlock file exists, mirroring `LockdownWritableMount`.

## Peripherals

| Peripheral                                     | Status                                                                                                                                                                                                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monitors, drives                               | Engine-emulated (vanilla CC)                                                                                                                                                                                                                   |
| Modems (wireless, ender, wired)                | Virtual, measured against real computers: see [Modems and networks](#modems-and-networks)                                                                                                                                                      |
| Speakers                                       | Virtual recording fake (the headless engine has no audio): rules measured on a real speaker: sounds are never refused, notes are capped at 8 per tick, only a malformed name errors. Calls land in sim state under `peripherals.<name>.sounds` |
| Inventories (`minecraft:chest`, `barrel`, ...) | Virtual: `size`, `list`, `getItemDetail` (fixture fields such as `vaultData` pass through), `getItemLimit`, `pushItems`, `pullItems`                                                                                                           |
| Advanced Peripherals (enabled ones)            | Virtual, full method surface: see [advanced-peripherals.md](advanced-peripherals.md) (player detector, chat box, energy, environment, redstone, NBT, AR, ME and RS bridges)                                                                    |
| Mekanism QIO and Quantum Entangloporter        | Virtual, full method surface, machines on the virtual clock: see [mekanism-qio.md](mekanism-qio.md)                                                                                                                                            |

vhcctweaks' changes to AP are applied: the two `sendFormatted*` chat methods return its
"disabled" error, the hidden `$` chat channel is dropped, `isSlimeChunk` is always false, and the
peripherals its config patcher disables (block reader, inventory manager, geo scanner) do not exist.

**Without the mod.** A world with `"vhcctweaks": false`, or a ROM with no `rom/ccsim/vhcc.lua` (a build without the mod's files), is plain CC:Tweaked 1.101.3 with Advanced Peripherals 0.7.31r
and Mekanism on their shipped defaults: no `ccvault` or `vhcc`, no `/.vhcc_data` mount, no lockdown, no claim prompts or
`vhcc_touch`, no links, batch methods or watches, and an ender modem is CC's plain one. A chest on a cable shared by
several computers is still one chest, as in plain CC (`ccsim/wiredrelay.lua`). AP behaves as its own code: a `$`
chat message reaches chat boxes with every `$` removed and `isHidden` true, `sendFormattedMessage(ToPlayer)` send the
JSON component, the chat cooldown is 100 ms, and `isSlimeChunk` is vanilla's for `environment.seed`. Pinned by
`packages/runner/src/vanilla.integration.test.ts`.

## Modems and networks

A modem is a world peripheral: `{ "name": "top", "type": "modem" }` is a normal wireless one, and `kind` can be `wireless`,
`ender` or `wired`. Rules live in `rom-overlay/rom/ccsim/modem.lua`, written from the 1.101.3 source and held to
measurements in the game.

- **Range:** 64 blocks up to y 96, then rising in a line to 384 at the top of the world (y 300 reaches 356.7). Exactly on
  the limit is heard. Storm values come from `environment.raining` and `thunder`, and are the same on this server.
- **Reach is the larger of the two modems' ranges,** so a low modem and a high one hear each other in both directions.
- **Ender modems** reach every wireless modem at any distance in any dimension, and any wireless modem reaches them. Distance
  is a number in the same dimension. Across dimensions the event has no distance argument at all.
- **Position** is the computer's (`position`), because a real wireless modem reports the block it sits on. The height used
  is that block's. Wired distance runs along the cable: one step to the modem block at each end, plus the blocks between.
- **Wired:** only joined blocks connect. A sided modem counts as its cable's block. An off modem on a cable still hears and
  lists the network; only its own computer is not offered. Traffic stops after 256 blocks of route. What a modem reaches is listed in
  `peripheral.getNames` straight after that modem, in the real order. `getNameLocal` is `computer_N` from the network's
  counter, not the computer id, and nil when the modem is off. Wired modems have the `peripheral_hub` type as well.
- **Two modems on one computer** hear each other; a modem never hears itself. That needs no network.
- **128 open channels** per modem. Bad channels raise `Expected number in range 0-65535`. A channel is a Java int: `open(1.5)`
  opens 1.
- **Messages** are frozen at `transmit`, and every receiver gets its own copy. Shared tables and cycles survive, metatables do
  not, and any pair with a function in it is dropped.

Several computers: `SessionManager.createNetwork` (or `craftos_network_create`) starts one engine per computer, each a normal
session with its own world, and a `ComputerNetwork` in the runner relays packets between them. rednet needs nothing more: it
is the unmodified ROM.

```js
const { network, computers } = manager.createNetwork({
  computers: [
    {
      name: "hub",
      world: {
        computerId: 50,
        position: { x: 0, y: 70, z: 0 },
        peripherals: [{ name: "back", type: "modem" }],
      },
    },
    {
      name: "a",
      world: {
        computerId: 11,
        position: { x: 30, y: 70, z: 0 },
        peripherals: [{ name: "back", type: "modem", kind: "ender" }],
      },
    },
    {
      name: "b",
      world: {
        computerId: 12,
        position: { x: 0, y: 70, z: 9 },
        peripherals: [
          {
            name: "left",
            type: "modem",
            kind: "wired",
            block: { x: 1, y: 70, z: 9 },
          },
        ],
      },
    },
    {
      name: "c",
      world: {
        computerId: 13,
        position: { x: 5, y: 70, z: 9 },
        peripherals: [
          { name: "left", type: "modem", kind: "wired", network: "shop" },
        ],
      },
    },
  ],
  wired: [
    {
      cables: [
        { x: 2, y: 70, z: 9 },
        { x: 3, y: 70, z: 9 },
      ],
    }, // or by id, with no blocks: straight-line distances
    { id: "shop", peripherals: [{ type: "speaker" }] },
  ],
});
network.move("a", { x: 5000 }); // or { dimension: "minecraft:the_nether" }
network.setModemOn("b", "left", false); // a right-click: computer_N leaves the network, and peripheral_detach fires
```

Each computer needs its own `computerId`, and its own `seed` if it has one: rednet numbers messages with `math.random` and
drops a number it has seen for about 10 seconds, so a shared seed loses messages. `createNetwork` refuses both. A seed also
repeats a computer's own numbers after a reboot, so leave it off a computer a test reboots. Start a computer listening before
anyone transmits: a message that beats a computer's boot is gone, as on the server.

## vhcctweaks 2.2.36 (the current release)

2.2.36 is the current release (2.2.35 was never live), so a world with the addon on gets everything in the 2.2.36
contract (`docs/SPEC_2_2_36.md` in Akkiruk/vhcctweaks) without asking. `"vhcctweaks": "2.2.35"` in a world opts out and gives the
older behaviour, with none of the below; it is kept for comparisons with measurements made before 2.2.36. Code: `rom-overlay/rom/ccsim/link.lua` (links, watches) on `wiredrelay.lua` (directory, remote calls), `peripherals.lua`
(batch methods, transfers), `ccvault.lua` (allowances), the relay in `packages/runner/src/network.ts`. Tests:
`packages/runner/src/links.integration.test.ts`.

New config values (in `config`, with the server's defaults): `maxLinksPerComputer` 64, `maxBatchMoves` 256,
`batchTimeBudgetMicros` 2000, `maxWatchesPerComputer` 64, `maxAllowanceMinutes` 240, and the emulator's own
`batchMoveCostMicros` 10 (below). `interactionStaleSeconds` accepts 5 to 3600; a value outside that range falls back to 30,
as Forge does with an invalid config value.

### Linked ender modems

Several computers on one network (`craftos_network_create`), none opted out to 2.2.35. The relay keeps a
directory of every such computer (owner, dimension, ender modem, links, peripherals, loaded) and passes calls between them.

- **`link(id)`** on an ender modem returns `true`, or `false` and the first reason that applies, in the spec's order:
  `"not loaded"` (no computer with that id is running and loaded, or it opted out to 2.2.35), `"not your computer"` (the owners differ, or
  either computer has none), `"no ender modem"`, `"other dimension"`, `"too many links"`. Linking again is `true`.
  `unlink(id)` is `true` if there was a link. `getLinks()` lists ids in the order they were linked.
- **Owner:** a block computer's is its `host`. A pocket computer's is the online player using it (`interacting`), so a
  pocket nobody holds owns nothing. Names compare without case.
- **Remote peripherals** are `<id>:<name>`, `<name>` being what the other computer calls it (sides, wired names,
  monitors). They are listed by `peripheral.getNames` straight after the ender modem, in link order and then the other
  computer's own order. Its links are not passed on, and when it is asked, its ender modem's `getNamesRemote` is empty.
- **Calls** run on the other computer between its events, by the same code as its own calls. A method that waits for
  the server thread (every inventory method, Advanced Peripherals, QIO) waits the tick and loses every event meanwhile,
  as locally. Monitor, drive, printer, modem, computer and speaker-play calls keep the caller's events.
- **pushItems/pullItems** work local to remote, remote to local, remote to remote on one computer (done there in one
  piece) and between two linked computers. A cross-computer move takes out only what the target has room for, and puts
  back anything refused after all, so no items are made or lost.
- **Unload:** the `unload` sim command (or `network.unload(name)`, `craftos_network_update {loaded:false}`) stops the
  computer: every event is lost, and every linked computer gets `peripheral_detach` for each of its peripherals. Calls on
  them, wrapped or through `callRemote`, fail with `computer <id> is not loaded`, and linking to it says `"not loaded"`.
  `load` boots it afresh; linked computers get `peripheral` for each again. A computer whose engine stops counts as unloaded
  (removed). A reboot or a reload keeps what is in the computer's chests, as the world does.
- **Touches:** a monitor touch queues, on every computer linked to the monitor's computer, `vhcc_touch` with the player
  (the monitor computer's `interacting` player) and then `monitor_touch` with `<id>:<name>`, and refreshes that
  player's interaction there too.
- **Links are not saved:** a reboot of the computer that linked forgets them.

### Batch inventory methods and watches

Every inventory peripheral, local or linked, gains `listDetailed`, `moveMany`, `watch` and `unwatch`.

- `listDetailed()` is `{ [slot] = getItemDetail(slot) }` for every non-empty slot, in one server-thread call.
- `moveMany(moves)` takes a list of `{ fromSlot = n, to = "name", toSlot = n?, limit = n? }`, by name or by position
  (`{ 1, "chest", 4, 2 }`, in that order); numbers are cut towards zero. The list is read whole before any move runs
  (MoveBatch.parse): more than `maxBatchMoves` raises `too many moves (max N)`, a move that is not a table
  `bad move #i (table expected)`, a `to` that is not a string `bad move #i (to expected string)`, and a bad number
  `bad move #i (fromSlot expected number)` (`toSlot`, `limit`). Each move is then a `pushItems(to, fromSlot, limit,
toSlot)` with its errors; a move that raises ends the call with that error, and the moves before it stay done. The
  result is `{ moved = { ... }, done = k }`.
- **The time budget is deterministic:** every move costs `batchMoveCostMicros` (default 10), and the batch stops after the
  move that takes the total past `batchTimeBudgetMicros`. With the defaults a full batch of 256 stops after 201 moves;
  cost 1000 and budget 2000 stop every batch after 3. On a linked inventory whose targets are all on the same
  computer, that computer runs the whole batch.
- `watch()` starts `inventory_changed` events, with the name as the watching computer sees it (`chest`, `5:chest`).
  More than `maxWatchesPerComputer` raises `too many watches (max N)`; watching twice counts once. The emulator compares the
  contents at the end of every server tick (50 ms of virtual time) while anything is watched, so any change source counts
  (sim commands, the computer's own moves, other computers' moves, QIO machines) and a tick gives at most one event per
  inventory per watcher. A change undone within one tick sends nothing. Watches end on the watcher's reboot, on
  `unwatch`, on unlink, and when the peripheral detaches or its computer unloads; the watched computer rebooting does
  not end them.

### Spending allowances

- `ccvault.requestAllowance(player, maxTokens, minutes)` returns a request id (1, 2, ... per boot) and sends the player
  the chat prompt `<label or "Computer #id"> (owner <host>) asks to charge you up to <N> tokens over <M> minutes
[APPROVE]` (`kind: "allowance"`, with a nonce). Refusals return `nil, message`: `maxTokens must be positive`,
  `minutes must be between 1 and <maxAllowanceMinutes>`, `player not on this server` (offline and on another server are
  one answer), `player is required` (a blank name), the no-owner message, and `an allowance request to 'X' is already
  waiting` while a request from this computer to that player is unanswered. They are checked in that order; the player
  name is trimmed, here and in `getAllowance` and `endAllowance`.
- `approve` (sim command, or `autoApprove`) grants it and queues `ccvault_allowance(id, player, true)`. With no answer
  within `nonceExpirySeconds` on the virtual clock (`advance` works), `ccvault_allowance(id, player, false)`.
- `ccvault.getAllowance(player)` is `remaining, secondsLeft` (whole seconds, rounded down) or `nil`;
  `ccvault.endAllowance(player)` ends it and returns whether there was one.
- While it lasts, `transfer("player:Name", "host", n, reason)` needs no session and no touch when `n` fits in what is
  left; the player must be online. Each charge lowers it and is in the ledger. A charge bigger than what is left takes the
  normal rules. It ends when used up, at expiry, when the player leaves, and on `revoke {player}` (`/ccvault revoke`;
  `revoke` with no player ends everyone's).
- `transfer("host", "player:Name", ...)` no longer needs the player's touch; online and approved here still apply.

### The economy thread

| Calls                                                                                                                                        | Emulator (2.2.36)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ccvault.transfer`, `ccvault.getPlayerBalance`, and `ccvault.getBalance` when the target is not an online player here (an offline host, say) | They run on the mod's economy thread. The call does its checks and its work at once (a check that fails raises at once), then the calling coroutine waits for `vhcc_economy_done` with its ticket (1, 2, ... per boot) and every other event that arrives meanwhile is lost to it, as with `getItemDetail`. `terminate` during the wait errors the call with `Terminated` (positioned at the caller, like the main-thread wait); the transfer is already done. Tickets finish in the order they were issued, each at least `economyDelayTicks` server ticks after it was made (world option, default 0: the next timer; `setEconomyDelay {ticks}` changes it for later calls), so a test can hold a call open. `nil, "internal error"` from an injected error waits too. |

### Players on another server, and internal errors

The live server is one of a network: a player can be online elsewhere while the economy still knows them.

| State                                                                                  | Emulator (2.2.36)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onOtherServer: true` on a world player, or `setOnOtherServer {player, onOtherServer}` | This server counts them as offline: `getPlayerEquipment` is `nil, "player offline"`; `requestAllowance` is `nil, "player not on this server"`; a charge on their allowance returns `nil, "player not on this server"` (no error raised, nothing moves, the allowance stays); `getBalance("player:Name")`, transfers to or from them, interaction and anything else that needs them here act as for an offline player (`player 'X' is not online`). `getPlayerBalance` and `getPlayerVaultLevel` read the saved values at once (no `try again` lookup). Moving away ends their sessions and pending prompts here, as a logout does, but not their allowances. `join` or `onOtherServer: false` brings them back. |
| `refuseTransfers {times?}`                                                             | The economy refuses the next `times` transfers (default 1; -1 every one, 0 none again): `nil, "transfer failed"`, nothing moves, and a `REJECTED:` entry goes in the player's history, as `TransferService` logs it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `crashServer {onReboot?}`                                                              | The server crashes: the computer restarts and the sessions, last touch, approvals and allowances are gone; ownership and the economy stay. `onReboot: true` makes the next reboot that crash. `ComputerNetwork.crashServer()` does it to every computer.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `internalErrors: { fn: n }` in the world, or `internalError {function, times?}`        | The next `n` calls (default 1; -1 every call, 0 none again) of that `ccvault` function return `nil, "internal error"` before doing anything, so tests can check that callers cope.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### Player vault level and equipment

| Function                              | Emulator                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ccvault.getPlayerEquipment(player)`  | `{ head, chest, legs, feet, mainhand, offhand, curios = { [slotType] = { [index] = detail } } }` from the player's `equipment` in the world: `{ head: item, ..., curios: { ring: { "1": item, "2": item } } }`, items as in chests (`nbt`, `vaultData`, any fixture field). Each piece is built by the same code as `getItemDetail`, so it is identical to that item's detail in a chest. Empty slots are left out; `curios` is always there, with only slot types that hold something. Change it with `setEquipment {player, slot, item\|null}`, `{player, curio, index, item\|null}` or `{player, equipment}`; it survives a reboot. No auth, touch or range; it waits for the server tick and loses events meanwhile, like any main-thread call (the argument is checked after the wait). Online players only: `nil, "player offline"`, and `nil, "unknown player"` for a blank or unknown name. |
| `ccvault.getPlayerVaultLevel(player)` | The player's `vaultLevel` from the world's `players` (change it with the `setVaultLevel {player, level\|null}` sim command; it survives a reboot). No auth, no touch, offline players too. The name or UUID resolves as for `getPlayerBalance`, trimmed and without case, including its first `looking up player 'X' - try again` for an offline name not yet looked up. `nil, "unknown player"` for a blank or unknown name; `nil, "no vault data"` for a player without `vaultLevel` or a well-formed UUID of nobody in the world.                                                                                                                                                                                                                                                                                                                                                                |

```js
manager.createNetwork({
  computers: [
    {
      name: "vault",
      world: loadNamedWorld(dir, "linked-vault"),
      monitors: [{ name: "right", blocksWide: 3, blocksHigh: 2 }],
    },
    {
      name: "d1",
      world: loadNamedWorld(dir, "linked-display-1"),
      monitors: [{ name: "left", blocksWide: 3, blocksHigh: 2 }],
    },
    {
      name: "d2",
      world: loadNamedWorld(dir, "linked-display-2"),
      monitors: [{ name: "left", blocksWide: 3, blocksHigh: 2 }],
    },
  ],
});
```

### Choices where the spec is silent

Checked against the mod's source (2.2.36, d4605c3); each of these matches it unless a line says otherwise.

- Links go one way: A linking B shows A B's peripherals, not the reverse. Owner, dimension and ender modem are checked
  when linking only; the link then lasts until unlink, reboot, or the other computer unloading (its peripherals return
  when it loads, the link stays).
- `link`/`unlink` queue `peripheral` / `peripheral_detach` for each remote peripheral, as a wired modem attaching them does.
- An ender modem always has the link and hub methods and the `peripheral_hub` type on 2.2.36, linked or not (a CC
  peripheral's types are fixed when it attaches). It has no `getNameLocal`. Its method order is not known: the mod adds
  its methods from a `HashMap` into CC's, so the order is the JVM's, not the source's (open).
- A computer may link to itself (it passes every check); its peripherals then also appear as `<own id>:<name>`.
- `link(id)` on a link that exists is `true` before any rule is looked at, so a link to an unloaded computer, or one whose
  owner changed, still answers `true`; the rules (and `too many links`) apply to a new link only.
- `watch`/`unwatch` run on the server thread (`mainThread = true`): they wait for the server tick like the other
  inventory methods, and return nothing. `link`, `unlink` and `requestAllowance` do too; `getLinks`, the hub
  methods, `getAllowance` and `endAllowance` answer from the computer thread, at once.
- The allowance prompt is exactly the spec's sentence (no `[CCVault]` prefix), numbers without separators.
  `getAllowance`/`endAllowance` take a plain player name. The allowance applies only to `"player:Name"` as the source
  and `"host"` as the target. A new approval replaces the player's allowance on that computer.
- Allowances survive a reboot of the computer (server state); pending requests do not.
- A remote call waits for its answer with a `task_complete` event carrying a negative id, which other coroutines can see,
  as they see real main-thread tasks complete.
- If the called computer reboots in the middle of a call, the call fails with `computer <id> is not loaded`.
- `getPlayerVaultLevel` shares `getPlayerBalance`'s resolver, so the background lookup of an offline name answers once
  with its `try again` message (one lookup per player serves both functions); a UUID of nobody known is `no vault data`,
  not `unknown player`, as `getPlayerBalance` accepts any well-formed UUID.
- Players on another server: the messages are provisional until the mod's agent reports its own. Moving away keeps
  allowances (only a real disconnect, `leave`, ends them) so a charge can fail cleanly; `requestAllowance` checks it
  before "is not online".
- `getPlayerEquipment`: a known offline name is `player offline` at once (no `try again` lookup: the player list is
  what decides), and a well-formed UUID of nobody known is also `player offline`. Curio indexes come from the fixture as
  given; the emulator does not know the pack's Curios slot names or counts.

### Remote code requests (`vhcc.rcReply`)

The mod's `/vhcc pc <id> exec` has a player upload code and run it on a computer through a supervisor program. The sim
command `rcExec {player, code, request?}` stands for it (the player must be online here; `request` picks the id, default
32 random hex digits): the computer gets `vhcc_rc_exec(request, code)`, and the program answers with
`vhcc.rcReply(request, result)`.

- `rcReply` is `true` for a request this computer was sent and has not answered, `false` for anything else (another
  computer's request, an unknown or answered id). Both arguments are strings.
- The answer reaches the player as chat, `kind: "rc"`: `[vhcc-rc] {"exec":id,"result":text,"truncated":bool}`, a result
  over 64 KB cut to 64 KB. If the line would pass 260,000 characters once escaped for chat (a result full of quotes),
  the player gets `{"exec":id,"ok":false,"error":"reply too large for one chat line"}` instead. A player who has left is not told.
- At most 32 requests wait; the 33rd is refused. A request older than 60 seconds is dropped when the next one is made, not
  before. Requests belong to the server: a reboot of the computer keeps them.
- Not emulated: the audit log, the controller guard on CCVault transfers, and the chat commands themselves.

### vaultData and rawNbt

`vaultData` is whatever the fixture contains. The mod adds `rawNbt`, the item's NBT as the game prints it (SNBT, up to 32 KB),
only to items it has no parser for (`itemType = "VaultItem"`) that have NBT; parsed types (`Gear`, `Trinket`, ...) do not carry
it since 2.2.36. Fixtures write it in `vaultData`; the sim does not derive it from `nbt`.

## vhcctweaks 2.2.37 (the 2.2.37 API, behind a world option)

2.2.37 is built against Vault Hunters 3.21.74 and reads what that update added: Gear Score, Gear Power, Temper and Dust.
Its contract is the mod's 2.2.37 spec; the emulator models that API, and none of it is measured in the game yet. No
world gets it by default: a world asks with `"vhcctweaks": "2.2.37"` and then has everything of 2.2.36 plus the below. Worlds on 2.2.36 (the
default) and 2.2.35 have none of these functions, fields or checks. This is how 2.2.36 came in too: behind the option
first, the default once the mod was released.

**Charging a named player needs only their approval.** From vhcctweaks e7c880a (2.2.37), `"player:Name"` as the payer
is checked for being online and having approved this computer, and nothing else: no fresh touch within
`interactionStaleSeconds`. The approval session (until they disconnect or go idle `authIdleTimeoutMinutes`) is the whole
permission. A 2.2.36 world keeps the touch rule. (`resolveNamedPlayer` in `ccvault.lua`.)

Code: `rom-overlay/rom/ccsim/vhcc237.lua` (the player functions, `getLimits`, item details), `vhcc.lua` (`getUsage`),
`peripherals.lua` (`expectName`). Tests: `packages/runner/src/vhcc237.integration.test.ts`.

**What is the world's and what is worked out.** Vault Hunters' scorer, its Temper ladder and its saved profiles are
not modelled. A world says what each slot scores, what each Temper category multiplies by and what a piece scores; the
emulator gives the answers the mod's shape, derived numbers, missing fields and errors. What is modelled rather than measured is said with each part below.

### World fields

On a player (all optional):

```jsonc
{
  "vhcctweaks": "2.2.37",
  "players": [
    {
      "name": "Mira",
      "vaultLevel": 104,
      "greedTier": 2, // default 0
      "gearPower": {
        // slot scores, 0 to 1500; a slot left out scores 0. weapon is the best weapon on the hotbar
        "slots": {
          "head": 900,
          "chest": 1000,
          "legs": 800,
          "feet": 700,
          "weapon": 1199,
          "offhand": 0,
        },
        // optional, per slot: status, item, name, and for the weapon hotbarSlot (1-9) and hotbarWeapons.
        // false: Vault Hunters could not explain the slots, and slotDetails is left out of the answer
        "slotDetails": {
          "weapon": {
            "item": "the_vault:sword",
            "name": "Blade",
            "hotbarSlot": 3,
            "hotbarWeapons": 2,
          },
        },
        "peak": 2100, // peakGearPower; default 0, never raised by the emulator
      },
      "temper": {
        "dust": 1234,
        // level 0 to 400; multiplier and power are the world's (default 1 at level 0)
        "might": { "level": 40, "multiplier": 2, "power": 1.4 },
        "magic": { "level": 120, "multiplier": 3.5, "power": 2.25 },
        "vigor": { "level": 10, "multiplier": 1.5, "power": 1.1 },
        "tool": { "level": 5, "multiplier": 1.25, "power": 1.05 },
        "bossesBeaten": 3,
        "trialsRecord": 17,
        "favorsUsed": 4,
      },
      "reputation": { "velara": 12, "tenos": -3, "wendarr": 0, "idona": 7 }, // each default 0
    },
  ],
}
```

On the world: `gearPowerAvailable: false` stands for a server whose Vault Hunters is older than 3.21.74. In `config`:
`gearScore` and `gearScoreLines` (the mod's `vaultDetails.gearScore` and `vaultDetails.gearScoreLines`, both default
true), `maxBytesPerComputer` (default 16777216), and the emulator's own `gearPowerMinLevel` (Vault Hunters'
`minLevel`, default 100).

Sim commands, each replacing what the player had (null takes it away): `setGearPower {player, gearPower}`,
`setTemper {player, temper}`, `setReputation {player, reputation}`, `setGreedTier {player, greedTier}`. What they set
survives a reboot of the computer (`vaultStats` in the sim state). `internalError` covers the new functions.

### Player functions

All three take a name or a UUID, resolved as for `getPlayerVaultLevel`: trimmed, without case, `nil, "unknown player"`
for a blank or unknown name, and `nil, "looking up player 'X' - try again"` on the first call for an offline name (not
for one on another server of the network). No auth, touch or range; each waits for the server tick. A player counts as
online only on this server: offline and `onOtherServer` players are read from what is saved.

| Function                              | Emulator                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ccvault.getPlayerGearPower(player)`  | On this server at or above `minLevel`: `online = true`, `shown = true`, `level` (the player's `vaultLevel`, 0 without one), `minLevel`, `greedTier`, `peakGearPower`, `slots` (all six, from the world), `gearScoreExact` (their mean), `gearScore` (rounded), `might`/`magic`/`vigor` (the Temper multipliers, 1 without one), `temper` (`(max(might, magic) + vigor) / 2`), `gearPower` (`round(gearScoreExact * temper)`) and `slotDetails`. A slot's `status` is the world's, or `COUNTED` for a score above 0, `EMPTY` for 0 (`NO_WEAPON` for the weapon); a slot whose status is not `COUNTED` scores 0. `item` and `name` are the world's, or those of the piece in the player's `equipment` (never for the weapon). Below `minLevel`: `online`, `shown = false`, `level`, `minLevel`, `greedTier`, `peakGearPower`. Not on this server: `{ online = false, shown = false, level, peakGearPower }`. `nil, "no vault data"` for a player not here with no `vaultLevel`, `temper` or `gearPower`, and for a well-formed UUID of nobody; `nil, "gear power not available"` on an old Vault Hunters. |
| `ccvault.getPlayerTemper(player)`     | `online`, `dust`, `might`/`magic`/`vigor`/`tool` as `{ level, multiplier, power }`, `gearPowerMultiplier`, `peakGearPower`, `trialsRecord`, and for a player on this server `bossesBeaten` and `favorsUsed`. A player with no `temper` has zero Dust, zero levels and multipliers of 1. A category with a level above 0 and no multiplier in the world has none in the answer, and then `gearPowerMultiplier` is left out too: that is what the mod gives when it cannot read the ladder. `nil, "no vault data"` as above; `nil, "temper not available"` for a player here on an old Vault Hunters (for one not here, levels without multipliers).                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `ccvault.getPlayerReputation(player)` | `{ velara, tenos, wendarr, idona }` for a player on this server; `nil, "player offline"` for anyone else, a well-formed UUID of nobody included.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

`ccvault.getPlayerVaultLevel` is unchanged and has no cap: a world's `vaultLevel` above 100 is returned as it is.

### Item details

Items still carry the `vaultData` the world gives them. On a 2.2.37 world the detail (from `getItemDetail`,
`listDetailed` and `getPlayerEquipment`) is a copy with what the mod's provider always adds:

- `durability.max`, the same number as `durability.total`.
- `chance` and `amount` beside `first` and `second` in the value of a modifier whose `attribute` is
  `the_vault:on_kill_heal` or `the_vault:block_heal`.
- `isLegendary = true` on `Gear`, `Tool` and `Jewel` when one of its modifiers has `legendary = true`.
- `greedTier` only when it is above 0.
- Gear Score, for identified `Gear` whose world `vaultData` has `gearScore` (or `gearScoreExact`) or `gearScoreStatus`:
  `gearScoreStatus` (default `COUNTED`), and when counted `gearScoreExact`, `gearScore` (rounded) and
  `gearScoreLines = { expected, actual }`, where `actual` is the piece's modifier count and `expected` the world's
  `gearScoreLines.expected` (default: `actual`). Each modifier with a `scoreRatio` from the world gets
  `scorePoints = 1000 * scoreRatio / max(expected, actual)` and keeps `naturalBest`/`naturalWorst` when it has both,
  with `naturalBestAtLevel`/`naturalWorstAtLevel` beside them: the world's, or at level 100 (or with no `level`) the
  same pair, and below 100 the pair scaled by `level / 100` (row 193). Ability and talent level lines
  (`value = { ability | talent, levelChange }`) always have `scoreRatio = 1` and no range; a heal pair with no ratio
  from the world counts 1. A `UNIQUE` piece's expected line count is its own. A piece that is not `COUNTED` (a broken one is `INERT`) has only the status. Anything that is not identified gear
  loses these fields. `config.gearScore = false` or `gearPowerAvailable: false` takes all of it off;
  `config.gearScoreLines = false` takes the per-modifier fields off.

Everything else the spec lists (`attribute` on modifiers, the legendary flag before identification, jewel `size`,
`state` and `identified`, tool `capacity`, `hammerSize`, `material`, `isSoulbound`, `craftingPotential`) is in the
answer when the world's `vaultData` has it. There is no scorer: a piece with no `gearScore` in the world has no score.
A 2.2.36 world passes `vaultData` through untouched, as before.

### Smaller additions

- `ccvault.getLimits()`: the sixteen keys of the spec from `config` and the mod's defaults; `vhccMaxBytesPerComputer`
  is `maxBytesPerComputer`, `gearScoreInDetails` and `gearScoreLinesInDetails` are `gearScore` and `gearScoreLines`,
  `containerItems` and `identify` are the switches of the same names, and `statCaps` is the coded table of section
  9.4 (absent with `gearPowerAvailable: false`).
- `vhcc.getUsage()`: `used, limit`. Every file and folder counts as at least 4096 bytes, the computer's own folder
  included; a computer that has written nothing uses 0. Counted afresh on every call.
- `moveMany` and `expectName`: a move with `expectName = "mod:item"` moves 0 when `fromSlot` holds another item or
  nothing, and the batch goes on. It is read by name only. A value that is not a string raises
  `bad move #n (expectName expected string)` before any move runs (after the check of `to`, before `fromSlot`'s).
  Slots and targets are checked as for any move. Also on a linked computer's chest.

### Skills, stat totals, the counted weapon (section 9)

Code: `vhcc237.lua`. Tests: `packages/runner/src/vhcc237-players.integration.test.ts`. Gaps: rows 190 to 194.

On a player (all optional; sim commands `setSkills {player, skills}` and `setStats {player, stats}` replace them, and
they survive a reboot):

```jsonc
{
  "skills": {
    // each tree a list in the skill tree's order, or false: it cannot be read and is left out
    "abilities": [
      // level: what works, gear bonuses included (online only); learned: the points put in; only learned > 0 listed
      {
        "id": "Dash",
        "learned": 3,
        "level": 4,
        "maxLevel": 5,
        "specialization": "Dash_Warp",
        "specializationName": "Warp",
        "specializationIndex": 1,
      },
    ],
    "selectedAbility": "Dash", // or "selected": true on the ability
    "talents": [{ "id": "Haste", "learned": 2, "maxLevel": 6 }],
    "expertises": [],
    "prestige": false,
    "spentPoints": { "abilities": 12 }, // per tree; default the sum of learned
  },
  // by attribute id: a number, or { value | uncapped, limit, name, display, percent, extra }
  "stats": {
    "the_vault:cooldown_reduction": { "uncapped": 0.9 },
    "the_vault:health": 40,
  },
  "equipment": {
    "hotbar": {
      "1": {
        "name": "the_vault:sword",
        "count": 1,
        "vaultData": { "...": "..." },
      },
    },
    "selectedHotbarSlot": 1, // default 1
    "weaponHotbarSlot": 1, // optional: overrides the emulator's pick
  },
}
```

- `ccvault.getPlayerSkills(player)`: `online`, the four lists and `spentPoints`, resolved like the other player
  functions. Not on this server: the same record as the saved profile, `level = learned` and no `selected`. Names
  default to the id in title case, `specialization` to the ability's id with index 0, `maxLevel` to the learned
  level. `nil, "no vault data"` for a player not here with no saved profile (no `vaultLevel`, `temper`, `gearPower`
  or `skills`) and for a UUID of nobody; `skills: false` is `nil, "skills not available"`.
- `ccvault.getPlayerStats(player)`: `{ [id] = { name, value, display, limit?, uncapped?, hitLimit?, extra? } }` for
  the stats the world gives. The six capped stats (cooldown reduction, block, resistance, area of effect, durability
  wear reduction, lucky hit) get `limit` (the world's, default the base cap, never above the max), `uncapped` and
  `value = min(uncapped, limit)`, `hitLimit`. `display` is a percentage to one decimal place for capped stats and
  `percent` ones, two places otherwise, unless the world gives it. `nil, "player offline"` for anyone not on this
  server, `stats: false` is `nil, "stats not available"`.
- `ccvault.getPlayerEquipment(player)` also has `hotbar` (`{ [1..9] = detail }`), `selectedHotbarSlot`, and `weapon`
  with `weaponHotbarSlot`. With a `hotbar` in the world, `mainhand` is the held slot's item; without one the held slot
  holds `mainhand`. The weapon is the world's `weaponHotbarSlot` or the hotbar's identified main-hand `Gear`
  (`vaultData.equipmentSlot = "mainhand"`, else gear type sword, axe, battlestaff, trident or rang; not broken) with
  the best `gearScore`, the held slot first on a tie, then the lowest slot. `getPlayerGearPower`'s
  `slotDetails.weapon` names the same piece (`item`, `name`, `hotbarSlot`, `hotbarWeapons`) when the world's
  `slotDetails.weapon` does not.

### Items inside container items, and identify

Every inventory of a 2.2.37 world, local or linked, has `listContents`, `pushContents` and `identify`, and `moveMany`
reads `inner`. Code: `core.v37inventory` in `vhcc237.lua`, wired into `newInventory` and the linked-computer proxy in
`peripherals.lua` (and `ops.inner` in `wiredrelay.lua`). Tests: `packages/runner/src/vhcc237-containers.integration.test.ts`.
Chosen where the spec is silent: what counts as a container (by item id), the nbt hash of a filled shulker box or
vault barrel (the emulator's own), the order of the refusal reasons, and identify's roll (not Vault Hunters').

A container item is a world item that carries its contents:

```jsonc
{
  "name": "sophisticatedbackpacks:backpack", // iron_, gold_, diamond_, netherite_backpack: 54, 81, 108, 120 slots
  "count": 1,
  "nbt": "b0a1c2", // a backpack's nbt never changes with its contents
  "contents": { "1": { "name": "minecraft:diamond", "count": 5 } }, // absent: empty (never opened)
  "outputFilter": { "allow": ["minecraft:stick"] }, // optional: a filter upgrade ("deny" too)
  "containerSlots": 27, // optional: overrides the slot count
}
```

- Containers, in the spec's order: the five Sophisticated Backpacks ids or any item with `itemHandler: true`;
  `minecraft:shulker_box` and its colours (27 slots); `the_vault:wooden_barrel` (36) and the living, gilded and ornate
  vault barrels (45). A stack of more than one never is. One level deep: a backpack inside one is listed and moved out
  as an item. `contents` (and the other fixture fields) never show in `getItemDetail`.
- A backpack changes in place and keeps its nbt; the inventory watch still sees it (`inventory_changed`). A shulker box
  or barrel is replaced by a copy whose nbt hash follows its contents, and loses its nbt once emptied (unless the world
  gave it `blockEntityTag`). A filled one given without `nbt` gets a hash at boot.
- `listContents(slot [, detailed])`: `contents, size` (`list()`-shaped, or `getItemDetail`-shaped with `detailed`), or
  `nil, "empty slot" | "container items are turned off" | "not a container"`. Raises for a slot out of range.
- `pushContents(toName, slot, innerSlot [, limit [, toSlot]])`: raises what `pushItems` raises; a limit of 0 or less, an
  empty inner slot, a full target or a refusing filter moves 0 with no reason; `0, reason` for `empty slot`,
  `container items are turned off`, `not a container`, `inner slot out of range (between 1 and M)` and
  `can't change items in this inventory` (a peripheral with `canChangeItems: false`), in that order. Into the target
  first, then out of the container; at most one normal stack per move, a big slot (count above 64) included.
- `moveMany` with `inner = n` (by key only; `bad move #n (inner expected number)`) is that same move inside a batch: any
  reason makes it 0 and the batch goes on, `expectName` checks the inner item, and it counts against `maxBatchMoves` and
  the time budget like any move.
- `identify(slot, player [, innerSlot])` for a piece whose `vaultData.state` is `UNIDENTIFIED`: the reasons in the
  spec's order. The player must be online here and have an approval session on this computer (`ccvault.requestAuth()`,
  the one `"player:Name"` transfers use); each identify past those checks refreshes it. The piece's `identifiesTo` is
  the vaultData it gets; without it, the level and other fields stay, the rarity is rolled from `vaultData.rollPool`
  (`"Omega"`, `"Rare+"`, a list) or a `rarity` given without a pool is kept, and seeded made-up modifiers are added
  (`world.seed` pins them). `ROLLING` is "being identified"; an item with no `state` or `identifiable: false` is "not
  identifiable". `identifyAvailable: false` on the world is a Vault Hunters that cannot identify.
- `config.containerItems` and `config.identify` (both default true) are the mod's `inventory.containerItems` and
  `inventory.identify`; off, they give the spec's reasons, and an inner move in `moveMany` moves 0.
- On a linked computer's chest `listContents` is a call to that computer; `pushContents` and inner moves ask it first
  and then move the item over; `identify` checks the approval on the calling computer.

## Not emulated

- The vault item detail provider itself (`vaultData` is whatever your fixtures contain, `rawNbt` included; on 2.2.37
  the few derived fields above are added). Vault Hunters' gear scorer and Temper ladder.
- Turtles and command computers (the mod also disables command computers).
- AP types and integrations that are disabled, unusable, or not needed here; the list and reasons
  are in [advanced-peripherals.md](advanced-peripherals.md).
