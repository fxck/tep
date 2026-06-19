# Tep — Zerops recipe

See the [root README](../README.md) · live app: **[tep.today](https://tep.today)**

## Recipe metadata

- **Name:** <!-- #ZEROPS_EXTRACT_START:name# -->Tep<!-- #ZEROPS_EXTRACT_END:name# -->
- **Shape:** <!-- #ZEROPS_EXTRACT_START:shape# -->app<!-- #ZEROPS_EXTRACT_END:shape# --> — you fork and deploy your own copy
- **Environments:** `0 — Small Production` (single-node) · `1 — HA Production` (HA clusters)

## Tagline

<!-- #ZEROPS_EXTRACT_START:intro# -->
A real-time map of every Prague tram, bus, metro and train, rendered on a WebGL
vector map and streamed live to the browser over SSE.
<!-- #ZEROPS_EXTRACT_END:intro# -->

## Overview

<!-- #ZEROPS_EXTRACT_START:description# -->
Tep turns Prague's open transit feed into a fast, living map. A poller ingests the
public PID / Golemio GTFS-Realtime vehicle positions, normalizes them, and keeps a
hot snapshot in Valkey; an API serves that snapshot over REST plus a live SSE delta
stream so the browser never touches the upstream feed directly; and a WebGL
frontend (MapLibre GL + a Three.js layer) paints hundreds of vehicles moving in
real time. Every fix is also banked to ClickHouse, so the same deployment backs
historical analytics — punctuality, bunching, speed and delay heatmaps.

The architecture is built for throughput and to leave room for a later 3D phase:
the frontend is WebGL-capable from day one, and the API/worker split means you can
scale the read path independently of the ingest path.

Two environments are available — a lean single-node setup to evaluate, and a fully
highly-available topology that matches the live tep.today deployment.
<!-- #ZEROPS_EXTRACT_END:description# -->

## Features

<!-- #ZEROPS_EXTRACT_START:features# -->
- **Live vehicle map** — hundreds of trams, buses, metro and trains updating in real time on a smooth WebGL vector map.
- **Sub-second updates over SSE** — the browser subscribes to a delta stream; no polling, no hammering the upstream feed.
- **Cached read path** — a Valkey hot snapshot absorbs all client load, so the public Golemio feed is polled once, centrally.
- **Built-in analytics** — every position is banked to ClickHouse, powering punctuality, bunching, speed and delay views.
- **Per-line detail** — colors, headsigns, delays and next-stop ETAs straight from the realtime feed.
- **Scales independently** — read API and ingest worker are separate services you can size apart.
- **3D-ready frontend** — WebGL/MapLibre + Three.js, designed to grow into real 3D vehicle models.
- **One repo, one click** — monorepo (api + worker + web) deploys as a complete project from a single recipe.
<!-- #ZEROPS_EXTRACT_END:features# -->

## First-run setup

<!-- #ZEROPS_EXTRACT_START:takeover-guide# -->
**Set your Golemio API key.** Tep reads Prague's open data through the Golemio API,
which requires a free key. Register at https://api.golemio.cz/, create a key, and
paste it when the deploy wizard prompts for `GOLEMIO_API_KEY` (the same value is
used by both the `api` and `worker` services). Without it the worker logs
`Golemio HTTP 401` and the map stays empty.

**Populate the static timetable (stops & route shapes).** Live vehicles work
immediately, but stop markers and route geometry come from the static GTFS dataset,
loaded by the `worker` cron (`node src/ingest-gtfs.js`, scheduled nightly). To fill
it right after the first deploy, open the `worker` service terminal and run
`cd /var/www && node src/ingest-gtfs.js`. Until then `/api/stops` returns 503 and
no stops/route lines are drawn — vehicles are unaffected.

**Open the app.** The public URL is the `web` service's subdomain (or attach your
own domain in Project → Public Access). The frontend reaches the API through the
`api` service's own subdomain (CORS is open), which the build wires automatically.
<!-- #ZEROPS_EXTRACT_END:takeover-guide# -->

## Knowledge base

<!-- #ZEROPS_EXTRACT_START:knowledge-base# -->
### Architecture

Three runtime services plus three managed stores:

- **worker** (Node) — polls the Golemio GTFS-Realtime feed on an interval, normalizes
  each vehicle fix, writes the live snapshot to **Valkey** (`cache`), publishes deltas
  on a pub/sub channel, and banks history to **ClickHouse** (`analytics`). Multiple
  worker containers elect a single leader-writer, so the upstream feed is polled once.
- **api** (Node) — serves the Valkey snapshot over REST (`/api/vehicles`, `/api/stops`,
  `/api/analytics/*`) and a live SSE stream (`/api/stream`). Reads static GTFS from
  **PostgreSQL** (`db`) and analytics from ClickHouse. Sends `Access-Control-Allow-Origin: *`.
- **web** (nginx) — the Vite/MapLibre/Three.js single-page app. Built with
  `VITE_API_BASE` pointing at the `api` service's public subdomain, so the browser
  talks to the API cross-origin.

### Environment variables

Cross-service wiring (`PG_*`, `CH_*`, `CACHE_*`) is resolved automatically from the
managed services via `zerops.yaml` — you never set these by hand. The only value you
provide is the secret below.

- `GOLEMIO_API_KEY` (required, prompted) — your Golemio API token, used by `api` and `worker`.
- `VITE_API_BASE` (build-time, automatic) — set to `${api_zeropsSubdomain}` for the `web` build.
- `GOLEMIO_URL`, `GTFS_URL`, `POLL_INTERVAL_MS`, `DEMO_COUNT` (optional) — worker tuning; sensible defaults apply if unset.

### Troubleshooting

- **Empty map / `Golemio HTTP 401` in worker logs** — `GOLEMIO_API_KEY` is missing or wrong. Set it on `api` and `worker`, then restart those services.
- **No stop markers / route lines; `/api/stops` returns 503** — the static GTFS hasn't been ingested. Run `node src/ingest-gtfs.js` on the `worker` service, or wait for the nightly cron.
- **Map loads but no vehicles** — confirm the `web` build baked the `api` subdomain into `VITE_API_BASE` (the `api` service must have subdomain access enabled), and that `/api/vehicles` on the `api` subdomain returns data.
<!-- #ZEROPS_EXTRACT_END:knowledge-base# -->
