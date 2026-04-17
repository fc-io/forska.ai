type ProjectVisibleJudgmentNaturalKeySqlParams = {judgmentAlias: string; projectAlias: string}

type ProjectVisibleJudgmentPromptSqlParams = ProjectVisibleJudgmentNaturalKeySqlParams & {projectPromptAlias: string}

type ProjectVisibleJudgmentScopeSqlParams = ProjectVisibleJudgmentPromptSqlParams & {projectScopeAlias: string}

export const getProjectVisibleJudgmentNaturalKeySql = ({
  judgmentAlias,
  projectAlias,
}: ProjectVisibleJudgmentNaturalKeySqlParams) => {
  return `(
    (${projectAlias}.model_id IS NULL OR ${judgmentAlias}.model_id = ${projectAlias}.model_id)
    AND ${judgmentAlias}.use_title = ${projectAlias}.use_title
    AND ${judgmentAlias}.use_abstract = ${projectAlias}.use_abstract
    AND ${judgmentAlias}.use_fulltext = ${projectAlias}.use_fulltext
    AND ${judgmentAlias}.use_fulltext_no_images = ${projectAlias}.use_fulltext_no_images
  )`
}

export const getProjectVisibleJudgmentPromptSql = ({
  judgmentAlias,
  projectAlias,
  projectPromptAlias,
}: ProjectVisibleJudgmentPromptSqlParams) => {
  return `(
    ${projectPromptAlias}.project_id = ${projectAlias}.id
    AND ${projectPromptAlias}.enabled = TRUE
    AND ${judgmentAlias}.prompt_id = ${projectPromptAlias}.prompt_id
    AND ${getProjectVisibleJudgmentNaturalKeySql({judgmentAlias, projectAlias})}
  )`
}

export const getProjectVisibleJudgmentScopeSql = ({
  judgmentAlias,
  projectAlias,
  projectPromptAlias,
  projectScopeAlias,
}: ProjectVisibleJudgmentScopeSqlParams) => {
  return `(
    ${projectScopeAlias}.project_id = ${projectAlias}.id
    AND ${judgmentAlias}.article_id = ${projectScopeAlias}.article_id
    AND ${getProjectVisibleJudgmentPromptSql({judgmentAlias, projectAlias, projectPromptAlias})}
  )`
}
