import {Elysia} from 'elysia'

import {adminInvestigateRoutes} from './AdminInvestigateRoutes.ts'
import {articleAdminRoutes} from './ArticleAdminRoutes.ts'
import {articlesRoutes} from './ArticlesRoutes.ts'
import {comparisonProjectsRoutes} from './ComparisonProjectsRoutes.ts'
import {dataSourcesImportRoutes} from './DataSourcesImportRoutes.ts'
import {dataSourcesRoutes} from './DataSourcesRoutes.ts'
import {duckdbStudioRoutes} from './DuckdbStudioRoutes.ts'
import {humanAssessmentRoutes} from './HumanAssessmentRoutes.ts'
import {importRoutes} from './ImportRoutes.ts'
import {judgmentsJobsRoutes} from './JudgmentsJobsRoutes.ts'
import {judgmentWorkflowTopologyTestRoutes} from './judgmentWorkflowTopologyTestRoutes.ts'
import {llmStatusRoutes} from './LlmStatusRoutes.ts'
import {modelsRoutes} from './ModelsRoutes.ts'
import {nvidiaSmiRoutes} from './NvidiaSmiRoutes.ts'
import {projectArticlesRoutes} from './ProjectArticlesRoutes.ts'
import {projectExportRoutes} from './ProjectExportRoutes.ts'
import {projectsAddArticlesRoutes} from './ProjectsAddArticlesRoutes.ts'
import {projectsRoutes} from './ProjectsRoutes.ts'
import {projectTransferRoutes} from './projectTransferRoutes.ts'
import {promptsRoutes} from './PromptsRoutes.ts'
import {providerAdmissionLeaseRoutes} from './providerAdmissionLeaseRoutes.ts'
import {runtimeAssetsRoutes} from './RuntimeAssetsRoutes.ts'
import {subprojectsRoutes} from './SubprojectsRoutes.ts'
import {tokensRoutes} from './TokensRoutes'
import {usersRoutes} from './UsersRoutes'

export const getProductApiRoutes = () => {
  const topologyTestRoutes =
    process.env.NODE_ENV === 'test' && process.env.FORSKA_TEST_JUDGMENT_TOPOLOGY_SEED_TOKEN
      ? judgmentWorkflowTopologyTestRoutes
      : new Elysia()

  return new Elysia()
    .use(adminInvestigateRoutes)
    .use(comparisonProjectsRoutes)
    .use(judgmentsJobsRoutes)
    .use(topologyTestRoutes)
    .use(articlesRoutes)
    .use(articleAdminRoutes)
    .use(humanAssessmentRoutes)
    .use(modelsRoutes)
    .use(providerAdmissionLeaseRoutes)
    .use(projectTransferRoutes)
    .use(projectsRoutes)
    .use(projectExportRoutes)
    .use(projectsAddArticlesRoutes)
    .use(projectArticlesRoutes)
    .use(promptsRoutes)
    .use(runtimeAssetsRoutes)
    .use(importRoutes)
    .use(dataSourcesRoutes)
    .use(dataSourcesImportRoutes)
    .use(duckdbStudioRoutes)
    .use(tokensRoutes)
    .use(usersRoutes)
    .use(llmStatusRoutes)
    .use(nvidiaSmiRoutes)
    .use(subprojectsRoutes)
}
