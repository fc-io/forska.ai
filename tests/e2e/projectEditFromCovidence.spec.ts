import {expect, test} from '@playwright/test'

import {routeErrorSurfaceTestId} from '../../src/app/routerErrorSurface'
import {createBrowserFailureAssertions} from '../../src/app/utils/browserFailureAssertions'

import {seedProjectEditFromCovidence} from './projectEditFromCovidenceSeed'

test('seeded Covidence project edit smoke renders edit controls without browser failures', async ({page}) => {
  const browserFailures = createBrowserFailureAssertions(page)

  try {
    const {projectId} = await seedProjectEditFromCovidence('http://127.0.0.1:43101')

    await page.goto(`/projects/${projectId}/edit`)

    await expect(page.getByRole('heading', {name: 'Edit Project'})).toBeVisible()
    await expect(page.getByTestId(routeErrorSurfaceTestId)).toHaveCount(0)
    await expect(page.locator('#project-name')).toHaveValue('Playwright Covidence Project')
    await expect(page.locator('#model')).toBeVisible()
    await expect(page.getByText('Import Routes')).toBeVisible()
    await expect(page.getByText('Playwright Covidence Project')).toBeVisible()
    await expect(page.getByText('Use Article Title')).toBeVisible()
    await expect(page.getByText('Your questions about the article')).toBeVisible()
    await expect(page.getByPlaceholder('Prompt 1 heading (optional)...')).toHaveValue('Population Inclusion')

    browserFailures.assertNoFailures()
  } finally {
    browserFailures.dispose()
  }
})
