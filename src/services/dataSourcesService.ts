import {apiClient} from './apiClient.ts'

export interface AdminDataSource {
  id: string
  title: string
  description: string | null
  createdAt: string
  updatedAt: string
  ownerId: string
  ownerName: string | null
  ownerEmail: string | null
  accessCount: number
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
      }
    })
  } catch (err) {
    console.error('Error fetching data sources:', err)
    throw err
  }
}
