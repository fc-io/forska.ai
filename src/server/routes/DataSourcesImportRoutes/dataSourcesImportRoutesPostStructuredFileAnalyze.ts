import type {Context} from 'elysia'

import {analyzeStructuredFileUpload} from '../../services/structuredFileImportService.ts'

export const dataSourcesImportRoutesPostStructuredFileAnalyze = async ({
  body,
  set,
}: {
  body: {file: Blob & {name?: string; type?: string}}
  set: Context['set']
}) => {
  const upload = body.file

  if (!upload || !(upload instanceof Blob)) {
    set.status = 400
    return {data: null, error: 'No file provided'}
  }

  const result = await analyzeStructuredFileUpload(upload)

  return {data: result}
}
