import {getProviderConnectionConfigFromJson} from '../../providers/providerDbUtils.ts'
import {
  getProviderConnectionEffectiveBaseURL,
  getProviderConnectionWorkerState,
} from '../../providers/providerRuntimeState.ts'
import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {escapeSqlString, getDateValue, getSqlLiteral} from '../../services/appQueryHelpers.ts'
import {getJudgmentsCapacity} from './getJudgmentsCapacity.ts'
import {getSGLangMetrics} from './judgmentsJobsAdjustBatchSize/getSGLangMetrics.ts'

const ema = (prev: number | null | undefined, cur: number, alpha: number): number => {
  return prev == null ? cur : alpha * cur + (1 - alpha) * prev
}

const getLatestStatus = async (engine: 'vllm' | 'sglang', instanceId: string, modelName: string) => {
  const rows = await getAppDatabaseService().queryJson<{
    ts: unknown
    promptTokensTotal: number | null
    generationTokensTotal: number | null
    numRequestsTotal: number | null
    prefillTps: number | null
    genTps: number | null
    targetGenTps: number | null
    targetPrefillTps: number | null
    lastAction: string | null
  }>(`
    SELECT
      ts,
      prompt_tokens_total AS promptTokensTotal,
      generation_tokens_total AS generationTokensTotal,
      num_requests_total AS numRequestsTotal,
      prefill_tps AS prefillTps,
      gen_tps AS genTps,
      target_gen_tps AS targetGenTps,
      target_prefill_tps AS targetPrefillTps,
      last_action AS lastAction
    FROM app.llm_status
    WHERE engine = '${escapeSqlString(engine)}'
      AND instance_id = '${escapeSqlString(instanceId)}'
      AND model_name = '${escapeSqlString(modelName)}'
    ORDER BY ts DESC
    LIMIT 1
  `)
  return rows[0]
}

const computeTps = (
  prev: {prefill: number; gen: number; success: number; ts: Date} | undefined,
  now: {prefill: number; gen: number; success: number; ts: Date},
) => {
  const dtMs = prev ? now.ts.getTime() - prev.ts.getTime() : 0
  const dt = dtMs > 0 ? dtMs / 1000 : 0
  const prefill = dt > 0 ? Math.max(0, now.prefill - (prev?.prefill ?? 0)) / dt : 0
  const gen = dt > 0 ? Math.max(0, now.gen - (prev?.gen ?? 0)) / dt : 0
  const rps = dt > 0 ? Math.max(0, now.success - (prev?.success ?? 0)) / dt : 0
  return {prefill, gen, rps, dtMs}
}

const smallQueue = (waiting: number, running: number): boolean => {
  const thr = Math.max(1, Math.ceil(0.05 * running))
  return waiting <= thr
}

const safetyTriggered = (waiting: number, running: number): boolean => {
  const thr = Math.max(1, Math.ceil(0.15 * running))
  return waiting > 4 * thr
}

const getProviderRuntime = ({
  baseURL,
  providerConfigJson,
  providerKind,
}: {
  baseURL: string | null
  providerConfigJson: unknown
  providerKind: string | null
}): {baseURL: string | null; workerUrls: string[]} => {
  const config = getProviderConnectionConfigFromJson({providerKind, value: providerConfigJson})
  const workerState = getProviderConnectionWorkerState({baseURL, config, providerKind})

  return {
    baseURL: getProviderConnectionEffectiveBaseURL({baseURL, config, providerKind}),
    workerUrls: workerState.effectiveWorkerUrls,
  }
}

const getStatusModelName = (modelNames: string[]) => {
  return modelNames.length === 1 ? (modelNames[0] ?? 'unknown') : 'multiple'
}

