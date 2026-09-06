# The Constellation

One flow across every repo, offline first.

## The problem this closes

The system was seventeen repos and about forty routes, and nothing anywhere
could answer two questions a person actually has: *what is this made of*, and
*what of it is running right now*. Each surface knew its own corner. The map
lived in someone's head, which meant a station that had quietly stopped working
stayed broken until somebody went looking.

`/workstation` is that map, made of live checks instead of memory, with one next
step at the top of it.

## The walk

Four stages, in the order they have to hold:

| Stage | What it establishes | Gated by |
|---|---|---|
| **Ignition** | The shell is up and the device granted room to hold the system offline | `jackie-shell`, `partitions` |
| **Core** | Identity, vault, and the engine that decides where work runs | `vault` |
| **Workstation** | The desk: the PC, the foundry, the mesh, the pods | `workstation-pc` |
| **Field** | Everything that runs away from this screen — hosts, phones, agents | nothing (declared) |

A stage is blocked when a station marked `required` did not answer a check. The
flow does not advance past a blocked stage, and the next action points at the
blocker rather than at the desk. `resolveFlow` is pure — statuses in, flow out —
so the refusal to advance is a unit test, not something you have to unplug a
machine to see.

## The stations

Declared once, in `src/lib/constellation/stations.ts`, and checked against the
route manifest by `src/test/constellation-stations.test.ts` so an in-app station
can never point at a route the router does not serve.

| Station | Repo | Offline | How it is checked |
|---|---|---|---|
| Jackie | `sasjacky777-d1033916` | full | in-app |
| Offline Partitions | `sasjacky777-d1033916` | full | `navigator.storage.estimate()` against the partition floors |
| Vault | `core-light-vault` | full | in-app |
| Core Keeper | `jackie-core-keeper` | full | in-app |
| Jacky Engine | `jacky` | sync | `jacky-proxy → /api/status` |
| Jacky Console | `Jacky-Console-` | sync | in-app |
| The PC | `my-pc-companion` | full | `GET /pc-os/index.html` |
| Bot Foundry, Router Mesh, Pod Station | `sasjacky777-d1033916` | sync / full | in-app |
| Ollama Host | `jacky` | full | `GET localhost:11434/api/tags` |
| Off Grid Mobile, LLMFarm, MobileLLM, llama.cpp, MobileRun, Xagent | own repos | full / sync | **declared** |

`declared` is not a soft `live`. It means real, named, and not observable from a
browser — an iOS app, an Android driver, a C++ library. Reporting those as live
because the repo exists would be a lie the panel then repeats every time it
loads, so the probe refuses to make it and the flow never counts them as
running.

## Offline is the product

Online is a sync-and-download hub. Nothing in the walk depends on it: every
`required` station is `offline: "full"`, asserted by a test, so the flow cannot
become online-only by accident.

### Partitions

Six partitions, declared in `src/lib/partitions/registry.ts`, each owning one
purpose and reserving its own share of the device budget up front:

| Partition | Floor | Tier | Backups | Router |
|---|---|---|---|---|
| Vault | 64 MB | critical | 5 | keeper |
| Model Bay | 1200 MB | critical | 1 | operator |
| Context Store | 256 MB | critical | 3 | recall |
| Conversations | 128 MB | standard | 5 | recall |
| Pod State | 64 MB | standard | 3 | maker |
| Media Cache | 32 MB | standard | 1 | maker |

`planBudget(mb)` divides a real quota: critical floors first, then standard
floors, then the surplus by weight. A device that cannot cover the critical
floors comes back `viable: false` with the short partitions named — and the
ignition stage blocks on it, rather than letting you download a model into a bay
that cannot hold one.

Every write carries an FNV-1a checksum. A read whose body no longer matches
throws instead of returning damaged content, and `heal()` restores from the
newest backup whose own checksum still verifies, then re-verifies and reports
whether it actually worked. A heal that could not fix it says so.

