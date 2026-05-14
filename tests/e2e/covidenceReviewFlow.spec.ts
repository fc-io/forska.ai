import {expect, test} from '@playwright/test'

import {routeErrorSurfaceTestId} from '../../src/app/routerErrorSurface'
import {createBrowserFailureAssertions} from '../../src/app/utils/browserFailureAssertions'

import {
  cleanupNewCovidenceImportAssetDirectories,
  createPlaywrightProviderModel,
  getCovidenceImportAssetDirectories,
  playwrightCovidenceEligibilityField,
} from './covidenceImportFixtures'

type CovidenceCreateResponse = {data: {covidenceProject: {id: string} | null; dataSource: {id: string}}}

const apiBaseUrl = 'http://127.0.0.1:43101'

const duplicateStudyHref = 'https://example.test/duplicate-b'

const getCsvBlob = (content: string) => {
  return new Blob([content], {type: 'text/csv'})
}

const appendCovidenceCsv = (
  formData: FormData,
  params: {content: string; fileName: string; fileRole: 'all' | 'full_text' | 'irrelevant'; index: number},
) => {
  formData.append(`files[${params.index}].file`, getCsvBlob(params.content), params.fileName)
  formData.append(`files[${params.index}].fileRole`, params.fileRole)
  return formData
}

const assertOk = async <T>(response: Response, errorMessage: string): Promise<T> => {
  if (!response.ok) {
    throw new Error(`${errorMessage}: ${response.status} ${await response.text()}`)
  }

  return (await response.json()) as T
}

const getReviewFlowCsvPackage = () => {
  return {
    all: [
      'Title,Authors,Year,DOI,Covidence #,URL,Journal',
      'Duplicate Alpha,"Doe, Jane",2024,10.1000/playwright-duplicate,#1001,https://example.test/duplicate-a,Journal Alpha',
      'Duplicate Beta,"Doe, Jane",2024,10.1000/playwright-duplicate,#1002,https://example.test/duplicate-b,Journal Beta',
      'Unique Gamma,"Roe, Sam",2023,10.1000/playwright-unique,#2001,https://example.test/unique,Journal Gamma',
    ].join('\n'),
    fullText: [
      'Title,Authors,Year,DOI,Covidence #,URL,Journal',
      'Duplicate Beta,"Doe, Jane",2024,10.1000/playwright-duplicate,#1002,https://example.test/duplicate-b,Journal Beta',
      'Unique Gamma,"Roe, Sam",2023,10.1000/playwright-unique,#2001,https://example.test/unique,Journal Gamma',
    ].join('\n'),
    irrelevant: [
      'Title,Authors,Year,DOI,Covidence #,URL,Journal',
      'Duplicate Alpha,"Doe, Jane",2024,10.1000/playwright-duplicate,#1001,https://example.test/duplicate-a,Journal Alpha',
    ].join('\n'),
  }
}

const createCovidenceReviewFlowProject = async (projectTitle: string) => {
  const modelId = await createPlaywrightProviderModel(apiBaseUrl)
  const csvPackage = getReviewFlowCsvPackage()
  const formData = appendCovidenceCsv(new FormData(), {
    content: csvPackage.all,
    fileName: 'review-flow-all.csv',
    fileRole: 'all',
    index: 0,
  })

  appendCovidenceCsv(formData, {
    content: csvPackage.irrelevant,
    fileName: 'review-flow-irrelevant.csv',
    fileRole: 'irrelevant',
    index: 1,
  })
  appendCovidenceCsv(formData, {
    content: csvPackage.fullText,
    fileName: 'review-flow-full-text.csv',
    fileRole: 'full_text',
    index: 2,
  })

  formData.append('answerSet', 'yes|no|maybe')
  formData.append('mode', 'title_abstract')
  formData.append('modelId', modelId)
  formData.append('title', projectTitle)
  formData.append('description', 'Seeded for Covidence review flow verification')
  formData.append('eligibilityFields[0].disposition', playwrightCovidenceEligibilityField.disposition)
  formData.append('eligibilityFields[0].sectionKey', playwrightCovidenceEligibilityField.sectionKey)
  formData.append('eligibilityFields[0].sectionLabel', playwrightCovidenceEligibilityField.sectionLabel)
  formData.append('eligibilityFields[0].text', playwrightCovidenceEligibilityField.text)

  const response = await fetch(`${apiBaseUrl}/api/datasources/import/covidence-create`, {
    method: 'POST',
    body: formData,
  })
  const payload = await assertOk<CovidenceCreateResponse>(response, 'Failed to seed Covidence review flow project')
  const projectId = payload.data.covidenceProject?.id

  if (!projectId) {
    throw new Error('Covidence review flow seed did not return a project id')
  }

  return {dataSourceId: payload.data.dataSource.id, projectId}
}

test('Covidence review flow preserves scoped source ids, filters, related records, and PDF fetch', async ({page}) => {
  const browserFailures = createBrowserFailureAssertions(page)
  const existingAssetDirectories = getCovidenceImportAssetDirectories()
  const projectTitle = `Playwright Covidence Review Flow ${Date.now()}`

  try {
    const {dataSourceId, projectId} = await createCovidenceReviewFlowProject(projectTitle)
    const expectedExternalId = `covidence:${dataSourceId}:covidence%3A%231002`

    await page.goto(`/projects/${projectId}/reviews-human`)

    await expect(page.getByRole('heading', {name: 'Project Reviews'})).toBeVisible()
    await expect(page.getByTestId(routeErrorSurfaceTestId)).toHaveCount(0)
    await expect(page.getByText(projectTitle)).toBeVisible()
    await expect(page.getByText('Articles with Overall Human Answers')).toBeVisible()
    await expect(page.getByRole('link', {name: expectedExternalId})).toHaveAttribute('href', duplicateStudyHref)
    await expect(page.getByRole('link', {name: `covidence:${dataSourceId}:covidence%3A%232001`})).toBeVisible()

    await page.getByLabel('Covidence duplicates only').check()

    await expect(page).toHaveURL(/covidenceDuplicates=1/)
    await expect(page.getByText('Duplicate x2')).toBeVisible()
    await expect(page.getByRole('link', {name: expectedExternalId})).toBeVisible()
    await expect(page.getByRole('link', {name: `covidence:${dataSourceId}:covidence%3A%232001`})).toHaveCount(0)

    const duplicateRow = page.locator('tbody tr', {hasText: expectedExternalId})
    await expect(duplicateRow).toHaveCount(1)
    await duplicateRow.locator('input[type="checkbox"]').check()
    await page.getByRole('button', {name: 'Download PDFs for selected'}).click()
    await expect(page.getByText('PDF fetch job started:')).toBeVisible()

    await duplicateRow.getByRole('link', {name: /Duplicate (Alpha|Beta)/}).click()

    await expect(page.getByRole('heading', {name: 'Article Details'})).toBeVisible()
    await expect(page.getByText('Covidence duplicate study group')).toBeVisible()
    await expect(page.getByText('2 records share the same study identity in this import.')).toBeVisible()
    await expect(page.getByText('Covidence: #1001')).toBeVisible()
    await expect(page.getByText('Covidence: #1002')).toBeVisible()
    await expect(page.getByText('Stages: Irrelevant')).toBeVisible()
    await expect(page.getByText('Stages: Select')).toBeVisible()
    await expect(page.getByRole('link', {name: expectedExternalId})).toHaveAttribute('href', duplicateStudyHref)

    browserFailures.assertNoFailures()
  } finally {
    cleanupNewCovidenceImportAssetDirectories(existingAssetDirectories)
    browserFailures.dispose()
  }
})
