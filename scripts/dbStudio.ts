import {getDuckdbPath} from '../src/server/utils/getDuckdbPath.ts'

const runDuckdbStudio = async (): Promise<void> => {
  const duckdbPath = getDuckdbPath({duckdbPath: process.env.DUCKDB_PATH})
  const exitCode = await Bun.spawn(['duckdb', '-cmd', 'CALL start_ui_server();', duckdbPath], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  }).exited

  if (exitCode !== 0) {
    process.exit(exitCode)
  }
}

if (import.meta.main) {
  void runDuckdbStudio()
}
