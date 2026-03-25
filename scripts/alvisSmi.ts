import {$} from 'bun'

import {ALVIS_HOST, getLatestAlvisJob, parseUrlHostAndPort, readAlvisConfigFromLog, splitCsv} from './alvisCommon.ts'

const log = (message: string): void => {
  console.log(`[alvis:smi] ${message}`)
}

const getHostsFromWorkerUrls = (workerUrls: string, fallbackHost: string): string[] => {
  const hosts = splitCsv(workerUrls).reduce<Set<string>>((accumulator, workerUrl) => {
    const parsed = parseUrlHostAndPort(workerUrl)
    if (parsed?.host) accumulator.add(parsed.host)
    return accumulator
  }, new Set<string>())

  return hosts.size > 0 ? Array.from(hosts) : [fallbackHost]
}

const main = async () => {
  log('Checking for running job...')
  const job = await getLatestAlvisJob('RUNNING')

  if (!job) {
    console.error('[alvis:smi] No running job found.')
    process.exit(1)
  }

  const config = await readAlvisConfigFromLog(job.jobId, job.jobName)
  if (!config) {
    console.error('[alvis:smi] Could not parse startup config from log.')
    process.exit(1)
  }

  const hosts = getHostsFromWorkerUrls(config.WORKER_URLS, config.SGLANG_HOST)
  log(`Querying nvidia-smi on ${hosts.length} host(s): ${hosts.join(', ')}`)

  for (const host of hosts) {
    console.log(`\n\n=== Status for ${host} ===`)
    try {
      await $`ssh -t ${ALVIS_HOST} "ssh -o StrictHostKeyChecking=no ${host} nvidia-smi"`
    } catch (error) {
      console.error(`Failed to query ${host}:`, error)
    }
  }
}

void main()
