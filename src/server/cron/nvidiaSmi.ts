import {spawn} from 'node:child_process'
import os from 'node:os'

import {cron} from '@elysiajs/cron'
import {Elysia} from 'elysia'

import * as schema from '../../db/schema.ts'
import {env} from '../utils/env.ts'
import {getDatabase} from '../utils/getDatabase.ts'

type NvidiaSmiSample = {
  ts: Date
  hostname: string
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

const spawnNvidiaSmi = (
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

const parseNvidiaSmiCsv = (csv: string, ts: Date, hostname: string): NvidiaSmiSample[] => {
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
            hostname,
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

const pollNvidiaSmi = async (): Promise<void> => {
  if (env.GPU_TOTAL_GPUS === 0) return

  const args = [
    '--query-gpu=index,uuid,name,temperature.gpu,utilization.gpu,utilization.memory,memory.total,memory.used,power.draw,power.limit,fan.speed,pstate',
    '--format=csv,noheader,nounits',
  ]

  let command = 'nvidia-smi'
  let commandArgs = args
  const sshHost = process.env.NVIDIA_SMI_SSH_HOST

  if (sshHost) {
    // Run via SSH
    command = 'ssh'
    // SSH command: ssh <host> nvidia-smi <args>
    commandArgs = [sshHost, 'nvidia-smi', ...args]
  }

  const hostname = String(process.env.HOSTNAME ?? '').trim() || os.hostname()
  const ts = new Date()

  const result = await spawnNvidiaSmi(command, commandArgs)
  if (result.code !== 0) {
    // Suppress "executable not found" errors to avoid log spam on non-GPU machines
    if (result.stderr.includes('Executable not found') || result.stderr.includes('command not found')) {
      // Log only once per session ideally, but for now just suppress or log debug
      // console.debug('[nvidia-smi] command not found, skipping poll')
      return
    }
    console.error('[nvidia-smi] poll failed', {
      command: `${command} ${commandArgs[0]}...`, // log simplified command
      code: result.code,
      stderr: result.stderr.trim(),
    })
    return
  }

  const samples = parseNvidiaSmiCsv(result.stdout, ts, hostname)
  if (samples.length === 0) return

  const db = getDatabase()
  await db
    .insert(schema.nvidiaSmi)
    .values(samples)
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
