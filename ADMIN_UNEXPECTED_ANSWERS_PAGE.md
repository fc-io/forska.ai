# Admin Page: Unexpected Answers Investigation

## ✅ Optimized Three-Level Design

### Level 1: Project List
**URL**: `/admin/unexpected-answers`

Shows all projects in a grid layout.

**Speed**: ⚡ Very fast (<1 second)

### Level 2: Prompt List (per project)
**URL**: `/admin/unexpected-answers/:projectId`

Shows all prompts with defined types for the selected project.

**Features**:
- Search filter
- Shows prompt type definition
- Only shows enabled prompts with defined types

**Speed**: ⚡ Very fast (<1 second)

### Level 3: Prompt Investigation
**URL**: `/admin/unexpected-answers/:projectId/:promptId`

Shows unexpected answers for ONE specific prompt.

**Features**:
- Summary stats (total judgments, % unexpected)
- Expected options (green badges)
- Unexpected values found (red with counts)
- Color-coded severity indicator
- Recommendations for fixes
- Success message if no issues

**Speed**: ⚡ Fast (1-3 seconds)

**Why This Design?**:
- **Much faster** - analyzes only one prompt's judgments at a time
- **Focused** - drill down to exactly what you need
- **Scalable** - works instantly even with many projects/prompts

## Access

Navigate to: **Admin Menu → Data → Unexpected Answers**

Or directly:
1. Project list: `http://localhost:5173/admin/unexpected-answers`
2. Prompt list: `http://localhost:5173/admin/unexpected-answers/<project-id>`
3. Prompt detail: `http://localhost:5173/admin/unexpected-answers/<project-id>/<prompt-id>`

## Navigation Flow

```
Projects → Select Project → Prompts → Select Prompt → Results
```

Each page has a breadcrumb trail to navigate back:
- Level 2: "← Back to Projects"
- Level 3: "← Projects / <Project Name>"

## What Level 3 Shows

### Summary Section
- **Total Judgments**: How many judgments exist for this prompt
- **Unexpected %**: Percentage of judgments with unexpected values (color-coded)

### Expected vs Unexpected
- **Expected Options**: Green badges showing what answers should be
- **Unexpected Values Found**: Red cards showing:
  - The unexpected value
  - How many judgments have this value

### Color Coding
- 🔴 Red (≥20%): Critical issue
- 🟠 Orange (≥10%): Significant issue
- 🟡 Yellow (≥5%): Minor issue
- ⚪ Gray (<5%): Low impact

### Success Message
If no unexpected answers found, shows:
- ✓ Green success message
- "All judgments match the defined type options"

### Recommendations
Provides actionable suggestions:
- Review if values are valid but missing from type
- Check if judgments are from old schema
- Consider re-judging if values incorrect
- Update type definition if new options identified

## Common Unexpected Values

- **NULL**: Judgment failed or LLM returned no answer
- **(empty string)**: Similar to NULL
- **Other values**: Could be:
  - Old values from before type was changed
  - LLM hallucinations (e.g., "not sure" vs "unsure")
  - Manual entries that don't match constraints
  - Case/whitespace differences

## Technical Details

### API Endpoint
- **GET** `/api/admin/investigate-unexpected-answers?projectId=<id>&promptId=<id>`
- Query parameters:
  - `projectId` (optional): Filter to project
  - `promptId` (optional): Filter to specific prompt
- Returns different formats based on parameters:
  - With `promptId`: Single-prompt format `{projectName, promptHeading, result}`
  - Without `promptId`: Multi-prompt format `{summary, results[], projectName}`
- Requires admin authentication

### Frontend Routes
- List: `src/app/routes/+admin/+unexpected-answers/+index.tsx`
- Prompts: `src/app/routes/+admin/+unexpected-answers/+$projectId/+index.tsx`
- Detail: `src/app/routes/+admin/+unexpected-answers/+$projectId/+$promptId/+index.tsx`
- Uses TanStack Query for data fetching
- Fully responsive design

### Backend Route
- `src/server/routes/AdminInvestigateRoutes.ts`
- Intelligently filters based on parameters
- Single-prompt mode: analyzes only one prompt
- Returns different format for single vs multiple prompts
- Calculates percentages and sorts by impact

## Performance Comparison

| Level | What It Does | Speed |
|-------|--------------|-------|
| Level 1 | List projects | <1 sec |
| Level 2 | List prompts | <1 sec |
| Level 3 | Analyze 1 prompt | 1-3 sec |
| Old (all at once) | Analyze all prompts | 30+ sec |

**Speed improvement: 10-30x faster** 🚀

## Navigation Menu

Added to **Admin Menu → Data** section, right after "Parquet".
