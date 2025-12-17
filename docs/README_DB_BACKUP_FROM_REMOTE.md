# BACKUP DATABAE FROM REMOTE

Run on the login node of the hpc.

Pick an available port like 5333.

## Run postgres:

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

## Make the remote postgres host/port available on the local machine:

### Alvis

``` bash
ssh -N -L 8432:127.0.0.1:5433 alvis2
```

### Discoverer

``` bash
ssh -N -L 8432:127.0.0.1:5433 dis
```


if something is conflicting with the local port check by:

``` bash
lsof -iTCP:8432 -sTCP:LISTEN -Pn
```

## Run the script for retriving the remote database and storing it locally:

``` bash
bun run db:backup-from-remote
```

## Then push the dump/data into the local database.

First make sure it is up

``` bash
docker compose up db
```

## Then merge the dump.

This command will first create a dump of the local db and the merge the remote db with the local one. The latest remote dump will automatically be picked for merge.

### Recommended: Safe merge (handles index size issues)

Use this version if you encounter B-tree index size errors (e.g., "index row size exceeds btree maximum"):

``` bash
bun run db:merge-from-remote-dump-safe
```

This version automatically drops problematic indexes before the merge and recreates them with expression-based prefixes afterward.

### Standard merge

``` bash
bun run db:merge-from-remote-dump
```

**Note:** If the standard merge fails with an error like:
```
ERROR: index row size 2720 exceeds btree version 4 maximum 2704 for index "judgments_..."
```

This is because some `answered_original` values are too large for B-tree indexes. Use the safe merge command instead, or run the migration `0041_fix_judgments_answered_index_size.sql` to permanently fix the indexes.
