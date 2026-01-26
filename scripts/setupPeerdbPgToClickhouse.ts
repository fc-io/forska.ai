import pg from 'pg'

const {Client} = pg

const escapeSqlString = (value: string) => {
  return value.replaceAll("'", "''")
}

const getEnvString = (key: string, fallback: string) => {
  return process.env[key] ?? fallback
}

const getEnvNumber = (key: string, fallback: number) => {
  const value = process.env[key]
  const maybeNumber = value ? Number(value) : fallback
  return Number.isFinite(maybeNumber) ? maybeNumber : fallback
}

const getEnvBoolean = (key: string, fallback: boolean) => {
  const value = process.env[key]
  return value ? value === 'true' : fallback
}

const formatSqlBool = (value: boolean) => {
  return value ? 'true' : 'false'
}

const buildCreatePostgresPeerQuery = (args: {
  peerName: string
  host: string
  port: number
  user: string
  password: string
  database: string
}) => {
  return `
    CREATE PEER ${args.peerName} FROM POSTGRES WITH
    (
      host = '${escapeSqlString(args.host)}',
      port = '${escapeSqlString(String(args.port))}',
      user = '${escapeSqlString(args.user)}',
      password = '${escapeSqlString(args.password)}',
      database = '${escapeSqlString(args.database)}'
    );
  `
}

const buildCreateClickhousePeerQuery = (args: {
  peerName: string
  host: string
  port: number
  user: string
  password: string
  database: string
  disableTls: boolean
}) => {
  const maybeDisableTls = args.disableTls ? ',\n      disable_tls = true' : ''

  return `
    CREATE PEER ${args.peerName} FROM CLICKHOUSE
    WITH
    (
      host='${escapeSqlString(args.host)}',
      port=${args.port},
      user='${escapeSqlString(args.user)}',
      password='${escapeSqlString(args.password)}',
      database='${escapeSqlString(args.database)}'${maybeDisableTls}
    );
  `
}

const buildCdcMirrorQuery = (args: {
  mirrorName: string
  sourcePeer: string
  targetPeer: string
  doInitialCopy: boolean
  maxBatchSize: number
  syncIntervalSeconds: number
  snapshotNumRowsPerPartition: number
  snapshotMaxParallelWorkers: number
  snapshotNumTablesInParallel: number
}) => {
  return `
    CREATE MIRROR ${args.mirrorName}
    FROM ${args.sourcePeer} TO ${args.targetPeer}
    WITH TABLE MAPPING
    (
      public.articles:articles,
      public.judgments:judgments_raw
    )
    WITH (
      do_initial_copy = ${formatSqlBool(args.doInitialCopy)},
      max_batch_size = ${args.maxBatchSize},
      sync_interval = ${args.syncIntervalSeconds},
      snapshot_num_rows_per_partition = ${args.snapshotNumRowsPerPartition},
      snapshot_max_parallel_workers = ${args.snapshotMaxParallelWorkers},
      snapshot_num_tables_in_parallel = ${args.snapshotNumTablesInParallel}
    );
  `
}

const runSqlStatements = async (client: pg.Client, statements: string[]) => {
  await statements.reduce(async (prev, statement) => {
    await prev
    await client.query(statement)
  }, Promise.resolve())
}

