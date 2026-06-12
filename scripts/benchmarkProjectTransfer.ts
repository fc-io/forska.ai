import {existsSync, readFileSync} from 'node:fs'

import {
  getProjectTransferPerformanceMetrics,
  projectTransferMetricUnavailable,
  type ProjectTransferPerformanceMetrics,
} from '../src/server/services/projectTransfer/projectTransferPerformanceMetrics.ts'

type ProjectTransferBenchmarkFixture =
  | 'article-heavy-export'
  | 'article-heavy-package'
  | 'asset-heavy-export'
  | 'asset-heavy-package'
  | 'conflict-heavy-package'
  | 'judgment-heavy-package'
  | 'large-export'
  | 'reuse-heavy-package'
  | 'small-inline'

type ProjectTransferBenchmarkArgs = {
  fixture: ProjectTransferBenchmarkFixture
  metricsFile: string | null
  progressFile: string | null
}

const projectTransferBenchmarkFixtures = [
  'small-inline',
  'article-heavy-package',
  'judgment-heavy-package',
  'asset-heavy-package',
  'reuse-heavy-package',
  'conflict-heavy-package',
  'article-heavy-export',
  'asset-heavy-export',
  'large-export',
] as const satisfies readonly ProjectTransferBenchmarkFixture[]

const getArgValue = (flag: string) => {
  const prefix = `${flag}=`

  return (
    process.argv
      .slice(2)
      .find((argument) => {
        return argument.startsWith(prefix)
      })
      ?.slice(prefix.length) ?? null
  )
}

const getFixture = (value: string | null): ProjectTransferBenchmarkFixture => {
  return projectTransferBenchmarkFixtures.includes(value as ProjectTransferBenchmarkFixture)
    ? (value as ProjectTransferBenchmarkFixture)
    : 'small-inline'
}

const getArgs = (): ProjectTransferBenchmarkArgs => {
  return {
    fixture: getFixture(getArgValue('--fixture')),
    metricsFile: getArgValue('--metrics-file'),
    progressFile: getArgValue('--progress-file'),
  }
}

const readJsonFile = (pathValue: string | null) => {
  return pathValue !== null && existsSync(pathValue) ? (JSON.parse(readFileSync(pathValue, 'utf8')) as unknown) : null
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const getMetricsFromRecord = (value: unknown): ProjectTransferPerformanceMetrics | null => {
  return isRecord(value) && isRecord(value.performanceMetrics)
    ? (value.performanceMetrics as ProjectTransferPerformanceMetrics)
    : isRecord(value) && value.version === 1 && isRecord(value.benchmark)
      ? (value as ProjectTransferPerformanceMetrics)
      : null
}

const getInputMetrics = (args: ProjectTransferBenchmarkArgs) => {
  return (
    getMetricsFromRecord(readJsonFile(args.metricsFile))
    ?? getMetricsFromRecord(readJsonFile(args.progressFile))
    ?? getProjectTransferPerformanceMetrics({operation: 'import'})
  )
}

const getMetricStatus = (metrics: ProjectTransferPerformanceMetrics) => {
  return metrics.benchmark.wallTimeMs === projectTransferMetricUnavailable ? 'metrics_unavailable' : 'ok'
}

const main = () => {
  const args = getArgs()
  const metrics = getInputMetrics(args)

  console.log(
    JSON.stringify({
      benchmark: metrics.benchmark,
      bytes: metrics.bytes,
      fixture: args.fixture,
      generatedAt: new Date().toISOString(),
      machineReadable: true,
      memory: metrics.memory,
      parser: metrics.parser,
      phases: metrics.phases,
      rows: metrics.rows,
      status: getMetricStatus(metrics),
      warnings: metrics.warnings,
    }),
  )
}

main()
