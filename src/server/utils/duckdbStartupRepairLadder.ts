export const duckdbStartupRepairRungOrder = ['secondary-indexes', 'table-rebuild', 'all-secondary-indexes'] as const

export type DuckdbStartupRepairRung = (typeof duckdbStartupRepairRungOrder)[number]
export type DuckdbStartupRepairRungs = Record<string, DuckdbStartupRepairRung>
export type DuckdbStartupRepairLadderTable = {dependencyTableKeys: string[]; tableKey: string}

const getDuckdbStartupRepairRungIndex = (rung: DuckdbStartupRepairRung) => {
  return duckdbStartupRepairRungOrder.indexOf(rung)
}

const getDuckdbStartupRepairDependencyRung = (
  rungs: DuckdbStartupRepairRungs,
  dependencyTableKey: string,
): DuckdbStartupRepairRung => {
  const dependencyRung = rungs[dependencyTableKey] ?? 'secondary-indexes'

  return getDuckdbStartupRepairRungIndex(dependencyRung) < getDuckdbStartupRepairRungIndex('table-rebuild')
    ? 'table-rebuild'
    : dependencyRung
}

const getDuckdbStartupRepairRungsWithDependencies = (
  tables: DuckdbStartupRepairLadderTable[],
  rungs: DuckdbStartupRepairRungs,
): DuckdbStartupRepairRungs => {
  return tables
    .filter((table) => {
      return rungs[table.tableKey] === 'table-rebuild'
    })
    .flatMap((table) => {
      return table.dependencyTableKeys
    })
    .filter((dependencyTableKey) => {
      return dependencyTableKey in rungs
    })
    .reduce<DuckdbStartupRepairRungs>(
      (nextRungs, dependencyTableKey) => {
        return {...nextRungs, [dependencyTableKey]: getDuckdbStartupRepairDependencyRung(nextRungs, dependencyTableKey)}
      },
      {...rungs},
    )
}

export const getDuckdbStartupRepairFirstRung = (failurePhase: string | null): DuckdbStartupRepairRung => {
  return failurePhase === 'inline-primary-key-repair' ? 'table-rebuild' : 'secondary-indexes'
}

export const getInitialDuckdbStartupRepairRungs = (
  tables: DuckdbStartupRepairLadderTable[],
  firstRung: DuckdbStartupRepairRung,
): DuckdbStartupRepairRungs => {
  const rungs = Object.fromEntries(
    tables.map((table) => {
      return [table.tableKey, firstRung]
    }),
  )

  return getDuckdbStartupRepairRungsWithDependencies(tables, rungs)
}

type DuckdbStartupRepairRungEscalation = {nextRung: DuckdbStartupRepairRung | null; tableKey: string}

const getNextDuckdbStartupRepairRung = (rung: DuckdbStartupRepairRung) => {
  return duckdbStartupRepairRungOrder[getDuckdbStartupRepairRungIndex(rung) + 1] ?? null
}

const getEscalatedDuckdbStartupRepairTableKeys = (rungs: DuckdbStartupRepairRungs, failedTableKeys: string[]) => {
  const knownFailedTableKeys = failedTableKeys.filter((tableKey) => {
    return tableKey in rungs
  })

  return knownFailedTableKeys.length > 0 ? knownFailedTableKeys : Object.keys(rungs)
}

const applyDuckdbStartupRepairRungEscalations = (
  rungs: DuckdbStartupRepairRungs,
  escalations: DuckdbStartupRepairRungEscalation[],
) => {
  return escalations.reduce<DuckdbStartupRepairRungs>(
    (nextRungs, escalation) => {
      return escalation.nextRung === null ? nextRungs : {...nextRungs, [escalation.tableKey]: escalation.nextRung}
    },
    {...rungs},
  )
}

export const getEscalatedDuckdbStartupRepairRungs = (
  tables: DuckdbStartupRepairLadderTable[],
  rungs: DuckdbStartupRepairRungs,
  failedTableKeys: string[],
): DuckdbStartupRepairRungs | null => {
  const escalations = getEscalatedDuckdbStartupRepairTableKeys(rungs, failedTableKeys).map((tableKey) => {
    return {nextRung: getNextDuckdbStartupRepairRung(rungs[tableKey] ?? 'secondary-indexes'), tableKey}
  })
  const isLadderExhausted = escalations.some((escalation) => {
    return escalation.nextRung === null
  })

  return isLadderExhausted
    ? null
    : getDuckdbStartupRepairRungsWithDependencies(tables, applyDuckdbStartupRepairRungEscalations(rungs, escalations))
}
