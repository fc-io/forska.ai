# Create Admin Page for Unexpected Answers

This would involve creating:

1. **Server Route** (src/server/routes/AdminRoutes.ts or new file):
   - GET /api/admin/unexpected-answers?projectId=xxx
   - Returns list of prompts with unexpected answer values
   - Includes counts, examples, and percentages

2. **Frontend Page** (src/app/routes/+admin/+unexpected-answers/+index.tsx):
   - Table showing all prompts with unexpected answers
   - For each prompt:
     - Expected options
     - Unexpected values found (with counts)
     - % of judgments affected
     - Link to see affected articles
   - Filter by project
   - Export to CSV

3. **Benefits**:
   - Visual exploration
   - No command-line needed
   - Easy to share with team
   - Can click through to see specific articles

Would you like me to implement this admin page?
