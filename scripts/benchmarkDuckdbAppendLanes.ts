import {rmSync} from 'node:fs'
import {dirname, join} from 'node:path'

type BenchmarkSummary = {
  attempted: number
  averageRowsPerSecond: number | null
  averageRowsPerSecondAttempted: number | null
  batchSize: number
  durationMs: number
  inserted: number
  laneCount: number
  lastInsertedRowsPerSecond: number | null
  maxQueueDepth: number
  maxQueueDepthByLane: number[]
  queueDepth: number
  queueDepthByLane: number[]
  rowCount: number
  skipped: number
  wallRowsPerSecond: number
}

const getArgValue = (name: string) => {
  const prefix = `${name}=`
  return process.argv
    .slice(2)
    .find((argument) => {
      return argument.startsWith(prefix)
    })
    ?.slice(prefix.length)
}

const getIntegerArg = (name: string, fallbackValue: number) => {
  const rawValue = getArgValue(name)
  const parsedValue = Number(rawValue ?? fallbackValue)
  return Number.isFinite(parsedValue) && parsedValue > 0 ? Math.round(parsedValue) : fallbackValue
}

const hasArg = (name: string) => {
  return process.argv.slice(2).includes(name)
}

const getChunkedValues = <T>(items: T[], chunkSize: number): T[][] => {
  return items.length === 0 ? [] : [items.slice(0, chunkSize), ...getChunkedValues(items.slice(chunkSize), chunkSize)]
}

const getSqlStringLiteral = (value: string) => {
  return `'${value.replaceAll("'", "''")}'`
}

const getTempDbPath = (laneCount: number) => {
  return `/tmp/f1-duckdb-append-benchmark-${laneCount}-${process.pid}-${Date.now()}.duckdb`
}

const removeBenchmarkFiles = (duckdbPath: string) => {
  const tempJobDir = join(dirname(duckdbPath), 'judgment-jobs')

  rmSync(duckdbPath, {force: true})
  rmSync(`${duckdbPath}.writer.history.json`, {force: true})
  rmSync(`${duckdbPath}.writer.lock`, {force: true})
  rmSync(tempJobDir, {force: true, recursive: true})
}

const logBenchmarkSummary = (summary: BenchmarkSummary) => {
  console.log(
    `[append-bench] lanes=${summary.laneCount} rows=${summary.inserted}/${summary.attempted} durationMs=${summary.durationMs} wallRowsPerSecond=${summary.wallRowsPerSecond} avgRowsPerSecond=${summary.averageRowsPerSecond ?? 'n/a'} maxQueueDepth=${summary.maxQueueDepth} queueDepthByLane=${summary.maxQueueDepthByLane.join(',')}`,
  )
}

const getComparisonSummary = (results: BenchmarkSummary[]) => {
  const [twoLaneResult, fourLaneResult] = results

  if (!twoLaneResult || !fourLaneResult) {
    throw new Error('Need both 2-lane and 4-lane benchmark results')
  }

  const twoLaneRowsPerSecond = twoLaneResult.wallRowsPerSecond
  const fourLaneRowsPerSecond = fourLaneResult.wallRowsPerSecond
  const winningResult = fourLaneRowsPerSecond > twoLaneRowsPerSecond ? fourLaneResult : twoLaneResult
  const deltaRowsPerSecond = Number((fourLaneRowsPerSecond - twoLaneRowsPerSecond).toFixed(2))

  return {deltaRowsPerSecond, results, winnerLaneCount: winningResult.laneCount}
}

const getWorkerArgs = (batchSize: number, laneCount: number, rowCount: number) => {
  return [
    'bun',
    'scripts/benchmarkDuckdbAppendLanes.ts',
    `--lane-count=${laneCount}`,
    `--row-count=${rowCount}`,
    `--batch-size=${batchSize}`,
    '--json',
  ]
}

const runWorkerBenchmark = (batchSize: number, laneCount: number, rowCount: number): BenchmarkSummary => {
  const result = globalThis.Bun.spawnSync(getWorkerArgs(batchSize, laneCount, rowCount), {
    cwd: process.cwd(),
    env: {...process.env},
    stderr: 'pipe',
    stdout: 'pipe',
  })
  const stdout = result.stdout.toString().trim()
  const stderr = result.stderr.toString().trim()
  const stdoutLines = stdout
    .split('\n')
    .map((line) => {
      return line.trim()
    })
    .filter((line) => {
      return line !== ''
    })
  const jsonLine = stdoutLines.at(-1) ?? ''

  if (result.exitCode !== 0) {
    throw new Error(stderr || stdout || `Append benchmark worker failed for lane count ${laneCount}`)
  }

  return JSON.parse(jsonLine) as BenchmarkSummary
}

const runBenchmarkComparison = (batchSize: number, rowCount: number) => {
  return [2, 4].map((laneCount) => {
    return runWorkerBenchmark(batchSize, laneCount, rowCount)
  })
}

