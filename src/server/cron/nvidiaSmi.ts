import {spawn} from 'node:child_process'

import {cron} from '@elysiajs/cron'
import {Elysia} from 'elysia'

import * as schema from '../../db/schema.ts'
import {env} from '../utils/env.ts'
import {getDatabase} from '../utils/getDatabase.ts'

type NvidiaSmiSample = {
  ts: Date
  instanceId: string
  gpuIndex: number
  gpuUuid: string | null
  gpuName: string | null
  temperatureGpu: number | null
  utilizationGpu: number | null
  utilizationMemory: number | null
  memoryTotalMiB: number | null
  memoryUsedMiB: number | null
  powerDrawWatts: number | null
  powerLimitWatts: number | null
  fanSpeed: number | null
  pstate: string | null
}

const NVIDIA_SMI_INTERVAL = '*/30 * * * * *'
const START_DELAY_MS = 1500

const normalizeNullable = (value: string | undefined): string | null => {
  const normalized = String(value ?? '').trim()
  return normalized.length === 0 || normalized === 'N/A' ? null : normalized
}

const parseNullableNumber = (value: string | undefined): number | null => {
  const normalized = normalizeNullable(value)
  const parsed = normalized === null ? null : Number(normalized)
  return parsed === null || !Number.isFinite(parsed) ? null : parsed
}

const parseNullableInt = (value: string | undefined): number | null => {
  const parsed = parseNullableNumber(value)
  return parsed === null ? null : Math.trunc(parsed)
}

const spawnCommand = (
  command: string,
  args: string[],
): Promise<{stdout: string; stderr: string; code: number | null}> => {
  return new Promise((resolve) => {
    const child = spawn(command, args, {stdio: ['ignore', 'pipe', 'pipe']})

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    child.on('close', (code) => {
      resolve({stdout, stderr, code})
    })

    child.on('error', (error) => {
      resolve({stdout: '', stderr: String(error), code: -1})
    })
  })
}

const parseNvidiaSmiCsv = (csv: string, ts: Date, instanceId: string): NvidiaSmiSample[] => {
  const lines = csv
    .trim()
    .split('\n')
    .map((line) => {
      return line.trim()
    })
    .filter((line) => {
      return line.length > 0
    })

  return lines
    .map((line) => {
      const parts = line.split(',').map((part) => {
        return part.trim()
      })

      const gpuIndex = parseNullableInt(parts[0])
      return gpuIndex === null
        ? null
        : ({
            ts,
            instanceId,
            gpuIndex,
            gpuUuid: normalizeNullable(parts[1]),
            gpuName: normalizeNullable(parts[2]),
            temperatureGpu: parseNullableInt(parts[3]),
            utilizationGpu: parseNullableInt(parts[4]),
            utilizationMemory: parseNullableInt(parts[5]),
            memoryTotalMiB: parseNullableInt(parts[6]),
            memoryUsedMiB: parseNullableInt(parts[7]),
            powerDrawWatts: parseNullableNumber(parts[8]),
            powerLimitWatts: parseNullableNumber(parts[9]),
            fanSpeed: parseNullableInt(parts[10]),
            pstate: normalizeNullable(parts[11]),
          } satisfies NvidiaSmiSample)
    })
    .filter((row): row is NvidiaSmiSample => {
      return row !== null
    })
}

const normalizeWorkerUrls = (urls: string[] | null | undefined): string[] => {
  return Array.from(
    new Set(
      (urls ?? [])
        .map((url) => {
          return url.trim()
        })
        .filter((url) => {
          return url.length > 0
        }),
    ),
  )
}

// Extract host from worker URL (e.g., http://10.2.101.73:30000 -> 10.2.101.73)
const extractHostFromUrl = (url: string): string | null => {
  const match = url.match(/https?:\/\/([^:\/]+)/)
  return match ? match[1] : null
}

// Get SSH jump host from env (optional, for remote HPC access)
const getSSHJumpHost = (): string | null => {
  return process.env.NVIDIA_SMI_SSH_JUMP_HOST?.trim() || null
}

