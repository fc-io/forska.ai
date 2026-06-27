import {expect, test} from '@playwright/test'

import {routeErrorSurfaceTestId} from '../../src/app/routerErrorSurface'
import {createBrowserFailureAssertions} from '../../src/app/utils/browserFailureAssertions'

import {seedProjectEditFromCovidence} from './projectEditFromCovidenceSeed'

test('seeded Covidence project edit smoke renders edit controls without browser failures', async ({page}) => {
  const browserFailures = createBrowserFailureAssertions(page)

  try {
    const {projectId} = await seedProjectEditFromCovidence('http://127.0.0.1:43101')

    await page.goto(`/projects/${projectId}/edit`)

    const editForm = page.locator('form')

    await expect(page.getByRole('heading', {name: 'Edit Project'})).toBeVisible()
    await expect(page.getByTestId(routeErrorSurfaceTestId)).toHaveCount(0)
    await expect(editForm.locator('#project-name')).toHaveValue('Playwright Covidence Project')
    await expect(editForm.locator('#model')).toBeVisible()
    await expect(editForm.getByText('Import Routes')).toBeVisible()
    await expect(editForm.getByLabel('Project Name *')).toHaveValue('Playwright Covidence Project')
    await expect(editForm.getByText('Use Article Title')).toBeVisible()
    await expect(editForm.getByText('Your questions about the article')).toBeVisible()
    await expect(editForm.getByPlaceholder('Prompt 1 heading (optional)...')).toHaveValue('Population Inclusion')

    browserFailures.assertNoFailures()
  } finally {
    browserFailures.dispose()
  }
})
