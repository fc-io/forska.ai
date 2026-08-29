import {runRealCodexSmoke} from './judgmentWorkflowRealCodex/realCodexSmoke.ts'
import {createRealCodexTopologyAdapter} from './judgmentWorkflowRealCodex/realCodexTopologyAdapter.ts'

await runRealCodexSmoke({adapter: createRealCodexTopologyAdapter()})
