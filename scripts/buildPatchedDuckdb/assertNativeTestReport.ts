import assert from 'node:assert/strict'

const expectedNativeCases = [
  'Truncated string maxima preserve the wider prefix in both merge orders',
  'Exact short string maxima and unequal prefixes retain ordinary ordering',
  'String maximum merges preserve equal, empty and unknown bound semantics',
  'String maximum unions are associative and preserve every represented suffix',
]

const expectedSqlCases = [
  'test/sql/delete/bulk_delete_version_info_memory.test',
  'test/sql/delete/delete_compression_after_restart.test',
  'test/sql/delete/delete_compression_blocked_by_old_snapshot.test',
  'test/sql/delete/full_vector_delete_conflict.test',
  'test/sql/delete/full_vector_delete_rollback.test',
  'test/sql/delete/masked_vector_further_delete.test',
  'test/sql/delete/masked_vector_rollback.test',
  'test/sql/delete/partial_delete_version_info_memory.test',
  'test/sql/delete/piecemeal_delete_checkpoint_compress.test_slow',
  'test/sql/storage/full_vector_delete_checkpoint.test',
  'test/sql/storage/partial_delete_checkpoint_mask.test',
  'test/sql/storage/partial_delete_pending_compress.test',
  'test/sql/storage/piecemeal_delete_checkpoint_compress.test',
  'test/sql/storage/truncated_string_max_update.test',
]

export const assertNativeTestReport = (xml: string, filter: string) => {
  const sqlCases = filter.split(',').filter((name) => {
    return name.startsWith('test/sql/')
  })
  assert.deepEqual(
    sqlCases.sort(),
    expectedSqlCases.toSorted(),
    'All 13 checkpoint regressions and the new SQL regression must be selected',
  )
  const expected = [...sqlCases, ...expectedNativeCases].sort()
  const actual = [...xml.matchAll(/<testcase\b[^>]*\bname="([^"]+)"/g)]
    .map((match) => {
      const name = match[1]
      assert.ok(name)
      return name
    })
    .sort()
  assert.deepEqual(actual, expected, 'Native test report must contain exactly all 18 named cases')
  assert.ok(!/<(?:failure|error|skipped)\b/.test(xml), 'Native regression contains failed or skipped cases')
}
