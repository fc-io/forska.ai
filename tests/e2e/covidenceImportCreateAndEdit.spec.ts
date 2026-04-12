import {expect, test} from '@playwright/test'

import {routeErrorSurfaceTestId} from '../../src/app/routerErrorSurface'
import {createBrowserFailureAssertions} from '../../src/app/utils/browserFailureAssertions'

import {
  cleanupNewCovidenceImportAssetDirectories,
  covidenceImportFixturePaths,
  createPlaywrightProviderModel,
  getCovidenceImportAssetDirectories,
  playwrightCovidenceEligibilityField,
  playwrightCovidenceProjectTitle,
} from './covidenceImportFixtures'

const apiBaseUrl = 'http://127.0.0.1:43101'

test('Covidence import create flow redirects to edit page without browser failures', async ({page}) => {
  const browserFailures = createBrowserFailureAssertions(page)
  const existingAssetDirectories = getCovidenceImportAssetDirectories()

  try {
    await createPlaywrightProviderModel(apiBaseUrl)

    await page.goto('/admin/datasources/covidence-import')

    await expect(page.getByRole('heading', {name: 'Covidence multi-file import'})).toBeVisible()
    await expect(page.getByTestId(routeErrorSurfaceTestId)).toHaveCount(0)

    await page.getByLabel('Project name').fill(playwrightCovidenceProjectTitle)
    await page.getByPlaceholder('Include population criteria').fill(playwrightCovidenceEligibilityField.text)

    await page
      .locator('label:has(input[type="file"]):has-text("Title and abstract screening") input[type="file"]')
      .setInputFiles(covidenceImportFixturePaths.all)
    await page
      .locator('label:has(input[type="file"]):has-text("Irrelevant") input[type="file"]')
      .setInputFiles(covidenceImportFixturePaths.irrelevant)
    await page
      .locator('label:has(input[type="file"]):has-text("Full text review") input[type="file"]')
      .setInputFiles(covidenceImportFixturePaths.full_text)

    await page.getByRole('button', {name: 'Analyze package'}).click()

    await expect(page.getByText('Preview ready')).toBeVisible()
    await expect(page.getByText('No warnings')).toBeVisible()

    await Promise.all([
      page.waitForURL(/\/projects\/[^/]+\/edit$/),
      page.getByRole('button', {name: 'Create datasource and project'}).click(),
    ])

    await expect(page.getByRole('heading', {name: 'Edit Project'})).toBeVisible()
    await expect(page.getByTestId(routeErrorSurfaceTestId)).toHaveCount(0)
    await expect(page.locator('#project-name')).toHaveValue(playwrightCovidenceProjectTitle)
    await expect(page.getByText('Import Routes')).toBeVisible()
    await expect(page.getByText('Use Article Title')).toBeVisible()
    await expect(page.getByText('Importable prompts')).toBeVisible()

    browserFailures.assertNoFailures()
  } finally {
    cleanupNewCovidenceImportAssetDirectories(existingAssetDirectories)
    browserFailures.dispose()
  }
})
