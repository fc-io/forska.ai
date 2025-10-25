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

Helper (upload via Bun)
- A convenience script uploads the batch file to your remote `$STACK_ROOT`:

```
bun run sbatch:put
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
bun run sbatch:put \
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
# Follow all logs at once (latest forska-stack job)
tail -f "$STACK_ROOT"/logs/"$(squeue -u "$USER" -h -o "%i" -n forska-stack --sort=-i | head -n1)"/*.log

# Or monitor specific services (latest job):
tail -f "$STACK_ROOT"/logs/"$(squeue -u "$USER" -h -o "%i" -n forska-stack --sort=-i | head -n1)"/vllm.log
tail -f "$STACK_ROOT"/logs/"$(squeue -u "$USER" -h -o "%i" -n forska-stack --sort=-i | head -n1)"/api.log
tail -f "$STACK_ROOT"/logs/"$(squeue -u "$USER" -h -o "%i" -n forska-stack --sort=-i | head -n1)"/app.log
tail -f "$STACK_ROOT"/logs/"$(squeue -u "$USER" -h -o "%i" -n forska-stack --sort=-i | head -n1)"/db.log
```

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
