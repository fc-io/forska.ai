import {version} from '@duckdb/node-api'

import {assertDuckdbEngineVersion, duckdbEngineCompatibilityOptions} from './duckdbEngineContract.ts'

export {
  assertDuckdbEngineVersion,
  duckdbEngineCompatibilityOptions,
  getDuckdbLegacyWalCompatibilityError,
  isDuckdbLegacyWalCompatibilityError,
} from './duckdbEngineContract.ts'

export const getDuckdbEngineOptions = () => {
  assertDuckdbEngineVersion(version())

  return {...duckdbEngineCompatibilityOptions}
}
