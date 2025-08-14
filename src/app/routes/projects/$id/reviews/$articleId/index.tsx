import {createFileRoute} from '@tanstack/solid-router'

const ReviewDetail = () => {
  const params = Route.useParams()
  const projectId = (params() as {id: string; articleId: string}).id
  const articleId = (params() as {id: string; articleId: string}).articleId

  return (
    <div class="min-h-screen bg-gray-50 p-6 mx-auto">
      <div class="p-4 bg-white rounded-lg shadow">
        <p>Review Detail</p>
        <p>Project ID: {projectId}</p>
        <p>Article ID: {articleId}</p>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/projects/$id/reviews/$articleId/')({
  component: ReviewDetail,
})
