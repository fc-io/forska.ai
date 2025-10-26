# Slurm sbatch example (Apptainer)

Single sbatch script to run the database (Postgres), the API + app servers, and the GPU-backed vLLM service together on one Slurm node using Apptainer. It follows the host-network Apptainer guidance from README.md so all services listen on localhost.

Read first (from README.md)
- Set `STACK_ROOT` and create shared dirs: `pgdata`, `models`, `hf_cache`, `logs`, `.cache`.
- Pre-pull SIFs into `$STACK_ROOT`: `postgres_18.sif`, `vllm_openai_latest.sif`, `api_server.sif`, `app_server.sif`.
- Create secrets under `$STACK_ROOT/.secrets`: `db_password.txt` and `database_url.txt`. Optional: `better_auth_secret.txt`, `better_auth_url.txt`.
- Ensure env has `VLLM_API_KEY` (temporary; see README.md).

Assumptions
- Apptainer is available on the compute node (e.g., `module load apptainer`).
- Ports 5432 (db), 8000 (vLLM), 3001 (API), and 8181 (app) are free on the node and reachable via SSH port-forwarding.

Cluster GPU/account notes
- Account/project: set your Slurm account via `#SBATCH -A <account>`. Example (NAISS): `#SBATCH -A NAISS2025-22-715`.
- GPUs: request the right GPU type/count with `--gres`. Example for 2×A100: `#SBATCH --gres=gpu:A100:2`. Keep the job on one node for tensor parallelism.
- Nodes/tasks: keep everything on a single node. Add `#SBATCH --nodes=1` and `#SBATCH --ntasks=1` (the services run as background processes within one task).
- vLLM parallelism: set `TP_SIZE` to the number of GPUs you requested (e.g., `TP_SIZE=2` for 2 GPUs). The script passes it to the vLLM server as `--tensor-parallel-size $TP_SIZE`.
- Exporting env to the job: either export before submission, or pass on the command line. Example: `sbatch --export=ALL,TP_SIZE=2,VLLM_GPU_UTIL=0.90 forska-stack.sbatch`.
- Partitions/constraints vary by cluster. If your site uses generic `--gres=gpu:2` plus constraints, use `#SBATCH -C a100` and keep `TP_SIZE` in sync.

Submit with `sbatch forska-stack.sbatch` (if your cluster does not export environment variables to jobs by default, use `sbatch --export=ALL forska-stack.sbatch` or keep the directive in the script below), then tunnel from your laptop:

```
# After the job starts, check the compute hostname printed in the logs, e.g. c17-42
ssh -N \
  -L 8181:c17-42:8181 \
  -L 3001:c17-42:3001 \
  -L 8000:c17-42:8000 \
  your-user@cluster-login
```

Open the app at http://localhost:8181 (it proxies API calls to http://localhost:3001). vLLM is exposed at http://localhost:8000/v1.

Important: The OpenAI-compatible model name used in requests must match the served name. With this script, vLLM is started as `--model /models/Qwen3-32B-FP8` so clients must send `{"model": "/models/Qwen3-32B-FP8"}` (note the leading slash; not `./models/...`).

Script
- Use the maintained script in the repo: [forska-stack.sbatch](./forska-stack.sbatch). This is the single source of truth and is preconfigured for NAISS A100×2 with `TP_SIZE=2`.

Multi-node (Ray) mode
- The batch script now supports multi-node vLLM via Ray. Set `#SBATCH --nodes=<N>` and `#SBATCH --gpus-per-node=A100:<G>` and it will:
  - Start a Ray head on the first node and Ray workers on the others.
  - Launch vLLM on the head with `--distributed-executor-backend ray`; TP/DP are computed from total GPUs (see below).
