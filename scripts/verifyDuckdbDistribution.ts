import assert from 'node:assert/strict'
import {copyFileSync, mkdtempSync, statSync, symlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'

import {spawnSync} from 'bun'

import {getInstalledDuckdbDistribution} from './verifyDuckdbDistribution/getInstalledDuckdbDistribution.ts'
import {verifyDuckdbStringStatistics} from './verifyDuckdbDistribution/verifyDuckdbStringStatistics.ts'
import {verifyDuckdbUpdatedStringStatistics} from './verifyDuckdbDistribution/verifyDuckdbUpdatedStringStatistics.ts'
import {verifyDuckdbWal} from './verifyDuckdbDistribution/verifyDuckdbWal.ts'

const packageRoot = resolve(
  process.argv
    .find((value) => {
      return value.startsWith('--package-root=')
    })
    ?.slice('--package-root='.length) ?? process.cwd(),
)
const phase = process.argv
  .find((value) => {
    return value.startsWith('--phase=')
  })
  ?.slice('--phase='.length)
const directory = process.argv
  .find((value) => {
    return value.startsWith('--directory=')
  })
  ?.slice('--directory='.length)

const runCommand = (command: string[], artifactDirectory: string, name: string) => {
  const result = spawnSync(command, {cwd: packageRoot, stdout: 'pipe', stderr: 'pipe', timeout: 180000})
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  writeFileSync(join(artifactDirectory, `${name}.log`), output)
  console.log(output)
  assert.equal(result.exitCode, 0, `${name} failed; evidence: ${artifactDirectory}`)
}

const verifyInstalledRuntime = () => {
  getInstalledDuckdbDistribution(packageRoot)
  const artifacts = mkdtempSync(join(tmpdir(), 'forska-duckdb-distribution-'))
  console.log('duckdb-distribution:artifacts', artifacts)
  const command = [process.execPath, import.meta.path, `--package-root=${packageRoot}`, `--directory=${artifacts}`]
  runCommand([...command, '--phase=seed'], artifacts, 'seed')
  assert.ok(statSync(join(artifacts, 'new-wal.duckdb.wal')).size > 0, 'Committed data must require actual WAL replay')
  runCommand([...command, '--phase=reopen'], artifacts, 'reopen')
  ;['statistics-replay', 'statistics-checkpoint', 'statistics-reopen'].map((statisticsPhase) => {
    return runCommand([...command, `--phase=${statisticsPhase}`], artifacts, statisticsPhase)
  })
  ;[
    'updated-statistics-live',
    'updated-statistics-live-reopen',
    'updated-statistics-replay',
    'updated-statistics-checkpoint',
    'updated-statistics-reopen',
  ].map((statisticsPhase) => {
    return runCommand([...command, `--phase=${statisticsPhase}`], artifacts, statisticsPhase)
  })
  const regressionPath = join(artifacts, 'duckdbCheckpointMemoryRegression.ts')
  copyFileSync(new URL('./duckdbCheckpointMemoryRegression.ts', import.meta.url), regressionPath)
  symlinkSync(join(packageRoot, 'node_modules'), join(artifacts, 'node_modules'), 'junction')
  runCommand([process.execPath, regressionPath], artifacts, 'checkpoint-memory')
  console.log('duckdb-distribution:pass', {packageRoot, artifacts})
}

if (phase !== undefined) {
  assert.ok(directory, 'A child verification phase requires its disposable directory')
  if (phase.startsWith('updated-statistics-')) {
    await verifyDuckdbUpdatedStringStatistics(packageRoot, phase, directory)
  } else if (phase.startsWith('statistics-')) {
    await verifyDuckdbStringStatistics(packageRoot, phase, directory)
  } else {
    await verifyDuckdbWal(packageRoot, phase, directory)
  }
} else {
  verifyInstalledRuntime()
}
