import {DuckDBInstance} from '@duckdb/node-api'
import {expect, test} from 'bun:test'

import {getCurrentReviewServingReviewConfigHash} from '../reviewServing/reviewServingReviewConfig.ts'
import {duckdbEngineCompatibilityOptions} from '../utils/duckdbEngineCompatibility.ts'
import {getCurrentReviewConfigHash} from './reviewServingProjectConfigIdentity.ts'

const withReviewConfigDatabase = async <T>(
  operation: (database: {queryJson: <TRow>(statement: string) => Promise<TRow[]>}) => Promise<T>,
) => {
  const instance = await DuckDBInstance.create(':memory:', duckdbEngineCompatibilityOptions)
  const connection = await instance.connect()
  const database = {
    queryJson: async <TRow>(statement: string): Promise<TRow[]> => {
      const reader = await connection.runAndReadAll(statement)

      return reader.getRowObjectsJson() as TRow[]
    },
  }

  try {
    await connection.run(`
      CREATE SCHEMA app;
      CREATE TABLE app.project (
        id VARCHAR,
        human_judgment_mode VARCHAR,
        model_id VARCHAR,
        use_title BOOLEAN,
        use_abstract BOOLEAN,
        use_fulltext BOOLEAN,
        use_fulltext_no_images BOOLEAN,
        system_prompt_variant VARCHAR
      );
      CREATE TABLE app.model (
        id VARCHAR,
        provider_connection_id VARCHAR,
        remote_model_id VARCHAR,
        variant VARCHAR,
        metadata_json JSON
      );
      CREATE TABLE app.provider_connection (id VARCHAR, provider_kind VARCHAR, base_url VARCHAR);
      CREATE TABLE app.prompt (id VARCHAR, content_hash VARCHAR, original_text VARCHAR, archived BOOLEAN);
      CREATE TABLE app.project_prompt (
        project_id VARCHAR,
        prompt_id VARCHAR,
        prompt_order INTEGER,
        enabled BOOLEAN,
        archived BOOLEAN
      );
      INSERT INTO app.project VALUES
        ('project-null', 'prompt', 'model-1', TRUE, TRUE, FALSE, FALSE, NULL),
        ('project-legacy', 'prompt', 'model-1', TRUE, TRUE, FALSE, FALSE, 'legacy'),
        ('project-screening', 'prompt', 'model-1', TRUE, TRUE, FALSE, FALSE, 'screening_v1');
      INSERT INTO app.model VALUES ('model-1', 'provider-1', 'remote-1', 'thinking', '{"options": {"thinking": "high"}}');
      INSERT INTO app.provider_connection VALUES ('provider-1', 'openai-compatible', 'http://localhost:1');
      INSERT INTO app.prompt VALUES ('prompt-1', 'hash-1', 'Prompt one', FALSE);
      INSERT INTO app.project_prompt VALUES
        ('project-null', 'prompt-1', 0, TRUE, FALSE),
        ('project-legacy', 'prompt-1', 0, TRUE, FALSE),
        ('project-screening', 'prompt-1', 0, TRUE, FALSE);
    `)

    return await operation(database)
  } finally {
    connection.closeSync()
    instance.closeSync()
  }
}

test('both review config hash readers agree on the system prompt variant and keep NULL equal to legacy', async () => {
  const hashes = await withReviewConfigDatabase(async (database) => {
    const projectIds = ['project-null', 'project-legacy', 'project-screening']

    return Promise.all(
      projectIds.map(async (projectId) => {
        return {
          current: await getCurrentReviewConfigHash(projectId, {database}),
          serving: await getCurrentReviewServingReviewConfigHash(projectId, database),
        }
      }),
    )
  })
  const [nullVariant, legacyVariant, screeningVariant] = hashes

  expect(nullVariant?.current).toMatch(/^review:/)
  expect(nullVariant?.serving).toBe(nullVariant?.current)
  expect(legacyVariant?.current).toBe(nullVariant?.current)
  expect(legacyVariant?.serving).toBe(nullVariant?.current)
  expect(screeningVariant?.serving).toBe(screeningVariant?.current)
  expect(screeningVariant?.current).not.toBe(nullVariant?.current)
})
