import {$} from 'bun'
import {spawn} from 'bun'

const SSH_HOST = 'alog'
const GLOG = 'glog'
const MN5_ROOT = '/gpfs/projects/ehpc482/dev'

const log = (m: string): void => {
  console.log(`[mn5:smi] ${m}`)
}

// Helper to run SSH command
const sshCommand = async (host: string, cmd: string): Promise<string> => {
  const proc = spawn(['ssh', host, cmd], {stdout: 'pipe', stderr: 'pipe'})
  const stdout = await new Response(proc.stdout).text()
  return stdout.trim()
}

// Find latest job (copied from mn5DevServer.ts)
const findLatestJob = async (): Promise<{jobId: string; computeNode: string} | null> => {
  try {
    const result = await sshCommand(GLOG, 'squeue -u $USER -n forska-mn5-sglang -h -o "%i %N" -t RUNNING | head -1')
    if (!result.trim()) return null
    const parts = result.split(/\s+/)
    const jobId = parts[0]
    const nodeList = parts[1]
    if (!jobId || !nodeList) return null
    return {jobId, computeNode: nodeList}
  } catch (e) {
    return null
  }
}

// Parse config (copied from mn5DevServer.ts)
const parseConfigFromLog = async (jobId: string): Promise<Record<string, string> | null> => {
  try {
    const logPath = `${MN5_ROOT}/forska-mn5-sglang-${jobId}.log`
    const logContent = await $`ssh ${SSH_HOST} "cat ${logPath} 2>/dev/null || echo ''"`.text()

    const startMarker = '[mn5:config:start]'
    const endMarker = '[mn5:config:end]'
    const startIdx = logContent.indexOf(startMarker)
    const endIdx = logContent.indexOf(endMarker)

    if (startIdx === -1 || endIdx === -1) return null

    const configBlock = logContent.slice(startIdx + startMarker.length, endIdx)
    const config: Record<string, string> = {}

    for (const line of configBlock.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.includes('=')) continue
      const [key, ...valueParts] = trimmed.split('=')
      if (key) {
        config[key.trim()] = valueParts.join('=').trim()
      }
    }
    return config
  } catch (e) {
    return null
  }
}

const main = async () => {
  log('Checking for running job...')
  const job = await findLatestJob()
  if (!job) {
    console.error('No running job found.')
    process.exit(1)
  }

  log(`Found job ${job.jobId} on ${job.computeNode}`)
  const config = await parseConfigFromLog(job.jobId)
  if (!config || !config.WORKER_URLS) {
    console.error('Could not parse worker config from log.')
    process.exit(1)
  }

  // Extract IPs from WORKER_URLS (e.g. http://10.2.101.73:30000,...)
  // We want unique Hosts.
  const workerUrls = config.WORKER_URLS.split(',')
  const hosts = new Set<string>()

  for (const url of workerUrls) {
    const match = url.match(/http:\/\/([^:]+):/)
    const host = match?.[1]
    if (host) hosts.add(host)
  }

  if (hosts.size === 0) {
    // If no workers found, maybe standalone mode? Try SGLANG_HOST
    if (config.SGLANG_HOST) hosts.add(config.SGLANG_HOST)
  }

  if (hosts.size === 0) {
    console.error('No worker hosts found.')
    process.exit(1)
  }

  log(`Querying nvidia-smi on ${hosts.size} host(s): ${Array.from(hosts).join(', ')}`)

  for (const host of hosts) {
    console.log(`\n\n=== Status for ${host} ===`)
    try {
      // Execute ssh ON the login node (nested) to use cluster-internal keys/auth
      // rather than trying to proxy local keys which may not be authorized on compute nodes.
      await $`ssh -t ${SSH_HOST} "ssh -o StrictHostKeyChecking=no ${host} nvidia-smi"`
    } catch (e) {
      console.error(`Failed to query ${host}:`, e)
    }
  }
}

void main()
