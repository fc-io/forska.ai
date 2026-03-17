import {$, spawn} from 'bun'

export const ALVIS_HOST = 'alvis2'
export const ALVIS_JOB_NAME = 'forska-alvis'
export const ALVIS_ROOT = '/mimer/NOBACKUP/groups/clin-agent-bench/dev'
export const ALVIS_SBATCH_FILE = 'forska-alvis.sbatch'

const CONFIG_START = '[alvis:config:start]'
const CONFIG_END = '[alvis:config:end]'
const ALVIS_CONFIG_POLL_INTERVAL_SECONDS = 5
const ALVIS_CONFIG_WAIT_SECONDS = Number(process.env.ALVIS_CONFIG_WAIT_SECONDS ?? '21600')
const ALVIS_CONFIG_WAIT_ATTEMPTS = Math.max(
  1,
  Math.ceil(ALVIS_CONFIG_WAIT_SECONDS / ALVIS_CONFIG_POLL_INTERVAL_SECONDS),
)

export type AlvisConfig = {
  SGLANG_HOST: string
  SGLANG_PORT: string
  SGLANG_INTERNAL_PORT: string
  CADDY_PORT: string
  SGLANG_WORKER_PORT: string
  SGLANG_MODEL: string
  WORKER_URLS: string
  WORKER_URLS_LOCAL: string
  NNODES: string
  GPUS_PER_NODE: string
  TP_SIZE: string
  DP_SIZE: string
  SGLANG_ONE_WORKER_PER_GPU: string
  SGLANG_ENABLE_ROUTER: string
  SGLANG_MAX_RUNNING_REQUESTS: string
  SGLANG_API_MAX_INFLIGHT_REQUESTS: string
  SGLANG_API_MAX_BURST_REQUESTS: string
  SGLANG_CHUNKED_PREFILL_SIZE: string
  SGLANG_CONTEXT_LENGTH: string
  SGLANG_LOCAL_PORT_BASE: string
}

export type SqueueJob = {jobId: string; jobName: string; state: string; nodeList: string}
export type AlvisJobRequest = {gresPerNode: string; numNodes: string}

export type WorkerTunnel = {
  remoteUrl: string
  localUrl: string
  remoteHost: string
  remotePort: number
  localPort: number
}

export const sleep = (ms: number): Promise<void> => {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export const splitCsv = (value: string | undefined): string[] => {
  return String(value ?? '')
    .split(',')
    .map((part) => {
      return part.trim()
    })
    .filter((part) => {
      return part.length > 0
    })
}

export const sshCommand = async (host: string, command: string): Promise<string> => {
  const proc = spawn(['ssh', host, command], {stdout: 'pipe', stderr: 'pipe'})
  const stdout = await new Response(proc.stdout).text()
  return stdout.trim()
}

export const parseSqueueJobLine = (line: string): SqueueJob | undefined => {
  const parts = line.split('|').map((part) => {
    return part.trim()
  })
  const jobId = parts[0]
  const jobName = parts[1]
  const state = parts[2]
  const nodeList = parts[3]

  return jobId && jobName && state ? {jobId, jobName, state, nodeList: nodeList ?? ''} : undefined
}

export const getFirstNodeFromNodeList = async (nodeList: string): Promise<string | undefined> => {
  const trimmed = nodeList.trim()

  if (!trimmed || trimmed === '(null)' || trimmed === 'n/a') return undefined
  if (!trimmed.includes('[')) return trimmed.split(',')[0]

  const expanded =
    await $`ssh ${ALVIS_HOST} "scontrol show hostnames '${trimmed}' 2>/dev/null | head -1 || echo ''"`.text()
  const firstNode = expanded.trim()
  return firstNode ? firstNode : undefined
}

export const getJobStatus = async (jobId: string): Promise<{state: string; nodeList: string}> => {
  const result = await $`ssh ${ALVIS_HOST} "squeue -j ${jobId} -h -o '%T|%.200N' 2>/dev/null || echo 'UNKNOWN|'"`.text()
  const parts = result
    .trim()
    .split('|')
    .map((part) => {
      return part.trim()
    })
  const state = parts[0]
  const nodeList = parts[1]

  return {state: state || 'UNKNOWN', nodeList: nodeList || ''}
}

export const getAlvisJobRequest = async (jobId: string): Promise<AlvisJobRequest | undefined> => {
  const result = await $`ssh ${ALVIS_HOST} "squeue -j ${jobId} -h -o '%b|%D' 2>/dev/null || echo '|'"`.text()
  const parts = result
    .trim()
    .split('|')
    .map((part) => {
      return part.trim()
    })
  const gresPerNode = parts[0]
  const numNodes = parts[1]

  return gresPerNode && numNodes ? {gresPerNode, numNodes} : undefined
}

export const findAlvisJobs = async (): Promise<SqueueJob[]> => {
  const result = await sshCommand(
    ALVIS_HOST,
    `squeue -u $USER -h -o "%i|%j|%T|%.200N" | grep "|${ALVIS_JOB_NAME}|" || true`,
  )

  return result
    .split('\n')
    .map((line) => {
      return line.trim()
    })
    .filter((line) => {
      return line.length > 0
    })
    .map(parseSqueueJobLine)
    .filter((job): job is SqueueJob => {
      return Boolean(job)
    })
    .sort((left, right) => {
      return Number(right.jobId) - Number(left.jobId)
    })
}

export const getLatestAlvisJob = async (state?: string): Promise<SqueueJob | undefined> => {
  const jobs = await findAlvisJobs()

  return state
    ? jobs.find((job) => {
        return job.state === state
      })
    : jobs[0]
}

const parseConfigBlock = (logContent: string): Partial<AlvisConfig> | undefined => {
  const startIndex = logContent.indexOf(CONFIG_START)
  const endIndex = logContent.indexOf(CONFIG_END)

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) return undefined

  const configBlock = logContent.slice(startIndex + CONFIG_START.length, endIndex)
  const config = configBlock.split('\n').reduce<Partial<AlvisConfig>>((accumulator, line) => {
    const trimmed = line.trim()
    if (!trimmed || !trimmed.includes('=')) return accumulator

    const [key, ...valueParts] = trimmed.split('=')
    return key ? {...accumulator, [key.trim()]: valueParts.join('=').trim()} : accumulator
  }, {})

  return config
}

