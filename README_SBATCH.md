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
- vLLM parallelism: set `TP_SIZE` to the number of GPUs you requested (e.g., `TP_SIZE=2` for 2 GPUs). The script passes it to `vllm serve` as `--tensor-parallel-size $TP_SIZE`.
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

Script
- Use the maintained script in the repo: [forska-stack.sbatch](./forska-stack.sbatch). This is the single source of truth and is preconfigured for NAISS A100×2 with `TP_SIZE=2`.

Notes
- The API reads secrets via `*_FILE` env fallbacks. If Better Auth files are absent, those envs are ignored.
- vLLM requires a GPU. Increase `--gres=gpu:<N>` and set `TP_SIZE=<N>` if serving with tensor parallelism.
- Update partition/account/directives to match your cluster.

Quick checks
- Compute node and job: printed at start; also see `squeue -j <jobid>`.
- Health: check logs in `$STACK_ROOT/logs/<jobid>/`.
- vLLM: `curl -sf -H "Authorization: Bearer $VLLM_API_KEY" http://localhost:8000/v1/models | jq .` (from the compute node or via tunnel).
