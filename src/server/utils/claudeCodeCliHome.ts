import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {getEnv} from './env.ts'

export const getClaudeCodeUserConfigDir = (envValues: Record<string, string | undefined> = process.env): string => {
  const configDir = envValues.CLAUDE_CONFIG_DIR

  return configDir ? configDir : path.join(os.homedir(), '.claude')
}

export const getClaudeCodeCliWorkDir = ({duckdbPath, serverRole}: {duckdbPath: string; serverRole: string}) => {
  const runtimeRoot = duckdbPath === ':memory:' ? path.join(os.tmpdir(), 'forska') : path.dirname(duckdbPath)

  return path.join(runtimeRoot, 'claude-code-cwd', serverRole)
}

export const getDefaultClaudeCodeCliWorkDir = (serverRole?: string) => {
  const env = getEnv()

  return getClaudeCodeCliWorkDir({duckdbPath: env.DUCKDB_PATH, serverRole: serverRole ?? env.SERVER_ROLE})
}

const isPathInside = (parent: string, child: string) => {
  const relative = path.relative(path.resolve(parent), path.resolve(child))

  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

const assertIsolatedClaudeCodeWorkDir = (workDir: string, userConfigDir: string) => {
  if (isPathInside(userConfigDir, workDir) || isPathInside(workDir, userConfigDir)) {
    throw new Error(`Refusing to run Claude Code inside or around the user's Claude config directory: ${workDir}`)
  }
}

export const ensureClaudeCodeCliWorkDir = async ({
  userConfigDir = getClaudeCodeUserConfigDir(),
  workDir,
}: {
  userConfigDir?: string
  workDir: string
}): Promise<string> => {
  assertIsolatedClaudeCodeWorkDir(workDir, userConfigDir)
  await fs.mkdir(workDir, {mode: 0o700, recursive: true})

  return workDir
}
