import {createFileRoute} from '@tanstack/solid-router'

import {ArticlesTable} from '../../../components/main/articlesTable'

const Articles = () => {
  return (
    <div class="min-h-screen bg-gray-50 flex justify-center p-4">
      <div class="w-full space-y-8">
        <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-8">
          <ArticlesTable />
        </div>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/articles/')({component: Articles})
