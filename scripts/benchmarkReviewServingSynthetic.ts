import {
  reviewServingSyntheticBenchmarkScales,
  runReviewServingSyntheticBenchmark,
  type ReviewServingSyntheticBenchmarkMode,
  type ReviewServingSyntheticBenchmarkScale,
} from '../src/server/reviewServing/reviewServingSyntheticBenchmark.ts'

const getArgValue = (name: string) => {
  const prefix = `${name}=`
  const matchingArg = process.argv.slice(2).find((arg) => {
    return arg.startsWith(prefix)
  })

  return matchingArg ? matchingArg.slice(prefix.length) : null
}

const hasArg = (name: string) => {
  return process.argv.slice(2).includes(name)
}

const getMode = (): ReviewServingSyntheticBenchmarkMode => {
  const mode = getArgValue('--mode') ?? 'check'

  if (mode !== 'check' && mode !== 'measure') {
    throw new Error(`Invalid --mode=${mode}; expected check or measure`)
  }

  return mode
}

const getScale = (): ReviewServingSyntheticBenchmarkScale => {
  const scale = getArgValue('--scale') ?? 'medium'

  if (!reviewServingSyntheticBenchmarkScales.includes(scale as ReviewServingSyntheticBenchmarkScale)) {
    throw new Error(`Invalid --scale=${scale}; expected ${reviewServingSyntheticBenchmarkScales.join(', ')}`)
  }

  return scale as ReviewServingSyntheticBenchmarkScale
}

const getSeed = () => {
  const seed = getArgValue('--seed')

  return seed ? Number(seed) : undefined
}

const getDuckdbMemoryLimit = () => {
  return getArgValue('--duckdb-memory-limit') ?? process.env.DUCKDB_MEMORY_LIMIT?.trim() ?? '1024MiB'
}

const mode = getMode()
const scale = getScale()
const artifact = await runReviewServingSyntheticBenchmark({
  command: `bun ${process.argv.slice(1).join(' ')}`,
  duckdbMemoryLimit: getDuckdbMemoryLimit(),
  holdout: hasArg('--holdout'),
  mode,
  scale,
  seed: getSeed(),
  targetMetric: getArgValue('--target-metric'),
  targetOperation: getArgValue('--target-operation'),
})

console.log(
  JSON.stringify(
    {
      artifactPath: artifact.artifactPath,
      fixture: artifact.fixture,
      mode: artifact.mode,
      operationCount: artifact.operationMetrics.length,
      totals: artifact.totals,
      violations: artifact.violations,
    },
    null,
    2,
  ),
)
