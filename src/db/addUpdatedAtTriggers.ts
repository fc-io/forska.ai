import {Client} from 'pg'

const tablesWithUpdatedAt = [
  'articles',
  'models',
  'profiles',
  'projects',
  'prompts',
  'judgments',
  'token_use',
  // Auth tables
  'user',
  'session',
  'account',
  'verification',
]

const createOrReplaceFunctionSQL = `
CREATE OR REPLACE FUNCTION set_updated_at_timestamp()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
`

const buildDropTriggerSQL = (tableName: string): string => {
  return `DROP TRIGGER IF EXISTS set_updated_at ON "${tableName}";`
}

const buildCreateTriggerSQL = (tableName: string): string => {
  return `CREATE TRIGGER set_updated_at BEFORE UPDATE ON "${tableName}"
FOR EACH ROW EXECUTE FUNCTION set_updated_at_timestamp();`
}

const run = async (): Promise<void> => {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set')
  }

  const client = new Client({connectionString: databaseUrl})
  await client.connect()

  try {
    await client.query('BEGIN')
    await client.query(createOrReplaceFunctionSQL)

    for (const tableName of tablesWithUpdatedAt) {
      await client.query(buildDropTriggerSQL(tableName))
      await client.query(buildCreateTriggerSQL(tableName))
    }

    await client.query('COMMIT')
    console.log(
      `Installed/updated updated_at triggers for: ${tablesWithUpdatedAt.join(
        ', ',
      )}`,
    )
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('Failed to install triggers:', error)
    process.exitCode = 1
  } finally {
    await client.end()
  }
}

void run()
