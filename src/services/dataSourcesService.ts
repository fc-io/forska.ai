import {apiClient} from './apiClient.ts'

export interface AdminDataSource {
  id: string
  title: string
  description: string | null
  createdAt: string
  updatedAt: string
  lastImportAt: string | null
  itemsAfterLastImport: number
  importRoute: string | null
  ownerId: string
  ownerName: string | null
  ownerEmail: string | null
  accessCount: number
}

export interface AdminDataSourceDetail {
  id: string
  title: string
  description: string | null
  importRoute: string | null
  lastImportAt: string | null
  itemsAfterLastImport: number
  createdAt: string
  updatedAt: string
}

export const fetchDataSources = async (): Promise<AdminDataSource[]> => {
  try {
    const response = await apiClient.api.datasources.get()

    if (response.error) {
      console.error('Error fetching data sources:', response.error)
      throw new Error('Failed to fetch data sources')
    }

    const entries = response.data?.data ?? []

    return entries.map((entry) => {
      return {
        id: entry.id,
        title: entry.title,
        description: entry.description ?? null,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        ownerId: entry.ownerId,
        ownerName: entry.ownerName ?? null,
        ownerEmail: entry.ownerEmail ?? null,
        accessCount: entry.accessCount ?? 0,
        lastImportAt: entry.lastImportAt ?? null,
        itemsAfterLastImport: entry.itemsAfterLastImport ?? 0,
        importRoute: entry.importRoute ?? null,
      }
    })
  } catch (err) {
    console.error('Error fetching data sources:', err)
    throw err
  }
}

export const fetchDataSourceById = async (id: string): Promise<AdminDataSourceDetail> => {
  const response = await apiClient.api.datasources({id}).get()

  if (response.error) {
    console.error('Error fetching data source:', response.error)
    throw new Error('Failed to fetch data source')
  }

  if (!response.data?.data) {
    throw new Error('Data source not found')
  }

  const entry = response.data.data

  return {
    id: entry.id,
    title: entry.title,
    description: entry.description ?? null,
    importRoute: entry.importRoute ?? null,
    lastImportAt: entry.lastImportAt ?? null,
    itemsAfterLastImport: entry.itemsAfterLastImport ?? 0,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  }
}

export const updateDataSource = async (
  id: string,
  payload: Partial<{title: string; description: string | null; importRoute: string | null}>,
): Promise<AdminDataSourceDetail> => {
  const response = await apiClient.api.datasources({id}).patch(payload)

  if (response.error) {
    console.error('Error updating data source:', response.error)
    throw new Error('Failed to update data source')
  }

  if (!response.data?.data) {
    throw new Error('Data source update failed')
  }

  const entry = response.data.data

  return {
    id: entry.id,
    title: entry.title,
    description: entry.description ?? null,
    importRoute: entry.importRoute ?? null,
    lastImportAt: entry.lastImportAt ?? null,
    itemsAfterLastImport: entry.itemsAfterLastImport ?? 0,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  }
}
