import {rmSync} from 'node:fs'
import path from 'node:path'

type SeededProject = {projectId: string}

type ProviderConnectionCreateResponse = {data: {connection: {id: string}}}
type ProviderModelCreateResponse = {data: {modelId: string}}
type CovidenceCreateResponse = {data: {covidenceProject: {id: string} | null; dataSource: {id: string}}}

const seedTitle = 'Playwright Covidence Project'
const allReferencesCsv = [
  'Title,Authors,Year,DOI',
  'Study A,"Doe, Jane",2024,10.1000/alpha',
  'Study B,"Roe, John",2023,10.1000/beta',
  'Study C,"Lane, Kim",2022,10.1000/gamma',
].join('\n')
const irrelevantReferencesCsv = ['Title,Authors,Year,DOI', 'Study B,"Roe, John",2023,10.1000/beta'].join('\n')
const fullTextReferencesCsv = ['Title,Authors,Year,DOI', 'Study A,"Doe, Jane",2024,10.1000/alpha'].join('\n')

const assertOk = async <T>(response: Response, errorMessage: string): Promise<T> => {
  if (!response.ok) {
    throw new Error(`${errorMessage}: ${response.status} ${await response.text()}`)
  }

  return (await response.json()) as T
}

const getUnwrappedData = <T>(value: unknown): T | null => {
  if (!value || typeof value !== 'object') {
    return null
  }

  return 'data' in value ? getUnwrappedData<T>((value as {data?: unknown}).data) : (value as T)
}

const wait = async (ms: number) => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

const waitForSeededProject = async (apiBaseUrl: string, projectId: string) => {
  const attempts = Array.from({length: 20})

  for (const _attempt of attempts) {
    const response = await fetch(`${apiBaseUrl}/api/projects/${projectId}`)

    if (response.ok) {
      const payload = getUnwrappedData<{project?: {name?: string}; prompts?: unknown[]}>(await response.json())

      if (payload?.project?.name === seedTitle && Array.isArray(payload.prompts)) {
        return
      }
    }

    await wait(250)
  }

  throw new Error(`Seeded project ${projectId} was not readable in time`)
}

const createProviderConnection = async (apiBaseUrl: string) => {
  const response = await fetch(`${apiBaseUrl}/api/provider-connections`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({
      baseURL: 'http://127.0.0.1:1234/v1',
      label: 'Playwright LM Studio',
      providerKind: 'llmstudio',
    }),
  })
  const payload = await assertOk<ProviderConnectionCreateResponse>(response, 'Failed to create provider connection')

  return payload.data.connection.id
}

const createProviderModel = async (apiBaseUrl: string, connectionId: string) => {
  const response = await fetch(`${apiBaseUrl}/api/provider-connections/${connectionId}/models`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({displayName: 'Playwright Model', remoteModelId: 'playwright-model'}),
  })
  const payload = await assertOk<ProviderModelCreateResponse>(response, 'Failed to create provider model')

  return payload.data.modelId
}

const appendFileEntry = (
  formData: FormData,
  params: {content: string; fileName: string; fileRole: string; index: number},
) => {
  formData.append(`files[${params.index}].file`, new Blob([params.content], {type: 'text/csv'}), params.fileName)
  formData.append(`files[${params.index}].fileRole`, params.fileRole)
  return formData
}

const createCovidenceProject = async (apiBaseUrl: string, modelId: string) => {
  const formData = appendFileEntry(new FormData(), {
    content: allReferencesCsv,
    fileName: 'all.csv',
    fileRole: 'all',
    index: 0,
  })

  appendFileEntry(formData, {
    content: irrelevantReferencesCsv,
    fileName: 'irrelevant.csv',
    fileRole: 'irrelevant',
    index: 1,
  })

  appendFileEntry(formData, {
    content: fullTextReferencesCsv,
    fileName: 'full_text.csv',
    fileRole: 'full_text',
    index: 2,
  })

  formData.append('answerSet', 'yes|no|maybe')
  formData.append('mode', 'title_abstract')
  formData.append('modelId', modelId)
  formData.append('title', seedTitle)
  formData.append('description', 'Seeded for Playwright smoke coverage')
  formData.append('eligibilityFields[0].disposition', 'include')
  formData.append('eligibilityFields[0].sectionKey', 'population')
  formData.append('eligibilityFields[0].sectionLabel', 'Population')
  formData.append('eligibilityFields[0].text', 'Adults with chronic conditions')

  const response = await fetch(`${apiBaseUrl}/api/datasources/import/covidence-create`, {
    method: 'POST',
    body: formData,
  })
  const payload = await assertOk<CovidenceCreateResponse>(response, 'Failed to seed Covidence project')

  return payload.data
}

const cleanupCovidenceAssets = (dataSourceId: string) => {
  rmSync(path.resolve(process.cwd(), 'assets/covidence_imports', dataSourceId), {force: true, recursive: true})
}

export const seedProjectEditFromCovidence = async (apiBaseUrl: string): Promise<SeededProject> => {
  const connectionId = await createProviderConnection(apiBaseUrl)
  const modelId = await createProviderModel(apiBaseUrl, connectionId)
  const payload = await createCovidenceProject(apiBaseUrl, modelId)
  const projectId = payload.covidenceProject?.id

  if (!projectId) {
    throw new Error('Covidence project seed did not return a project id')
  }

  await waitForSeededProject(apiBaseUrl, projectId)

  cleanupCovidenceAssets(payload.dataSource.id)

  return {projectId}
}
