import {spawn} from 'bun'

import {type AlvisConfig, getLatestAlvisJob, readAlvisConfigFromLog} from './alvisCommon.ts'
import {getForskaRuntimeEnv} from './getForskaRuntimeEnv.ts'

const log = (message: string): void => {
  console.log(`[alvis:dev] ${message}`)
}

const getDevServerEnv = (config: AlvisConfig) => {
  return {
    ...process.env,
    RUN_SERVER_JUDGING: 'true',
    BUN_CONFIG_MAX_HTTP_REQUESTS: '2048',
    ...getForskaRuntimeEnv({
      dpSize: config.DP_SIZE,
      gpuGpusPerNode: config.GPUS_PER_NODE,
      gpuNnodes: config.NNODES,
      localWorkerUrls: config.WORKER_URLS_LOCAL,
      remoteWorkerUrls: config.WORKER_URLS,
      providerKind: 'sglang',
      sglangApiMaxBurstRequests: config.SGLANG_API_MAX_BURST_REQUESTS,
      sglangApiMaxInflightRequests: config.SGLANG_API_MAX_INFLIGHT_REQUESTS,
      sglangMaxRunningRequests: config.SGLANG_MAX_RUNNING_REQUESTS,
      sshJumpHost: 'alvis2',
      tpSize: config.TP_SIZE,
    }),
  }
}

const startDevServer = async (config: AlvisConfig): Promise<void> => {
  log(`Tunnel endpoints: ${config.WORKER_URLS_LOCAL}`)
  log(`Remote model: ${config.SGLANG_MODEL}`)
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
