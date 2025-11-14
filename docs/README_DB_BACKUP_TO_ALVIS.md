# Copy Local Databse To Remote

Manual restore alternative (this is what I used last)
``` bash
# start the local database to copy from
docker compose up db
# the push
bun db:r:p
# set ssh alias
# Pick the uploaded dump name from backups/
ls -1 ${STACK_ROOT}/backups
# start postgres in one session
apptainer run --cleanenv --writable-tmpfs \
  --env POSTGRES_USER=postgres \
  --env POSTGRES_PASSWORD_FILE=/run/secrets/db_password \
  --env POSTGRES_DB=postgres \
  --env PGPORT=${POSTGRES_PORT:-5433} \
  --bind ${STACK_ROOT:-.}/pgdata:/var/lib/postgresql \
  --bind ${STACK_ROOT:-.}/.secrets/db_password.txt:/run/secrets/db_password:ro \
  ${STACK_ROOT}/postgres_18.sif

# to clear the db we can drop and recreate the schema to completely clear the database
apptainer exec --cleanenv --writable-tmpfs \
  --env POSTGRES_USER=postgres \
  --env POSTGRES_PASSWORD_FILE=/run/secrets/db_password \
  --env POSTGRES_DB=postgres \
  --env PGPORT=${POSTGRES_PORT:-5433} \
  --bind ${STACK_ROOT:-.}/pgdata:/var/lib/postgresql \
  --bind ${STACK_ROOT:-.}/.secrets/db_password.txt:/run/secrets/db_password:ro \
  ${STACK_ROOT}/postgres_18.sif \
  psql -h localhost -p ${POSTGRES_PORT:-5433} -U postgres -d postgres \
  -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

# then restore
# replace the path to the dump

apptainer exec --cleanenv --writable-tmpfs \
  --env POSTGRES_USER=postgres \
  --env POSTGRES_PASSWORD_FILE=/run/secrets/db_password \
  --env POSTGRES_DB=postgres \
  --env PGPORT=${POSTGRES_PORT:-5433} \
  --bind ${STACK_ROOT:-.}/pgdata:/var/lib/postgresql \
  --bind ${STACK_ROOT:-.}/.secrets/db_password.txt:/run/secrets/db_password:ro \
  --bind ${STACK_ROOT:-.}/backups:/backups:ro \
  ${STACK_ROOT}/postgres_18.sif \
  pg_restore -h localhost -p ${POSTGRES_PORT:-5433} -U postgres -d postgres \
  --clean --if-exists --no-owner --no-privileges --single-transaction /backups/dump_local_postgres_20251113_210818.dump
```

### Why this works
- Postgres 18 expects a major-version layout under `/var/lib/postgresql`; a fresh, empty `${STACK_ROOT}/pgdata` avoids the legacy `/data` structure that triggers the safety check.
- `db:r:p` verifies the local dump and remote upload path; the `--restore` run completes the cycle by loading into the fresh cluster.

## Common problems

problem: port already in use
solution: switch all the uses of the 5433 port to something else