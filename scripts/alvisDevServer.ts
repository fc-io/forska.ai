import {spawn} from 'bun'

import {type AlvisConfig, getLatestAlvisJob, readAlvisConfigFromLog} from './alvisCommon.ts'

const log = (message: string): void => {
  console.log(`[alvis:dev] ${message}`)
}

const getDevServerEnv = (config: AlvisConfig) => {
  return {
    ...process.env,
    RUN_SERVER_JUDGING: 'true',
    WORKER_URLS: config.WORKER_URLS_LOCAL,
    SGLANG_ENABLE_ROUTER: config.SGLANG_ENABLE_ROUTER,
    GPU_TOTAL_GPUS: String(Number(config.NNODES) * Number(config.GPUS_PER_NODE)),
    GPU_NNODES: config.NNODES,
    GPU_GPUS_PER_NODE: config.GPUS_PER_NODE,
    TP_SIZE: config.TP_SIZE,
    DP_SIZE: config.DP_SIZE,
    SGLANG_MAX_RUNNING_REQUESTS: config.SGLANG_MAX_RUNNING_REQUESTS,
    SGLANG_API_MAX_INFLIGHT_REQUESTS: config.SGLANG_API_MAX_INFLIGHT_REQUESTS,
    SGLANG_API_MAX_BURST_REQUESTS: config.SGLANG_API_MAX_BURST_REQUESTS,
    SGLANG_CHUNKED_PREFILL_SIZE: config.SGLANG_CHUNKED_PREFILL_SIZE,
    SGLANG_CONTEXT_LENGTH: config.SGLANG_CONTEXT_LENGTH,
    SGLANG_MODEL: config.SGLANG_MODEL,
    NVIDIA_SMI_WORKER_URLS: config.WORKER_URLS,
    NVIDIA_SMI_WORKER_URLS_LOCAL: config.WORKER_URLS_LOCAL,
    NVIDIA_SMI_SSH_JUMP_HOST: 'alvis2',
    BUN_CONFIG_MAX_HTTP_REQUESTS: '2048',
  }
}

const startDevServer = async (config: AlvisConfig): Promise<void> => {
  log(`WORKER_URLS: ${config.WORKER_URLS_LOCAL}`)
  log(`SGLANG_MODEL: ${config.SGLANG_MODEL}`)
  log(`SGLANG_MAX_RUNNING_REQUESTS: ${config.SGLANG_MAX_RUNNING_REQUESTS}`)
  log(`SGLANG_CONTEXT_LENGTH: ${config.SGLANG_CONTEXT_LENGTH}`)

  const proc = spawn(['bun', '--env-file=.env.local', 'run', 'src/server/index.ts'], {
    cwd: process.cwd(),
    env: getDevServerEnv(config),
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  })

  process.exit(await proc.exited)
}

const main = async () => {
  log('Looking for running Alvis job...')
  const job = await getLatestAlvisJob('RUNNING')

  if (!job) {
    console.error('[alvis:dev] No running SGLang job found on Alvis')
    console.error('             Submit a job first: bun run alvis:launch:a100:fat')
    console.error('             Or use the 4x A100 preset: bun run alvis:launch:a100:4')
    console.error('             Or check status: bun run alvis:status')
    process.exit(1)
  }

  const config = await readAlvisConfigFromLog(job.jobId, job.jobName)
  if (!config) {
    console.error('[alvis:dev] Could not find startup config in the job log')
    console.error('             Resubmit with the updated `forska-alvis.sbatch` if needed.')
    process.exit(1)
  }

  log(`Found job ${job.jobId} (${job.jobName})`)
  log(`Workers (remote): ${config.WORKER_URLS}`)
  log(`Workers (local):  ${config.WORKER_URLS_LOCAL}`)
  log('Using SSH tunnels from `bun run alvis:launch` (this script does not create tunnels)')

  await startDevServer(config)
}

void main()
