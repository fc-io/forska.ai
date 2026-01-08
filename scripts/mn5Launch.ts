/**
 * Launch SGLang on MareNostrum 5 and wait for it to be ready
 * Usage: bun run mn5:launch [--force] [--model <id>]
 */

import {$, spawn} from 'bun'

const MN5_ROOT = '/gpfs/projects/ehpc482/dev'
const TLOG = 'tlog' // Transfer login
const GLOG = 'glog' // General login (for sbatch)
const ALOG = 'alog' // ACC login (for tunnel)
const SGLANG_PORT = 30000 // Main OpenAI-compatible API port (router or worker)
const SBATCH_FILE = 'forska-mn5-sglang.sbatch'

// Track the active job ID for cleanup
let activeJobId: string | null = null

const log = (m: string): void => {
  console.log(`[mn5] ${m}`)
}

const cancelJob = async (jobId: string): Promise<void> => {
  log(`Cancelling job ${jobId}...`)
  try {
    await $`ssh ${GLOG} "scancel ${jobId} 2>/dev/null || true"`.quiet()
    log('Job cancelled')
  } catch {
    // Ignore errors - job may already be gone
  }
}

const setupSignalHandler = (): void => {
  const cleanup = async () => {
    console.log('') // New line after ^C
    if (activeJobId) {
      await cancelJob(activeJobId)
    }
    process.exit(0)
  }

  process.on('SIGINT', () => {
    return void cleanup()
  })
  process.on('SIGTERM', () => {
    return void cleanup()
  })
}

const sleep = (ms: number): Promise<void> => {
  return new Promise((r) => {
    setTimeout(r, ms)
  })
}

type SqueueJob = {jobId: string; state: string; nodeList: string}

const parseSqueueJobLine = (line: string): SqueueJob | undefined => {
  const [jobId, state, nodeList] = line.split('|').map((part) => {
    return part.trim()
  })

  return jobId && state ? {jobId, state, nodeList: nodeList ?? ''} : undefined
}

const getFirstNodeFromNodeList = async (nodeList: string): Promise<string | undefined> => {
  const trimmed = nodeList.trim()
  if (!trimmed || trimmed === '(null)' || trimmed === 'n/a') return undefined

  if (!trimmed.includes('[')) return trimmed.split(',')[0]

  const expanded = await $`ssh ${GLOG} "scontrol show hostnames '${trimmed}' 2>/dev/null | head -1 || echo ''"`.text()
  const firstNode = expanded.trim()
  return firstNode ? firstNode : undefined
}

const getJobStatus = async (jobId: string): Promise<{state: string; nodeList: string}> => {
  const result = await $`ssh ${GLOG} "squeue -j ${jobId} -h -o '%T|%.200N' 2>/dev/null || echo 'UNKNOWN|'"`.text()
  const [state, nodeList] = result
    .trim()
    .split('|')
    .map((part) => {
      return part.trim()
    })

  return {state: state || 'UNKNOWN', nodeList: nodeList || ''}
}

const startTunnel = async (computeNode: string, jobId: string): Promise<void> => {
  // Set active job for signal handler if not already set
  activeJobId = jobId
  log(`Starting SSH tunnel: localhost:${SGLANG_PORT} -> ${computeNode}:${SGLANG_PORT} via ${ALOG}`)

  // Kill any existing process on port 30000
  await $`lsof -i :${SGLANG_PORT} -t 2>/dev/null | xargs kill 2>/dev/null || true`
  await sleep(500)

  const proc = spawn(
    [
      'ssh',
      '-N',
      '-o',
      'ControlPath=none', // Disable SSH multiplexing to keep tunnel process alive
      '-o',
      'ServerAliveInterval=30',
      '-o',
      'ServerAliveCountMax=3',
      '-o',
      'ExitOnForwardFailure=yes',
      '-L',
      `${SGLANG_PORT}:${computeNode}:${SGLANG_PORT}`,
      ALOG,
    ],
    {stdout: 'inherit', stderr: 'inherit'},
  )

  // Wait for tunnel to be ready
  await sleep(2000)

  // Verify connection
  const check =
    await $`curl -sf --connect-timeout 5 http://localhost:${SGLANG_PORT}/v1/models 2>/dev/null && echo OK || echo FAIL`.text()
  if (check.includes('OK')) {
    log('✓ Tunnel connected and SGLang responding')
  } else {
    log('⚠ Tunnel started but SGLang health check failed (may still be starting)')
  }

  log(`SGLang API available at http://localhost:${SGLANG_PORT}/v1`)
  log(`Press Ctrl+C to disconnect and cancel job ${jobId}`)

  await proc.exited
}

/**
 * Wait for SGLang to be ready
 */
