import type {DistributionManifest, DistributionPlatform} from '../buildDuckdbDistribution/distributionManifest'
import type {NativeBuild} from '../stagePatchedDuckdbDistribution/readNativeBuild'

export type NativeVerificationEvidence = {
  build: NativeBuild
  platform: DistributionPlatform
  engine: DistributionManifest['engine']
  nativeXml: Uint8Array
  verification: Uint8Array
}

export const expectedNativeVerificationPhases = [
  'seed',
  'reopen',
  'statistics-replay',
  'statistics-checkpoint',
  'statistics-reopen',
  'updated-statistics-live',
  'updated-statistics-live-reopen',
  'updated-statistics-replay',
  'updated-statistics-checkpoint',
  'updated-statistics-reopen',
]
