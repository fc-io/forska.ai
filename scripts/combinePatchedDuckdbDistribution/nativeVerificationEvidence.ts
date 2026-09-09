import type {DistributionManifest, DistributionPlatform} from '../buildDuckdbDistribution/distributionManifest'
import type {NativeBuild} from '../stagePatchedDuckdbDistribution/readNativeBuild'

export type NativeVerificationEvidence = {
  build: NativeBuild
  platform: DistributionPlatform
  engine: DistributionManifest['engine']
  verification: Uint8Array
} & (
  | {nativeXml: Uint8Array; nativeConsole?: never}
  | {nativeXml?: never; nativeConsole: {log: Uint8Array; job: Uint8Array}}
)

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