const waitForSGLangReady = async (computeNode: string): Promise<boolean> => {
  // Wait for SGLang to be ready (can take 10-20 min for large models)
  log('Waiting for SGLang to start (this can take 10-20 minutes for large models)...')
  for (let i = 0; i < 240; i++) {
    // Wait up to 40 minutes
    const checkWorker =
      await $`ssh ${ALOG} "curl -sf --connect-timeout 2 --max-time 3 http://${computeNode}:${SGLANG_PORT}/v1/models 2>/dev/null && echo OK || echo NOTREADY"`.text()
    if (checkWorker.includes('OK') && checkWorker.includes('data')) {
      log('SGLang worker is ready!')
      return true
    }

    if (i % 30 === 0 && i > 0) {
      log(`Still loading model... (${Math.floor((i * 10) / 60)} min elapsed)`)
    }
    await sleep(10000)
  }

  log('Timed out waiting for SGLang readiness (it may still be starting)')
  return false
}

const main = async () => {
  setupSignalHandler()

  const args = process.argv.slice(2)
  let model: string | undefined
  let force = false

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--force') force = true
    else if (args[i] === '--model') model = args[++i]
  }

  // 1. Check for existing pending/running jobs
  log('Checking for existing jobs...')
  const existingJobsOutput =
    await $`ssh ${GLOG} "squeue -u \\$USER -n forska-mn5-sglang -h -o '%i|%T|%.200N' 2>/dev/null || echo ''"`.text()
  const existingJobs = existingJobsOutput
    .trim()
    .split('\n')
    .map(parseSqueueJobLine)
    .filter((job): job is SqueueJob => {
      return Boolean(job)
    })

  const existingRunningJob = existingJobs.find((job) => {
    return job.state === 'RUNNING'
  })

  if (existingRunningJob && !force) {
    const computeNode = await getFirstNodeFromNodeList(existingRunningJob.nodeList)
    if (computeNode) {
      log(`Found running job: ${existingRunningJob.jobId} on ${computeNode}`)
      log('Reusing existing job (use --force to submit a new one)')
      await waitForSGLangReady(computeNode)
      await startTunnel(computeNode, existingRunningJob.jobId)
      return
    }
  }

  const existingPendingJob = existingJobs.find((job) => {
    return job.state === 'PENDING'
  })

  if (existingPendingJob && !force) {
    log(`Found pending job: ${existingPendingJob.jobId}`)
    log('Waiting for existing job to start (use --force to submit a new one)')

    let computeNode: string | undefined
    for (let i = 0; i < 720; i++) {
      const {state, nodeList} = await getJobStatus(existingPendingJob.jobId)

      if (state === 'RUNNING') {
        computeNode = await getFirstNodeFromNodeList(nodeList)
        if (computeNode) {
          log(`Job running on: ${computeNode}`)
          break
        }
      } else if (state === 'FAILED' || state === 'CANCELLED' || state === 'UNKNOWN' || !state) {
        log('Existing job ended, will submit a new one')
        break
      }

      if (i % 12 === 0) log(`Still pending... (${i * 5}s)`)
      await sleep(5000)
    }

    if (computeNode) {
      await waitForSGLangReady(computeNode)
      await startTunnel(computeNode, existingPendingJob.jobId)
      return
    }
  }

  // 2. Copy sbatch file to MN5
  log('Deploying sbatch file...')
  await $`scp ${SBATCH_FILE} ${TLOG}:${MN5_ROOT}/`

  // 3. Submit job
  log('Submitting job...')
  const exportVars = model ? `ALL,SGLANG_MODEL=${model}` : 'ALL'
  const result = await $`ssh ${GLOG} "cd ${MN5_ROOT} && sbatch --export=${exportVars} ${SBATCH_FILE}"`.text()
  const jobIdMatch = result.match(/Submitted batch job (\d+)/)
  if (!jobIdMatch) {
    console.error('Failed to submit job:', result)
    process.exit(1)
  }
  const jobId = jobIdMatch[1]
  activeJobId = jobId // Set for cleanup
  log(`Job submitted: ${jobId}`)

  // 4. Wait for job to start running (HPC queues can be slow)
  log('Waiting for job to start (this may take a while in the queue)...')
  let computeNode: string | undefined
  for (let i = 0; i < 720; i++) {
    // Wait up to 60 minutes
    const {state, nodeList} = await getJobStatus(jobId)

    if (state === 'RUNNING') {
      computeNode = await getFirstNodeFromNodeList(nodeList)
      if (computeNode) {
        log(`Job running on: ${computeNode}`)
        break
      }
    } else if (state === 'PENDING') {
      if (i % 12 === 0) log(`Still pending... (${i * 5}s)`)
    } else if (state === 'FAILED' || state === 'CANCELLED' || state === 'UNKNOWN') {
      console.error(`Job ${jobId} failed or was cancelled`)
      process.exit(1)
    }
    await sleep(5000)
  }

  if (!computeNode) {
    console.error('Timeout waiting for job to start')
    process.exit(1)
  }

  // 5. Wait for SGLang and start tunnel
  await waitForSGLangReady(computeNode)
  await startTunnel(computeNode, jobId)
}

void main()
