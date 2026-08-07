type DuckdbStartupChildProcessInput = {command: string[]; stdin: 'ignore' | Uint8Array}

type GetDuckdbStartupChildProcessInputOptions = {
  executablePath: string
  platform: string
  script: string
  serializedArguments: string[]
}

const getDuckdbStartupChildStdinSource = (script: string, serializedArguments: string[]) => {
  return `process.argv.splice(1, process.argv.length - 1, ...${JSON.stringify(serializedArguments)})\n${script}`
}

const getWindowsDuckdbStartupChildProcessInput = ({
  executablePath,
  script,
  serializedArguments,
}: GetDuckdbStartupChildProcessInputOptions): DuckdbStartupChildProcessInput => {
  return {
    command: [executablePath, 'run', '-'],
    stdin: new TextEncoder().encode(getDuckdbStartupChildStdinSource(script, serializedArguments)),
  }
}

const getDirectDuckdbStartupChildProcessInput = ({
  executablePath,
  script,
  serializedArguments,
}: GetDuckdbStartupChildProcessInputOptions): DuckdbStartupChildProcessInput => {
  return {command: [executablePath, '-e', script, ...serializedArguments], stdin: 'ignore'}
}

export const getDuckdbStartupChildProcessInput = (
  options: GetDuckdbStartupChildProcessInputOptions,
): DuckdbStartupChildProcessInput => {
  return options.platform === 'win32'
    ? getWindowsDuckdbStartupChildProcessInput(options)
    : getDirectDuckdbStartupChildProcessInput(options)
}
