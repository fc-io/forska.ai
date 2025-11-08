

Run on the login node.

Pick an available port like 5333.

Run postgres:

``` bash
apptainer run --cleanenv --writable-tmpfs \
  --env POSTGRES_USER=postgres \
  --env POSTGRES_PASSWORD_FILE=/run/secrets/db_password \
  --env POSTGRES_DB=postgres \
  --env PGPORT=5433 \
  --bind /mimer/NOBACKUP/groups/clin-agent-bench/dev/pgdata:/var/lib/postgresql \
  --bind /mimer/NOBACKUP/groups/clin-agent-bench/dev/.secrets/db_password.txt:/run/secrets/db_password:ro \
  /mimer/NOBACKUP/groups/clin-agent-bench/dev/postgres_18.sif
```

Make the remote postgres host/port available on the local machine:

``` bash
ssh -N -L 8432:127.0.0.1:5433 alvis2
```

Check if something is conflicting with the local port by:

``` bash
lsof -iTCP:8432 -sTCP:LISTEN -Pn
```

Run the script for retriving the remote database and storing it locally:

``` bash
bun run db:backup-from-remote
```

Then push the dump/data into the local database.

First make sure it is up

``` bash
docker compose up db
```

Then merge the dump. This command will first create a dump of the local db and the merge the remote db with the local one. The latest remote dump will automatically be picked for merge.

``` bash
bun run db:merge-from-remote-dump
```