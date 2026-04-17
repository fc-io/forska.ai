import {expect, test} from '@playwright/test'

import {routeErrorSurfaceTestId} from '../../src/app/routerErrorSurface'
import {createBrowserFailureAssertions} from '../../src/app/utils/browserFailureAssertions'

import {createPlaywrightProviderModel} from './covidenceImportFixtures'

type ProjectCreateResponse = {data: {id: string}}

const apiBaseUrl = 'http://127.0.0.1:43101'

const assertOk = async <T>(response: Response, errorMessage: string): Promise<T> => {
  if (!response.ok) {
    throw new Error(`${errorMessage}: ${response.status} ${await response.text()}`)
  }

  return (await response.json()) as T
}

const createProject = async (modelId: string) => {
  const response = await fetch(`${apiBaseUrl}/api/projects`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({
      modelId,
      name: 'Playwright Clone Source Project',
      prompts: ['Is this about adults with chronic conditions?'],
    }),
  })

  return assertOk<ProjectCreateResponse>(response, 'Failed to create source project')
}

test('cloned project edit page renders without browser failures', async ({page}) => {
  const browserFailures = createBrowserFailureAssertions(page)

  try {
    const modelId = await createPlaywrightProviderModel(apiBaseUrl)
    await createProject(modelId)

    await page.goto('/projects')

    const sourceProjectCard = page.locator('li').filter({hasText: 'Playwright Clone Source Project'}).first()

    await expect(sourceProjectCard).toBeVisible()
    await sourceProjectCard.getByRole('button', {name: 'Clone Project'}).click()

    const clonedProjectCard = page.locator('li').filter({hasText: 'Playwright Clone Source Project - Copy'}).first()

    await expect(clonedProjectCard).toBeVisible()
    await expect(page).toHaveURL(/\/projects\/?$/)
    await Promise.all([
      page.waitForURL(/\/projects\/.+\/edit$/),
      clonedProjectCard.getByRole('button', {name: 'Edit'}).click(),
    ])

    await expect(page.getByRole('heading', {name: 'Edit Project'})).toBeVisible()
    await expect(page.getByTestId(routeErrorSurfaceTestId)).toHaveCount(0)
    await expect(page.locator('#project-name')).toHaveValue('Playwright Clone Source Project - Copy')
    await expect(page.locator('#model')).toBeVisible()

    browserFailures.assertNoFailures()
  } finally {
    browserFailures.dispose()
  }
})
