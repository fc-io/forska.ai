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

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--no-tunnel') noTunnel = true
    else if (args[i] === '--model') model = args[++i]
  }

  // 1. Copy sbatch file to MN5
  log('Deploying sbatch file...')
  await $`scp ${SBATCH_FILE} ${TLOG}:${MN5_ROOT}/`

  // 2. Submit job
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

  // 3. Wait for job to start running
  log('Waiting for job to start...')
  let computeNode: string | undefined
  for (let i = 0; i < 120; i++) {
    // Wait up to 10 minutes
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

  // 4. Wait for SGLang to be ready (can take 10-20 min for large models)
  log('Waiting for SGLang to start (this can take 10-20 minutes for large models)...')
  for (let i = 0; i < 240; i++) {
    // Wait up to 40 minutes
    try {
      const check =
        await $`ssh ${ALOG} "curl -sf http://${computeNode}:${SGLANG_PORT}/v1/models 2>/dev/null && echo OK || echo NOTREADY"`.text()
      if (check.includes('OK') && check.includes('data')) {
        log('SGLang is ready!')
        break
      }
    } catch {
      // Ignore errors during startup
    }

    if (i % 30 === 0 && i > 0) {
      log(`Still loading model... (${Math.floor((i * 10) / 60)} min elapsed)`)
    }
    await sleep(10000)
  }

  // 5. Set up SSH tunnel
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
