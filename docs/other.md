saftey
trustworthiness
looked at demographics
metric

is healthcare a focus for the article or just something that is mentioned in passing or as a possible future use?
yes, a focus | only in passing | healthcare not mentioned | unsure

is it evaluating AI agents on clinical tasks?
yes | no | unsure

is it about something performed at a hospital?
yes | no | unsure

is it about agentic AI?
yes | no | unsure

what categori of agentic AI would you say this is? (only answer to this if the question fits the article, otherwise return null)
string | null

what to call the task/tasks the aI was instructed to do in this study? (only answer to this if the question fits the article, otherwise return null)
string | null

does it compare agentic AI with other forms of AI, like an AI agent vs a plain LLM?

need to better define what an agent is:

tada

## agentic ai
L0 — Non-agentic

Behavior: Single shot prediction or generation; no actions, no planning.
Examples: Image classifier, one-off LLM completion, embedding service.
Risk/benefit: Low power, low risk.

L1 — Reactive tool user (single turn)

Behavior: Perceives → picks one tool/API → returns result; no iteration or memory.
Examples: LLM with function calling for “lookup weather” or “SQL query” once.
Notes: Deterministic routing or simple policies; no goal decomposition.

L2 — Iterative executor (short-horizon loop)

Behavior: Plan-execute-reflect loop within a bounded session; may call multiple tools; short-term scratchpad memory.
Examples: ReAct-style agents, planner+critic patterns, code-runner that retries on errors.
Notes: Human sets the top-level goal; agent manages substeps locally.

L3 — Autonomous tasking with state (long-horizon, single agent)

Behavior: Maintains persistent memory/state across sessions; decomposes goals, schedules work, and re-plans over time; can write/update artifacts.
Examples: Research assistant that builds a knowledge base; CI bot that files PRs; data pipeline auto-fixer.
Controls: Resource budgets, allowlists, review gates.
Risk/benefit: Meaningful leverage – needs guardrails.

L4 — Multi-agent orchestration

Behavior: Coordinates specialized agents (planner, executor, reviewer, tool specialists); negotiates interfaces; may learn division of labor.
Examples: Team-of-agents for product triage → spec → code → test → deploy; robotic fleet coordination.
Notes: Adds robustness and throughput – also systemic failure modes (spec drift, feedback loops).

L5 — Open-world, self-directed agents

Behavior: Forms/updates own objectives under constraints; learns new tools; self-modifies workflows; operates continuously with sparse human input.
Examples: Autonomous trading/ops/robotics with real-world actuation; self-improving devops agents.
Controls: Strong governance – capability gating, anomaly detection, audit trails, kill-switches.