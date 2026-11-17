import {createFileRoute} from '@tanstack/solid-router'

import {CreateCompareJudgmentsFromProjectPage} from './createCompareJudgmentsFromProjectPage.tsx'

export const Route = createFileRoute('/compare-judgments/create-from-project')({
  component: CreateCompareJudgmentsFromProjectPage,
})
