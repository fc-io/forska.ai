export type AppQueryRunner = {queryJson: <T>(statement: string) => Promise<T[]>}
export type AppTx = AppQueryRunner & {run: (statement: string) => Promise<void>}
