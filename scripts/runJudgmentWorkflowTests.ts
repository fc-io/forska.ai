import {judgmentWorkflowTestFilesByGate, type JudgmentWorkflowTestGate} from './judgmentWorkflowTestFiles.ts'
import {getBunTestCommand} from './runBunTests.ts'

const isJudgmentWorkflowTestGate = (value: string): value is JudgmentWorkflowTestGate => {
  return Object.hasOwn(judgmentWorkflowTestFilesByGate, value)
}

export const getJudgmentWorkflowTestCommand = (gate: JudgmentWorkflowTestGate) => {
  return getBunTestCommand([...judgmentWorkflowTestFilesByGate[gate]])
}

const main = async () => {
  const [gate = 'focused'] = process.argv.slice(2)

  if (!isJudgmentWorkflowTestGate(gate)) {
    console.error(`Unknown judgment workflow test gate: ${gate}`)
    process.exit(1)
  }

  // The component lifecycle owns process-wide runtime environment and module singletons.
  // Run each component file in a fresh process so its production composition cannot
  // leak DuckDB or SQLite ownership into the boundary suites.
  const commands =
    gate === 'component'
      ? judgmentWorkflowTestFilesByGate.component.map((filePath) => {
          return getBunTestCommand([filePath])
        })
      : [getJudgmentWorkflowTestCommand(gate)]

  for (const command of commands) {
    const testProcess = globalThis.Bun.spawn(command, {
      cwd: process.cwd(),
      env: process.env,
      stderr: 'inherit',
      stdout: 'inherit',
    })
    const exitCode = await testProcess.exited

    if (exitCode !== 0) {
      process.exit(exitCode ?? 1)
    }
  }
}

if (import.meta.main) {
  await main()
}
