# Troubleshooting Anthropic Request Failures

## Summary

We observed a recurring pattern where a judgments job would show a very high failure rate in the first minute after stopping and starting the same job, then a much lower failure rate in later minutes.

The main cause was not that old requests became corrupted while sitting in SQLite. The bigger issue was that the per-job SQLite queue persisted across pause and resume, and retry-prone prompt rows stayed at the front of the ready queue. On restart, the worker would hit those same old problematic rows first.

## Conclusions

1. The startup spike was not primarily explained by stale request payload corruption.

The per-job SQLite queue stores `article_id` and `prompt_id`, not a frozen request body. When a prompt runs, the article and prompt definition are fetched fresh from the app database. Old queue rows therefore keep old queue position, not old request payload text.

2. The startup spike was strongly affected by persisted queue order.

Retry-prone rows stayed at the head of the local ready queue across pause and resume. When the same job restarted, those rows were reclaimed first, which created a burst of failures at startup and a much healthier failure rate once the queue head was exhausted.

3. `pause` is a drain-preserving operation, not a hard reset.

Pausing a job marks it `draining`, clears `ready` rows, releases the lease, and keeps the local SQLite DB for safe import, repair, and cleanup. It does not fully wipe non-terminal local state.

4. `delete job` is too destructive for troubleshooting this case.

Deleting a job removes:

- the per-job SQLite files
- the `app.judgment_job` row
- the job's `app.token_use` rows

That makes delete/recreate a clean experiment, but not an acceptable normal workflow when we want to preserve token usage history.

5. Some Anthropic failures were still request-level issues, not only queue-state issues.

The repeated `anthropic_empty_response` failures indicate that some article-prompt pairs are genuinely fragile or refusal-prone on Anthropic. Queue persistence explained why they clustered at startup, but not why they failed at all.

6. We should not fix this by broadly disabling `thinking=max`.

That is not an acceptable product-level fix for this issue.

7. The remaining failures are now mostly article-level Anthropic refusals.

After the queue-order fixes, the dominant remaining pattern is that the same article IDs fail across all five screening prompts with `anthropic_empty_response` and `stop_reason=refusal`. These are concentrated in harmless bioscience literature involving pathogens, AMR, plasmids, virulence, and outbreaks.

8. Anthropic-specific prompt framing should stay Anthropic-specific.

The extra harmless-literature / non-procedural framing is now only appropriate for Anthropic article-screening prompts. Other providers should keep the original article prompts unless they show the same refusal pattern.

## Requirements Agreed During Troubleshooting

1. Preserve historical token usage.

Any clean restart mechanism must keep existing `app.token_use` rows for the job.

2. Preserve the job row.

We want to keep the same judgments job instead of deleting and recreating it.

3. Add a clean-start action in the admin UI.

Add a `Start Job Clean` button between `Start Job` and `Delete Job` in the job detail view.

4. Wire `Start Job Clean` to a backend action that resets local SQLite state safely.

The action should:

- keep the existing judgments job row
- keep existing `app.token_use` history
- flush local outbox state when possible
- remove the current per-job SQLite queue/state
- recreate fresh local SQLite state for the same job
- start the same job again

5. Do not use delete/recreate as the main user workflow.

Delete is still useful for a full reset, but it removes token usage history and is therefore not the right user-facing solution for this problem.

## Intended Outcome Of `Start Job Clean`

`Start Job Clean` should give the user a way to restart a job from clean local SQLite queue state while preserving the job and its historical token usage.

## Implemented Changes

1. Retry queue rows now move to the back of the ready queue.

This prevents old retry-prone rows from staying at the queue head across pause and resume.

2. The admin job page now has `Start Job Clean`.

This resets the per-job local SQLite state while preserving the job row and `app.token_use` history.

3. The job detail view now exposes refusal-specific metrics.

The UI now shows persisted failed requests, Anthropic refusals, and the number of affected articles.

4. Anthropic article prompts now have provider-specific harmless-literature framing.

This framing is applied only to Anthropic article-screening prompts, not to other providers, patient prompts, or structured-import prompts.

## Researched Prompt Workarounds For Anthropic Refusals

The current remaining failures look like Anthropic bio-safety false positives on harmless literature screening for pathogen, plasmid, virulence, outbreak, and AMR-heavy articles.

The safest next prompt experiments are:

1. Strengthen the system prompt as a harmless literature-review classification task.

State explicitly that the task is title/abstract screening and evidence extraction, not scientific advising, protocol design, diagnosis, or treatment guidance.

2. Use quote-first structured screening.

Ask the model to extract direct evidence spans first and classify only from those spans, using a tightly constrained JSON schema.

3. Use XML-style separation between source text, task instructions, and output contract.

This can make it clearer that the bioscience content is document evidence rather than something the model should act on.

4. Add refusal-specific retry narrowing.

If Anthropic refuses, retry with a narrower task such as: extract only exact quotes and return only enum labels, with no extra prose.

5. Add a few-shot set of harmless bioscience screening examples.

Use examples with pathogens, AMR, plasmids, virulence, and outbreaks, but only in the context of inclusion/exclusion or evidence extraction.

## Prompt Workaround Constraints

1. Do not disable `thinking=max` as the main fix.

2. Do not use jailbreak-style wording or instructions that ask the model to ignore policy.

3. Keep the task clearly non-procedural and grounded in provided text only.

4. Prefer narrowing scope and constraining outputs over arguing with refusals.

5. Keep Anthropic-specific mitigations provider-scoped unless another provider shows the same failure mode.
