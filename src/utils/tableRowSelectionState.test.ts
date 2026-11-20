import {expect, test} from 'bun:test'

import {getTableRowSelectionState} from './tableRowSelectionState.ts'

test('table row selection state keeps only selected rows', () => {
  expect(getTableRowSelectionState({a: true, b: false, c: true})).toEqual({a: true, c: true})
})

test('table row selection state of an empty selection is empty', () => {
  expect(getTableRowSelectionState({})).toEqual({})
})
