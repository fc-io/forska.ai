import {readdirSync, readFileSync, rmSync} from 'node:fs'
import path from 'node:path'

type ProviderConnectionCreateResponse = {data: {connection: {id: string}}}
type ProviderModelCreateResponse = {data: {modelId: string}}

type CovidenceFixtureFileRole = 'all' | 'full_text' | 'irrelevant'

const covidenceImportsDirectoryPath = path.resolve(process.cwd(), 'assets/covidence_imports')

export const playwrightCovidenceProjectTitle = 'Playwright Covidence Project'
export const playwrightCovidenceProjectDescription = 'Seeded for Playwright smoke coverage'
export const playwrightCovidenceEligibilityField = {
  disposition: 'include',
  sectionKey: 'population',
  sectionLabel: 'Population',
  text: 'Adults with chronic conditions',
} as const
export const covidenceImportFixturePaths: Record<CovidenceFixtureFileRole, string> = {
  all: path.resolve(process.cwd(), 'tests/e2e/fixtures/covidenceImport/allReferences.csv'),
  full_text: path.resolve(process.cwd(), 'tests/e2e/fixtures/covidenceImport/fullTextReferences.csv'),
  irrelevant: path.resolve(process.cwd(), 'tests/e2e/fixtures/covidenceImport/irrelevantReferences.csv'),
}

const assertOk = async <T>(response: Response, errorMessage: string): Promise<T> => {
  if (!response.ok) {
    throw new Error(`${errorMessage}: ${response.status} ${await response.text()}`)
  }

  return (await response.json()) as T
}

export const appendCovidenceFixtureFileEntry = (
  formData: FormData,
  params: {fileName: string; fileRole: CovidenceFixtureFileRole; index: number},
) => {
  formData.append(
    `files[${params.index}].file`,
    new Blob([readFileSync(covidenceImportFixturePaths[params.fileRole], 'utf8')], {type: 'text/csv'}),
    params.fileName,
  )
  formData.append(`files[${params.index}].fileRole`, params.fileRole)
  return formData
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

export const createPlaywrightProviderModel = async (apiBaseUrl: string) => {
  const connectionId = await createProviderConnection(apiBaseUrl)
  return createProviderModel(apiBaseUrl, connectionId)
}

export const getCovidenceImportAssetDirectories = () => {
  try {
    return readdirSync(covidenceImportsDirectoryPath, {withFileTypes: true})
      .filter((entry) => {
        return entry.isDirectory()
      })
      .map((entry) => {
        return entry.name
      })
  } catch {
    return []
  }
}

export const cleanupNewCovidenceImportAssetDirectories = (previousDirectories: string[]) => {
  const previousDirectorySet = new Set(previousDirectories)

  getCovidenceImportAssetDirectories().forEach((directoryName) => {
    if (!previousDirectorySet.has(directoryName)) {
      rmSync(path.join(covidenceImportsDirectoryPath, directoryName), {force: true, recursive: true})
    }
  })
}
