import {createFileRoute} from '@tanstack/solid-router'

import {CompareProjectImportResolutionsPage} from './compareProjectImportResolutionsPage.tsx'

export const Route = createFileRoute('/compare-judgments/$id/import-resolutions')({
  component: CompareProjectImportResolutionsPage,
})
