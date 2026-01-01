/**
 * Launch SGLang on MareNostrum 5 and set up SSH tunnel
 * Usage: bun run mn5:launch [--no-tunnel] [--model <id>]
 */

import {$} from 'bun'

const MN5_ROOT = '/gpfs/projects/ehpc482/dev'
const TLOG = 'tlog' // Transfer login
const GLOG = 'glog' // General login (for sbatch)
const ALOG = 'alog' // ACC login (for tunnel)
const SGLANG_PORT = 30000
const SGLANG_WORKER_PORT = 30001 // Workers in multi-node mode
const SBATCH_FILE = 'forska-mn5-sglang.sbatch'

const log = (m: string): void => {
  console.log(`[mn5] ${m}`)
}

const sleep = (ms: number): Promise<void> => {
  return new Promise((r) => {
    setTimeout(r, ms)
  })
}

const main = async () => {
  const args = process.argv.slice(2)
  let noTunnel = false
  let model: string | undefined
  let force = false

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--no-tunnel') noTunnel = true
    else if (args[i] === '--force') force = true
    else if (args[i] === '--model') model = args[++i]
  }

  // 1. Check for existing pending/running jobs
  log('Checking for existing jobs...')
  const existingJobs =
    await $`ssh ${GLOG} "squeue -u \\$USER -n forska-mn5-sglang -h -o '%i %T %N' 2>/dev/null || echo ''"`.text()
  const jobLines = existingJobs
    .trim()
    .split('\n')
    .filter((l) => {
      return l.trim()
    })

  if (jobLines.length > 0 && !force) {
    const [existingJobId, state, node] = jobLines[0].split(/\s+/)
    if (state === 'RUNNING' && node) {
      log(`Found running job: ${existingJobId} on ${node}`)
      log('Reusing existing job (use --force to submit a new one)')

      // Skip to waiting for SGLang and tunnel setup
      const computeNode = node.split(',')[0]
      await waitForSGLangAndTunnel(computeNode, noTunnel)
      return
    } else if (state === 'PENDING') {
      log(`Found pending job: ${existingJobId}`)
      log('Waiting for existing job to start (use --force to cancel and submit a new one)')

      // Wait for this job to start
      let computeNode: string | undefined
      for (let i = 0; i < 720; i++) {
        const queueInfo =
          await $`ssh ${GLOG} "squeue -j ${existingJobId} -h -o '%T %N' 2>/dev/null || echo 'UNKNOWN'"`.text()
        const [st, nd] = queueInfo.trim().split(/\s+/)
        if (st === 'RUNNING' && nd) {
          computeNode = nd.split(',')[0]
          log(`Job running on: ${computeNode}`)
          break
        } else if (st === 'FAILED' || st === 'CANCELLED' || st === 'UNKNOWN' || !st) {
          log('Existing job ended, will submit a new one')
          break
        }
        if (i % 12 === 0) log(`Still pending... (${i * 5}s)`)
        await sleep(5000)
      }

      if (computeNode) {
        await waitForSGLangAndTunnel(computeNode, noTunnel)
        return
      }
      // Fall through to submit new job
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
  log(`Job submitted: ${jobId}`)

  // 4. Wait for job to start running (HPC queues can be slow)
  log('Waiting for job to start (this may take a while in the queue)...')
  let computeNode: string | undefined
  for (let i = 0; i < 720; i++) {
    // Wait up to 60 minutes
    const queueInfo = await $`ssh ${GLOG} "squeue -j ${jobId} -h -o '%T %N' 2>/dev/null || echo 'UNKNOWN'"`.text()
    const [state, node] = queueInfo.trim().split(/\s+/)

    if (state === 'RUNNING' && node) {
      computeNode = node.split(',')[0] // Take first node if multi-node
      log(`Job running on: ${computeNode}`)
      break
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

  // 5. Wait for SGLang and set up tunnel
  await waitForSGLangAndTunnel(computeNode, noTunnel)
}

/**
 * Wait for SGLang to be ready and optionally set up SSH tunnel
 */
const waitForSGLangAndTunnel = async (computeNode: string, noTunnel: boolean): Promise<void> => {
  // Wait for SGLang to be ready (can take 10-20 min for large models)
  // In multi-node mode, check worker port (30001) first since router starts after workers
  log('Waiting for SGLang to start (this can take 10-20 minutes for large models)...')
  for (let i = 0; i < 240; i++) {
    // Wait up to 40 minutes
    try {
      // Try router port first, then worker port
      const checkRouter =
        await $`ssh ${ALOG} "curl -sf http://${computeNode}:${SGLANG_PORT}/v1/models 2>/dev/null && echo OK || echo NOTREADY"`.text()
      if (checkRouter.includes('OK') && checkRouter.includes('data')) {
        log('SGLang router is ready!')
        break
      }

      // Check worker port in case router isn't started yet
      const checkWorker =
        await $`ssh ${ALOG} "curl -sf http://${computeNode}:${SGLANG_WORKER_PORT}/v1/models 2>/dev/null && echo OK || echo NOTREADY"`.text()
      if (checkWorker.includes('OK') && checkWorker.includes('data')) {
        log('SGLang worker is ready! Waiting for router...')
        // Give router a moment to start
        await sleep(5000)
        continue
      }
    } catch {
      // Ignore errors during startup
    }

    if (i % 30 === 0 && i > 0) {
      log(`Still loading model... (${Math.floor((i * 10) / 60)} min elapsed)`)
    }
    await sleep(10000)
  }

  // Set up SSH tunnel
  if (noTunnel) {
    log('Skipping tunnel (--no-tunnel)')
    log(`To connect manually: ssh -N -L ${SGLANG_PORT}:${computeNode}:${SGLANG_PORT} ${ALOG}`)
  } else {
    log(`Setting up SSH tunnel: localhost:${SGLANG_PORT} -> ${computeNode}:${SGLANG_PORT}`)
    log('Press Ctrl+C to disconnect')
    log('')
    log(`Test with: curl http://localhost:${SGLANG_PORT}/v1/models`)

    // Run SSH tunnel - this will block until Ctrl+C
    await $`ssh -N -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L ${SGLANG_PORT}:${computeNode}:${SGLANG_PORT} ${ALOG}`
  }
}

void main()
