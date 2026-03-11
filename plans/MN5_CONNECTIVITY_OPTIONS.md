# Connectivity Strategy

## Goal

Leverage remote HPC for LLM inference while serving responsive public web app.
**Architecture**: `Local (UI + API + DB)` <---> `SSH Tunnel` <---> `HPC (Inference)`.

## Problem: Tunnel Breaks

**Cause**: **Concurrency**, not Bandwidth.

1.  **TCP Meltdown**: Packet drop on multiplexed SSH = all streams hang.
2.  **Starvation**: HPC CPU 100% -> `sshd` blocked -> KeepAlive missed -> Drop.
3.  **No Outbound**: Compute nodes often isolated. No user-space VPNs.

## Sol 1: Optimized Tunnel (Current)

Patch current setup for dev.

- **Jitter**: 0-1s delay. Flattens bursts.
- **SSH**: `ServerAlive=5` (Aggressive), `QoS=throughput` (Bulk), `No Compression`.
- **Multi-Tunnel**: 1 port/worker. Redundancy.

**Risk**: Band-aid. Scale will break this.

## Sol 2: HPC-Centric (Scalable)

**Respect Data Gravity**.

- **HPC Node**: Runs `Postgres` + `API` + `Inference`. Heavy traffic local.
- **Gateway**: External node acts as proxy.
- **Link**: HPC reverse-tunnels **only UI JSON** to Gateway.
- **Verdict**: Inevitable for production.

## Considered / Rejected

- **Single tunnel to router**: rejected; multiplexing all traffic through one SSH stream triggers TCP meltdown under bursty load.
- **Reverse tunnels from compute → laptop**: usually blocked by MN5 egress rules and would still land on the login node; keep for future if outbound SSH is formally allowed.
- **Login-node reverse proxy for bulk traffic**: not viable—login QoS/process caps make it a bottleneck similar to the single-tunnel case.
