import {existsSync} from 'node:fs'
import {readFile} from 'node:fs/promises'
import {join} from 'node:path'

export const readNativeTestEvidence = async (directory: string) => {
  const xml = join(directory, 'native-tests.xml')
  if (existsSync(xml)) {
    return {nativeXml: await readFile(xml)}
  }
  const [log, job] = await Promise.all([
    readFile(join(directory, 'native-console.log')),
    readFile(join(directory, 'native-job.json')),
  ])
  return {nativeConsole: {log, job}}
}
