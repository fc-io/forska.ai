import assert from 'node:assert/strict'
import {win32} from 'node:path'

export const getNativeExtractionCommand = (archive: string, source: string, platform: string, systemRoot?: string) => {
  if (platform === 'win32') {
    assert.ok(systemRoot && win32.isAbsolute(systemRoot), 'Windows source extraction requires its native system root')
  }
  const executable = platform === 'win32' ? win32.join(systemRoot ?? '', 'System32', 'tar.exe') : 'tar'
  return [executable, '-xzf', archive, '--strip-components=1', '-C', source]
}