// Generic LLM status ingestion targeting the new llm_status table.
// Initially feeds engine='vllm' using the existing vLLM metrics adapter.
export const judgmentsJobsCheckLLMStatus = async () => {
  const runningJobConfigs = await getAppDatabaseService().queryJson<{
    providerKind: string | null
    modelName: string | null
    baseURL: string | null
    providerConfigJson: unknown
  }>(`
    WITH active_running_projects AS (
      SELECT DISTINCT project_id
      FROM app.judgment_job
      WHERE status = 'running'
        AND storage_state = 'active'
    )
    SELECT DISTINCT
      pc.provider_kind AS providerKind,
      COALESCE(m.remote_model_id, m.name) AS modelName,
      pc.base_url AS baseURL,
      TO_JSON(pc.config_json) AS providerConfigJson
    FROM active_running_projects jj
    INNER JOIN app.project p ON jj.project_id = p.id
    INNER JOIN app.model m ON p.model_id = m.id
    INNER JOIN app.provider_connection pc ON pc.id = m.provider_connection_id
    WHERE lower(trim(pc.provider_kind)) = 'sglang'
  `)
  const validConfigs = runningJobConfigs.filter((r) => {
    return (
      String(r.providerKind ?? '')
        .trim()
        .toLowerCase() === 'sglang'
      && !!getProviderRuntime({
        baseURL: r.baseURL,
        providerConfigJson: r.providerConfigJson,
        providerKind: r.providerKind,
      }).baseURL
    )
  })
  const workerUrlToModelNames = validConfigs.reduce((acc, cfg) => {
    const runtime = getProviderRuntime({
      baseURL: cfg.baseURL,
      providerConfigJson: cfg.providerConfigJson,
      providerKind: cfg.providerKind,
    })
    const baseURL = runtime.baseURL
    const targetWorkers = (runtime.workerUrls.length > 0 ? runtime.workerUrls : baseURL ? [baseURL] : [])
      .map((url) => {
        return url.trim()
      })
      .filter((url) => {
        return url.length > 0
      })
    const modelName = String(cfg.modelName ?? '').trim() || 'unknown'

    targetWorkers.reduce((nextAcc, workerUrl) => {
      const existingModelNames = nextAcc.get(workerUrl) ?? new Set<string>()
      nextAcc.set(workerUrl, new Set([...existingModelNames, modelName]))
      return nextAcc
    }, acc)

    return acc
  }, new Map<string, Set<string>>())
  if (workerUrlToModelNames.size === 0) return

  for (const [workerUrl, modelNameSet] of workerUrlToModelNames.entries()) {
    const engine = 'sglang' as const
    const modelName = getStatusModelName(
      Array.from(modelNameSet).sort((a, b) => {
        return a.localeCompare(b)
      }),
    )
    const instanceId = workerUrl
    const prev = await getLatestStatus(engine, instanceId, modelName)

    const m = await getSGLangMetrics(workerUrl)
    const promptTokensTotal = m.promptTokensTotal
    const generationTokensTotal = m.generationTokensTotal
    const numRequestsTotal = m.numRequestsTotal
    const numQueueReqs = m.numQueueReqs
    const numRunningReqs = m.numRunningReqs

    const {prefill, gen, rps, dtMs} = computeTps(
      prev
        ? {
            prefill: Number(prev.promptTokensTotal ?? 0),
            gen: Number(prev.generationTokensTotal ?? 0),
            success: Number(prev.numRequestsTotal ?? 0),
            ts: getDateValue(prev.ts) ?? new Date(),
          }
        : undefined,
      {prefill: promptTokensTotal, gen: generationTokensTotal, success: numRequestsTotal, ts: new Date()},
    )

    const alpha = 0.3
    const prefillTps = ema(prev?.prefillTps ?? null, prefill, alpha)
    const genTps = ema(prev?.genTps ?? null, gen, alpha)

    const wasSmall = smallQueue(numQueueReqs, numRunningReqs)

    const prevTargets = {gen: Number(prev?.targetGenTps ?? 0), prefill: Number(prev?.targetPrefillTps ?? 0)}
    const incGen = Math.max(prevTargets.gen, genTps * 1.08 + 50)
    const incPrefill = Math.max(prevTargets.prefill, prefillTps * 1.08 + 50)
    const decGen = prevTargets.gen * 0.85
    const decPrefill = prevTargets.prefill * 0.85
    const targetGenTps = wasSmall ? incGen : decGen
    const targetPrefillTps = wasSmall ? incPrefill : decPrefill

    const prevState = (() => {
      if (!prev?.lastAction) return {bestGen: 0}
      try {
        const parsed = JSON.parse(prev.lastAction) as unknown
        return typeof parsed === 'object'
          && parsed
          && 'bestGen' in parsed
          && typeof (parsed as {bestGen?: unknown}).bestGen === 'number'
          ? {bestGen: (parsed as {bestGen: number}).bestGen}
          : {bestGen: 0}
      } catch (_e) {
        return {bestGen: 0}
      }
    })()

    const bestGenDecay = Math.max(0, prevState.bestGen * 0.98)
    const bestGen = Math.max(bestGenDecay, genTps)
    const plateauGen = 0.92 * bestGen
    const targetGenFinal = Math.max(targetGenTps, plateauGen)
    const targetPrefillFinal = targetPrefillTps

    const isUnsafe = safetyTriggered(numQueueReqs, numRunningReqs)
    const tGen = isUnsafe ? targetGenFinal * 0.6 : targetGenFinal
    const tPre = isUnsafe ? targetPrefillFinal * 0.6 : targetPrefillFinal

    const inFlight = numQueueReqs + numRunningReqs
    // Show per-worker limit (not total across all workers) for accurate per-instance display
    const maxInFlight = getJudgmentsCapacity(1).perWorkerMaxInflightRequests

    // Log when SGLang queue is high - helps diagnose capacity overflow
    if (inFlight > maxInFlight * 0.9) {
      console.warn('[llm-status] Worker queue high:', {
        worker: instanceId,
        sglangQueue: inFlight,
        perWorkerLimit: maxInFlight,
        waiting: numQueueReqs,
        running: numRunningReqs,
      })
    }

    const llmStatusData = {
      engine,
      instanceId,
      modelName,
      engineVersion: null,
      gpuType: null,
      gpuCount: null,
      pollMs: dtMs || 2000,
      promptTokensTotal,
      generationTokensTotal,
      numRequestsTotal,
      cachedTokensTotal: m.cachedTokensTotal,
      numRetractionsCount: m.numRetractionsCount,
      numQueueReqs,
      numRunningReqs,
      numGrammarQueueReqs: m.numGrammarQueueReqs,
      numRunningReqsOfflineBatch: m.numRunningReqsOfflineBatch,
      numPrefillPreallocQueueReqs: m.numPrefillPreallocQueueReqs,
      numPrefillInflightQueueReqs: m.numPrefillInflightQueueReqs,
      numDecodePreallocQueueReqs: m.numDecodePreallocQueueReqs,
      numDecodeTransferQueueReqs: m.numDecodeTransferQueueReqs,
      genThroughput: m.genThroughput,
      tokenUsage: m.tokenUsage,
      utilization: m.utilization,
      cacheHitRate: m.cacheHitRate,
      specAcceptRate: m.specAcceptRate,
      specAcceptLength: m.specAcceptLength,
      isCudaGraph: m.isCudaGraph ?? null,
      swaTokenUsage: m.swaTokenUsage,
      mambaUsage: m.mambaUsage,
      pendingPreallocTokenUsage: m.pendingPreallocTokenUsage,
      kvTransferSpeedGbS: m.kvTransferSpeedGbS,
      kvTransferLatencyMs: m.kvTransferLatencyMs,
      kvTransferBootstrapMs: m.kvTransferBootstrapMs,
      kvTransferAllocMs: m.kvTransferAllocMs,
      prefillTps,
      genTps,
      rps,
      targetGenTps: tGen,
      targetPrefillTps: tPre,
      inFlight,
      maxInFlight,
      timeToFirstTokenSeconds: m.timeToFirstTokenSeconds ?? null,
      e2eRequestLatencySeconds: m.e2eRequestLatencySeconds ?? null,
      interTokenLatencySeconds: m.interTokenLatencySeconds ?? null,
      perStageReqLatencySeconds: m.perStageReqLatencySeconds ?? null,
      queueTimeSeconds: m.queueTimeSeconds ?? null,
    }

    await getAppDatabaseService().run(`
        INSERT INTO app.llm_status (
          id,
          engine,
          instance_id,
          model_name,
          engine_version,
          gpu_type,
          gpu_count,
          poll_ms,
          prompt_tokens_total,
          generation_tokens_total,
          num_requests_total,
          cached_tokens_total,
          num_retractions_count,
          num_queue_reqs,
          num_running_reqs,
          num_grammar_queue_reqs,
          num_running_reqs_offline_batch,
          num_prefill_prealloc_queue_reqs,
          num_prefill_inflight_queue_reqs,
          num_decode_prealloc_queue_reqs,
          num_decode_transfer_queue_reqs,
          gen_throughput,
          token_usage,
          utilization,
          cache_hit_rate,
          spec_accept_rate,
          spec_accept_length,
          is_cuda_graph,
          swa_token_usage,
          mamba_usage,
          pending_prealloc_token_usage,
          kv_transfer_speed_gb_s,
          kv_transfer_latency_ms,
          kv_transfer_bootstrap_ms,
          kv_transfer_alloc_ms,
          prefill_tps,
          gen_tps,
          rps,
          target_gen_tps,
          target_prefill_tps,
          in_flight,
          max_in_flight,
          time_to_first_token_seconds,
          e2e_request_latency_seconds,
          inter_token_latency_seconds,
          per_stage_req_latency_seconds,
          queue_time_seconds
        ) VALUES (
          ${getSqlLiteral(crypto.randomUUID())},
          ${getSqlLiteral(llmStatusData.engine)},
          ${getSqlLiteral(llmStatusData.instanceId)},
          ${getSqlLiteral(llmStatusData.modelName)},
          ${getSqlLiteral(llmStatusData.engineVersion)},
          ${getSqlLiteral(llmStatusData.gpuType)},
          ${getSqlLiteral(llmStatusData.gpuCount)},
          ${getSqlLiteral(llmStatusData.pollMs)},
          ${getSqlLiteral(llmStatusData.promptTokensTotal)},
          ${getSqlLiteral(llmStatusData.generationTokensTotal)},
          ${getSqlLiteral(llmStatusData.numRequestsTotal)},
          ${getSqlLiteral(llmStatusData.cachedTokensTotal)},
          ${getSqlLiteral(llmStatusData.numRetractionsCount)},
          ${getSqlLiteral(llmStatusData.numQueueReqs)},
          ${getSqlLiteral(llmStatusData.numRunningReqs)},
          ${getSqlLiteral(llmStatusData.numGrammarQueueReqs)},
          ${getSqlLiteral(llmStatusData.numRunningReqsOfflineBatch)},
          ${getSqlLiteral(llmStatusData.numPrefillPreallocQueueReqs)},
          ${getSqlLiteral(llmStatusData.numPrefillInflightQueueReqs)},
          ${getSqlLiteral(llmStatusData.numDecodePreallocQueueReqs)},
          ${getSqlLiteral(llmStatusData.numDecodeTransferQueueReqs)},
          ${getSqlLiteral(llmStatusData.genThroughput)},
          ${getSqlLiteral(llmStatusData.tokenUsage)},
          ${getSqlLiteral(llmStatusData.utilization)},
          ${getSqlLiteral(llmStatusData.cacheHitRate)},
          ${getSqlLiteral(llmStatusData.specAcceptRate)},
          ${getSqlLiteral(llmStatusData.specAcceptLength)},
          ${getSqlLiteral(llmStatusData.isCudaGraph)},
          ${getSqlLiteral(llmStatusData.swaTokenUsage)},
          ${getSqlLiteral(llmStatusData.mambaUsage)},
          ${getSqlLiteral(llmStatusData.pendingPreallocTokenUsage)},
          ${getSqlLiteral(llmStatusData.kvTransferSpeedGbS)},
          ${getSqlLiteral(llmStatusData.kvTransferLatencyMs)},
          ${getSqlLiteral(llmStatusData.kvTransferBootstrapMs)},
          ${getSqlLiteral(llmStatusData.kvTransferAllocMs)},
          ${getSqlLiteral(llmStatusData.prefillTps)},
          ${getSqlLiteral(llmStatusData.genTps)},
          ${getSqlLiteral(llmStatusData.rps)},
          ${getSqlLiteral(llmStatusData.targetGenTps)},
          ${getSqlLiteral(llmStatusData.targetPrefillTps)},
          ${getSqlLiteral(llmStatusData.inFlight)},
          ${getSqlLiteral(llmStatusData.maxInFlight)},
          ${getSqlLiteral(llmStatusData.timeToFirstTokenSeconds)},
          ${getSqlLiteral(llmStatusData.e2eRequestLatencySeconds)},
          ${getSqlLiteral(llmStatusData.interTokenLatencySeconds)},
          ${getSqlLiteral(llmStatusData.perStageReqLatencySeconds)},
          ${getSqlLiteral(llmStatusData.queueTimeSeconds)}
        )
    `)
  }
}
