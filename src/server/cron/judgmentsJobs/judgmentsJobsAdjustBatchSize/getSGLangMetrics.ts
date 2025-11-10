const parse = (line: string) => {
  if (!line || line.startsWith('#')) return undefined

  const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)$/)
  if (!m) return undefined

  const [, name, labelStr, valStr] = m
  const labels: Record<string, string> = !labelStr
    ? {}
    : Object.fromEntries(
        labelStr
          .slice(1, -1)
          .split(',')
          .filter(Boolean)
          .map((kv) => {
            const idx = kv.indexOf('=')
            const k = kv.slice(0, idx)
            const v = kv.slice(idx + 1).replace(/^"|"$/g, '')
            return [k, v]
          }),
      )
  const value = Number(valStr)

  return Number.isFinite(value) ? {name: name ?? '', labels, value} : undefined
}

const parsePrometheusText = (text: string) => {
  const lines = text.split(/\n+/)

  return lines.map(parse).filter((x): x is NonNullable<typeof x> => {
    return x !== undefined
  })
}

const buildMetricsUrl = (endpoint: string): string => {
  const trimmed = endpoint.replace(/\/+$/, '')
  const withoutV1 = trimmed.replace(/\/?v1\/?$/, '')
  return `${withoutV1}/metrics`
}

const fetchMetrics = async (endpoint: string) => {
  const url = buildMetricsUrl(endpoint)
  const res = await fetch(url).catch(() => {
    return undefined
  })

  if (!res || !res.ok) return []

  return parsePrometheusText(await res.text())
}

type PromSample = Awaited<ReturnType<typeof fetchMetrics>>[number]

const sumByName = (metrics: PromSample[], names: string[]): number => {
  const set = new Set(names)
  return metrics.reduce((acc, s) => {
    return set.has(s.name) ? acc + s.value : acc
  }, 0)
}

const pickOne = (metrics: PromSample[], names: string[], def = 0): number => {
  for (const n of names) {
    const s = metrics.find((x) => {
      return x.name === n
    })
    if (s) return s.value
  }
  return def
}

const stableKey = (labels: Record<string, string>, exclude: string[] = []): string => {
  const ex = new Set(exclude)
  return Object.entries(labels)
    .filter(([k]) => {
      return !ex.has(k)
    })
    .sort(([a], [b]) => {
      return a.localeCompare(b)
    })
    .map(([k, v]) => {
      return `${k}=${v}`
    })
    .join(',')
}

const strip = (labels: Record<string, string>, exclude: string[] = []): Record<string, string> => {
  const ex = new Set(exclude)
  return Object.fromEntries(
    Object.entries(labels).filter(([k]) => {
      return !ex.has(k)
    }),
  )
}

type HistogramSeries = {
  labels: Record<string, string>
  sum?: number
  count?: number
  buckets: {le: string; value: number}[]
}

const collectHistogram = (metrics: PromSample[], baseName: string): {series: HistogramSeries[]} => {
  const sumName = `${baseName}_sum`
  const countName = `${baseName}_count`
  const bucketName = `${baseName}_bucket`

  const map = new Map<string, HistogramSeries>()

  const upsert = (labels: Record<string, string>): HistogramSeries => {
    const key = stableKey(labels)
    const cur = map.get(key)
    if (cur) return cur
    const init = {labels: {...labels}, buckets: []}
    map.set(key, init)
    return init
  }

  for (const s of metrics) {
    if (s.name === sumName) {
      const series = upsert(s.labels)
      series.sum = s.value
    } else if (s.name === countName) {
      const series = upsert(s.labels)
      series.count = s.value
    } else if (s.name === bucketName) {
      const labels = strip(s.labels, ['le'])
      const series = upsert(labels)
      const le = String(s.labels.le ?? '+Inf')
      series.buckets = [...series.buckets, {le, value: s.value}]
    }
  }

  return {series: [...map.values()]}
}

