import {readdirSync, readFileSync} from 'node:fs'
import {join, relative} from 'node:path'

import {expect, test} from 'bun:test'

const projectRoot = process.cwd()

const scanRoots = [
  'package.json',
  'AGENTS.md',
  'README.md',
  'docs',
  'scripts',
  'src/server',
  'src/db/duckdbMigrations',
] as const

const allowedReferenceFiles = new Set([
  'scripts/rebuild2Cutover.test.ts',
  'scripts/rebuild2Cutover.ts',
  'scripts/rebuild2ObsoleteCommandReferences.test.ts',
  'src/db/duckdbMigrations/0002_martRefreshQueue.sql',
  'src/db/duckdbMigrations/0023_martRefreshQueueGeneration.sql',
  'src/db/duckdbMigrations/0024_martRefreshQueueCompletedAt.sql',
  'src/db/duckdbMigrations/0054_clearProjectMartRefreshQueueProjectTasks.sql',
  'src/db/duckdbMigrations/0063_dropMartRefreshQueue.sql',
])

const allowedStateClearingFiles = new Set(['scripts/rebuild2Cutover.ts'])

const obsoletePatterns = [
  /db:duck:recover-archived-refresh-queue/,
  /recoverArchivedProjectRefreshQueue/,
  /martRefreshDrainHeartbeat/,
  /flushQueuedMartRefreshes/,
  /ensureQueueSchema/,
  /getQueuedArticleTasksSqlForTests/,
  /recoverQueuedArchivedProjectRefresh/,
  /pruneProjectQueueRowsForProjects/,
  /db:duck:quarantine-refresh-article/,
  /db:duck:unquarantine-refresh-article/,
  /db:duck:rebuild-marts/,
  /db:duck:backfill-review-serving-v3/,
  /db:duck:refresh-project-once/,
  /db:duck:run-large-rebuild-cycle/,
  /db:duck:run-large-rebuild-cycles/,
  /backfillReviewServingV3/,
  /runProjectMartLargeRebuildCycle\.ts/,
  /runProjectMartLargeRebuildCycles\.ts/,
  /quarantineProjectMartRefreshArticle/,
  /unquarantineProjectMartRefreshArticle/,
  /db:duck:inspect-project-refresh-risk/,
  /db:duck:recover-project-refresh-claims/,
  /db:duck:repair-project-refresh-ledger/,
  /db:duck:repair-judgment-fact/,
  /db:duck:purge-archived-marts/,
  /inspectProjectMartRefreshRisk/,
  /recoverProjectMartRefreshClaims/,
  /repairProjectMartRefreshLedger/,
  /repairJudgmentFactTable/,
  /purgeArchivedProjectMarts/,
  /reproArchivedProjectServingDelete/,
  /app\.mart_refresh_queue/,
] as const

const obsoleteStateClearingPatterns = [
  {
    label: 'dirty materialization state',
    pattern:
      /\b(?:DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|DROP\s+TABLE(?:\s+IF\s+EXISTS)?)\s+app\.project_mart_dirty_materialization_state\b/i,
  },
  {
    label: 'dirty refresh article quarantine',
    pattern:
      /\b(?:DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|DROP\s+TABLE(?:\s+IF\s+EXISTS)?)\s+app\.project_mart_dirty_refresh_article_quarantine\b/i,
  },
  {
    label: 'dirty refresh article state',
    pattern:
      /\b(?:DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|DROP\s+TABLE(?:\s+IF\s+EXISTS)?)\s+app\.project_mart_refresh_article_state\b/i,
  },
  {
    label: 'dirty refresh project state',
    pattern:
      /\b(?:DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|DROP\s+TABLE(?:\s+IF\s+EXISTS)?)\s+app\.project_mart_refresh_state\b/i,
  },
  {
    label: 'large rebuild state',
    pattern:
      /\b(?:DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|DROP\s+TABLE(?:\s+IF\s+EXISTS)?)\s+app\.project_mart_large_rebuild_state\b/i,
  },
  {
    label: 'legacy mart refresh queue',
    pattern: /\b(?:DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|DROP\s+TABLE(?:\s+IF\s+EXISTS)?)\s+app\.mart_refresh_queue\b/i,
  },
  {
    label: 'obsolete quarantine state',
    pattern:
      /\b(?:DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|DROP\s+TABLE(?:\s+IF\s+EXISTS)?)\s+app\.project_mart_refresh_article_quarantine\b/i,
  },
  {
    label: 'outbox import state',
    pattern:
      /\b(?:DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|DROP\s+TABLE(?:\s+IF\s+EXISTS)?)\s+app\.judgment_job_sqlite_outbox_import\b/i,
  },
  {
    label: 'maintenance lease state',
    pattern:
      /\b(?:DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?|DROP\s+TABLE(?:\s+IF\s+EXISTS)?)\s+app\.maintenance_work_lease\b/i,
  },
] as const

const getScanFiles = (rootPath: string): string[] => {
  const absolutePath = join(projectRoot, rootPath)
  const entries = readdirSync(absolutePath, {withFileTypes: true})

  return entries.reduce<string[]>((acc, entry) => {
    const entryPath = join(rootPath, entry.name)

    if (entry.isDirectory()) {
      return [...acc, ...getScanFiles(entryPath)]
    }

    return entry.name.endsWith('.md')
      || entry.name.endsWith('.ts')
      || entry.name.endsWith('.sql')
      || entry.name === 'package.json'
      ? [...acc, entryPath]
      : acc
  }, [])
}

const getRootScanFiles = (rootPath: string) => {
  return rootPath.endsWith('.json') || rootPath.endsWith('.md') ? [rootPath] : getScanFiles(rootPath)
}

const getObsoleteReferenceMatches = () => {
  const files = scanRoots.flatMap((root) => {
    return getRootScanFiles(root)
  })

  return files
    .filter((filePath) => {
      return !allowedReferenceFiles.has(filePath) && !filePath.endsWith('.test.ts')
    })
    .flatMap((filePath) => {
      const content = readFileSync(join(projectRoot, filePath), 'utf8')

      return obsoletePatterns
        .filter((pattern) => {
          return pattern.test(content)
        })
        .map((pattern) => {
          return {path: relative(projectRoot, join(projectRoot, filePath)), pattern: String(pattern)}
        })
    })
}

const getNonCutoverStateClearingMatches = () => {
  return getScanFiles('scripts')
    .filter((filePath) => {
      return !allowedStateClearingFiles.has(filePath) && !filePath.endsWith('.test.ts')
    })
    .flatMap((filePath) => {
      const content = readFileSync(join(projectRoot, filePath), 'utf8')

      return obsoleteStateClearingPatterns
        .filter(({pattern}) => {
          return pattern.test(content)
        })
        .map(({label}) => {
          return {label, path: relative(projectRoot, join(projectRoot, filePath))}
        })
    })
}

test('obsolete mart refresh queue command, docs, and runtime references are gone', () => {
  expect(getObsoleteReferenceMatches()).toEqual([])
})

test('rebuild2 cutover is the only operator script that clears obsolete rebuild2 state', () => {
  expect(getNonCutoverStateClearingMatches()).toEqual([])
})
