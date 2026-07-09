import {existsSync, mkdirSync, rmSync} from 'node:fs'
import {join} from 'node:path'

import {DuckDBConnection, DuckDBInstance} from '@duckdb/node-api'

export const reviewServingSyntheticBenchmarkFixtureVersion = 'reviewServingSynthetic.v1'
export const reviewServingSyntheticBenchmarkDefaultSeed = 732_451
export const reviewServingSyntheticBenchmarkScales = ['small', 'medium', 'release'] as const

export type ReviewServingSyntheticBenchmarkScale = (typeof reviewServingSyntheticBenchmarkScales)[number]

export type ReviewServingSyntheticFixtureManifest = {
  articleCount: number
  articlePromptOverlapRows: number
  duckdbMemoryLimit: string
  fixtureVersion: string
  holdout: boolean
  promptCount: number
  scale: ReviewServingSyntheticBenchmarkScale
  seed: number
}

export type ReviewServingSyntheticFixture = {
  connection: DuckDBConnection
  duckdbInstance: DuckDBInstance
  duckdbPath: string
  manifest: ReviewServingSyntheticFixtureManifest
  rootDirectory: string
}

const scaleArticleCounts = {
  small: 1_000,
  medium: 10_000,
  release: 100_000,
} as const satisfies Record<ReviewServingSyntheticBenchmarkScale, number>

export const getReviewServingSyntheticBenchmarkArticleCount = (scale: ReviewServingSyntheticBenchmarkScale) => {
  return scaleArticleCounts[scale]
}

export const getReviewServingSyntheticFixtureManifest = ({
  duckdbMemoryLimit,
  holdout = false,
  scale,
  seed,
}: {
  duckdbMemoryLimit: string
  holdout?: boolean
  scale: ReviewServingSyntheticBenchmarkScale
  seed: number
}): ReviewServingSyntheticFixtureManifest => {
  const articleCount = getReviewServingSyntheticBenchmarkArticleCount(scale)
  const promptCount = 7

  return {
    articleCount,
    articlePromptOverlapRows: articleCount * promptCount,
    duckdbMemoryLimit,
    fixtureVersion: reviewServingSyntheticBenchmarkFixtureVersion,
    holdout,
    promptCount,
    scale,
    seed,
  }
}

const removeFileIfExists = (filePath: string) => {
  if (existsSync(filePath)) {
    rmSync(filePath, {force: true, recursive: true})
  }
}

export const cleanupReviewServingSyntheticFixture = (fixture: Pick<ReviewServingSyntheticFixture, 'duckdbPath' | 'rootDirectory'>) => {
  removeFileIfExists(fixture.duckdbPath)
  removeFileIfExists(`${fixture.duckdbPath}.wal`)
  removeFileIfExists(`${fixture.duckdbPath}.duckdb-owner.lock`)
  removeFileIfExists(`${fixture.duckdbPath}.duckdb-owner.history.json`)
  removeFileIfExists(fixture.rootDirectory)
}

const getBenchmarkRootDirectory = () => {
  const rootDirectory = join(process.cwd(), '.tmp', 'benchmarks')
  mkdirSync(rootDirectory, {recursive: true})

  return rootDirectory
}

const getFixtureRootDirectory = (scale: ReviewServingSyntheticBenchmarkScale, seed: number) => {
  const rootDirectory = join(getBenchmarkRootDirectory(), `review-serving-${scale}-${seed}-${Date.now()}`)
  mkdirSync(rootDirectory, {recursive: true})

  return rootDirectory
}

const seedReviewServingSyntheticSchema = async (
  connection: DuckDBConnection,
  manifest: ReviewServingSyntheticFixtureManifest,
) => {
  await connection.run(`
    CREATE TABLE article (
      article_id INTEGER PRIMARY KEY,
      title VARCHAR NOT NULL,
      year INTEGER NOT NULL,
      selected BOOLEAN NOT NULL
    );
    CREATE TABLE prompt_overlap (
      article_id INTEGER NOT NULL,
      prompt_id INTEGER NOT NULL,
      llm_status VARCHAR NOT NULL,
      human_status VARCHAR NOT NULL,
      queue_kind VARCHAR NOT NULL,
      token_prefix VARCHAR NOT NULL
    );
    CREATE TABLE filter_option (
      prompt_id INTEGER NOT NULL,
      year INTEGER NOT NULL,
      total INTEGER NOT NULL
    );
    CREATE TABLE writer_diagnostic (
      table_name VARCHAR NOT NULL,
      batch_count INTEGER NOT NULL,
      rows_per_batch INTEGER NOT NULL,
      rows_written INTEGER NOT NULL
    );
  `)
  await connection.run(`
    INSERT INTO article
    SELECT
      article_id,
      'Synthetic review article ' || article_id || ' seed ${manifest.seed}' AS title,
      2000 + ((article_id + ${manifest.seed}) % 25) AS year,
      article_id % 3 <> 0 AS selected
    FROM range(1, ${manifest.articleCount + 1}) AS source(article_id);
  `)
  await connection.run(`
    INSERT INTO prompt_overlap
    SELECT
      article.article_id,
      prompt.prompt_id,
      CASE WHEN (article.article_id + prompt.prompt_id + ${manifest.seed}) % 5 = 0 THEN 'unassessed' ELSE 'assessed' END AS llm_status,
      CASE WHEN (article.article_id + prompt.prompt_id + ${manifest.seed}) % 7 = 0 THEN 'conflict' ELSE 'reviewed' END AS human_status,
      CASE WHEN (article.article_id + prompt.prompt_id) % 11 = 0 THEN 'priority' ELSE 'normal' END AS queue_kind,
      lower(substr(article.title, 1, 3)) AS token_prefix
    FROM article
    CROSS JOIN range(1, ${manifest.promptCount + 1}) AS prompt(prompt_id);
  `)
  await connection.run(`
    INSERT INTO filter_option
    SELECT prompt_id, year, count(*)::INTEGER AS total
    FROM prompt_overlap
    INNER JOIN article USING (article_id)
    GROUP BY prompt_id, year;
  `)
  await connection.run(`
    INSERT INTO writer_diagnostic VALUES
      ('article', 4, ${Math.ceil(manifest.articleCount / 4)}, ${manifest.articleCount}),
      ('prompt_overlap', 7, ${manifest.articleCount}, ${manifest.articlePromptOverlapRows}),
      ('filter_option', 1, ${manifest.promptCount * 25}, ${manifest.promptCount * 25});
  `)
}

export const createReviewServingSyntheticFixture = async ({
  duckdbMemoryLimit,
  holdout = false,
  scale,
  seed = reviewServingSyntheticBenchmarkDefaultSeed,
}: {
  duckdbMemoryLimit: string
  holdout?: boolean
  scale: ReviewServingSyntheticBenchmarkScale
  seed?: number
}): Promise<ReviewServingSyntheticFixture> => {
  const manifest = getReviewServingSyntheticFixtureManifest({duckdbMemoryLimit, holdout, scale, seed})
  const rootDirectory = getFixtureRootDirectory(scale, seed)
  const duckdbPath = join(rootDirectory, 'synthetic.duckdb')
  const duckdbInstance = await DuckDBInstance.create(duckdbPath, {memory_limit: duckdbMemoryLimit})
  const connection = await duckdbInstance.connect()

  await seedReviewServingSyntheticSchema(connection, manifest)

  return {connection, duckdbInstance, duckdbPath, manifest, rootDirectory}
}

export const closeReviewServingSyntheticFixture = (fixture: ReviewServingSyntheticFixture) => {
  fixture.connection.closeSync()
  fixture.duckdbInstance.closeSync()
}
