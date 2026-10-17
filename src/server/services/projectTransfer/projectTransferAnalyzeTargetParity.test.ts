import {createHash} from 'node:crypto'
import {mkdtempSync, rmSync} from 'node:fs'
import {mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'

import {expect, test} from 'bun:test'

import {migrateDuckdb} from '../../../db/migrateDuckdb.ts'
import {computePromptContentHash} from '../../utils/computePromptContentHash.ts'
import {resetDuckdbServiceForTests} from '../../utils/duckdbService.ts'
import {resetServerRuntimeRoleForTests} from '../../utils/serverRuntimeRole.ts'
import {getAppDatabaseService} from '../appDatabaseService.ts'
import {getSqlLiteral} from '../appQueryHelpers.ts'
import {getProjectTransferAnalyzeTargetPlanWithOperationTables} from './projectTransferAnalyzeTarget.ts'
import {
  getProjectTransferPayloadFixtureMap,
  type ProjectTransferPayloadByKey,
  serializeProjectTransferPayload,
} from './projectTransferPayloadSchemas.ts'
import {projectTransferPayloadPathByKey} from './projectTransferSchemas.ts'
import {getProjectTransferImportTempLayout} from './projectTransferSession.ts'
import {getProjectTransferImportStagingLayout} from './projectTransferStaging.ts'

const sharedAssetPath = 'assets/project-transfer/parity/shared.pdf'
const getSourceArticleId = (index: number) => {
  return `source-${String(index).padStart(3, '0')}`
}
const getDoi = (index: number) => {
  return `10.1000/parity-${index % 8 === 6 ? index - 1 : index}`
}
const getPmid = (index: number) => {
  return String(100000 + index)
}

const getFixtureEntry = <T>(entries: readonly T[], index = 0) => {
  const entry = entries[index]

  if (entry === undefined) {
    throw new Error(`Missing parity fixture entry ${index}`)
  }

  return entry
}

const getParityPayloads = (): ProjectTransferPayloadByKey => {
  const fixtures = getProjectTransferPayloadFixtureMap()
  const articles = Array.from({length: 320}, (_, index) => {
    return {
      ...getFixtureEntry(fixtures.articles),
      articleCreatedAt: '2024-01-01T00:00:00.000Z',
      articleId: `legacy-${index}`,
      articleSummary: `Abstract ${index}`,
      articleTitle: `Study ${index}`,
      arxivId: null,
      biorxivId: null,
      doi: `HTTPS://DOI.ORG/${getDoi(index)}`,
      fullTextPdf: sharedAssetPath,
      identifierInputs: [{inputKind: 'pmid' as const, source: 'article_identifier', value: getPmid(index)}],
      medrxivId: null,
      provenance: {sourceArticleId: getSourceArticleId(index)},
      pubmedId: `PMID:${getPmid(index)}`,
      signature: {...getFixtureEntry(fixtures.articles).signature, identifierKeys: [`doi:${getDoi(index)}` as const]},
      sourceArticleId: getSourceArticleId(index),
      url: `https://doi.org/${getDoi(index)}`,
      warnings: [],
    }
  })
  const prompts = Array.from({length: 8}, (_, index) => {
    return {
      ...getFixtureEntry(fixtures.prompts),
      originalText: `Eligibility criterion ${index % 6}?`,
      sourcePromptId: `prompt-${index}`,
    }
  })
  const importRoutes = ['active', 'inactive', 'missing'].map((name) => {
    return {...getFixtureEntry(fixtures.importRoutes), route: `parity-${name}`, sourceImportRouteId: `route-${name}`}
  })
  const judgments = articles.map((article, index) => {
    return {
      ...getFixtureEntry(fixtures.judgments),
      sourceArticleId: article.sourceArticleId,
      sourceJudgmentId: `judgment-${index}`,
      sourcePromptId: `prompt-${index % 8}`,
    }
  })
  const humanJudgments = articles.map((article, index) => {
    return {
      ...getFixtureEntry(fixtures.humanJudgments),
      sourceArticleId: article.sourceArticleId,
      sourceHumanJudgmentId: `human-${index}`,
      sourcePromptId: `prompt-${index % 8}`,
    }
  })

  return {
    ...fixtures,
    articleImportRoutes: articles.map((article, index) => {
      return {
        ...getFixtureEntry(fixtures.articleImportRoutes),
        sourceArticleId: article.sourceArticleId,
        sourceArticleImportRouteId: `article-route-${index}`,
        sourceImportRouteId: getFixtureEntry(importRoutes, index % 3).sourceImportRouteId,
      }
    }),
    articles,
    assetManifest: {
      entries: [11, 12].map((byteLength) => {
        return {
          ...getFixtureEntry(fixtures.assetManifest.entries),
          byteLength,
          packagePath: sharedAssetPath,
          references: [],
        }
      }),
    },
    humanJudgmentSummaries: [],
    humanJudgments: [...humanJudgments, {...getFixtureEntry(humanJudgments), sourceHumanJudgmentId: 'human-duplicate'}],
    importRoutes,
    judgmentAssessments: judgments.map((judgment, index) => {
      return {
        ...getFixtureEntry(fixtures.judgmentAssessments),
        sourceJudgmentAssessmentId: `assessment-${index}`,
        sourceJudgmentId: judgment.sourceJudgmentId,
      }
    }),
    judgments: [...judgments, {...getFixtureEntry(judgments), sourceJudgmentId: 'judgment-duplicate'}],
    projectArticles: articles.map((article, index) => {
      return {
        ...getFixtureEntry(fixtures.projectArticles),
        sourceArticleId: article.sourceArticleId,
        sourceProjectArticleId: `project-article-${index}`,
      }
    }),
    projectImportRoutes: importRoutes.map((route, index) => {
      return {
        ...getFixtureEntry(fixtures.projectImportRoutes),
        sourceImportRouteId: route.sourceImportRouteId,
        sourceProjectImportRouteId: `project-route-${index}`,
      }
    }),
    projectPrompts: prompts.map((prompt, index) => {
      return {
        ...getFixtureEntry(fixtures.projectPrompts),
        order: index,
        sourceProjectPromptId: `project-prompt-${index}`,
        sourcePromptId: prompt.sourcePromptId,
      }
    }),
    prompts,
    reviews: [],
  }
}

const seedParityTargets = async (database: ReturnType<typeof getAppDatabaseService>) => {
  const targetRows = Array.from({length: 320}, (_, index) => {
    return index
  }).flatMap((index) => {
    const kind = index % 8
    return kind >= 1 && kind <= 4
      ? Array.from({length: kind >= 3 ? 2 : 1}, (_, candidate) => {
          return {candidate, index}
        })
      : []
  })
  await database.run(`
    INSERT INTO app.article (id, article_id, article_title, article_created_at)
    VALUES ${targetRows
      .map(({candidate, index}) => {
        const legacyId =
          candidate === 0 && (index % 8 === 1 || index % 8 === 3)
            ? `legacy-${index}`
            : `target-legacy-${index}-${candidate}`
        return `('target-${index}-${candidate}', '${legacyId}', 'Target ${index}', '2024-01-01T00:00:00.000Z')`
      })
      .join(',')}
  `)
  await database.run(`
    INSERT INTO app.article_identifier (id, article_id, kind, normalized_value, source)
    VALUES ${targetRows
      .flatMap(({candidate, index}) => {
        const identifiers =
          index % 8 === 3 && candidate === 0
            ? []
            : index % 8 === 4
              ? [candidate === 0 ? 'doi' : 'pmid']
              : ['doi', 'pmid']
        return identifiers.map((kind) => {
          const value = kind === 'doi' ? getDoi(index) : getPmid(index)
          return `('identifier-${index}-${candidate}-${kind}', 'target-${index}-${candidate}', '${kind}', '${value}', 'test')`
        })
      })
      .join(',')}
  `)
  const promptHash = computePromptContentHash('Eligibility criterion 0?', null, 'Eligibility', 'system')
  await database.run(`
    INSERT INTO app.prompt (id, original_text, prompt_heading, type, content_hash, archived)
    VALUES ('target-prompt-0', 'Eligibility criterion 0?', 'Eligibility', 'system', ${getSqlLiteral(promptHash)}, FALSE)
  `)
  await database.run(`
    INSERT INTO app.import_route (id, route, name, active)
    VALUES ('target-route-active', 'parity-active', 'Active', TRUE),
      ('target-route-inactive', 'parity-inactive', 'Inactive', FALSE)
  `)
  await database.run(`
    INSERT INTO app.provider_connection (id, provider_kind, label, enabled, auth_mode)
    VALUES ('target-provider', 'openai', 'Target Provider', TRUE, 'none')
  `)
  await database.run(`
    INSERT INTO app.model (id, provider_connection_id, name, remote_model_id, display_name, source, enabled)
    VALUES ('target-model', 'target-provider', 'target-model', 'target-model', 'Target Model', 'manual', TRUE)
  `)
  await database.run(`
    INSERT INTO app.project (id, name, model_id, archived)
    VALUES ('target-project', 'Existing project', 'target-model', FALSE)
  `)
  await database.run(`
    INSERT INTO app.project_import_route (id, project_id, import_route_id)
    VALUES ('target-project-route', 'target-project', 'target-route-active')
  `)
  await database.run(`
    INSERT INTO app.project_article (id, project_id, article_id)
    VALUES ('target-project-article', 'target-project', 'target-1-0')
  `)
  await database.run(`
    INSERT INTO app.article_import_route (id, article_id, import_route_id)
    VALUES ('target-article-route', 'target-1-0', 'target-route-active')
  `)
}

const checkParityWithDuckdb = async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'f2-project-transfer-target-parity-'))
  const previousEnv = {
    API_SERVER_PORT: process.env.API_SERVER_PORT,
    DUCKDB_PATH: process.env.DUCKDB_PATH,
    SERVER_ROLE: process.env.SERVER_ROLE,
    VITE_PORT: process.env.VITE_PORT,
  }
  process.env.API_SERVER_PORT = '3001'
  process.env.DUCKDB_PATH = join(cwd, 'parity.duckdb')
  process.env.SERVER_ROLE = 'dev-single'
  process.env.VITE_PORT = '3000'
  resetDuckdbServiceForTests()
  resetServerRuntimeRoleForTests()
  const database = getAppDatabaseService()

  try {
    await migrateDuckdb()
    await seedParityTargets(database)
    const payloads = getParityPayloads()
    const layout = getProjectTransferImportStagingLayout({
      layout: getProjectTransferImportTempLayout('target-parity-session'),
      stagingRevision: 1,
    })
    const routePath = join(cwd, layout.extractedPath, projectTransferPayloadPathByKey.importRoutes)
    await mkdir(dirname(routePath), {recursive: true})
    await globalThis.Bun.write(routePath, serializeProjectTransferPayload('importRoutes', payloads.importRoutes))
    const result = await getProjectTransferAnalyzeTargetPlanWithOperationTables({
      cwd,
      layout,
      operationId: 'target-parity',
      packageFingerprint: null,
      payloads,
    })

    expect(result.targetPlan.articleMatches).toHaveLength(320)
    expect(
      new Set(
        result.targetPlan.articleMatches.map((match) => {
          return match.action
        }),
      ),
    ).toEqual(new Set(['create', 'reuse', 'blocked']))
    expect(result.targetPlan.articleMatches[1]?.candidates[0]?.matchedIdentifiers).toHaveLength(3)
    expect(result.targetPlan.articleMatches[3]?.candidates).toHaveLength(2)
    expect(result.targetPlan.articleUpdatePlan).toHaveLength(80)
    expect(result.targetPlan.assetPromotionPlan[0]?.byteLength).toBe(12)
    expect(result.targetPlan.judgmentPlan).toHaveLength(321)
    expect(result.targetPlan.humanReviewPlan).toHaveLength(321)
    expect(createHash('sha256').update(JSON.stringify(result)).digest('hex')).toBe(
      'a84bedbfbe7f0e1be68806d98187bd2edbb07c32eb7b6c78f528513f5093f2dc',
    )
  } finally {
    await database.close()
    resetDuckdbServiceForTests()
    resetServerRuntimeRoleForTests()
    Object.entries(previousEnv).forEach(([key, value]) => {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    })
    rmSync(cwd, {force: true, recursive: true})
  }
  return {exitCode: 0}
}

const checkParityInIsolatedProcess = async () => {
  const child = globalThis.Bun.spawn([process.execPath, 'test', import.meta.path], {
    cwd: process.cwd(),
    env: {...process.env, FORSKA_TARGET_ANALYSIS_PARITY_CHILD: '1'},
    stderr: 'pipe',
    stdout: 'ignore',
  })
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])

  return {exitCode, stderr}
}

const checkParity =
  process.env.FORSKA_TARGET_ANALYSIS_PARITY_CHILD === '1' ? checkParityWithDuckdb : checkParityInIsolatedProcess

test('preserves the complete target-analysis JSON for mixed synthetic imports', async () => {
  expect(await checkParity()).toMatchObject({exitCode: 0})
}, 120_000)