export const getSGLangMetrics = async (
  endpoint: string,
): Promise<{
  promptTokensTotal: number
  generationTokensTotal: number
  numRequestsTotal: number
  numQueueReqs: number
  numRunningReqs: number
  timeToFirstTokenSeconds?: {series: HistogramSeries[]}
  e2eRequestLatencySeconds?: {series: HistogramSeries[]}
  interTokenLatencySeconds?: {series: HistogramSeries[]}
  perStageReqLatencySeconds?: {series: HistogramSeries[]}
  queueTimeSeconds?: {series: HistogramSeries[]}
  genThroughput?: number
  tokenUsage?: number
  utilization?: number
  cacheHitRate?: number
  specAcceptRate?: number
  specAcceptLength?: number
  numGrammarQueueReqs?: number
  numRunningReqsOfflineBatch?: number
  numPrefillPreallocQueueReqs?: number
  numPrefillInflightQueueReqs?: number
  numDecodePreallocQueueReqs?: number
  numDecodeTransferQueueReqs?: number
  kvTransferSpeedGbS?: number
  kvTransferLatencyMs?: number
  kvTransferBootstrapMs?: number
  kvTransferAllocMs?: number
  pendingPreallocTokenUsage?: number
  isCudaGraph?: boolean
  swaTokenUsage?: number
  mambaUsage?: number
  numRetractionsCount?: number
  cachedTokensTotal?: number
}> => {
  const metrics = await fetchMetrics(endpoint)

  // SGLang Prometheus names seen in the wild (prefix "sglang:")
  // Counters: prompt_tokens_total, generation_tokens_total, num_requests_total
  // Gauges: num_queue_reqs, num_running_reqs, gen_throughput, token_usage, utilization, cache_hit_rate
  // Histograms: time_to_first_token_seconds, e2e_request_latency_seconds, inter_token_latency_seconds, num_retractions
  // There is no direct GPU KV cache usage percentage metric akin to vLLM's kv_cache_usage_*.

  const promptTokensTotal = Math.floor(sumByName(metrics, ['sglang:prompt_tokens_total']))
  const generationTokensTotal = Math.floor(sumByName(metrics, ['sglang:generation_tokens_total']))
  const numRequestsTotal = Math.floor(sumByName(metrics, ['sglang:num_requests_total']))
  const cachedTokensTotal = Math.floor(sumByName(metrics, ['sglang:cached_tokens_total']))

  const numRetractionsCount = Math.floor(pickOne(metrics, ['sglang:num_retractions_count'], 0))

  const numQueueReqs = Math.floor(pickOne(metrics, ['sglang:num_queue_reqs'], 0))
  const numRunningReqs = Math.floor(pickOne(metrics, ['sglang:num_running_reqs'], 0))
  const numGrammarQueueReqs = Math.floor(pickOne(metrics, ['sglang:num_grammar_queue_reqs'], 0))
  const numRunningReqsOfflineBatch = Math.floor(pickOne(metrics, ['sglang:num_running_reqs_offline_batch'], 0))
  const numPrefillPreallocQueueReqs = Math.floor(pickOne(metrics, ['sglang:num_prefill_prealloc_queue_reqs'], 0))
  const numPrefillInflightQueueReqs = Math.floor(pickOne(metrics, ['sglang:num_prefill_inflight_queue_reqs'], 0))
  const numDecodePreallocQueueReqs = Math.floor(pickOne(metrics, ['sglang:num_decode_prealloc_queue_reqs'], 0))
  const numDecodeTransferQueueReqs = Math.floor(pickOne(metrics, ['sglang:num_decode_transfer_queue_reqs'], 0))

  const genThroughput = pickOne(metrics, ['sglang:gen_throughput'], 0)
  const tokenUsage = pickOne(metrics, ['sglang:token_usage'], 0)
  const utilization = pickOne(metrics, ['sglang:utilization'], 0)
  const cacheHitRate = pickOne(metrics, ['sglang:cache_hit_rate'], 0)
  const specAcceptRate = pickOne(metrics, ['sglang:spec_accept_rate'], 0)
  const specAcceptLength = pickOne(metrics, ['sglang:spec_accept_length'], 0)
  const pendingPreallocTokenUsage = pickOne(metrics, ['sglang:pending_prealloc_token_usage'], 0)
  const isCudaGraph = pickOne(metrics, ['sglang:is_cuda_graph'], 0) > 0
  const swaTokenUsage = pickOne(metrics, ['sglang:swa_token_usage'], 0)
  const mambaUsage = pickOne(metrics, ['sglang:mamba_usage'], 0)

  const kvTransferSpeedGbS = pickOne(metrics, ['sglang:kv_transfer_speed_gb_s'], 0)
  const kvTransferLatencyMs = pickOne(metrics, ['sglang:kv_transfer_latency_ms'], 0)
  const kvTransferBootstrapMs = pickOne(metrics, ['sglang:kv_transfer_bootstrap_ms'], 0)
  const kvTransferAllocMs = pickOne(metrics, ['sglang:kv_transfer_alloc_ms'], 0)

  const timeToFirstTokenSeconds = collectHistogram(metrics, 'sglang:time_to_first_token_seconds')
  const e2eRequestLatencySeconds = collectHistogram(metrics, 'sglang:e2e_request_latency_seconds')
  const interTokenLatencySeconds = collectHistogram(metrics, 'sglang:inter_token_latency_seconds')
  const perStageReqLatencySeconds = collectHistogram(metrics, 'sglang:per_stage_req_latency_seconds')
  const queueTimeSeconds = collectHistogram(metrics, 'sglang:queue_time_seconds')

  return {
    promptTokensTotal,
    generationTokensTotal,
    numRequestsTotal,
    numQueueReqs,
    numRunningReqs,
    timeToFirstTokenSeconds,
    e2eRequestLatencySeconds,
    interTokenLatencySeconds,
    perStageReqLatencySeconds,
    queueTimeSeconds,
    genThroughput,
    tokenUsage,
    utilization,
    cacheHitRate,
    specAcceptRate,
    specAcceptLength,
    numGrammarQueueReqs,
    numRunningReqsOfflineBatch,
    numPrefillPreallocQueueReqs,
    numPrefillInflightQueueReqs,
    numDecodePreallocQueueReqs,
    numDecodeTransferQueueReqs,
    kvTransferSpeedGbS,
    kvTransferLatencyMs,
    kvTransferBootstrapMs,
    kvTransferAllocMs,
    pendingPreallocTokenUsage,
    isCudaGraph,
    swaTokenUsage,
    mambaUsage,
    numRetractionsCount,
    cachedTokensTotal,
  }
}
