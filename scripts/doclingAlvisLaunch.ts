/**
 * Launch Docling Serve on Alvis2 and set up SSH tunnel
 * Usage: bun run docling:alvis:launch [--force] [--skip-build]
 */

import {$, spawn} from 'bun'

const STACK_ROOT = '/mimer/NOBACKUP/groups/clin-agent-bench/dev'
const SSH_HOST = 'alvis2' // Login node for sbatch and tunnel
const DOCLING_PORT = 5001
const SBATCH_FILE = 'forska-docling-alvis.sbatch'
const SIF_NAME = 'docling_serve_cu126.sif'
const DOCKER_IMAGE = 'ghcr.io/docling-project/docling-serve-cu126:main'

// Track the active job ID for cleanup
let activeJobId: string | null = null

const log = (m: string): void => {
  console.log(`[docling:alvis] ${m}`)
}

const cancelJob = async (jobId: string): Promise<void> => {
  log(`Cancelling job ${jobId}...`)
  try {
    await $`ssh ${SSH_HOST} "scancel ${jobId} 2>/dev/null || true"`.quiet()
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
  const parts = line.split('|').map((part) => {
    return part.trim()
  })
  const jobId = parts[0]
  const state = parts[1]
  const nodeList = parts[2]

  return jobId && state ? {jobId, state, nodeList: nodeList ?? ''} : undefined
}

const getFirstNodeFromNodeList = async (nodeList: string): Promise<string | undefined> => {
  const trimmed = nodeList.trim()
  if (!trimmed || trimmed === '(null)' || trimmed === 'n/a') return undefined

  if (!trimmed.includes('[')) return trimmed.split(',')[0]

  const expanded =
    await $`ssh ${SSH_HOST} "scontrol show hostnames '${trimmed}' 2>/dev/null | head -1 || echo ''"`.text()
  const firstNode = expanded.trim()
  return firstNode ? firstNode : undefined
}

const getJobStatus = async (jobId: string): Promise<{state: string; nodeList: string}> => {
  const result = await $`ssh ${SSH_HOST} "squeue -j ${jobId} -h -o '%T|%.200N' 2>/dev/null || echo 'UNKNOWN|'"`.text()
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

const startTunnel = async (computeNode: string, jobId: string): Promise<void> => {
  // Set active job for signal handler
  activeJobId = jobId
  log(`Starting SSH tunnel: localhost:${DOCLING_PORT} -> ${computeNode}:${DOCLING_PORT}`)

  // Kill any existing process on port 5001
  await $`lsof -i :${DOCLING_PORT} -t 2>/dev/null | xargs kill 2>/dev/null || true`
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
      `${DOCLING_PORT}:${computeNode}:${DOCLING_PORT}`,
      SSH_HOST,
    ],
    {stdout: 'inherit', stderr: 'inherit'},
  )

  // Wait for tunnel to be ready
  await sleep(2000)

  // Verify connection
  const check =
    await $`curl -sf --connect-timeout 5 http://localhost:${DOCLING_PORT}/health && echo OK || echo FAIL`.text()
  if (check.includes('OK')) {
    log('✓ Tunnel connected and Docling responding')
  } else {
    log('⚠ Tunnel started but Docling health check failed (may still be starting)')
  }

  log(`Docling Serve available at http://localhost:${DOCLING_PORT}`)
  log(`Press Ctrl+C to disconnect and cancel job ${jobId}`)

  await proc.exited
}

const waitForDoclingReady = async (computeNode: string): Promise<boolean> => {
  log('Waiting for Docling Serve to be ready (this can take 2-5 minutes for model loading)...')

  for (let i = 0; i < 150; i++) {
    // Wait up to ~5 minutes
    const checkHealth =
      await $`ssh ${SSH_HOST} "curl -sf --connect-timeout 2 --max-time 4 http://${computeNode}:${DOCLING_PORT}/health 2>/dev/null && echo OK || echo NOTREADY"`.text()

    if (checkHealth.includes('OK')) {
      log('Docling Serve is ready!')
      return true
    }

    if (i % 15 === 0 && i > 0) {
      log(`Still loading... (${Math.floor((i * 2) / 60)} min elapsed)`)
    }
    await sleep(2000)
  }

  log('Timed out waiting for Docling readiness (it may still be starting)')
  return false
}

const main = async () => {
  setupSignalHandler()

  const args = process.argv.slice(2)
  const force = args.includes('--force')
  const skipBuild = args.includes('--skip-build')

  // 1. Check/build SIF image
  if (!skipBuild) {
    log('Checking for Docling SIF image...')
    const sifCheckResult =
      await $`ssh ${SSH_HOST} "test -f ${STACK_ROOT}/${SIF_NAME} && echo EXISTS || echo MISSING"`.text()
    const sifExists = sifCheckResult.trim() === 'EXISTS'

    if (!sifExists || force) {
      log('Building Docling Serve SIF (this may take 10-15 minutes)...')
      try {
        await $`ssh ${SSH_HOST} "cd ${STACK_ROOT} && apptainer pull --force ${SIF_NAME} docker://${DOCKER_IMAGE}"`
        log('SIF image built successfully')
      } catch (e) {
        console.error('Failed to build SIF image:', e)
        console.error('You may need to run: module load Apptainer')
        process.exit(1)
      }
    } else {
      log('SIF image already exists (use --force to rebuild)')
    }
  }

  // 2. Check for existing jobs
  log('Checking for existing Docling jobs...')
  const existingJobsOutput =
    await $`ssh ${SSH_HOST} "squeue -u \\$USER -n forska-docling -h -o '%i|%T|%.200N' 2>/dev/null || echo ''"`.text()
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
      await waitForDoclingReady(computeNode)
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
      await waitForDoclingReady(computeNode)
      await startTunnel(computeNode, existingPendingJob.jobId)
      return
    }
  }

  // 3. Deploy sbatch file
  log('Deploying sbatch file...')
  await $`scp ${SBATCH_FILE} ${SSH_HOST}:${STACK_ROOT}/`

  // 4. Submit job
  log('Submitting job...')
  const result = await $`ssh ${SSH_HOST} "cd ${STACK_ROOT} && sbatch ${SBATCH_FILE}"`.text()
  const jobIdMatch = result.match(/Submitted batch job (\d+)/)
  const jobId = jobIdMatch?.[1]
  if (!jobId) {
    console.error('Failed to submit job:', result)
    process.exit(1)
  }
  log(`Job submitted: ${jobId}`)

  // 5. Wait for job to start running
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

  // 6. Wait for Docling to be ready and start tunnel
  await waitForDoclingReady(computeNode)
  await startTunnel(computeNode, jobId)
}

void main()
