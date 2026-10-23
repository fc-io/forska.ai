export type PromptMergeTransaction = {
  queryJson: <TRow>(statement: string) => Promise<TRow[]>
  run: (statement: string) => Promise<void>
}
