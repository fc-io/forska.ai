import {expect, test} from 'bun:test'

import {
  getProjectVisibleJudgmentNaturalKeySql,
  getProjectVisibleJudgmentScopeSql,
} from './projectVisibleJudgmentRule.ts'

test('project visible judgment natural key matches the project system prompt variant with legacy as default', () => {
  const sql = getProjectVisibleJudgmentNaturalKeySql({judgmentAlias: 'j', projectAlias: 'project'})

  expect(sql).toContain('j.use_fulltext_no_images = project.use_fulltext_no_images')
  expect(sql).toContain("j.system_prompt_variant = COALESCE(project.system_prompt_variant, 'legacy')")
})

test('project visible judgment scope carries the system prompt variant match', () => {
  const sql = getProjectVisibleJudgmentScopeSql({
    judgmentAlias: 'imported_judgment',
    projectAlias: 'p',
    projectPromptAlias: 'pp',
    projectScopeAlias: 'scope',
  })

  expect(sql).toContain("imported_judgment.system_prompt_variant = COALESCE(p.system_prompt_variant, 'legacy')")
})

test('project visible judgment natural key matches the project metadata flag with false as default', () => {
  const sql = getProjectVisibleJudgmentNaturalKeySql({judgmentAlias: 'j', projectAlias: 'project'})

  expect(sql).toContain('j.use_metadata = COALESCE(project.use_metadata, FALSE)')
})

test('project visible judgment scope carries the metadata flag match', () => {
  const sql = getProjectVisibleJudgmentScopeSql({
    judgmentAlias: 'imported_judgment',
    projectAlias: 'p',
    projectPromptAlias: 'pp',
    projectScopeAlias: 'scope',
  })

  expect(sql).toContain('imported_judgment.use_metadata = COALESCE(p.use_metadata, FALSE)')
})