const runBenchmarkWorker = async (
  batchSize: number,
  laneCount: number,
  rowCount: number,
): Promise<BenchmarkSummary> => {
  const duckdbPath = getTempDbPath(laneCount)

  process.env.API_SERVER_PORT = process.env.API_SERVER_PORT ?? '3001'
  process.env.DUCKDB_APPEND_LANE_COUNT = String(laneCount)
  process.env.DUCKDB_PATH = duckdbPath
  process.env.RUN_SERVER_JUDGING = 'false'
  process.env.SERVER_ROLE = 'dev-single'
  process.env.VITE_PORT = process.env.VITE_PORT ?? '3000'

  const [{migrateDuckdb}, {getAppDatabaseService}] = await Promise.all([
    import('../src/db/migrateDuckdb.ts'),
    import('../src/server/services/appDatabaseService.ts'),
  ])

  await migrateDuckdb()

  const database = getAppDatabaseService()
  const connectionId = `connection-${laneCount}-${Date.now()}`
  const modelId = `model-${laneCount}-${Date.now()}`
  const promptId = `prompt-${laneCount}-${Date.now()}`
  const articleIds = Array.from({length: rowCount}, (_value, index) => {
    return `article-${laneCount}-${index}-${Date.now()}`
  })
  const articleInsertStatements = getChunkedValues(articleIds, 500).map((articleIdChunk) => {
    return `
      INSERT INTO app.article (id, article_title)
      VALUES ${articleIdChunk
        .map((articleId) => {
          return `(${getSqlStringLiteral(articleId)}, ${getSqlStringLiteral(articleId)})`
        })
        .join(', ')}
    `
  })
  const createdAt = new Date()
  const updatedAt = new Date(createdAt.getTime() + 1_000)
  const batches = getChunkedValues(articleIds, batchSize).map((articleIdChunk, batchIndex) => {
    return articleIdChunk.map((articleId, rowIndex) => {
      return {
        answeredOriginal: 'yes',
        answeredOriginalAsArray: ['yes'],
        articleId,
        chunkingStrategy: null,
        confidenceOriginal: 50,
        createdAt,
        explanation: 'benchmark',
        id: `judgment-${laneCount}-${batchIndex}-${rowIndex}-${Date.now()}`,
        isAnswered: true,
        modelId,
        projectId: null,
        promptId,
        quotes: ['quote'],
        snapshotProjectId: null,
        snapshotProjectModelName: null,
        updatedAt,
        useAbstract: true,
        useFulltext: false,
        useFulltextNoImages: false,
        useTitle: true,
      }
    })
  })

  try {
    await database.run(`
      INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode, base_url)
      VALUES (${getSqlStringLiteral(connectionId)}, 'sglang', 'SGLang', TRUE, 'none', 'http://localhost:30001/v1')
    `)
    await database.run(`
      INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
      VALUES (
        ${getSqlStringLiteral(modelId)},
        ${getSqlStringLiteral(connectionId)},
        'Qwen/Qwen3.5-35B-A3B',
        'Qwen/Qwen3.5-35B-A3B',
        'Qwen 35B',
        'manual',
        TRUE
      )
    `)
    await database.run(`
      INSERT INTO app.prompt (id, original_text, content_hash)
      VALUES (${getSqlStringLiteral(promptId)}, 'Prompt', ${getSqlStringLiteral(`${promptId}-hash`)})
    `)
    await Promise.all(
      articleInsertStatements.map((statement) => {
        return database.run(statement)
      }),
    )

    const startedAtMs = Date.now()
    const results = await Promise.all(
      batches.map((batchRows) => {
        return database.appendJudgments(batchRows)
      }),
    )
    const durationMs = Date.now() - startedAtMs
    const totals = results.reduce(
      (state, result) => {
        return {
          attempted: state.attempted + result.attempted,
          inserted: state.inserted + result.inserted,
          skipped: state.skipped + result.skipped,
        }
      },
      {attempted: 0, inserted: 0, skipped: 0},
    )
    const metrics = database.getAppendMetrics()
    const wallRowsPerSecond = Number((totals.inserted / (durationMs / 1000)).toFixed(2))

    return {
      attempted: totals.attempted,
      averageRowsPerSecond: metrics.averageRowsPerSecond,
      averageRowsPerSecondAttempted: metrics.averageRowsPerSecondAttempted,
      batchSize,
      durationMs,
      inserted: totals.inserted,
      laneCount,
      lastInsertedRowsPerSecond: metrics.lastInsertedRowsPerSecond,
      maxQueueDepth: metrics.maxQueueDepth,
      maxQueueDepthByLane: metrics.maxQueueDepthByLane,
      queueDepth: metrics.queueDepth,
      queueDepthByLane: metrics.queueDepthByLane,
      rowCount,
      skipped: totals.skipped,
      wallRowsPerSecond,
    }
  } finally {
    await database.close()
    removeBenchmarkFiles(duckdbPath)
  }
}

const main = async () => {
  const batchSize = getIntegerArg('--batch-size', 100)
  const laneCount = getIntegerArg('--lane-count', 0)
  const rowCount = getIntegerArg('--row-count', 4_000)

  if (laneCount > 0) {
    const summary = await runBenchmarkWorker(batchSize, laneCount, rowCount)
    return hasArg('--json') ? console.log(JSON.stringify(summary)) : logBenchmarkSummary(summary)
  }

  const results = runBenchmarkComparison(batchSize, rowCount)

  results.map(logBenchmarkSummary)
  console.log(JSON.stringify(getComparisonSummary(results), null, 2))
}

await main()
