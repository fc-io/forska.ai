import {judgmentWorkflowTestFilesByGate, type JudgmentWorkflowTestGate} from './judgmentWorkflowTestFiles.ts'
import {getBunTestCommand} from './runBunTests.ts'

const isJudgmentWorkflowTestGate = (value: string): value is JudgmentWorkflowTestGate => {
  return Object.hasOwn(judgmentWorkflowTestFilesByGate, value)
}

export const getJudgmentWorkflowTestCommand = (gate: JudgmentWorkflowTestGate) => {
  return getBunTestCommand([...judgmentWorkflowTestFilesByGate[gate]])
}

export const getJudgmentWorkflowTestCommands = (gate: JudgmentWorkflowTestGate) => {
  return judgmentWorkflowTestFilesByGate[gate].map((filePath) => {
    return getBunTestCommand([filePath])
  })
}

const main = async () => {
  const [gate = 'focused'] = process.argv.slice(2)

  if (!isJudgmentWorkflowTestGate(gate)) {
    console.error(`Unknown judgment workflow test gate: ${gate}`)
    process.exit(1)
  }

  // Bun module mocks and runtime modules are process-wide. Each suite configures
  // different owners, databases, and provider boundaries, so sharing a process can
  // make a later file observe an earlier file's mock.module implementation.
  for (const command of getJudgmentWorkflowTestCommands(gate)) {
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
