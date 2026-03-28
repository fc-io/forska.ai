import type {Context} from 'elysia'

import {analyzeCovidencePackageFiles} from '../../services/covidenceImportService.ts'

type CovidenceImportMode = 'title_abstract' | 'full_text'
type CovidenceFileRole = 'all' | 'irrelevant' | 'full_text' | 'excluded' | 'included'

export const dataSourcesImportRoutesPostCovidenceAnalyze = async ({
  body,
  set,
}: {
  body: {
    files: Array<{file: Blob & {name?: string; type?: string}; fileRole: CovidenceFileRole}>
    mode: CovidenceImportMode
  }
  set: Context['set']
}) => {
  const result = await analyzeCovidencePackageFiles(body)

  if (result.ok === false) {
    set.status = 400
    return {data: null, error: result.error.message}
  }

  return {data: result.data}
}
