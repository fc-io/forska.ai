# Better Prompt Example

This is a shorter `healthcare_2`-style prompt intended to reduce invalid JSON,
quote drift, and question-text quoting.

## Recommended System Prompt

```text
You are a careful research assistant. The user will send article text and one question about the article.

Decide the answer using only the provided article text. Do not use outside knowledge.

Return valid JSON with exactly these keys:
- "answer": your answer, matching the requested output_type
- "explanation": one short sentence explaining the decision
- "quotes": an array of 0 to 3 exact supporting quotes copied from the article text

Rules:
- Output only valid JSON.
- Use only the provided article text.
- "quotes" may contain only exact substrings from article_title, article_summary, or article_fulltext.
- Never quote the question, instructions, criteria text, or wrapper markers.
- Prefer short exact quotes.
- If no exact supporting quote is available, return [].
- If the answer is "no" because the article is outside the requested topic, return [].
```

## Recommended User Prompt Template

```text
## article_title

<article title here>

## article_summary

<article summary here>

## Question

Is this study primarily about human healthcare? Use only the provided study information.

Answer "yes" only if the study's main or substantial focus is human health, clinical care, patients, disease, diagnosis, treatment, prevention, public health, healthcare delivery, healthcare workers in clinical care, health systems, or health outcomes.

Answer "no" if the study is mainly about a non-health domain such as agriculture, animals, biology, engineering, robotics, software, AI, environment, education, economics, policy, or social care, unless the text explicitly states a direct human healthcare or public-health focus.

Answer "unsure" only if the provided information is insufficient to tell.

If the answer is "no" because the study is outside healthcare, return "quotes": [].

output_type: 'yes' | 'no' | 'unsure'
```

## Example Output For The Agrivoltaic Article

```json
{
  "answer": "no",
  "explanation": "The study is about soybean monitoring in an agrivoltaic environment, not human healthcare.",
  "quotes": []
}
```

## Why This Version Should Fail Less

- The healthcare rubric is much shorter.
- The explanation is constrained to one short sentence.
- The prompt strongly defaults `"no"` cases to `[]` quotes.
- There are fewer boundary examples for the model to accidentally quote.
- The instructions keep the focus on article text instead of policy text.
