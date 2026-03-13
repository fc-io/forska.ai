import {Client} from 'pg'

import {getDatabaseUrl} from './getDatabaseUrl.ts'

const tablesWithUpdatedAt = [
  'articles',
  'models',
  'projects',
  'comparison_project',
  'prompts',
  'project_prompts',
  'comparison_project_prompt',
  'comparison_project_route_link',
  'project_articles',
  'judgments',
  'judgments_human',
  'token_use',
  'judgment_assessments',
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
  const client = new Client({connectionString: getDatabaseUrl()})
  await client.connect()

  try {
    await client.query('BEGIN')
    await client.query(createOrReplaceFunctionSQL)

    for (const tableName of tablesWithUpdatedAt) {
      await client.query(buildDropTriggerSQL(tableName))
      await client.query(buildCreateTriggerSQL(tableName))
    }

    await client.query('COMMIT')
    console.log(`Installed/updated updated_at triggers for: ${tablesWithUpdatedAt.join(', ')}`)
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('Failed to install triggers:', error)
    process.exitCode = 1
  } finally {
    await client.end()
  }
}

void run()
