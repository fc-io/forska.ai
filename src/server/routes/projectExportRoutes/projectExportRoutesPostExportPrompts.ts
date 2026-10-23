import type {Context} from 'elysia'

import {getAppDatabaseService} from '../../services/appDatabaseService.ts'
import {getQuotedStringList} from '../../services/appQueryHelpers.ts'
import {csvUtf8Bom, getCsvDownloadHeaders} from '../../utils/csvResponse.ts'
import {assertProjectIsActive} from '../projectsRoutes/projectAccessGuard.ts'
import {escapeCSV} from './escapeCSV.ts'
import {getProject} from './getProject.ts'
import {getProjectExportWorkloadContext} from './getProjectExportWorkloadContext.ts'
import type {PromptDetails} from './projectExportRouteTypes.ts'

type PromptInfoRow = {prompt: string; title: string; type: string}

const buildPromptInfoRows = (promptIds: string[], promptDetails: PromptDetails[]): PromptInfoRow[] => {
  const promptDetailsMap = new Map(
    promptDetails.map((detail) => {
      return [detail.id, detail]
    }),
  )

  return promptIds.flatMap((promptId) => {
    const detail = promptDetailsMap.get(promptId)

    return detail
      ? [{prompt: detail.originalText ?? '', title: detail.promptHeading || 'Untitled Prompt', type: detail.type ?? ''}]
      : []
  })
}

const buildPromptInfoCsv = (promptIds: string[], promptDetails: PromptDetails[]): string => {
  const rows = buildPromptInfoRows(promptIds, promptDetails)
  const headerRow = ['Prompt Heading', 'Prompt Answer Options', 'Prompt'].map(escapeCSV).join(',')
  const dataRows = rows.map((row) => {
    return [row.title, row.type, row.prompt].map(escapeCSV).join(',')
  })

  return [headerRow, ...dataRows].join('\n') + '\n'
}

export const projectExportRoutesPostExportPrompts = async ({
  body,
  params,
  set,
}: {
  body: {promptIds: string[]}
  params: {id: string}
  set: Context['set']
}) => {
  await assertProjectIsActive(params.id)

  const project = await getProject(params.id)

  if (!project) {
    throw new Error('Project not found')
  }

  if (body.promptIds.length === 0) {
    set.status = 400
    return {data: null, error: 'No prompts selected for export'}
  }

  const promptDetails = await getAppDatabaseService().queryJson<PromptDetails>(
    `
        SELECT
          id,
          prompt_heading AS promptHeading,
          original_text AS originalText,
          type
        FROM app.prompt
        WHERE id IN (${getQuotedStringList(body.promptIds).join(', ')})
      `,
    getProjectExportWorkloadContext({
      maxResultRows: body.promptIds.length,
      operation: 'exportPrompts.promptDetails',
      projectId: params.id,
    }),
  )
  const csv = csvUtf8Bom + buildPromptInfoCsv(body.promptIds, promptDetails)
  const filename = `${project.name.replace(/[^a-zA-Z0-9]/g, '_')}_prompts_${new Date().toISOString().slice(0, 10)}.csv`
  const headers = getCsvDownloadHeaders(filename)

  set.headers['Content-Type'] = headers['Content-Type']
  set.headers['Content-Disposition'] = headers['Content-Disposition']

  return new Response(csv, {headers})
}
