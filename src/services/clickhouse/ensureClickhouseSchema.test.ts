import {expect, mock, test} from 'bun:test'

type EngineMap = Record<string, string | null | undefined>

type QueryArgs = {query: string; query_params?: {db?: string; name?: string}}
type CommandArgs = {query: string}

const engineByTableRef: {current: EngineMap} = {current: {articles: null, judgments_raw: null, judgments: null}}

const commandCallsRef: {current: string[]} = {current: []}

const getEngineRows = (name: string | undefined) => {
  const engine = name ? engineByTableRef.current[name] : null
  return engine ? [{engine}] : []
}

const query = async ({query, query_params}: QueryArgs) => {
  const json = async () => {
    return query.includes('FROM system.tables') ? getEngineRows(query_params?.name) : []
  }
  return {json}
}

const command = async ({query}: CommandArgs) => {
  commandCallsRef.current = [...commandCallsRef.current, query]
}

void mock.module('./clickhouseClient.ts', () => {
  return {
    getClickhouseClient: () => {
      return {query, command}
    },
  }
})

const resetRefs = (engines: EngineMap) => {
  engineByTableRef.current = engines
  commandCallsRef.current = []
}

test('ensureClickhouseSchema migrates MergeTree tables to ReplacingMergeTree', async () => {
  resetRefs({articles: 'MergeTree', judgments_raw: 'MergeTree', judgments: 'View'})

  const {ensureClickhouseSchema} = await import('./ensureClickhouseSchema.ts')
  await ensureClickhouseSchema()

  const commands = commandCallsRef.current.join('\n')

  expect(commands.includes('RENAME TABLE forska.articles')).toBe(true)
  expect(commands.includes('RENAME TABLE forska.judgments_raw')).toBe(true)
  expect(commands.includes('ENGINE = ReplacingMergeTree(_peerdb_version)')).toBe(true)
})

test('ensureClickhouseSchema skips migration when engines already match', async () => {
  resetRefs({articles: 'ReplacingMergeTree', judgments_raw: 'ReplacingMergeTree', judgments: 'ReplacingMergeTree'})

  const {ensureClickhouseSchema} = await import('./ensureClickhouseSchema.ts')
  await ensureClickhouseSchema()

  const commands = commandCallsRef.current.join('\n')

  expect(commands.includes('RENAME TABLE forska.articles')).toBe(false)
  expect(commands.includes('RENAME TABLE forska.judgments_raw')).toBe(false)
})
