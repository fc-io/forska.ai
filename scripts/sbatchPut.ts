import {$} from 'bun'
import {existsSync} from 'fs'

const log = (s: string): void => {
  console.log(`[sbatchPut] ${s}`)
}

const fail = (s: string): never => {
  console.error(`[sbatchPut] ${s}`)
  process.exit(1)
}

const main = async (): Promise<void> => {
  const ssh = process.env.SSH_ALIAS
  const stackRoot = process.env.STACK_ROOT
  const localFile = 'forska-alvis.sbatch'

  if (!ssh) fail('Missing env SSH_ALIAS (e.g., user@hpc-host)')
  if (!stackRoot) fail('Missing env STACK_ROOT (remote shared path)')
  if (!existsSync(localFile)) fail(`Local file not found: ${localFile}`)

  log(`Ensuring remote dir exists: ${ssh}:${stackRoot}`)
  const mk = await $.nothrow()`ssh ${ssh} mkdir -p ${stackRoot}`
  if (mk.exitCode !== 0) fail('ssh mkdir failed')

  log(`Copying ${localFile} -> ${ssh}:${stackRoot}/`)
  const cp = await $.nothrow()`scp ${localFile} ${ssh}:${stackRoot}/`
  if (cp.exitCode !== 0) fail('scp failed')

  log('Done')
}

void main()
