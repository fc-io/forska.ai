export const ProjectStatistics = (props: {projectCount: number}) => {
  return (
    <div class="bg-card border rounded-lg p-6">
      <h2 class="text-2xl font-semibold mb-4">Project Statistics</h2>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div class="text-center">
          <div class="text-2xl font-bold text-primary">
            {props.projectCount}
          </div>
          <div class="text-sm text-muted-foreground">Active Projects</div>
        </div>
        <div class="text-center">
          <div class="text-2xl font-bold text-primary">-</div>
          <div class="text-sm text-muted-foreground">Total Judgments</div>
        </div>
        <div class="text-center">
          <div class="text-2xl font-bold text-primary">-</div>
          <div class="text-sm text-muted-foreground">In Queue</div>
        </div>
        <div class="text-center">
          <div class="text-2xl font-bold text-primary">-</div>
          <div class="text-sm text-muted-foreground">Success Rate</div>
        </div>
      </div>
    </div>
  )
}