- Defaults in the script are 2 nodes × 4 GPUs per node (TP=8). Override `GPUS_PER_NODE` or `TP_SIZE` with `--export` if needed.
- Requirements:
  - The vLLM SIF must include `ray` CLI and Python package.
  - Nodes must be able to talk to each other on ports `6379` (Ray GCS) and `8265` (dashboard). Firewalls must allow intra-allocation traffic.
  - If your cluster needs NCCL tuning for cross-node GPU comms, set `NCCL_SOCKET_IFNAME` (e.g., `ib0`) and related env vars before submission.
  - Slurm must allocate GPUs on each node (use `--gpus-per-node` or your site’s `--gres` equivalent).
  - Addressing: the script resolves a reachable head IP (`HEAD_IP`) from the Slurm-provided short hostname and passes it to both head and workers. If workers fail to connect to `GCS at address <host>:6379`, verify that `HEAD_IP` is reachable from worker nodes and adjust DNS or pass `HEAD_IP=<ip>` on submit if needed.
    - IPv6 gotcha: some clusters return an IPv6 address (e.g., `fe80::...`). Older Ray builds may error with `Invalid gcs_address: <ipv6>:6379`. The script now explicitly resolves IPv4 for head and workers; if resolution still yields IPv6 only, submit with an explicit IPv4 via `--export=ALL,HEAD_IP=1.2.3.4`.
 - Ray temp dir (important): Linux limits AF_UNIX socket paths to 107 bytes. The script now defaults `RAY_TMP_DIR` to a short, per-job path under `/tmp` (e.g., `/tmp/ray-<jobid>`). If you override `RAY_TMP_DIR`, keep it short (e.g., a path under `/tmp`) to avoid `OSError: AF_UNIX path length cannot exceed 107 bytes`.

TP/DP sizing
- The script now computes sizes from total GPUs: `TOTAL_GPUS = NNODES × GPUS_PER_NODE`.
- Defaults: `TP_SIZE=2` (pair GPUs) when `TOTAL_GPUS ≥ 2`, otherwise `1`; `DP_SIZE = TOTAL_GPUS / TP_SIZE`.
- For your example (2 nodes × 4 GPUs = 8 total): `--tensor-parallel-size 2 --data-parallel-size 4`.
- Override with `--export=ALL,TP_SIZE=<n>,DP_SIZE=<m>` if you want a different layout. If `TOTAL_GPUS` is not divisible by `TP_SIZE`, the script falls back to `TP_SIZE=TOTAL_GPUS, DP_SIZE=1` and logs a warning.

Parameterizing nodes/GPUs
- Note: Slurm `#SBATCH` lines do not expand environment variables. To override node/GPU allocation, pass flags at submit time:
  - Example: `sbatch -N 2 --gpus-per-node=A100:4 --export=ALL forska-stack.sbatch`
- Environment variables like `NNODES`, `GPUS_PER_NODE`, `TP_SIZE`, and `DP_SIZE` only influence vLLM’s distribution sizing; they don’t change Slurm’s allocation.

NCCL hints
- The script sets some safe defaults: `NCCL_DEBUG=WARN`, `NCCL_ASYNC_ERROR_HANDLING=1`.
- If your cluster requires specific interfaces, override via `--export`:
  - `NCCL_SOCKET_IFNAME=ib0` (or your NIC), optionally `NCCL_IB_HCA` and `NCCL_IB_GID_INDEX`.

Helper (upload via Bun)
- A convenience script uploads the batch file to your remote `$STACK_ROOT`:

```
bun run sbatch:push
```

Requirements
- `SSH_ALIAS` (e.g., `user@cluster-login` or an SSH config alias) set in your shell
- `STACK_ROOT` (remote shared path where your SIFs/secrets live)

What it does
- Creates the remote directory if missing: `ssh $SSH_ALIAS mkdir -p $STACK_ROOT`
- Copies `forska-stack.sbatch` to `$SSH_ALIAS:$STACK_ROOT/` via `scp`

Optional next step (submit remotely)

```
# After uploading, submit from your laptop in one go
bun run sbatch:push \
  && ssh "$SSH_ALIAS" "cd \"$STACK_ROOT\" && sbatch --export=ALL forska-stack.sbatch"
```

Tip: Add any job-specific overrides on submit, e.g. `--export=ALL,TP_SIZE=2,VLLM_GPU_UTIL=0.90`.

Notes
- The API reads secrets via `*_FILE` env fallbacks. If Better Auth files are absent, those envs are ignored.
- vLLM requires a GPU. Increase `--gres=gpu:<N>` and set `TP_SIZE=<N>` if serving with tensor parallelism.
- Update partition/account/directives to match your cluster.

Quick checks
- Compute node and job: printed at start; also see `squeue -j <jobid>`.
- Health: check logs in `$STACK_ROOT/logs/<jobid>/`.
- vLLM: `curl -sf -H "Authorization: Bearer $VLLM_API_KEY" http://localhost:8000/v1/models | jq .` (from the compute node or via tunnel).

Monitor logs in real-time

```bash
tail -f "$STACK_ROOT"/forska-stack-"$(squeue -u "$USER" -h -o "%i" -n forska-stack --sort=-i | head -n1)".log
```

