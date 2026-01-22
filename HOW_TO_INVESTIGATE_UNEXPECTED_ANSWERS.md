# How to Investigate Unexpected Answer Values

## Quick Start (Easiest Method)

With your server running, just open this URL in your browser (or use curl):

```bash
# Make sure server is running first
# Then visit:
http://localhost:8788/api/admin/investigate-unexpected-answers
```

Or using curl:
```bash
curl http://localhost:8788/api/admin/investigate-unexpected-answers | jq
```

This will return JSON showing:
- All prompts with unexpected answer values
- What the expected options are
- What unexpected values were found
- How many judgments have each unexpected value
- Percentage of judgments affected

## Output Format

```json
{
  "summary": {
    "totalPromptsWithTypes": 50,
    "promptsWithUnexpectedAnswers": 3
  },
  "results": [
    {
      "promptId": "abc-123-def-456",
      "promptHeading": "Is this relevant?",
      "expectedOptions": ["yes", "no", "unsure"],
      "unexpectedAnswers": [
        { "value": null, "count": 125 },
        { "value": "", "count": 42 },
        { "value": "maybe", "count": 10 }
      ],
      "totalJudgments": 1500,
      "percentUnexpected": 11.8
    }
  ]
}
```

## What This Shows

### Sorted by Impact
Results are sorted by `percentUnexpected` (highest first), so the most problematic prompts appear first.

### Common Unexpected Values
- `null` - Judgment failed or LLM returned no answer
- `""` (empty string) - Similar to null
- Other values - Could be:
  - Old values from before type was changed
  - LLM hallucinations (creative variations)
  - Manual entries that don't match constraints
  - Case/whitespace differences

## What to Do Next

### For Each Prompt with Unexpected Answers:

1. **Check if it's a real problem:**
   - Low percentage (<5%)? Might be acceptable
   - High percentage (>20%)? Should investigate

2. **Identify the cause:**
   - Are these old judgments? (check `createdAt` dates)
   - Is it a specific model? (check `modelId`)
   - Is the prompt type definition wrong?

3. **Choose a fix:**
   - **Re-judge:** Delete and regenerate judgments for affected articles
   - **Update type:** Add the "unexpected" values to the prompt type
   - **Data migration:** Map old values to new values
   - **Document:** If intentional, just note it

## For More Detailed Investigation

If you need to see which specific articles have unexpected answers:

```bash
# Find the promptId from the investigation results above, then:
bun run scripts/findArticlesWithUnexpectedAnswers.ts <project-id> <prompt-id>
```

This will show you:
- Specific article titles
- The unexpected answer for each
- When it was judged

## Prevention

To prevent this in the future:
1. Validate answers before storing judgments
2. Add tests for prompt type parsing
3. Log warnings for unexpected values
4. Use stricter LLM output formatting
5. Review prompt types before making changes
