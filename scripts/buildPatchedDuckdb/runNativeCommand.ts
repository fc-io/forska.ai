import assert from 'node:assert/strict'
import {appendFile} from 'node:fs/promises'

import {spawn} from 'bun'

export const runNativeCommand = async (command: string[], cwd: string, log: string) => {
  await appendFile(log, `${JSON.stringify({command, cwd})}\n`)
  const child = spawn(command, {cwd, stdout: 'pipe', stderr: 'pipe', env: process.env})
  const consume = async (stream: ReadableStream<Uint8Array>, stderr: boolean) => {
    const decoder = new TextDecoder()
    const reader = stream.getReader()
    const readNext = async (): Promise<void> => {
      const chunk = await reader.read()
      if (!chunk.done) {
        const text = decoder.decode(chunk.value, {stream: true})
        await appendFile(log, text)
        ;(stderr ? process.stderr : process.stdout).write(text)
        await readNext()
      }
    }
    await readNext()
  }
  const [code] = await Promise.all([child.exited, consume(child.stdout, false), consume(child.stderr, true)])
  assert.equal(code, 0, `Native build command failed (${code}): ${command[0]}; see ${log}`)
}
