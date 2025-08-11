import '../index.css'

import {createFileRoute} from '@tanstack/solid-router'
import {type JSX} from 'solid-js'

import {Subheader} from '../../components/main/subheader'
import {UnassessedArticles} from '../../components/main/unassessedArticles'

const Index = (): JSX.Element => {
  return (
    <div class="min-h-screen bg-gray-50 flex justify-center p-4">
      <div class="w-full space-y-8">
        <Subheader />
        <div class="bg-white rounded-lg shadow-sm border border-gray-200 p-8">
          <UnassessedArticles />
        </div>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/')({component: Index})
