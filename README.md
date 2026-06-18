# Tep — PID live map (monorepo)

One repository, three deployable packages, six Zerops services (a dev/stage pair
each). Everything is driven by the single root [`zerops.yaml`](./zerops.yaml).

```
pid/
├── api/        Node HTTP API — reads the Valkey snapshot, serves REST + SSE,
│               PostgreSQL (static GTFS) + ClickHouse (analytics).  → apidev / apistage
├── web/        Vite + React chrome over a vanilla MapLibre + Three.js engine.  → webdev / webstage
├── worker/     Golemio GTFS-RT poller; normalizes + writes the shared cache,
│               elects a single leader-writer, banks history to ClickHouse.  → workerdev / workerstage
├── zerops.yaml Six setups (apidev/apiprod, webdev/webprod, workerdev/workerprod)
└── package.json Root helper scripts (install:all, build:web, dev:api, …)
```

## Deploy model

Zerops rule: a **self-deploying** service must use `deployFiles: ["."]`; only
**cross-deploy** / git-built services may ship a specific sub-path. So:

| Service | Setup | Deploy | `deployFiles` | Runs |
|---|---|---|---|---|
| apidev | `apidev` | self-deploy | `["."]` (whole repo) | `api/` via `zerops_dev_server` |
| apistage | `apiprod` | cross-deploy from apidev | `["api/~"]` | `node src/index.js` |
| webdev | `webdev` | self-deploy | `["."]` (whole repo) | nginx `documentRoot: web/dist` |
| webstage | `webprod` | cross-deploy from webdev | `["web/dist/~"]` | nginx (root) |
| workerdev | `workerdev` | self-deploy | `["."]` (whole repo) | `worker/` via `zerops_dev_server` |
| workerstage | `workerprod` | cross-deploy from workerdev | `["worker/~"]` | `node src/index.js` |

The dev side carries the **whole** monorepo (root scripts + git tree intact); each
dev setup only builds + runs its own subdir. The stage side ships just the built
subdir, flattened to `/var/www` by the `~` tilde.

Secrets (`GOLEMIO_API_KEY` on the workers, cross-service env refs) live on the
Zerops services, not in this repo.

## Local helper scripts

```
npm run install:all   # install deps in api/, web/, worker/
npm run build:web      # vite build → web/dist
npm run dev:api        # node api/src/index.js
npm run dev:worker     # node worker/src/index.js
npm run dev:web        # vite dev server
```

## Cutover status

This repo is **prepared but not yet the live deploy source.** The six services
currently still deploy from their individual pre-monorepo mounts. Cutover (per
service, de-risked) flips each to deploy from this root `zerops.yaml`. See the
conversation / cutover notes before flipping.
