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

  const testProcess = globalThis.Bun.spawn(getJudgmentWorkflowTestCommand(gate), {
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

if (import.meta.main) {
  await main()
}