Backups live beside the records they copy, under a reserved key prefix, so a
restore needs no network and cannot be stranded by a device that dropped one
database and kept another.

**A backup never captures damage.** `backup()` verifies before it copies and
refuses a partition holding a bad record. This is not defensive padding — the
first version copied first and verified second, and a test caught what that
costs: copying a corrupted record produces a backup that is itself perfectly
valid (its checksum covers the damaged body), so the next restore hands the
damage straight back, and the rotation pushes the last good copy out to make
room for it. Restore is guarded from the other side too: a copy that is intact
as a file but holds records failing their own checksums is skipped, and an
older one is tried.

### Sync

`runSync` takes steps that each declare whether they need a network, and skips —
does not fail — the network ones when there isn't one. The order is fixed: back
up, verify and heal, *then* talk to the network. A sync that fetched first could
overwrite good local state with bad remote state and have nothing to go back to.

The backup step names any partition it passed over as damaged, so a sync that
copied less than the whole system says so rather than reporting a clean run.

## Crew

`src/lib/constellation/integrations.ts` holds the roster: seventy-odd tools
across nine areas, one specialist per area rather than one tool stretched over
all of them, and a priority stack of fifteen brought in first.

The useful half is `buildCompatibilityReport`, which names the exact capability
each tool is missing. `capabilitiesFrom` derives that environment from the
constellation's own sweep — `localOllama` because a probe got a model list back,
`python`/`gpu`/`cloudProxy` because the Jacky engine answered and reports GPU
thermals. What a browser cannot observe (Docker, Node, a VS Code extension host)
defaults to false and must be supplied by the host. A capability is claimed on
evidence or not at all, because being wrong costs a failed start.

Requirements are typed as `keyof EnvironmentCapabilities`, so a misspelt
requirement is a compile error rather than a tool that reports itself compatible
because nothing in the environment matched its typo.

## Micro-AI context routers

A micro model is small enough to run on the device and too small to know
everything, so the unit is a model *plus the slice of storage it is expert in*.
Four routers, in `src/lib/microai/contextRouter.ts`:

| Router | Specialty | Reads | Ladder |
|---|---|---|---|
| **Recall** | What was said, decided or stored before | context, conversations | device → LAN → network |
| **Keeper** | Identity, keys, vault records | vault | device only |
| **Operator** | Running models and reading the machine | models | device → LAN |
| **Maker** | Building pods, images, audio, surfaces | pods, media | device → LAN → network |

Each router's `reads` is derived from the partition table rather than written
twice, so the two cannot drift.

`selectEngine` walks the ladder and returns nothing at all rather than reaching
for a network engine while offline. Keeper has no network rung at any
connectivity — vault context does not leave the device, and the test asserts the
engine that comes back, not that a check was performed.

## Where things live

```
src/lib/constellation/
  types.ts      the Station and StationProbe contracts
  probes.ts     the four ways a station can be checked
  stations.ts   the station table + the real boundaries
  flow.ts       resolveFlow — pure, the four-stage walk
  service.ts    owns statuses, runs sweeps, projects a snapshot
  sync.ts       runSync — offline-tolerant step runner
  steps.ts      the real steps, wired to the services
src/lib/partitions/
  types.ts registry.ts store.ts service.ts budget.ts index.ts
src/lib/microai/contextRouter.ts
src/pages/Workstation.tsx   the View: observes, dispatches, decides nothing
src/hooks/useConstellation.ts
```

## Adding to it

- **A station**: one entry in `stations.ts` with a probe. No caller changes.
- **A partition**: one entry in `registry.ts`. Its router picks it up for free.
- **A new kind of check**: a new probe in `probes.ts`. The service does not
  learn about it.

## Not in the constellation

`awesome-go`, `awesome-selfhosted`, `terraform-google-cloud-storage`,
`task-manager-enhanced` and `SAS_opencode_Ai` are in the same account but are not
part of this system — upstream lists, unrelated infrastructure, and a separate
editor. They are left out on purpose rather than listed to make the map look
fuller.
