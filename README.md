# Tep — live Prague public transport map

### **[tep.today](https://tep.today)**

Tep ("pulse" in Czech) shows every Prague tram, bus, metro and train moving in real
time on a WebGL map — hundreds of vehicles, sub-second updates, straight from the
city's open transit feed.

> **Open source** · built and hosted on **[Zerops](https://zerops.io)**

## Features

- **Live vehicle map** — hundreds of trams, buses, metro and trains updating in real time on a smooth WebGL vector map.
- **Sub-second updates over SSE** — the browser subscribes to a delta stream; no polling, no hammering the upstream feed.
- **Cached read path** — a Valkey hot snapshot absorbs all client load; the public feed is polled once, centrally.
- **Built-in analytics** — every position is banked to ClickHouse, powering punctuality, bunching, speed and delay views.
- **Per-line detail** — colors, headsigns, delays and next-stop ETAs straight from the realtime feed.
- **3D-ready frontend** — WebGL/MapLibre + Three.js, designed to grow into real 3D vehicle models.

## How it works

A monorepo of three runtime services over three managed stores:

| Service | Stack | Role |
|---|---|---|
| **worker** | Node | polls the PID / Golemio GTFS-Realtime feed, normalizes each fix, writes the live snapshot to Valkey + publishes deltas, and banks history to ClickHouse. One leader-writer is elected across containers. |
| **api** | Node | serves the snapshot over REST (`/api/vehicles`, `/api/stops`, `/api/analytics/*`) and a live SSE stream (`/api/stream`); reads static GTFS from PostgreSQL and analytics from ClickHouse. |
| **web** | Vite · React · MapLibre GL · Three.js | the WebGL frontend; reaches the API over its public subdomain. |

```
Golemio GTFS-RT ──▶ worker ──▶ Valkey ⇄ api ──(REST + SSE)──▶ web ──▶ you
                       └──────▶ ClickHouse (history · analytics)
```

Managed stores: **PostgreSQL** (static GTFS), **Valkey** (hot snapshot + pub/sub),
**ClickHouse** (vehicle-fix history + analytics).

## Deploy your own

One click via the Zerops recipe — pick **Small Production** (single-node) or
**HA Production** (HA clusters). You'll be prompted for a free `GOLEMIO_API_KEY`
([get one](https://api.golemio.cz/)).

▶ **[Deploy on Zerops](https://app.zerops.io/recipes/detail?github=https://github.com/fxck/tep)**

The recipe manifest lives in [`.zerops-recipe/`](./.zerops-recipe/).

## Local development

```sh
npm run install:all   # install deps in api/ web/ worker/
npm run dev:api        # REST + SSE API
npm run dev:worker     # Golemio poller
npm run dev:web        # Vite dev server
```

Needs a `GOLEMIO_API_KEY` and reachable PostgreSQL, Valkey and ClickHouse (set
`PG_*`, `CACHE_*`, `CH_*`). The `web` dev server reads `VITE_API_BASE` for the API origin.

## Repository layout

```
api/             Node HTTP API — REST + SSE over the Valkey snapshot
web/             Vite + React + MapLibre GL + Three.js frontend
worker/          Golemio GTFS-RT poller → Valkey + ClickHouse
zerops.yaml      build/run setups for every service
.zerops-recipe/  Zerops recipe manifest (Small + HA Production)
```

## Data & attribution

- Realtime + static GTFS: **PID** via the **[Golemio API](https://api.golemio.cz/)**
- Basemap: **MapLibre GL** · © **OpenStreetMap** contributors

---

Built on **[Zerops](https://zerops.io)**.
