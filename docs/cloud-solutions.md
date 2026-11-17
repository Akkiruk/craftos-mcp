# SirEdvin's Cloud Solutions

Addon id `cloud-solutions`. SirEdvin's Cloud Solutions, release 0.3.4: `1.20.1-0.3.4` on Minecraft 1.20.1 (Forge and
Fabric) and `1.21.1-0.3.4` on 1.21.1 (NeoForge and Fabric). There is no 1.18.2 release.

Written from [SirEdvin/CloudSolutions](https://github.com/SirEdvin/CloudSolutions) at the tags `v1.20.1-0.3.4` and
`v1.21.1-0.3.4` (the peripherals are the same in both), with Tweakium 1.4.10
([SirEdvin/Minecraft-Modding-Libs](https://github.com/SirEdvin/Minecraft-Modding-Libs)) for `OwnedPeripheral`. Paths
below are under `projects/core/src/main/kotlin/site/siredvin/cloudsolutions/`. The mod is not in the pack, so nothing
here was measured in game. The module is `rom-overlay/rom/ccsim/addons/cloud-solutions/`.

The mod brings "cloud services" into the game: a key-value store, a message broker (Crafka) and a StatsD bridge, each
a block whose data belongs to the player who placed it. It keeps its data in SQLite files in the world folder
(`cloudsolutions/kv.db`, `crafka_broker.db`); the sim keeps the same tables in memory, answers the same queries and
saves them in state.json, so they survive a reboot.

## What is emulated

31 methods on 3 peripheral types. None of them waits for a server tick except the KV storage's `getSubscriptions`,
`subscribe` and `unsubscribe` (`mainThread = true`).

| Type            | Methods                                                                                                                                                                                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kv_storage`    | `put(key, value, expire?)`, `delete(key)`, `get(key)`, `mget(keys)`, `mput(values)`, `get_ex(key)`, `put_ex(key, expire?)`, `list(glob?)`, `incr(key, by?)`, `decr(key, by?)`, `getSubscriptions(kind)`, `subscribe(kind, pattern)`, `unsubscribe(kind, pattern)`, `getConfiguration()` |
| `crafka_broker` | `createTopic(name, messageLimit?)`, `listTopics()`, `deleteTopic(name)`, `publish(name, message)`, `fetchMessages(name, from)`, `describeTopic(name)`, `subscribe(name, options?)`, `unsubscribe(name)`, `getSubscription(name)`, `setCursor(name, cursor)`, `getConfiguration()`       |
| `statsd_bridge` | `count(aspect, n)`, `delta(aspect, n)`, `gauge(aspect, n)`, `set(aspect, event)`, `time(aspect, ms)`, `getConfiguration()`                                                                                                                                                              |

| Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Source                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------ | --------------------------------------------- | ------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Every block needs its owner: `Cannot find attached player to this peripheral` (StatsD: `Cannot find owner`, and the owner must be online). All of a player's KV blocks share one store, all of a player's brokers one set of topics.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `computercraft/peripheral/*Peripheral.kt`                                                                                             |
| KV `put`: a value over 500000 characters is `Value is too long`; with as many keys as the limit allows (count + new >= 10240) `false, "Too many keys in KV storage"`; else `true`. `expire` is an epoch second; a key past it reads as missing until the minute's cleanup deletes it (and tells subscribers). `get_ex` gives the expiry or nil, `put_ex` sets or clears it.                                                                                                                                                                                                                                                                                                                                                      | `KVStoragePeripheral.kt`; `subsystems/kv/sqlite/KVSQLiteManager.kt`                                                                   |
| `mput` stores every entry (keys and values through Java's `toString`, so the number 3 is `"3.0"`) and answers how many; `{}` is `false, "Where is values?"`, too many is `false, "Too many keys already exists"`. `mget` takes a list of keys and answers the ones there. `delete` is always `true`.                                                                                                                                                                                                                                                                                                                                                                                                                             | `KVSQLiteManager.kt`                                                                                                                  |
| `list(glob)` is SQL `LIKE` (`%` any run, `_` one character, ASCII letters in any case), in key order (SQLite walks the unique index).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `KVSQLiteManager.list`                                                                                                                |
| `incr`/`decr` (by 1 by default): a new key starts at the amount as Java prints it (`"1.0"`); an existing one is `CAST(CAST(value AS DOUBLE) + by AS VARCHAR)`, so text counts as its leading number (`"12apples"` + 1 is 13) and the result is SQLite's 15-digit text (`0.1 + 0.2` is `"0.3"`). They answer the new value.                                                                                                                                                                                                                                                                                                                                                                                                       | `KVSQLiteManager.incr`                                                                                                                |
| Subscriptions (`changed`, `deleted`) are Java regular expressions that must match the whole key, kept per block and per computer. A matching write (by any of the owner's computers) queues `kv_storage_key_changed` (key, value) or `kv_storage_key_deleted` (key). Other kinds: `You can subscribe only to changed or deleted events` (and the list/unsubscribe forms). The mod saves both kinds under one NBT tag, so after a reboot both kinds come back as whichever was saved last.                                                                                                                                                                                                                                        | `KVStoragePeripheral.kt` (`KV_STORAGE_DELETED_SUBS` is `"kv_storage_changed_subs"` too)                                               |
| Crafka topics belong to the owner: at most 512 (`false, "Too many topics"`), each keeping its newest `messageLimit` messages (at most 512; the minute's cleanup drops the oldest). Messages are numbered from 1 per topic. `createTopic` twice: `nil, "Such topic already exists"`. Messages over 500000 characters: `false, "Message is too big"`. An unknown topic: `false, "There is no such topic"` (`getSubscription`: `nil, ...`; `fetchMessages` and `describeTopic`: `{}`).                                                                                                                                                                                                                                              | `computercraft/peripheral/CrafkaBrokerPeripheral.kt`; `subsystems/crafka/CrafkaSQLiteManager.kt`                                      |
| `subscribe(name, { cursor = 0, autoCursor = true, fragile = false })` answers `true, id`; each message after the cursor arrives as `crafka_broker_message` (topic, id, message), what was published already first. With `autoCursor` the cursor follows; without it the message comes again after 100 ms, then 200, 300, ... (each wait one step longer) until `setCursor` moves past it, and after 21 tries the subscription is dropped. `setCursor` only moves forward. A second subscription of the same computer to a topic is SQLite's unique constraint error. A fragile subscription goes when the computer detaches, or when a message finds its computer gone. Deleting a topic deletes its messages and subscriptions. | `CrafkaSQLiteManager` (`subscribe`, `revalidateSubscription`, `publishMessageToSubscription`, `onComputerDetach`, `onComputerAttach`) |
| StatsD: each call takes a permit from the global limiter (21000 a minute: `Too many requests to server, please wait a little`) and the owner's (1000 a minute: `Too many request from you, please wait a little`), Guava's smooth rate limiter starting empty; then, with the connection off (the default), `Statsd Bridge is disabled in server configuration`. With it on, the line goes out as `<prefix>.<player>.<aspect>:<n>                                                                                                                                                                                                                                                                                                | c` (`                                                                                                                                 | g`gauge,`+n | g`/`-n | g`delta, a negative gauge first resets to 0,` | s`set,` | ms` time); the sim records the lines in state.json. | `computercraft/peripheral/StatsDBridgePeripheral.kt`; `subsystems/statsq/StatsDClient.kt` |
| `getConfiguration`: KV `keyLimit`, `valueLimit`; broker `topicLimit`, `maxMessageLimit` (the message size limit: the mod reads the wrong setting), `maxMessageSize`, `maxResendSteps`, `resendDelay`; StatsD `playerRateLimit`, `globalRateLimit`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | the peripherals' `peripheralConfiguration`                                                                                            |

## The world

```json
{
  "version": "1.20.1",
  "addons": ["cloud-solutions"],
  "cloudSolutions": {
    "owner": "8667ba71-b85a-4004-af54-457a9734eed7",
    "ownerName": "Steve",
    "ownerOnline": true,
    "kv": {
      "8667ba71-b85a-4004-af54-457a9734eed7": {
        "score.Alex": "150",
        "temp": { "value": "x", "expire": 1800000000 }
      }
    },
    "config": {
      "kvStorageKeyLimit": 10240,
      "enableStatsDConnection": false,
      "statsdPrefix": ""
    }
  },
  "peripherals": [
    { "name": "kv_storage_0", "type": "kv_storage" },
    { "name": "crafka_broker_0", "type": "crafka_broker" },
    { "name": "statsd_bridge_0", "type": "statsd_bridge" },
    { "name": "kv_storage_1", "type": "kv_storage", "owner": false }
  ]
}
```

- **`owner`** (a player UUID) placed every block, unless a block names its own `owner` (`false`: nobody, the
  "Cannot find attached player" case). **`ownerName`** is the name StatsD aspects start with, **`ownerOnline`**
  whether that player is on the server (StatsD needs it).
- **`kv`**: the store at boot, by owner: key to value, or to `{ value, expire }`.
- **`config`**: the mod's server config keys: `kvStorageMode` (`SQLITE` or `DISABLED`), `kvStorageKeyLimit`,
  `kvStorageValueLimit`, `crafkaStorageMode`, `crafkaTopicLimit`, `crafkaTopicSizeLimit`, `crafkaMessageSizeLimit`,
  `crafkaMaxResendSteps`, `crafkaCursorRevalidationDelay`, `enableStatsDConnection`, `statsdPrefix`,
  `statsdPlayerRateLimit`, `statsdGlobalRateLimit`. With KV disabled every KV call is `KV storage is disabled in
server configuration`; with Crafka disabled every broker call is a `NullPointerException`, as in the mod.
- A KV block's subscriptions can start from `subscriptions`: `{ pattern = { computerId, ... } }`.

## Sim commands

| Command                               | Does                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------ |
| `csPut {key, value, owner?, expire?}` | another computer of the owner writes a key (`value: null` deletes it); subscribers hear it |
| `csPublish {topic, message, owner?}`  | another computer publishes on a topic                                                      |
| `csSetOwnerOnline {online}`           | the owner joins or leaves the server                                                       |

## Not emulated

- **The TSDB storage** (`registerTimeseries`, `queryTimeseries`, `getTimeseries`, `postMeasurement`): the release
  hard-codes `enableTSDBStorage` to false, so the block is off; `queryTimeseries` and `getTimeseries` are stubs even in
  the source.
- **Other computers**: the store, the topics and the events are the server's in game; in the sim each computer has
  its own copy (sim commands stand in for the others). A subscription of another computer id counts as a computer
  that is not running.
- **Turtle and pocket upgrades** of the KV storage and the broker.
- **Real StatsD packets**: nothing leaves the emulator; the lines are recorded.
- **Java regular expressions** are a subset (no lookaround, backreferences, possessive quantifiers or inline flags);
  a pattern outside it fails at the first write it is checked against, as a broken one does in game, but with the
  sim's own message.
- **SQLite's exact row order** where the mod does not ask for one: keys and topic names come sorted, which is how
  SQLite walks the unique indexes those queries use.
- **The rate limiters** run on the emulator's clock with the same rates; the exact moment a permit frees differs by
  what the computer does in between.
