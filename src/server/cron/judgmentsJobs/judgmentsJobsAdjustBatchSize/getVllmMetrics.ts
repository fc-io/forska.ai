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

export const getVllmMetrics = async () => {
  const vllmMetricsUrl = 'http://localhost:8000/metrics'
  const res = await fetch(vllmMetricsUrl).catch(() => {
    return undefined
  })

  if (!res || !res.ok) return []

  return parsePrometheusText(await res.text())
}
