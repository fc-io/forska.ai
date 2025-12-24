/**
 * Artificial Analysis AI Models Routes - Fetch and enrich AI model data
 *
 * This module fetches model info from Artificial Analysis API and enriches
 * it with HuggingFace data (license, weights, VRAM estimates).
 */

import {Elysia} from 'elysia'

import {auth} from '../../auth'
import {requireAdminAuth} from '../utils/authGuard'
import {withErrorHandler} from '../utils/routeErrorHandler'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface AAModel {
  id: string
  name: string
  slug: string
  model_creator?: {id: string; name: string; slug: string}
  evaluations?: {artificial_analysis_intelligence_index?: number}
}

interface AAResponse {
  status: number
  data: AAModel[]
}

interface HFSearchItem {
  id: string
  author?: string
  gated?: boolean
  likes?: number
  downloads?: number
  tags?: string[]
}

interface HFModelInfo {
  id: string
  author?: string
  gated?: boolean
  license?: string
  cardData?: {license?: string}
  siblings?: Array<{rfilename: string}>
}

export interface ModelRow {
  aa_id: string
  aa_name: string
  aa_creator: string
  aa_creator_slug: string
  aa_intelligence_index: number | null

  hf_repo: string | null
  hf_license: string | null
  hf_has_weights: boolean | null
  open_source_or_proprietary: 'Open weights' | 'Proprietary' | 'Unknown'

  model_params: number | null
  model_params_label: string | null
  default_tensor_type: string | null

