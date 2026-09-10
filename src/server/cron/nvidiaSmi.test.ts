import {expect, test} from 'bun:test'

import {getNvidiaSmiCommandForWorker} from './nvidiaSmi.ts'

const nvidiaSmiArgs = [
  '--query-gpu=index,uuid,name,temperature.gpu,utilization.gpu,utilization.memory,memory.total,memory.used,power.draw,power.limit,fan.speed,pstate',
  '--format=csv,noheader,nounits',
]

test('getNvidiaSmiCommandForWorker polls Arrhenius GPUs through the owning Slurm job', () => {
  const command = getNvidiaSmiCommandForWorker({
    nvidiaSmiArgs,
    remoteWorkerUrl: 'http://n559:30002',
    runtimeConfig: {jobId: '2288777', sourceCluster: 'arr', sshJumpHost: 'arr'},
  })

  expect(command).not.toBeNull()
  expect(command?.command).toBe('ssh')
  expect(command?.args.slice(0, 3)).toEqual(['-o', 'ConnectTimeout=10', 'arr'])

  const remoteCommand = command?.args.at(-1) ?? ''
  expect(remoteCommand).toContain("'srun'")
  expect(remoteCommand).toContain("'--jobid=2288777'")
  expect(remoteCommand).toContain("'--overlap'")
  expect(remoteCommand).toContain("'-w' 'n559'")
  expect(remoteCommand).toContain("'nvidia-smi'")
  expect(remoteCommand).not.toContain("'ssh'")
})

test('getNvidiaSmiCommandForWorker keeps nested SSH for non-Arrhenius jump hosts', () => {
  const command = getNvidiaSmiCommandForWorker({
    nvidiaSmiArgs,
    remoteWorkerUrl: 'http://gpu-node.example:30000',
    runtimeConfig: {jobId: 'remote-job', sourceCluster: 'remote', sshJumpHost: 'remote-jump'},
  })

  expect(command).not.toBeNull()
  expect(command?.command).toBe('ssh')
  expect(command?.args.slice(0, 3)).toEqual(['-o', 'ConnectTimeout=10', 'remote-jump'])

  const remoteCommand = command?.args.at(-1) ?? ''
  expect(remoteCommand).toContain("'ssh'")
  expect(remoteCommand).toContain("'gpu-node.example'")
  expect(remoteCommand).toContain("'nvidia-smi'")
  expect(remoteCommand).not.toContain("'srun'")
})

test('getNvidiaSmiCommandForWorker uses direct SSH when no jump host is configured', () => {
  const command = getNvidiaSmiCommandForWorker({
    nvidiaSmiArgs,
    remoteWorkerUrl: 'http://10.0.0.1:30000',
    runtimeConfig: {jobId: null, sourceCluster: null, sshJumpHost: null},
  })

  expect(command).toEqual({
    args: ['-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10', '10.0.0.1', 'nvidia-smi', ...nvidiaSmiArgs],
    command: 'ssh',
  })
})
