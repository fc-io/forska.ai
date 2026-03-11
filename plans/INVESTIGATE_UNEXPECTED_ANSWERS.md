# Investigating Unexpected Answer Values

## Background

Some judgments have answer values that don't match the prompt's defined options. This can happen due to:

1. **Schema evolution**: Prompt options changed after judgments were created
2. **LLM hallucination**: LLM returned values outside the expected format
3. **Manual entry**: Human assessments that don't match constraints
4. **NULL/empty values**: Judgments that failed or were incomplete
5. **Type parsing issues**: Edge cases in how types are parsed or stored

## Investigation Options

### Option 1: Run Global Analysis (Quickest)

Analyzes all prompts across all projects to find unexpected answers:

```bash
# Analyze all prompts
bun run scripts/investigateUnexpectedAnswers.ts

# Analyze only one project
bun run scripts/investigateUnexpectedAnswers.ts <project-id>
```

**Output:**

- Summary of all prompts with unexpected answers
- Count and percentage of unexpected answers
- List of unexpected values found
- Breakdown by prompt

**Use when:**

- You want a quick overview
- You're not sure which prompts are affected
- You want to see patterns across all projects

---

### Option 2: Find Affected Articles (More Detail)

Shows specific articles that have unexpected answers for a project:

```bash
# Find articles in a project with any unexpected answers
bun run scripts/findArticlesWithUnexpectedAnswers.ts <project-id>

# Find articles for a specific prompt
bun run scripts/findArticlesWithUnexpectedAnswers.ts <project-id> <prompt-id>
```

**Output:**

- Article titles and IDs
- The unexpected answer value
- When it was judged
- Shows first 20 articles per prompt

**Use when:**

- You want to see which specific articles are affected
- You need to review or re-judge specific articles
- You're investigating a specific prompt

---

### Option 3: Admin UI Page (Most User-Friendly)

Create a web interface to explore unexpected answers visually.

See: `scripts/createUnexpectedAnswersAdminPage.md`

**Features:**

- Visual table interface
- Filter by project
- Click through to affected articles
- Export findings to CSV
- No command-line needed

**Use when:**

- You want to share findings with non-technical team members
- You need to regularly monitor this
- You prefer UI over command-line

---

### Option 4: Raw SQL Query (Most Flexible)

For custom analysis, run queries directly:

```sql
-- Find all unexpected answers for a specific prompt
WITH prompt_options AS (
  SELECT
    id,
    regexp_matches(type, '''([^'']+)''', 'g') AS option
  FROM prompts
  WHERE id = 'YOUR_PROMPT_ID'
),
expected AS (
  SELECT ARRAY_AGG(option[1]) AS options
  FROM prompt_options
)
SELECT
  j.answered_original,
  COUNT(*) as count,
  ARRAY_AGG(DISTINCT a.article_title) FILTER (WHERE a.article_title IS NOT NULL) as example_articles
FROM judgments j
LEFT JOIN articles a ON j.article_id = a.id
CROSS JOIN expected e
WHERE j.prompt_id = 'YOUR_PROMPT_ID'
  AND j.deleted_at IS NULL
  AND NOT (j.answered_original = ANY(e.options) OR j.answered_original IS NULL)
GROUP BY j.answered_original
ORDER BY count DESC;
```

**Use when:**

- You need custom analysis
- You want to join with other tables
- You're comfortable with SQL

---

## Common Causes and Solutions

### 1. NULL or Empty Answers

**Cause:** Judgment failed, timed out, or LLM returned no answer
**Solution:** Re-run judgments for affected articles

### 2. Old Values After Type Change

**Cause:** Prompt options were changed after judgments existed
**Solution:** Either:

- Re-judge articles with old values
- Add old values to the type definition
- Use migration to map old → new values

### 3. LLM Hallucination

**Cause:** LLM returned creative variations (e.g., "not sure" instead of "unsure")
**Solution:**

- Improve prompt instructions
- Use stricter output formatting
- Add post-processing to normalize answers

### 4. Case Sensitivity

**Cause:** Answer was "Yes" but type defines "yes"
**Solution:** Normalize case in type definitions or storage

### 5. Whitespace Issues

**Cause:** Answer has leading/trailing spaces
**Solution:** Trim answers before storing

---

## Next Steps

After identifying unexpected answers:

1. **Assess Impact**: How many judgments are affected?
2. **Root Cause**: Why did this happen?
3. **Fix Strategy**:
   - Re-judge affected articles?
   - Update type definitions?
   - Migrate data?
   - Leave as-is but document?

4. **Prevention**:
   - Add validation before storing judgments
   - Log warnings for unexpected values
   - Add tests for type parsing
   - Document expected behavior

---

## Questions to Answer

- Which prompts have the most unexpected answers?
- What percentage of judgments are affected?
- Are unexpected answers recent or old?
- Do they correlate with specific LLM models?
- Are they from human or LLM judgments?
- Can they be automatically fixed?