  weights_vram_gib_est: number | null
  fits_256gb_gpu_weights_only: boolean | null
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants & Helpers
// ─────────────────────────────────────────────────────────────────────────────

const AA_ENDPOINT = 'https://artificialanalysis.ai/api/v2/data/llms/models'
const HF_API_BASE = 'https://huggingface.co/api'
const HF_RAW_BASE = 'https://huggingface.co'

// Rate limiting helpers
const delay = (ms: number): Promise<void> => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
const HF_DELAY_MS = 150 // Delay between HF requests per worker
const MAX_RETRIES = 3

// Request deduplication - only process one request at a time
let inFlightRequest: Promise<ModelRow[]> | null = null
let cachedResult: {models: ModelRow[]; timestamp: number} | null = null
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

const norm = (s: string): string => {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

const bytesPerParam = (dtype: string | null): number | null => {
  if (!dtype) return null
  const d = dtype.toLowerCase()
  if (d.includes('float32') || d === 'fp32') return 4
  if (d.includes('bfloat16') || d.includes('bf16') || d.includes('float16') || d.includes('fp16') || d === 'half')
    return 2
  if (d.includes('float8') || d.includes('fp8')) return 1
  if (d.includes('int8')) return 1
  if (d.includes('int4')) return 0.5
  return null
}

const weightsGiB = (params: number, bpp: number): number => {
  return (params * bpp) / 1024 ** 3
}

const extractParamsFromName = (name: string): {params: number | null; label: string | null} => {
  const s = name.replace(/\s+/g, ' ').trim()

  // 8x7B style (MoE naming)
  {
    const m = s.match(/(\d+)\s*[x×]\s*(\d+(?:\.\d+)?)\s*B\b/i)
    if (m) {
      const a = Number(m[1])
      const b = Number(m[2])
      if (Number.isFinite(a) && Number.isFinite(b)) {
        const totalB = a * b
        return {params: Math.round(totalB * 1e9), label: `${totalB}B`}
      }
    }
  }

  // 235B / 32B / 1T / 0.5B
  {
    const m = s.match(/\b(\d+(?:\.\d+)?)\s*(T|B)\b/i)
    if (m && m[1] && m[2]) {
      const v = Number(m[1])
      const unit = m[2].toUpperCase()
      if (!Number.isFinite(v)) return {params: null, label: null}
      if (unit === 'B') return {params: Math.round(v * 1e9), label: `${v}B`}
      if (unit === 'T') return {params: Math.round(v * 1e12), label: `${v}T`}
    }
  }

  // common suffix: "-32b", "_70B", etc.
  {
    const m = s.match(/(?:^|[^a-z0-9])(\d+(?:\.\d+)?)(B|T)(?:[^a-z0-9]|$)/i)
    if (m && m[1] && m[2]) {
      const v = Number(m[1])
      const unit = m[2].toUpperCase()
      if (unit === 'B') return {params: Math.round(v * 1e9), label: `${v}B`}
      if (unit === 'T') return {params: Math.round(v * 1e12), label: `${v}T`}
    }
  }

  return {params: null, label: null}
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch Helpers
// ─────────────────────────────────────────────────────────────────────────────

const fetchJson = async <T>(url: string, init?: RequestInit): Promise<T> => {
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const r = await fetch(url, init)

    if (r.ok) {
      return (await r.json()) as T
    }

    // Rate limited - wait and retry
    if (r.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = r.headers.get('retry-after')
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : (attempt + 1) * 2000
      await delay(waitMs)
      continue
    }

    const txt = await r.text().catch(() => {
      return ''
    })
    lastError = new Error(`HTTP ${r.status} for ${url}\n${txt.slice(0, 400)}`)
  }

  throw lastError ?? new Error(`Failed to fetch ${url}`)
}

const fetchText = async (url: string, init?: RequestInit): Promise<string> => {
  const r = await fetch(url, init)
  if (!r.ok) return ''
  return await r.text()
}

const hasWeightsFromSiblings = (info: HFModelInfo): boolean => {
  const files =
    info.siblings?.map((s) => {
      return s.rfilename
    }) ?? []
  return files.some((f) => {
    return (
      f.endsWith('.safetensors')
      || f.endsWith('.safetensors.index.json')
      || f.endsWith('.bin')
      || f.endsWith('.pt')
      || f.endsWith('.gguf')
    )
  })
}

const licenseFromHF = (info: HFModelInfo): string | null => {
  return info.license ?? info.cardData?.license ?? null
}

const hfSearch = async (query: string, hfToken: string | null, limit = 8): Promise<HFSearchItem[]> => {
  const u = new URL(`${HF_API_BASE}/models`)
  u.searchParams.set('search', query)
  u.searchParams.set('limit', String(limit))

  return await fetchJson<HFSearchItem[]>(u.toString(), {
    headers: hfToken ? {Authorization: `Bearer ${hfToken}`} : undefined,
  })
}

const scoreHF = (candidate: HFSearchItem, aaName: string, aaCreatorSlug: string): number => {
  const n = norm(aaName)
  const id = candidate.id.toLowerCase()

  let score = 0

  if (id.endsWith('/' + n) || id.endsWith('/' + n.replace(/-+/g, '_'))) score += 200
  if (id.includes(n)) score += 80

  if (candidate.author && candidate.author.toLowerCase() === aaCreatorSlug.toLowerCase()) score += 40

  score += Math.min(candidate.likes ?? 0, 200) * 0.1
  score += Math.min(candidate.downloads ?? 0, 1_000_000) * 0.00001

  const tags = candidate.tags ?? []
  if (
    tags.some((t) => {
      return t.toLowerCase().includes('adapter') || t.toLowerCase().includes('lora')
    })
  )
    score -= 60

  return score
}

const hfModelInfo = async (repo: string, hfToken: string | null): Promise<HFModelInfo> => {
  return await fetchJson<HFModelInfo>(`${HF_API_BASE}/models/${repo}`, {
    headers: hfToken ? {Authorization: `Bearer ${hfToken}`} : undefined,
  })
}

const hfConfigDtype = async (repo: string, hfToken: string | null): Promise<string | null> => {
  const url = `${HF_RAW_BASE}/${repo}/resolve/main/config.json`
  const txt = await fetchText(url, {headers: hfToken ? {Authorization: `Bearer ${hfToken}`} : undefined})
  if (!txt) return null

  try {
    const j = JSON.parse(txt) as Record<string, unknown>
    const td = j['torch_dtype']
    const d = j['dtype']
    if (typeof td === 'string') return td
    if (typeof d === 'string') return d
    return null
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Model Processing
// ─────────────────────────────────────────────────────────────────────────────

const processOneModel = async (m: AAModel, hfToken: string | null, skipHf: boolean): Promise<ModelRow> => {
  const creatorName = m.model_creator?.name ?? ''
  const creatorSlug = m.model_creator?.slug ?? ''

  const aaii = m.evaluations?.artificial_analysis_intelligence_index
  const {params, label} = extractParamsFromName(m.name)

  let hfRepo: string | null = null
  let hfInfo: HFModelInfo | null = null
  let hfLicense: string | null = null
  let hfHasWeights: boolean | null = null
  let dtype: string | null = null

  if (!skipHf) {
    try {
      const q1 = creatorSlug ? `${creatorSlug}/${norm(m.name)}` : norm(m.name)
      const hits1 = await hfSearch(q1, hfToken, 8)
      const hits2 = await hfSearch(m.name, hfToken, 8)
      const hits = [...hits1, ...hits2]

      let best: {id: string; score: number} | null = null
      for (const h of hits) {
        const s = scoreHF(h, m.name, creatorSlug)
        if (!best || s > best.score) best = {id: h.id, score: s}
      }

      if (best && best.score >= 120) hfRepo = best.id

      if (hfRepo) {
        hfInfo = await hfModelInfo(hfRepo, hfToken)
        hfLicense = licenseFromHF(hfInfo)
        hfHasWeights = hasWeightsFromSiblings(hfInfo)
        dtype = await hfConfigDtype(hfRepo, hfToken)
      }
    } catch (e) {
      console.warn(`HF enrich failed for "${m.name}": ${(e as Error).message.split('\n')[0]}`)
    }
  }

  let openClass: ModelRow['open_source_or_proprietary'] = 'Unknown'
  if (hfRepo && hfHasWeights) openClass = 'Open weights'
  else if (!hfRepo) openClass = 'Proprietary'
  else if (hfRepo && hfHasWeights === false) openClass = 'Proprietary'

  let vramGiB: number | null = null
  let fits256: boolean | null = null

  const bpp = bytesPerParam(dtype)
  if (params && bpp) {
    vramGiB = weightsGiB(params, bpp)
    fits256 = vramGiB <= 256
  }

  return {
    aa_id: m.id,
    aa_name: m.name,
    aa_creator: creatorName,
    aa_creator_slug: creatorSlug,
    aa_intelligence_index: typeof aaii === 'number' ? aaii : null,

    hf_repo: hfRepo,
    hf_license: hfLicense,
    hf_has_weights: hfHasWeights,
    open_source_or_proprietary: openClass,

    model_params: params,
    model_params_label: label,
    default_tensor_type: dtype,

    weights_vram_gib_est: vramGiB ? Math.round(vramGiB * 10) / 10 : null,
    fits_256gb_gpu_weights_only: fits256,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

export const aaModelsRoutes = new Elysia()
  .use(withErrorHandler())
  .use(requireAdminAuth())
  .get('/api/aa-models', async ({request, set}) => {
    const session = await auth.api.getSession({headers: request.headers})
    const role = session?.user?.role ?? null
    if (role !== 'admin') {
      set.status = 403
      return {data: null, error: 'Administrator access required'}
    }

    const aaKey = process.env.AA_API_KEY
    const hfToken = process.env.HF_TOKEN ?? null
    const skipHf = !hfToken // Skip HF enrichment if no token

    if (!aaKey) {
      set.status = 500
      return {data: null, error: 'AA_API_KEY environment variable not set'}
    }

    // Helper to build response from model rows
    const buildResponse = (rows: ModelRow[]) => {
      return {
        data: {
          models: rows,
          meta: {
            totalModels: rows.length,
            hfEnriched: !skipHf,
            openWeightsCount: rows.filter((r) => {
              return r.open_source_or_proprietary === 'Open weights'
            }).length,
            proprietaryCount: rows.filter((r) => {
              return r.open_source_or_proprietary === 'Proprietary'
            }).length,
            unknownCount: rows.filter((r) => {
              return r.open_source_or_proprietary === 'Unknown'
            }).length,
          },
        },
      }
    }

    try {
      // Check if we have a fresh cached result
      if (cachedResult && Date.now() - cachedResult.timestamp < CACHE_TTL_MS) {
        console.log('[AA Models] Returning cached result')
        return buildResponse(cachedResult.models)
      }

      // If there's already a request in flight, wait for it
      if (inFlightRequest) {
        console.log('[AA Models] Request already in flight, waiting...')
        const rows = await inFlightRequest
        return buildResponse(rows)
      }

      // Start new processing
      inFlightRequest = (async (): Promise<ModelRow[]> => {
        console.log('[AA Models] Fetching from Artificial Analysis API...')
        console.log(
          `[AA Models] HF_TOKEN present: ${!!hfToken}, length: ${hfToken?.length ?? 0}, starts with hf_: ${hfToken?.startsWith('hf_') ?? false}`,
        )
        const aaResp = await fetchJson<AAResponse>(AA_ENDPOINT, {headers: {'x-api-key': aaKey}})

        const aaModels = aaResp.data ?? []
        console.log(`[AA Models] Got ${aaModels.length} models from AA API`)

        // Process models with limited concurrency and rate limiting
        const concurrency = 3 // Reduced to avoid HF rate limits
        const rows: ModelRow[] = []
        const queue = aaModels.slice()
        let processed = 0

        const workers = Array.from({length: concurrency}, async () => {
          while (queue.length) {
            const m = queue.shift()
            if (!m) break
            processed++
            if (processed % 20 === 0) {
              console.log(`[AA Models] Processed ${processed}/${aaModels.length}`)
            }
            const row = await processOneModel(m, hfToken, skipHf)
            rows.push(row)
            // Rate limiting delay between models
            if (!skipHf) await delay(HF_DELAY_MS)
          }
        })

        await Promise.all(workers)

        // Sort by intelligence index descending
        rows.sort((a, b) => {
          return (b.aa_intelligence_index ?? -1) - (a.aa_intelligence_index ?? -1)
        })

        console.log(`[AA Models] Complete. Returning ${rows.length} models.`)
        return rows
      })()

      const rows = await inFlightRequest

      // Cache the result
      cachedResult = {models: rows, timestamp: Date.now()}
      inFlightRequest = null

      return buildResponse(rows)
    } catch (error) {
      console.error('[AA Models] Failed to fetch models:', error)
      set.status = 500
      return {data: null, error: error instanceof Error ? error.message : 'Failed to fetch AI models'}
    }
  })
