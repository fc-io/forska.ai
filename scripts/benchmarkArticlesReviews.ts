type BenchmarkArgs = {
  baseUrl: string
  filterAnswer: string | null
  filterPromptId: string | null
  iterations: number
  limit: number
  mode: 'both' | 'filtered' | 'unfiltered'
  page: number
  projectId: string
  warmupRuns: number
}

type BenchmarkMeasurement = {bytes: number; durationMs: number; status: number}

type BenchmarkSummary = {
  averageMs: number
  bytes: number
  iterations: number
  maxMs: number
  minMs: number
  statusCodes: number[]
}

type FilterOption = {answeredOriginalValues?: string[]; promptId: string; promptName?: string}

const getArgValue = (flag: string) => {
  const entry = process.argv.slice(2).find((argument) => {
    return argument.startsWith(`${flag}=`)
  })

  return entry ? entry.slice(flag.length + 1).trim() : null
}

const getNumberArg = (flag: string, defaultValue: number) => {
  const rawValue = getArgValue(flag)
  const parsedValue = Number.parseInt(rawValue ?? '', 10)
  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : defaultValue
}

const getArgs = (): BenchmarkArgs => {
  const mode = getArgValue('--mode')
  return {
    baseUrl: getArgValue('--base-url') ?? 'http://localhost:3004',
    filterAnswer: getArgValue('--filter-answer'),
    filterPromptId: getArgValue('--filter-prompt-id'),
    iterations: getNumberArg('--iterations', 2),
    limit: getNumberArg('--limit', 10),
    mode: mode === 'unfiltered' || mode === 'filtered' ? mode : 'both',
    page: getNumberArg('--page', 1),
    projectId: getArgValue('--project-id') ?? '1f234646-34d6-458f-b455-1f6a1dca68e1',
    warmupRuns: getNumberArg('--warmup-runs', 1),
  }
}

const getJson = async <T>(response: Response): Promise<T> => {
  return response.json() as Promise<T>
}

const getFilterOption = (filters: FilterOption[], promptId: string | null, answer: string | null) => {
  if (promptId && answer) {
    return (
      filters.find((filter) => {
        return filter.promptId === promptId && (filter.answeredOriginalValues ?? []).includes(answer)
      }) ?? null
    )
  }

  return (
    filters.find((filter) => {
      return (filter.answeredOriginalValues ?? []).length > 0
    }) ?? null
  )
}

const getFilterConfig = async (args: BenchmarkArgs) => {
  const response = await fetch(
    `${args.baseUrl}/api/articlesreviewsfilters?projectId=${encodeURIComponent(args.projectId)}`,
  )

  if (!response.ok) {
    throw new Error(`Failed to load filters: ${response.status}`)
  }

  const filters = await getJson<FilterOption[]>(response)
  const selectedFilter = getFilterOption(filters, args.filterPromptId, args.filterAnswer)

  if (!selectedFilter) {
    throw new Error('No filter option with values was found for the benchmark project')
  }

  const selectedAnswer = args.filterAnswer ?? selectedFilter.answeredOriginalValues?.[0] ?? null

  if (!selectedAnswer) {
    throw new Error('Selected filter has no answer value for the benchmark request')
  }

  return {
    answer: selectedAnswer,
    promptId: selectedFilter.promptId,
    promptName: selectedFilter.promptName ?? selectedFilter.promptId,
  }
}

const postArticlesReviews = async (args: BenchmarkArgs, prompts: Record<string, string[]>) => {
  const startedAt = performance.now()
  const response = await fetch(`${args.baseUrl}/api/articlesreviews`, {
    body: JSON.stringify({limit: String(args.limit), page: String(args.page), projectId: args.projectId, prompts}),
    headers: {'content-type': 'application/json'},
    method: 'POST',
  })
  const text = await response.text()
  const endedAt = performance.now()

  return {bytes: Buffer.byteLength(text, 'utf8'), durationMs: endedAt - startedAt, status: response.status}
}

const runBenchmarkRecursively = async (
  args: BenchmarkArgs,
  prompts: Record<string, string[]>,
  remainingRuns: number,
  measurements: BenchmarkMeasurement[],
): Promise<BenchmarkMeasurement[]> => {
  if (remainingRuns === 0) {
    return measurements
  }

  const measurement = await postArticlesReviews(args, prompts)
  return runBenchmarkRecursively(args, prompts, remainingRuns - 1, [...measurements, measurement])
}

const getMeasuredRuns = (measurements: BenchmarkMeasurement[], warmupRuns: number) => {
  return measurements.slice(warmupRuns)
}

const getAverage = (values: number[]) => {
  return (
    values.reduce((sum, value) => {
      return sum + value
    }, 0) / values.length
  )
}

const getSummary = (measurements: BenchmarkMeasurement[], warmupRuns: number): BenchmarkSummary => {
  const measuredRuns = getMeasuredRuns(measurements, warmupRuns)
  const durations = measuredRuns.map((measurement) => {
    return measurement.durationMs
  })

  return {
    averageMs: getAverage(durations),
    bytes: getAverage(
      measuredRuns.map((measurement) => {
        return measurement.bytes
      }),
    ),
    iterations: measuredRuns.length,
    maxMs: Math.max(...durations),
    minMs: Math.min(...durations),
    statusCodes: measuredRuns.map((measurement) => {
      return measurement.status
    }),
  }
}

const roundSummary = (summary: BenchmarkSummary) => {
  return {
    ...summary,
    averageMs: Math.round(summary.averageMs),
    bytes: Math.round(summary.bytes),
    maxMs: Math.round(summary.maxMs),
    minMs: Math.round(summary.minMs),
  }
}

const main = async () => {
  const args = getArgs()
  const totalRuns = args.warmupRuns + args.iterations
  const filterConfig = args.mode === 'unfiltered' ? null : await getFilterConfig(args)
  const unfilteredMeasurements =
    args.mode === 'filtered' ? null : await runBenchmarkRecursively(args, {}, totalRuns, [])
  const filteredMeasurements =
    filterConfig === null
      ? null
      : await runBenchmarkRecursively(args, {[filterConfig.promptId]: [filterConfig.answer]}, totalRuns, [])

  console.log(
    JSON.stringify(
      {
        baseUrl: args.baseUrl,
        iterations: args.iterations,
        limit: args.limit,
        mode: args.mode,
        page: args.page,
        projectId: args.projectId,
        unfiltered:
          unfilteredMeasurements === null
            ? null
            : {summary: roundSummary(getSummary(unfilteredMeasurements, args.warmupRuns))},
        filtered:
          filteredMeasurements === null || filterConfig === null
            ? null
            : {
                filterAnswer: filterConfig.answer,
                filterPromptId: filterConfig.promptId,
                filterPromptName: filterConfig.promptName,
                summary: roundSummary(getSummary(filteredMeasurements, args.warmupRuns)),
              },
        warmupRuns: args.warmupRuns,
      },
      null,
      2,
    ),
  )
}

void main()
