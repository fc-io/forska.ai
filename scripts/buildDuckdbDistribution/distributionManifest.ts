import manifest from '../../vendor/duckdb/manifest.json'

type OriginalPlatform = (typeof manifest.platforms)[number]

export type DistributionPlatform = Omit<OriginalPlatform, 'artifact'> & {
  artifact: Omit<OriginalPlatform['artifact'], 'id'> & {id?: number}
  nativeBuild?: Record<string, unknown>
}

export type DistributionManifest = Omit<typeof manifest, 'engine' | 'platforms'> & {
  engine: Omit<typeof manifest.engine, 'workflowRunId'> & {
    workflowRunId?: number
    nativeBuild?: Record<string, unknown>
  }
  platforms: DistributionPlatform[]
}