const getDerivedLocalUrls = (workerUrls: string[], localPortBase: number): string => {
  return workerUrls
    .map((_, index) => {
      return `http://localhost:${localPortBase + index}`
    })
    .join(',')
}

export const readAlvisConfigFromLog = async (
  jobId: string,
  jobName = ALVIS_JOB_NAME,
): Promise<AlvisConfig | undefined> => {
  const logPath = `${ALVIS_ROOT}/${jobName}-${jobId}.log`
  const logContent = await $`ssh ${ALVIS_HOST} "cat ${logPath} 2>/dev/null || echo ''"`.text()
  const parsed = parseConfigBlock(logContent)
  const workerUrls = splitCsv(parsed?.WORKER_URLS)
  const localPortBase = Number(parsed?.SGLANG_LOCAL_PORT_BASE ?? '30001')
  const workerUrlsLocal = parsed?.WORKER_URLS_LOCAL || getDerivedLocalUrls(workerUrls, localPortBase)

  return parsed?.SGLANG_HOST && parsed.SGLANG_PORT && workerUrls.length > 0
    ? {
        SGLANG_HOST: parsed.SGLANG_HOST,
        SGLANG_PORT: parsed.SGLANG_PORT,
        SGLANG_INTERNAL_PORT: parsed.SGLANG_INTERNAL_PORT ?? parsed.SGLANG_PORT,
        CADDY_PORT: parsed.CADDY_PORT ?? parsed.SGLANG_PORT,
        SGLANG_WORKER_PORT: parsed.SGLANG_WORKER_PORT ?? parsed.SGLANG_PORT,
        SGLANG_MODEL: parsed.SGLANG_MODEL ?? 'not set',
        WORKER_URLS: parsed.WORKER_URLS ?? workerUrls.join(','),
        WORKER_URLS_LOCAL: workerUrlsLocal,
        NNODES: parsed.NNODES ?? '0',
        GPUS_PER_NODE: parsed.GPUS_PER_NODE ?? '0',
        TP_SIZE: parsed.TP_SIZE ?? '0',
        DP_SIZE: parsed.DP_SIZE ?? '0',
        SGLANG_ONE_WORKER_PER_GPU: parsed.SGLANG_ONE_WORKER_PER_GPU ?? '0',
        SGLANG_ENABLE_ROUTER: parsed.SGLANG_ENABLE_ROUTER ?? '0',
        SGLANG_MAX_RUNNING_REQUESTS: parsed.SGLANG_MAX_RUNNING_REQUESTS ?? '0',
        SGLANG_API_MAX_INFLIGHT_REQUESTS: parsed.SGLANG_API_MAX_INFLIGHT_REQUESTS ?? '0',
        SGLANG_API_MAX_BURST_REQUESTS: parsed.SGLANG_API_MAX_BURST_REQUESTS ?? '0',
        SGLANG_CHUNKED_PREFILL_SIZE: parsed.SGLANG_CHUNKED_PREFILL_SIZE ?? '0',
        SGLANG_CONTEXT_LENGTH: parsed.SGLANG_CONTEXT_LENGTH ?? '0',
        SGLANG_LOCAL_PORT_BASE: String(localPortBase),
      }
    : undefined
}

export const waitForAlvisConfig = async (
  jobId: string,
  log: (message: string) => void,
  jobName = ALVIS_JOB_NAME,
): Promise<AlvisConfig | undefined> => {
  for (let attempt = 0; attempt < ALVIS_CONFIG_WAIT_ATTEMPTS; attempt++) {
    const config = await readAlvisConfigFromLog(jobId, jobName)
    if (config) return config

    const status = await getJobStatus(jobId)
    if (status.state === 'FAILED' || status.state === 'CANCELLED' || status.state === 'UNKNOWN') return undefined
    if (attempt % 12 === 0) {
      log(`Waiting for startup config... (${attempt * ALVIS_CONFIG_POLL_INTERVAL_SECONDS}s)`)
    }
    await sleep(ALVIS_CONFIG_POLL_INTERVAL_SECONDS * 1000)
  }

  return undefined
}

export const parseUrlHostAndPort = (url: string): {host: string; port: number} | undefined => {
  try {
    const parsed = new URL(url)
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? '443' : '80'))
    return parsed.hostname && Number.isFinite(port) ? {host: parsed.hostname, port} : undefined
  } catch {
    return undefined
  }
}

export const getWorkerTunnels = (config: AlvisConfig): WorkerTunnel[] => {
  const remoteUrls = splitCsv(config.WORKER_URLS)
  const localUrls = splitCsv(config.WORKER_URLS_LOCAL)

  return remoteUrls
    .map((remoteUrl, index) => {
      const localUrl = localUrls[index] ?? `http://localhost:${Number(config.SGLANG_LOCAL_PORT_BASE) + index}`
      const remote = parseUrlHostAndPort(remoteUrl)
      const local = parseUrlHostAndPort(localUrl)

      return remote && local
        ? {remoteUrl, localUrl, remoteHost: remote.host, remotePort: remote.port, localPort: local.port}
        : undefined
    })
    .filter((worker): worker is WorkerTunnel => {
      return Boolean(worker)
    })
}