const pollNvidiaSmiForWorker = async (
  remoteWorkerUrl: string,
  displayInstanceId: string,
  ts: Date,
): Promise<NvidiaSmiSample[]> => {
  const host = extractHostFromUrl(remoteWorkerUrl)
  if (!host) {
    console.error(`[nvidia-smi] Could not extract host from URL: ${remoteWorkerUrl}`)
    return []
  }

  const nvidiaSmiArgs = [
    '--query-gpu=index,uuid,name,temperature.gpu,utilization.gpu,utilization.memory,memory.total,memory.used,power.draw,power.limit,fan.speed,pstate',
    '--format=csv,noheader,nounits',
  ]

  const jumpHost = getSSHJumpHost()
  let result: {stdout: string; stderr: string; code: number | null}

  if (jumpHost) {
    // Nested SSH: ssh jumpHost "ssh targetHost nvidia-smi ..."
    const remoteCmd = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${host} nvidia-smi ${nvidiaSmiArgs.join(' ')}`
    result = await spawnCommand('ssh', ['-o', 'ConnectTimeout=10', jumpHost, remoteCmd])
  } else {
    // Direct SSH to the worker host
    result = await spawnCommand('ssh', [
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'ConnectTimeout=10',
      host,
      'nvidia-smi',
      ...nvidiaSmiArgs,
    ])
  }

  if (result.code !== 0) {
    // Suppress common non-error cases
    if (
      result.stderr.includes('Executable not found')
      || result.stderr.includes('command not found')
      || result.stderr.includes('Connection refused')
      || result.stderr.includes('Connection timed out')
    ) {
      return []
    }
    console.error(`[nvidia-smi] poll failed for ${remoteWorkerUrl}`, {
      code: result.code,
      stderr: result.stderr.trim().slice(0, 200),
    })
    return []
  }

  // Use displayInstanceId (local URL) for the instanceId stored in DB
  return parseNvidiaSmiCsv(result.stdout, ts, displayInstanceId)
}

// Parse worker URLs from NVIDIA_SMI_WORKER_URLS env (remote IPs, not localhost tunnels)
const getNvidiaSmiWorkerUrls = (): string[] => {
  const raw = process.env.NVIDIA_SMI_WORKER_URLS?.trim() || ''
  if (!raw) return []
  return raw
    .split(',')
    .map((url) => {
      return url.trim()
    })
    .filter((url) => {
      return url.length > 0
    })
}

// Parse local worker URLs for display (matching LLM metrics page)
const getNvidiaSmiWorkerUrlsLocal = (): string[] => {
  const raw = process.env.NVIDIA_SMI_WORKER_URLS_LOCAL?.trim() || ''
  if (!raw) return []
  return raw
    .split(',')
    .map((url) => {
      return url.trim()
    })
    .filter((url) => {
      return url.length > 0
    })
}

// Build mapping from remote worker URL to local worker URL (1:1 positional mapping)
const buildRemoteToLocalMapping = (): Map<string, string> => {
  const remoteUrls = getNvidiaSmiWorkerUrls()
  const localUrls = getNvidiaSmiWorkerUrlsLocal()
  const mapping = new Map<string, string>()

  for (let i = 0; i < remoteUrls.length; i++) {
    // Use local URL if available at same position, otherwise fall back to remote
    const localUrl = localUrls[i] || remoteUrls[i]
    mapping.set(remoteUrls[i], localUrl)
  }

  return mapping
}

const pollNvidiaSmi = async (): Promise<void> => {
  const workerUrls = getNvidiaSmiWorkerUrls()

  // If no worker URLs configured, skip polling
  if (workerUrls.length === 0) {
    return
  }

  // Build mapping for local display URLs
  const remoteToLocalMapping = buildRemoteToLocalMapping()

  const ts = new Date()
  const allSamples: NvidiaSmiSample[] = []

  // Poll each worker in parallel
  const results = await Promise.all(
    workerUrls.map((remoteUrl) => {
      const displayUrl = remoteToLocalMapping.get(remoteUrl) || remoteUrl
      return pollNvidiaSmiForWorker(remoteUrl, displayUrl, ts)
    }),
  )

  for (const samples of results) {
    allSamples.push(...samples)
  }

  if (allSamples.length === 0) return

  const db = getDatabase()
  await db
    .insert(schema.nvidiaSmi)
    .values(allSamples)
    .catch((error) => {
      console.error('[nvidia-smi] db insert failed', error)
    })
}

export const nvidiaSmiCron = new Elysia().use(
  cron({
    name: 'nvidia-smi-poll',
    pattern: NVIDIA_SMI_INTERVAL,
    startAt: new Date(Date.now() + START_DELAY_MS),
    run: pollNvidiaSmi,
  }),
)
