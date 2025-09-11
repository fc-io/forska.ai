import type {JudgmentResultType} from './judgeParseJudgment'

// Helper to colorize judgment values
const colorizeJudgment = (value: string): string => {
  switch (value) {
    case 'yes':
      return `\x1b[32m${value}\x1b[0m` // Green
    case 'no':
      return `\x1b[31m${value}\x1b[0m` // Red
    case 'undecided':
      return `\x1b[33m${value}\x1b[0m` // Orange
    case 'unsure':
      return `\x1b[34m${value}\x1b[0m` // Blue
    default:
      return value // No color for other values
  }
}

// Helper to colorize the entire log message based on judgment values
const colorizeLogMessage = (message: string, judgment: JudgmentResultType): string => {
  const {article_judged_as_ai, article_judged_as_ai_agent, article_judged_as_healthcare} = judgment
  const judgments = [article_judged_as_ai, article_judged_as_ai_agent, article_judged_as_healthcare]

  const allYes = judgments.every((j) => {
    return j === 'yes'
  })
  const someUnsureRestYes =
    judgments.some((j) => {
      return j === 'unsure'
    })
    && judgments.every((j) => {
      return j === 'yes' || j === 'unsure'
    })

  if (allYes) {
    return `\x1b[42m${message}\x1b[0m` // Background Green
  }
  if (someUnsureRestYes) {
    return `\x1b[44m${message}\x1b[0m` // Background Blue
  }
  return message
}

export {colorizeJudgment, colorizeLogMessage}
