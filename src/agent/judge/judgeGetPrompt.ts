import type {getNewestArticlesToJudge} from '../../components/main/projectsGrid/projectsGridGetNewestArticlesToJudge.ts'
import {getShortId} from '../../utils/getShortId.ts'
// const getSortedArticle = (data: any) => {
//   const sortKey = (s: string) => {
//     return s.replace(/_(quote|explanation)$/, '')
//   }

//   const sortPriority = (s: string) => {
//     if (s.endsWith('_quote')) return 2
//     if (s.endsWith('_explanation')) return 1
//     return 0 // base comes first
//   }

//   const sort = (a: string, b: string) => {
//     const keyA = sortKey(a)
//     const keyB = sortKey(b)
//     if (keyA < keyB) return -1
//     if (keyA > keyB) return 1
//     return sortPriority(a) - sortPriority(b)
//   }

//   const judgedAsKeys = Object.keys(data)
//     .filter((key) => {
//       return key.indexOf('article_judged_as') > -1
//     })
//     .sort(sort)

//   return judgedAsKeys
// }

type PromptsType = Awaited<
  ReturnType<typeof getNewestArticlesToJudge>
>['prompts']

const getSections = (prompts: PromptsType): string => {
  return prompts.reduce((acc, key) => {
    const baseHeading =
      key.promptHeading ?? `${key.order}-${getShortId()}` ?? getShortId()

    return `Below will be a number of questions from the user for you to answer about the title and summary provided above.
### judged_as_${baseHeading}

output_key: ${baseHeading}-questions
questions: ${key.originalText}
output_type:


    `
    //       `## ${key.promptHeading}

    // Provide the reason why you judged it that way.

    // `
    //       }
    //       if (key.promptHeading?.indexOf('quote') > -1) {
    //         return `## ${key.promptHeading}

    // Provide verbatim quotes (a maximum of 3 quotes) that highlight the reasoning behind your explanation. Only do this if the explanation tries to make case for why it judged that the topic was in the info.

    // `
    //       }
    //       const topicName =
    //         key.promptHeading
    //           ?.split('article_judged_as_')[1]
    //           ?.split('_')
    //           .filter((part) => {
    //             return part !== '_'
    //           })
    //           .join(' ') ?? 'unknown topic'
    //       return `## ${key.promptHeading}

    // Judge if the article is about "${topicName}". Can you find out anything about this from the provided title or summary.

    // `
    //       }
    return acc
  }, '')
}

type ArticleType = Awaited<
  ReturnType<typeof getNewestArticlesToJudge>
>['articles'][number]

export const judgeGetPrompt = (
  data: ArticleType,
  prompts: PromptsType,
): string => {
  // const prompts = getSortedArticle(data)
  const sections = getSections(prompts)

  return `# id: ${data.articleId}

## article_title
${data.articleTitle}

## article_summary
${data.articleSummary}

${sections}`
}
