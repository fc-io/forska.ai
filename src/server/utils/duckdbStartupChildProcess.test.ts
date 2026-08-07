import {expect, test} from 'bun:test'

import {getDuckdbStartupChildProcessInput} from './duckdbStartupChildProcess.ts'

test('duckdb startup child keeps generated scripts and arguments off the Windows command line', () => {
  const serializedArguments = [JSON.stringify('C:\\Users\\sample\\AppData\\Local\\Forska\\forska.duckdb')]
  const script = `${' '.repeat(40_000)}
    const {DuckDBInstance} = await import('@duckdb/node-api')
    console.log(JSON.stringify({arguments: process.argv.slice(1), duckdbInstanceType: typeof DuckDBInstance}))
  `
  const input = getDuckdbStartupChildProcessInput({
    executablePath: process.execPath,
    platform: 'win32',
    script,
    serializedArguments,
  })

  expect(input.command).toEqual([process.execPath, 'run', '-'])
  expect(input.stdin).toBeInstanceOf(Uint8Array)
  expect(input.stdin).not.toBe('ignore')
  expect(input.stdin.length).toBeGreaterThan(32_767)

  const result = globalThis.Bun.spawnSync(input.command, {stderr: 'pipe', stdin: input.stdin, stdout: 'pipe'})

  expect(result.exitCode).toBe(0)
  expect(result.stderr.toString()).toBe('')
  expect(JSON.parse(result.stdout.toString())).toEqual({arguments: serializedArguments, duckdbInstanceType: 'function'})
})

test('duckdb startup child preserves direct eval outside Windows', () => {
  const input = getDuckdbStartupChildProcessInput({
    executablePath: '/usr/local/bin/bun',
    platform: 'darwin',
    script: 'console.log(process.argv[1])',
    serializedArguments: ['"argument"'],
  })

  expect(input).toEqual({
    command: ['/usr/local/bin/bun', '-e', 'console.log(process.argv[1])', '"argument"'],
    stdin: 'ignore',
  })
})
