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

const buildMetricsUrl = (
  : string): string => {
  const trimmed =
  .replace(/\/+$/, '')
  const withoutV1 = trimmed.replace(/\/?v1\/?$/, '')
  return `${withoutV1}/metrics`
}

const fetchMetrics = async (
  : string) => {
  const vllmMetricsUrl = buildMetricsUrl(
    
  )
  const res = await fetch(vllmMetricsUrl).catch(() => {
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

const maxByName = (metrics: PromSample[], names: string[]): number => {
  const set = new Set(names)
  let max = 0
  for (const s of metrics) if (set.has(s.name) && s.value > max) max = s.value
  return max
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

export const getVllmMetrics = async (

  : string,
): Promise<{
  promptTokensTotal: number
  generationTokensTotal: number
  requestSuccessTotal: number
  requestErrorTotal: number
  numPreemptionsTotal: number
  numRequestsWaiting: number
  numRequestsRunning: number
  numRequestsSwapped: number
  gpuCacheUsagePerc: number
}> => {
  const metrics = await fetchMetrics(
    
  )

  return {
    promptTokensTotal: Math.floor(sumByName(metrics, ['vllm:prompt_tokens_total', 'vllm_prompt_tokens_total'])),
    generationTokensTotal: Math.floor(
      sumByName(metrics, ['vllm:generation_tokens_total', 'vllm_generated_tokens_total']),
    ),
    requestSuccessTotal: Math.floor(sumByName(metrics, ['vllm:request_success_total'])),
    requestErrorTotal: Math.floor(sumByName(metrics, ['vllm:request_error_total'])),
    numPreemptionsTotal: Math.floor(sumByName(metrics, ['vllm:num_preemptions_total'])),

    numRequestsWaiting: Math.floor(pickOne(metrics, ['vllm:num_requests_waiting'])),
    numRequestsRunning: Math.floor(pickOne(metrics, ['vllm:num_requests_running'])),
    numRequestsSwapped: Math.floor(pickOne(metrics, ['vllm:num_requests_swapped'], 0)),
    // vLLM renamed GPU cache usage metric to kv_cache_usage_*. Prefer new name, fallback to old ones.
    gpuCacheUsagePerc: maxByName(metrics, [
      'vllm:kv_cache_usage_perc',
      'vllm:kv_cache_usage_ratio',
      'vllm:gpu_cache_usage_ratio',
      'vllm:gpu_cache_usage_perc',
    ]),
  }
}
