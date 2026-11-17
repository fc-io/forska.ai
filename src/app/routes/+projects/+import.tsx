import {createFileRoute} from '@tanstack/solid-router'

import {ImportProjectWizard} from './importWizard/importProjectWizard.tsx'

const ImportProjectRoute = () => {
  return <ImportProjectWizard />
}

export const Route = createFileRoute('/projects/import')({component: ImportProjectRoute})