```bash
# Follow all logs at once (latest forska-stack job)
tail -f "$STACK_ROOT"/logs/"$(squeue -u "$USER" -h -o "%i" -n forska-stack --sort=-i | head -n1)"/*.log

# Or monitor specific services (latest job):
tail -f "$STACK_ROOT"/logs/"$(squeue -u "$USER" -h -o "%i" -n forska-stack --sort=-i | head -n1)"/vllm.log
tail -f "$STACK_ROOT"/logs/"$(squeue -u "$USER" -h -o "%i" -n forska-stack --sort=-i | head -n1)"/api.log
tail -f "$STACK_ROOT"/logs/"$(squeue -u "$USER" -h -o "%i" -n forska-stack --sort=-i | head -n1)"/app.log
tail -f "$STACK_ROOT"/logs/"$(squeue -u "$USER" -h -o "%i" -n forska-stack --sort=-i | head -n1)"/db.log
```

Troubleshooting (Ray connectivity)

- Symptom: worker logs show `Failed to connect to GCS at address <host>:6379` and `Timed out while waiting for GCS to become available`.
- Checks:
  - In `ray-head.log`, confirm `Ray runtime started` and note the `Local node IP`.
  - Ensure `ray-head` is listening on `:6379` on the head node: `ss -ltnp | grep 6379` (run on head).
  - Verify workers can resolve and reach the head IP: `srun -N1 -w <a-worker> getent hosts <head-shortname>` and `srun -N1 -w <a-worker> timeout 3 bash -lc 'nc -vz <head-ip> 6379'`.
  - If name resolution differs across nodes, pass an explicit head IP: submit with `--export=ALL,HEAD_IP=<reachable-ip>`.
  - If your site has multiple NICs/subnets, ensure the resolved head IP and each worker’s `--node-ip-address` are on the same fabric; set `NCCL_SOCKET_IFNAME` accordingly.

Notes
- The script now adds `--disable-usage-stats` to Ray start commands to suppress non-interactive telemetry notices in logs.

Slurm wrapper logs (.out/.err)

The sbatch header writes job-level stdout/stderr to `forska-stack-<jobid>.out` and `forska-stack-<jobid>.err` in the directory where you ran `sbatch`. If you submit using the helper that `cd`'s into `$STACK_ROOT`, those files will be created under `$STACK_ROOT/`.

```bash
# Using the same JOBID as above, follow wrapper logs too
tail -f "$STACK_ROOT/forska-stack-$JOBID.log"

# After the job finishes, view all logs together
# (fallback to newest log dir if sacct is unavailable)
JOBID=${JOBID:-$(basename "$(ls -1dt "$STACK_ROOT"/logs/*/ | head -n1)")}
less "$STACK_ROOT/logs/$JOBID/"*.log \
     "$STACK_ROOT/forska-stack-$JOBID.out" \
     "$STACK_ROOT/forska-stack-$JOBID.err"
```

How long has the job been running?

- Quick (live) with squeue: shows elapsed time since start in the TIME column.

```bash
# Elapsed runtime is the %.10M column
squeue -h -j "$JOBID" -o "%.18i %.10T %.10M %.19S %R"
#           JobID     STATE   ELAPSED  START_TIME          NODELIST(REASON)
```

- Live per-step with sstat: useful while RUNNING; reports Elapsed for the batch step.

```bash
# For a normal job
sstat -j "${JOBID}.batch" --format=JobID,Elapsed

# For an array element (example: element 3)
# sstat -j "${JOBID}[3].batch" --format=JobID,Elapsed
```

- Historical/precise with sacct: works after the job has started (and after it finishes).

```bash
# Includes Start/End and total Elapsed, plus TimeLimit
sacct -j "$JOBID" --format=JobID,JobName,State,Start,End,Elapsed,TimeLimit

# Tip: add -X to exclude other users' jobs on some clusters; add -n for no headers
# sacct -X -n -j "$JOBID" --format=JobID,State,Start,End,Elapsed
```

- Detailed view with scontrol: prints RunTime, StartTime, and TimeLimit in one place.

```bash
scontrol show job "$JOBID" | egrep "RunTime=|StartTime=|TimeLimit="
```

Notes
- Pending jobs have no elapsed time; use `squeue --start -j "$JOBID"` to see the expected start time.
- Job arrays: replace `$JOBID` with the array element ID (e.g., `12345_7`), or use `sacct -j 12345` to see all elements.

### copy api log to clipboard
``` bash
ssh alvis2 'cat /mimer/NOBACKUP/groups/clin-agent-bench/dev/logs/5246678/api.log' | pbcopy
```