const setupPeerdbPgToClickhouse = async () => {
  const peerdbHost = getEnvString('PEERDB_HOST', 'localhost')
  const peerdbPort = getEnvNumber('PEERDB_PORT', 9900)
  const peerdbUser = getEnvString('PEERDB_USER', 'peerdb')
  const peerdbPassword = getEnvString('PEERDB_PASSWORD', 'peerdb')

  const sourcePeerName = getEnvString('PEERDB_PG_PEER_NAME', 'forska_pg')
  const targetPeerName = getEnvString('PEERDB_CH_PEER_NAME', 'forska_ch')
  const mirrorName = getEnvString('PEERDB_MIRROR_NAME', 'forska_pg_to_ch_cdc')

  const sourcePgHost = getEnvString('PEERDB_SOURCE_PG_HOST', 'db')
  const sourcePgPort = getEnvNumber('PEERDB_SOURCE_PG_PORT', 5432)
  const sourcePgUser = getEnvString('PEERDB_SOURCE_PG_USER', getEnvString('DB_USER', 'postgres'))
  const sourcePgPassword = getEnvString('PEERDB_SOURCE_PG_PASSWORD', getEnvString('DB_PASS', ''))
  const sourcePgDatabase = getEnvString('PEERDB_SOURCE_PG_DATABASE', getEnvString('DB_NAME', 'postgres'))

  const clickhouseHost = getEnvString('PEERDB_CLICKHOUSE_HOST', 'clickhouse')
  const clickhousePort = getEnvNumber('PEERDB_CLICKHOUSE_PORT', 9000)
  const clickhouseUser = getEnvString('PEERDB_CLICKHOUSE_USER', 'default')
  const clickhousePassword = getEnvString('PEERDB_CLICKHOUSE_PASSWORD', 'clickhouse')
  const clickhouseDatabase = getEnvString('PEERDB_CLICKHOUSE_DATABASE', 'forska')
  const clickhouseDisableTls = getEnvBoolean('PEERDB_CLICKHOUSE_DISABLE_TLS', true)

  const doInitialCopy = getEnvBoolean('PEERDB_MIRROR_DO_INITIAL_COPY', true)
  const maxBatchSize = getEnvNumber('PEERDB_MIRROR_MAX_BATCH_SIZE', 100_000)
  const syncIntervalSeconds = getEnvNumber('PEERDB_MIRROR_SYNC_INTERVAL_SECONDS', 10)
  const snapshotNumRowsPerPartition = getEnvNumber('PEERDB_MIRROR_SNAPSHOT_NUM_ROWS_PER_PARTITION', 250_000)
  const snapshotMaxParallelWorkers = getEnvNumber('PEERDB_MIRROR_SNAPSHOT_MAX_PARALLEL_WORKERS', 4)
  const snapshotNumTablesInParallel = getEnvNumber('PEERDB_MIRROR_SNAPSHOT_NUM_TABLES_IN_PARALLEL', 2)

  const sql = [
    `DROP MIRROR IF EXISTS ${mirrorName};`,
    `DROP PEER IF EXISTS ${targetPeerName};`,
    `DROP PEER IF EXISTS ${sourcePeerName};`,
    buildCreatePostgresPeerQuery({
      peerName: sourcePeerName,
      host: sourcePgHost,
      port: sourcePgPort,
      user: sourcePgUser,
      password: sourcePgPassword,
      database: sourcePgDatabase,
    }),
    buildCreateClickhousePeerQuery({
      peerName: targetPeerName,
      host: clickhouseHost,
      port: clickhousePort,
      user: clickhouseUser,
      password: clickhousePassword,
      database: clickhouseDatabase,
      disableTls: clickhouseDisableTls,
    }),
    buildCdcMirrorQuery({
      mirrorName,
      sourcePeer: sourcePeerName,
      targetPeer: targetPeerName,
      doInitialCopy,
      maxBatchSize,
      syncIntervalSeconds,
      snapshotNumRowsPerPartition,
      snapshotMaxParallelWorkers,
      snapshotNumTablesInParallel,
    }),
  ]

  console.log('[PeerDB] Connecting...')

  const client = new Client({
    host: peerdbHost,
    port: peerdbPort,
    user: peerdbUser,
    password: peerdbPassword,
    database: peerdbUser,
  })

  await client.connect()
  await runSqlStatements(client, sql)
  await client.end()

  console.log('[PeerDB] ✓ peers + mirror configured')
  console.log(`[PeerDB] UI: http://localhost:3001`)
  console.log(`[PeerDB] Server: postgresql://${peerdbUser}:***@${peerdbHost}:${peerdbPort}/${peerdbUser}`)
}

await setupPeerdbPgToClickhouse()
