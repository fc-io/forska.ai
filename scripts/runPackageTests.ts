import {realpathSync} from 'node:fs'

const bunExecutablePath = realpathSync(process.execPath)
const testScripts = ['test:bun', 'test:vitest', 'test:playwright'] as const

const runPackageTests = async () => {
  const results: Array<{exitCode: number; script: (typeof testScripts)[number]}> = []

  for (const script of testScripts) {
    const childProcess = globalThis.Bun.spawn([bunExecutablePath, 'run', script], {
      cwd: process.cwd(),
      env: process.env,
      stderr: 'inherit',
      stdin: 'inherit',
      stdout: 'inherit',
    })
    const exitCode = await childProcess.exited

    results.push({exitCode, script})
  }

  const failedScripts = results.filter(({exitCode}) => {
    return exitCode !== 0
  })

  if (failedScripts.length === 0) {
    return
  }

  console.error(
    `Top-level test failed: ${failedScripts
      .map(({exitCode, script}) => {
        return `${script} exited ${exitCode}`
      })
      .join(', ')}`,
  )
  process.exit(1)
}

if (import.meta.main) {
  await runPackageTests()
}
