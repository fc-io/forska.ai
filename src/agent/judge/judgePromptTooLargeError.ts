export class JudgePromptTooLargeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JudgePromptTooLargeError'
  }
}
