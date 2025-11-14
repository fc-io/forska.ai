# BACKUP DATABAE FROM REMOTE

Run on the login node of the hpc.

Pick an available port like 5333.

Run postgres:

``` bash
apptainer run --cleanenv --writable-tmpfs \
  --env POSTGRES_USER=postgres \
  --env POSTGRES_PASSWORD_FILE=/run/secrets/db_password \
  --env POSTGRES_DB=postgres \
  --env PGPORT=5433 \
  --bind ${STACK_ROOT:-.}/pgdata:/var/lib/postgresql \
  --bind ${STACK_ROOT:-.}/.secrets/db_password.txt:/run/secrets/db_password:ro \
  ${STACK_ROOT:-.}/postgres_18.sif
```

Make the remote postgres host/port available on the local machine:

``` bash
ssh -N -L 8432:127.0.0.1:5433 alvis2
```

or

``` bash
ssh -N -L 8432:127.0.0.1:5433 dis
```


if something is conflicting with the local port check by:

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

Before merging, ensure the local database schema is migrated so required types (like `public.publication_status_enum`) exist locally. This is necessary for the foreign schema import to succeed.

``` bash
bun run db:mig
# If you use Better Auth, also
bun run db:ba-mig
```

Then merge the dump. This command will first create a dump of the local db and the merge the remote db with the local one. The latest remote dump will automatically be picked for merge.

``` bash
bun run db:merge-from-remote-dump
```
