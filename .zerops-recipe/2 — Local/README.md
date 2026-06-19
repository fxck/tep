<!-- #ZEROPS_EXTRACT_START:intro# -->
Just the backing stores — PostgreSQL, Valkey and ClickHouse — and no app containers.
Bring up the Zerops VPN (`zcli vpn up`) and run `api`, `worker` and `web` on your own
machine, pointing `PG_*`, `CACHE_*` and `CH_*` at the internal `db` / `cache` /
`analytics` hostnames. Cheapest way to develop against real managed services.
<!-- #ZEROPS_EXTRACT_END:intro# -->
