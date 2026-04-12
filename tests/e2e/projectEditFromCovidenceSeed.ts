import {rmSync} from 'node:fs'
import path from 'node:path'

import {
  appendCovidenceFixtureFileEntry,
  createPlaywrightProviderModel,
  playwrightCovidenceEligibilityField,
  playwrightCovidenceProjectDescription,
  playwrightCovidenceProjectTitle,
} from './covidenceImportFixtures'

type SeededProject = {projectId: string}

type CovidenceCreateResponse = {data: {covidenceProject: {id: string} | null; dataSource: {id: string}}}

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

      if (payload?.project?.name === playwrightCovidenceProjectTitle && Array.isArray(payload.prompts)) {
        return
      }
    }

    await wait(250)
  }

  throw new Error(`Seeded project ${projectId} was not readable in time`)
}

const createCovidenceProject = async (apiBaseUrl: string, modelId: string) => {
  const formData = appendCovidenceFixtureFileEntry(new FormData(), {fileName: 'all.csv', fileRole: 'all', index: 0})

  appendCovidenceFixtureFileEntry(formData, {fileName: 'irrelevant.csv', fileRole: 'irrelevant', index: 1})

  appendCovidenceFixtureFileEntry(formData, {fileName: 'full_text.csv', fileRole: 'full_text', index: 2})

  formData.append('answerSet', 'yes|no|maybe')
  formData.append('mode', 'title_abstract')
  formData.append('modelId', modelId)
  formData.append('title', playwrightCovidenceProjectTitle)
  formData.append('description', playwrightCovidenceProjectDescription)
  formData.append('eligibilityFields[0].disposition', playwrightCovidenceEligibilityField.disposition)
  formData.append('eligibilityFields[0].sectionKey', playwrightCovidenceEligibilityField.sectionKey)
  formData.append('eligibilityFields[0].sectionLabel', playwrightCovidenceEligibilityField.sectionLabel)
  formData.append('eligibilityFields[0].text', playwrightCovidenceEligibilityField.text)

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
  const modelId = await createPlaywrightProviderModel(apiBaseUrl)
  const payload = await createCovidenceProject(apiBaseUrl, modelId)
  const projectId = payload.covidenceProject?.id

  if (!projectId) {
    throw new Error('Covidence project seed did not return a project id')
  }

  await waitForSeededProject(apiBaseUrl, projectId)

  cleanupCovidenceAssets(payload.dataSource.id)

  return {projectId}
}
