import type {JSX} from 'solid-js'

type CollapsibleSelectionSectionProps = {
  children: JSX.Element
  label: string
  open?: boolean
  selectedCount: number
  totalCount: number
}

/**
 * A `<details>` section for a list of selectable items. The summary shows the label, how many items are selected and
 * an Expand/Collapse hint. Sections start collapsed unless `open` is set; the browser owns the toggle state after that.
 */
export const CollapsibleSelectionSection = (props: CollapsibleSelectionSectionProps) => {
  return (
    <details class="group border border-input rounded-md bg-muted/10" open={props.open}>
      <summary class="cursor-pointer list-none flex items-center justify-between gap-3 px-4 py-3">
        <p class="text-sm font-medium text-gray-900">{props.label}</p>
        <span class="flex items-center gap-3 text-xs text-muted-foreground">
          <span>
            {props.selectedCount} of {props.totalCount} selected
          </span>
          <span class="group-open:hidden">Expand</span>
          <span class="hidden group-open:inline">Collapse</span>
        </span>
      </summary>
      <div class="px-4 pb-4 space-y-2">{props.children}</div>
    </details>
  )
}
