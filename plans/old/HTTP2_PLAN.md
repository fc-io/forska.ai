# HTTP/2 Dual Proxy Plan (Final)

## Problem

SSH tunnel hits MaxSessions limit (~1000 channels). Each HTTP request = 1 channel.

## Solution

Dual Caddy proxies per worker. H2 multiplexing = unlimited requests per SSH channel.

## Architecture

```
Local Machine                                    SSH Tunnels              Compute Nodes
┌────────────┐                                  ┌──────────┐            ┌─────────────┐     ┌────────┐
│ OpenAI SDK │──H1──▶ Docker Caddy ─────H2─────▶│ :40002   │───────────▶│ Caddy node1 │─H1─▶│ SGLang │
│ :30002     │       :30002→:40002              └──────────┘            │ :30002      │     │ :30001 │
└────────────┘                                                          └─────────────┘     └────────┘
```

## Port Mapping

| Local Port | Docker Caddy | SSH Tunnel To | Remote Caddy | SGLang |
| ---------- | ------------ | ------------- | ------------ | ------ |
| 30002      | H1→H2→:40002 | node:30002    | :30002       | :30001 |

App uses `http://localhost:30002/v1/...`

---

## Checklist

### Remote (HPC sbatch)

- [x] Caddy binary installed at `/gpfs/projects/ehpc482/dev/bin/caddy`
- [x] Add Caddy check in sbatch (fail if missing)
- [x] Change SGLANG to port 30001 (internal)
- [x] Add CADDY_PORT=30002 (external, H2 listener)
- [x] Start Caddy on each node before SGLang
- [x] Create Caddyfile inline
- [x] Update config block: output CADDY_PORT, SGLANG_INTERNAL_PORT

### Local (mn5Launch.ts)

- [x] Update port constants for new scheme
- [x] Generate Caddyfile dynamically
- [x] Start Docker Caddy container with volume mount
- [x] Start SSH tunnel: 40002→node:30002
- [x] Cleanup: stop Docker Caddy container on exit
- [x] Update healthcheck to use Caddy port

---

## Testing (TODO)

- [ ] Ensure Docker Desktop is running
- [ ] Run `bun mn5:launch`
- [ ] Verify Docker container starts: `docker ps | grep forska-caddy`
- [ ] Verify tunnel connects
- [ ] Run load test, monitor SSH with `-vv` in mn5-tunnel-debug.txt
- [ ] Confirm only 1-2 channels under heavy load (vs 1000+ before)

---

## Files Modified

- `forska-mn5-sglang.sbatch` - Added Caddy proxy startup
- `scripts/mn5Launch.ts` - Added Docker Caddy management

## Risks

- Docker Desktop must be running on local machine
- h2c between Docker Caddy and SSH tunnel needs `host.docker.internal`
