# How to Transfer local Database Backup to Alvis

Manual restore alternative

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

# or
mv pgdata pgdata_old
mkdir pgdata

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
  --clean --if-exists --no-owner --no-privileges --single-transaction /backups/dump_local_postgres_20251203_095526.dump
```

## Common problems

problem: port already in use
solution: switch all the uses of the 5433 port to something else