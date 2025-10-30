# forska.ai

This is a really deep, "deep research agent". It's actively developed, it's going to be a lot of changes.
You can run it yourself if you have the chops. There will probably be a hosted version eventually.

It uses Elysia/Bun for the API server. Solid.js/Tanstack/Vite on the client. Uses Drizzle ORM with Postgres and Better Auth. It then hooks up to open ai compatible apis – vllm or something, to analyze data in various forms (though mainly research papers for the time being).


## Run locally

[RUN LOCAL ](./docs/README_RUN_LOCAL.md)

## Run remotely on HPC:

[RUN REMOTE](./docs/README_RUN_REMOTE.md)

## For running with SLURM/SBATCH

[SBATCH.md](./docs/README_SBATCH.md)

## For syncing the dbs of the remote with our local db

[SYNC DB FROM REMOTE.md](./docs/README_DB_SYNC_FROM_REMOTE.md)

