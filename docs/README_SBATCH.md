# Slurm / sbatch Notes

Current repo flow: HPC runs SGLang inference only.

Do not treat the HPC job as a full remote app stack. We no longer run Postgres, API, or app on Alvis/MN5 for the normal launch flow.

## Current Entry Points

- Alvis managed launch: `bun run alvis:launch:a100:fat`
- Alvis 4x A100 launch: `bun run alvis:launch:a100:4`
- Alvis manual sbatch: `sbatch forska-alvis.sbatch`
- MN5 managed launch: `bun run mn5:launch`

## What the sbatch jobs do

- start SGLang on the allocated GPU node(s)
- download model weights into the shared HF cache if missing
- print a machine-readable config block that the local launch scripts parse
- keep the model server running until the Slurm job ends or the launcher cancels it

## What they do not do

- no remote Postgres
- no remote API server
- no remote app server
- no `db_password.txt` / `database_url.txt` requirement for the normal inference flow

## Images

- Alvis: `sglang_latest.sif`
- MN5: the maintained MN5 SGLang image/model transfer flow

Use `bun run build:docker:sglang` followed by `bun run alvis:sglang:pull` when the Alvis SGLang image needs to be refreshed from GHCR.

## Read Next

- `docs/README_RUN_REMOTE.md`
- `docs/README_RUN_SGLANG_REMOTE_INTERACTIVE.md`
- `docs/README_MN5_INFERENCE.md`
