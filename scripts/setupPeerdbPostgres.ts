import {Client} from 'pg'

import {env} from '../src/server/utils/env.ts'

const parseDbNameFromDatabaseUrl = (databaseUrl: string): string => {
  const parsed = new URL(databaseUrl)
  const normalized = parsed.pathname.replace(/^\//, '')
  return normalized || 'postgres'
}

const quoteIdentifier = (identifier: string): string => {
  return `"${identifier.replaceAll('"', '""')}"`
}

const quoteLiteral = (value: string): string => {
  return `'${value.replaceAll("'", "''")}'`
}

const isSafePgIdentifier = (value: string): boolean => {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)
}

const getPeerdbRoleName = (): string => {
  const configured = process.env['PEERDB_PG_USER']
  const normalized = String(configured ?? '').trim()
  const roleName = normalized ? normalized : 'peerdb_replicator'
  return isSafePgIdentifier(roleName) ? roleName : 'peerdb_replicator'
}

const getPeerdbPublicationName = (): string => {
  const configured = process.env['PEERDB_PUBLICATION']
  const normalized = String(configured ?? '').trim()
  const publicationName = normalized ? normalized : 'peerdb_publication'
  return isSafePgIdentifier(publicationName) ? publicationName : 'peerdb_publication'
}

const getPeerdbReplicationSlotName = (): string => {
  const configured = process.env['PEERDB_SLOT']
  const normalized = String(configured ?? '').trim()
  const slotName = normalized ? normalized : 'peerdb_slot'
  return isSafePgIdentifier(slotName) ? slotName : 'peerdb_slot'
}

const getPeerdbRolePassword = (): string | null => {
  const configured = process.env['PEERDB_PG_PASSWORD']
  const normalized = String(configured ?? '').trim()
  const fallback = new URL(env.DATABASE_URL).password
  const password = normalized ? normalized : fallback ? fallback : null
  return password
}

const getShouldCreateSlot = (): boolean => {
  const raw = String(process.env['PEERDB_CREATE_SLOT'] ?? '')
    .trim()
    .toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes'
}

const ensurePeerdbRole = async (client: Client, roleName: string, password: string, dbName: string): Promise<void> => {
  const existing = await client.query<{exists: true}>(
    'SELECT true AS exists FROM pg_roles WHERE rolname = $1 LIMIT 1',
    [roleName],
  )

  const roleIdent = quoteIdentifier(roleName)
  const dbIdent = quoteIdentifier(dbName)
  const passwordLiteral = quoteLiteral(password)

  if (existing.rowCount) {
    await client.query(`ALTER ROLE ${roleIdent} WITH LOGIN REPLICATION PASSWORD ${passwordLiteral}`)
  } else {
    await client.query(`CREATE ROLE ${roleIdent} WITH LOGIN REPLICATION PASSWORD ${passwordLiteral}`)
  }

  await client.query(`GRANT CONNECT ON DATABASE ${dbIdent} TO ${roleIdent}`)
  await client.query(`GRANT USAGE ON SCHEMA public TO ${roleIdent}`)
  await client.query(`GRANT SELECT ON TABLE public.articles TO ${roleIdent}`)
  await client.query(`GRANT SELECT ON TABLE public.judgments TO ${roleIdent}`)
}

const ensurePeerdbPublication = async (client: Client, publicationName: string): Promise<void> => {
  const existing = await client.query<{exists: true}>(
    'SELECT true AS exists FROM pg_publication WHERE pubname = $1 LIMIT 1',
    [publicationName],
  )

  const publicationIdent = quoteIdentifier(publicationName)

  await (existing.rowCount
    ? client.query(`ALTER PUBLICATION ${publicationIdent} SET TABLE public.articles, public.judgments`)
    : client.query(`CREATE PUBLICATION ${publicationIdent} FOR TABLE public.articles, public.judgments`))
}

const ensureJudgmentsReplicaIdentity = async (client: Client): Promise<void> => {
  await client.query(
    'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS judgments_peerdb_replica_identity_idx ON public.judgments (article_id, prompt_id, model_id, id)',
  )
  await client.query('ALTER TABLE public.judgments REPLICA IDENTITY USING INDEX judgments_peerdb_replica_identity_idx')
}

const ensurePeerdbLogicalReplicationSlot = async (client: Client, slotName: string): Promise<void> => {
  const existing = await client.query<{exists: true}>(
    "SELECT true AS exists FROM pg_replication_slots WHERE slot_name = $1 AND slot_type = 'logical' LIMIT 1",
    [slotName],
  )

  if (!existing.rowCount) {
    await client.query("SELECT pg_create_logical_replication_slot($1, 'pgoutput')", [slotName])
  }
}

const handleMissingPassword = async (): Promise<void> => {
  console.error('[PeerDB PG Setup] Missing PEERDB_PG_PASSWORD (and DATABASE_URL has no password)')
  process.exitCode = 1
}

const runPeerdbPostgresSetup = async (password: string): Promise<void> => {
  const roleName = getPeerdbRoleName()
  const publicationName = getPeerdbPublicationName()
  const slotName = getPeerdbReplicationSlotName()
  const shouldCreateSlot = getShouldCreateSlot()

  const dbName = parseDbNameFromDatabaseUrl(env.DATABASE_URL)

  console.log('[PeerDB PG Setup] Starting...')
  console.log('[PeerDB PG Setup] Database:', dbName)
  console.log('[PeerDB PG Setup] Role:', roleName)
  console.log('[PeerDB PG Setup] Publication:', publicationName)
  console.log('[PeerDB PG Setup] Replication slot:', slotName, `(create: ${shouldCreateSlot ? 'yes' : 'no'})`)

  const client = new Client({connectionString: env.DATABASE_URL})
  await client.connect()

  try {
    await ensurePeerdbRole(client, roleName, password, dbName)
    await ensurePeerdbPublication(client, publicationName)
    await ensureJudgmentsReplicaIdentity(client)
    await (shouldCreateSlot ? ensurePeerdbLogicalReplicationSlot(client, slotName) : Promise.resolve())

    console.log('[PeerDB PG Setup] ✓ Done')
  } finally {
    await client.end()
  }
}

const setupPeerdbPostgres = async (): Promise<void> => {
  const password = getPeerdbRolePassword()
  return password ? runPeerdbPostgresSetup(password) : handleMissingPassword()
}

void setupPeerdbPostgres().catch((error) => {
  console.error('[PeerDB PG Setup] Fatal error:', error)
  process.exitCode = 1
})
