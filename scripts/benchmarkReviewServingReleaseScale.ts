import {runReviewServingSyntheticBenchmark} from '../src/server/reviewServing/reviewServingSyntheticBenchmark.ts'

const confirmed = process.argv.includes('--confirm-release-scale')
const duckdbMemoryLimit = process.argv
  .find((arg) => {
    return arg.startsWith('--duckdb-memory-limit=')
  })
  ?.slice('--duckdb-memory-limit='.length)
  ?? process.env.DUCKDB_MEMORY_LIMIT?.trim()

if (!confirmed || !duckdbMemoryLimit) {
  throw new Error(
    'Release-scale review-serving benchmark is manual/long-running. Re-run with --confirm-release-scale and --duckdb-memory-limit=<limit>.',
  )
}

const artifact = await runReviewServingSyntheticBenchmark({
  command: `bun ${process.argv.slice(1).join(' ')}`,
  duckdbMemoryLimit,
  mode: 'check',
  scale: 'release',
})

console.log(JSON.stringify({artifactPath: artifact.artifactPath, fixture: artifact.fixture, totals: artifact.totals}, null, 2))
