# Prompt refinements for project "cov 6" (Fable)

- Project: "cov 6" (`ec1c5ee8-0edc-4f8a-bd79-9ddf41ec0247`), created 2026-09-30, Claude Opus 4.7 (thinking: max), title + abstract, no judgments yet.
- Compared against: the com 5 analysis (`CRITERIA_RESOLUTIONS_FIXES_FABLE_SUGGESTIONS.md`, 137 differences between LLM and conflict resolution), the team's two suggestion lists, and the wrapper the platform puts around each criteria section.
- Suggestion 11 ("maybe means include") is left out on request. Where the analysis had used it (record with no country at all), this document keeps "maybe" and proposes a flag instead.
- Data: `~/Developer/forska-criteria-analysis/2026-09-30-ec1c5ee8/` (`project.json`, `criteria_cov6.md`).

## 1. What cov 6 already changed

Compared with the criteria used in com 5 (source project 81f72e85):

| Section | Change in cov 6 | Suggestion | Status |
|---|---|---|---|
| Population | "aimed at prescribing/use" | – | wording only |
| Intervention | New line: stewardship components (dose individualisation, de-escalation, delayed prescribing, IV-to-oral switch, discontinuation, TDM), as whole or part of an intervention | 12 | done |
| Intervention | Exclusion names antituberculosis drugs, antiretrovirals, antifungals, antimalarials | 5 | done; add antiparasitic drugs and turn it into a definition (4.2) |
| Outcome | New primary outcome: change in the ability to differentiate bacterial from non-bacterial infections | – | new scope; needs the biomarker rule in 4.2 or diagnostic-accuracy studies come in |
| Outcome | Exclusion adds "results of prescription audits, reasons for antibiotic use" | C4 | fixes one record type; the general problem remains (2.3) |
| Study design | "Implementation-only studies" | 8 | added without a definition |
| Other | "developing/ low- and middle-income"; Ethiopia = Low income | 4 | done; Venezuela still blank |

Not yet addressed in cov 6: suggestions 6, 7, 9, 10, 13, 14, 15 (limits), 16, 17 (as an evidence rule), C1, C2, C3, C5, and the four structure problems: the country judged in two sections, one "maybe" rule for every kind of missing information, a Comparator section that cannot fail, and planned outcomes counted as outcomes.

## 2. What still goes wrong with cov 6 as written

Counts are from the 137 com 5 differences, judged by GPT-5.5. The causes below are in the prompt text, so they carry over to Opus 4.7; the sizes may differ.

1. **Country judged twice (31 records).** Population line 2 reads "Involving prescribers from low- and middle-income countries". One missing country name gives "maybe" under Population and under Other. The rule "Chinese means China" sits only under Other, so 7 Chinese records got a country doubt under Population. Cov 6 keeps the line.
2. **Two readings of the Population lines (Chinese list, item 1).** The wrapper says "Treat inclusion items as possible routes to inclusion unless the criteria text explicitly requires multiple conditions together". With four lines, line 1 ("Interventions that target antibiotic prescribing/use") was read as sufficient in 70 agreed includes with no prescriber named, and line 2 ("Involving prescribers ... doctors/physicians/dentists") as required in 63 differences with no prescriber named. Cov 6 keeps both the sentence and the four lines. The words 我院, 本院, 某院 were understood as "hospital" every time; a rule tied to the string 医院 would fail (absent in 17 of the 32 Chinese maybe-include records and in 54 of 89 Chinese agreed includes).
3. **No definition of "evaluates an intervention" and no section that demands a reported comparison** (9 records with no intervention evaluated, 13 with one vague phrase carrying four to six answers). The only exclusion for it sits under Outcome, where the model looks for outcomes; cov 6 keeps it there.
4. **Comparator cannot fail.** No exclusion, and "No intervention" listed as an inclusion route. It answered "yes" in all 8 hard over-inclusions, one-off audits included.
5. **One "maybe" rule for everything.** 116 of 137 differences were "maybe" with the reason "not enough information". The resolvers included when the prescriber or the country was missing and excluded when the intervention or the results were missing. The wrapper gives the same answer for all four.
6. **Planned outcomes count as outcomes.** Outcome was "yes" in 8 of 12 records that report no results. The conference-abstract exclusion is conditional on "do not report results" and was read that way (1 record "yes"). Nothing says "judge the record you have".
7. **Regimen studies (12 relevant).** The exclusion exists and the model set it aside with a reason each time ("antibiotic versus none is not regimen versus regimen"). "Including surgical antibiotic prophylaxis" and the outcome line "timing, route of administration, dosing, duration" pull these studies in. It needs a test, not emphasis.
8. **All-drug clause without a reverse limit.** It was applied to an antibiotic-only programme, and three includes have no antibiotic outcome at all.
9. **Other: no rule** for a record without a country, for several countries, for region-only records, or for what counts as evidence ("developing country", currency, a national guideline). Venezuela is blank. No rule for blank entries.
10. **Public and prescribers (1 record).** Population passes (mixed target does not exclude), Intervention fails on "Public awareness campaigns".

## 3. Each suggestion against cov 6

| # | Suggestion | In cov 6 | Change to make |
|---|---|---|---|
| 4 | Ethiopia | Done | Fill Venezuela (lower middle income); add rule 9 in 4.6 for blank entries |
| 5 | Tuberculosis | Done | Definition of "antibiotic" in 4.2; add antiparasitic drugs |
| 6 | Trials with no results | Not done | "Judge the record you have" (5.2); "an outcome counts only if a result is reported" (4.4); unconditional no-results line (4.5) |
| 7 | Conference abstracts | Still conditional | Own unconditional line (4.5). Recognisable only when the record says so; pass publication type to the model (5.4) |
| 8 | Implementation-only | Added, undefined | Definition in 4.5 |
| 9 | Public and prescribers | Not done | Exception in 4.2; "aimed only at" in the Population exclusions (4.1) |
| 10 | Several countries | Not done | Rules 4 and 5 in 4.6 |
| 12 | Dose individualisation, de-escalation, TDM | Done | Keep; it works together with 14 |
| 13 | Lenient on a vague phrase | Not done | Rule "base each answer on the part of the abstract that concerns that section" (5.2); conditions 1 and 2 in 4.2; exclusion in 4.3 |
| 14 | Clinical antibiotic use implies prescribing | Not done | Rules in 4.1 (27 records fixed in com 5). Apply the Intervention exclusions first, or 2 excluded Chinese records flip to "yes" |
| 15 | All-drug interventions | Present | Add the reverse limit and "named result with data" (4.2) |
| 16 | Intervention mentioned, not evaluated | Not done | Exclusion lines in 4.2 and 4.3. Team decision needed for exposure-only cohorts and date or accreditation cut-offs |
| 17 | Screen the title | Not supported | The title is in every prompt. Say so in the wrapper (5.2), add the evidence rule (4.6), fix titles cut at import (5.4) |
| C1 | Population contradiction | Not done | 4.1: judge the setting by meaning in any language; no rule tied to 医院 |
| C2 | Reports and commentaries | Present as "editorials, commentaries, opinion pieces" | Add news items, digests, letters without data (4.5). Do not add the bare word "report": primary research often calls itself a report |
| C3 | Two regimens compared | Present, no test | Test in 4.2 and the prophylaxis example |
| C4 | No intervention evaluated | Present under Outcome | Move to 4.2 and 4.3 |
| C5 | Knowledge, attitudes, perceptions | Present | Close the self-report gap (4.4) |

## 4. Paste-ready section texts for cov 6

Each block replaces the whole text of its section, including the generated preamble (see 5.1). Lines the team wrote and that are not mentioned stay as they are. The six Covidence sections are kept.

### 4.1 Population Criteria

```
Question: Is the intervention aimed at people who prescribe antibiotics in a formal health facility?

This section judges only who the intervention is aimed at and where care is delivered. Do not judge the country here (Other Criteria). Do not judge whether the intervention was evaluated here (Intervention and Comparison Criteria).

Inclusion criteria (any one line is enough):
- The intervention is meant to change how antibiotics are chosen, started, dosed, timed, given or stopped for patients cared for in a formal health facility, at any level of care (primary, secondary, tertiary; inpatient or outpatient).
- The prescribers do not have to be named. In a health facility antibiotics are prescribed by doctors, dentists or other authorised prescribers. Assume they are involved unless the record says the intervention was aimed only at another group.
- A health facility may be described in any way and in any language: a named hospital, "our hospital", "this hospital", "a hospital", a department, ward, intensive care unit, clinic or health centre, or patients described as inpatients, outpatients, surgical or perioperative patients, or prescriptions and medical records from a facility. Judge by meaning, not by a particular word.
- Abstracts describe the study sample as patients, medical records or prescriptions. That is the sample, not the target of the intervention, and is no reason for doubt.
- Pharmacist-led or nurse-led interventions are included when they concern what is prescribed: whether an antibiotic is given, which one, dose, timing, route or duration.
- National, regional or insurer policies are included when their effect is measured as antibiotic prescribing or use in health facilities.
- If the intervention is aimed at several groups and prescribers are one of them, include.

Exclusion criteria (the intervention is aimed only at these groups):
- Informal healthcare providers
- Community pharmacists or drug sellers
- Veterinarians
- Medical, pharmacy or nursing students without independent prescribing roles
- Patients, carers or community members
- Pharmacists or nurses whose work concerns only supply, storage, dispensing, preparation or administration of drugs, or patient education

Answer "maybe" only if nothing in the record shows where care was delivered or who was targeted.
```

### 4.2 Intervention Criteria

```
Question: Did the study set out to evaluate an intervention meant to change how antibiotics are prescribed or used?

Definitions:
- Antibiotic: a drug against bacteria, used to treat or prevent a bacterial infection. Drugs for tuberculosis (treatment or preventive therapy, for example isoniazid), antiretrovirals and other antivirals, antifungals, antimalarials and antiparasitic drugs are not antibiotics in this review.
- Intervention: something done to change how prescribers use antibiotics. Examples: a policy, restriction or pre-authorisation; education or training; audit with feedback; prescription review by pharmacists; a guideline, protocol or clinical pathway; decision support; an antimicrobial stewardship programme; a test used to decide on antibiotics (procalcitonin, CRP, rapid diagnostic test, culture and susceptibility workflow); therapeutic drug monitoring; dose individualisation or optimisation; de-escalation or narrowing; delayed or deferred prescribing; switch from intravenous to oral treatment; discontinuation. These may be the whole intervention or one component of a broader intervention.

Apply the exclusion criteria first.

Exclusion criteria:
- No intervention was evaluated: antibiotic utilisation, prescription audits or appropriateness measured at one point in time, resistance patterns, surveillance, stewardship metrics, reasons for antibiotic use, gap analyses, needs assessments.
- An intervention that appears only in the title, aim, background or conclusion, or that is only recommended, proposed or called for.
- Regimen studies: patients are put into groups by the antibiotic treatment they receive (one drug or schedule against another, short against long course, single dose against several doses, prophylaxis against no prophylaxis, antibiotic against placebo) and the study asks which group has better clinical results, pharmacokinetics or safety. Test: does the study ask which antibiotic treatment works better for patients (exclude), or whether an action changed what prescribers do (include)? A protocol or policy that changes how prophylaxis is prescribed, measured as prescribing, is an intervention. A trial of two prophylaxis schedules, measured as infections, is a regimen study.
- Biomarker or diagnostic studies that only measure levels, accuracy or diagnostic value. Include only if the test result was used to decide on antibiotics in one group, compared with a group managed without it.
- Interventions that target drugs other than antibiotics (see the definition).
- Interventions aimed at antibiotic sales or dispensing in community pharmacies or by drug sellers.
- Public awareness campaigns aimed only at patients or the public.
- Infection prevention, surgical safety, nursing care or adverse-event bundles, unless improving antibiotic prescribing or use is a stated aim and an antibiotic result is reported.

Inclusion criteria (both must be true):
1. What was done is an intervention as defined above. It may be named in general terms (management measures, supervision, rectification, comprehensive intervention) and may be a hospital-wide or national event (campaign, guideline roll-out, quality-improvement cycle), as long as the record says what was done.
2. The intervention is what the study set out to evaluate: it is named in the objective, or in the methods as the exposure being compared.

Further inclusion rules:
- Any antibiotic, any infectious disease (including surgical antibiotic prophylaxis), any age group, any level of care (primary, secondary, tertiary, inpatient, outpatient).
- If the intervention targets all medicines, general quality of care, or the care of one condition, include only if antibiotic prescribing or use is reported as a named result with data (primary outcome, key secondary outcome or major component of the evaluation). This condition does not apply to interventions that are about antibiotics.
- If the same intervention is aimed at the public and at prescribers, include.

Answer "maybe" only if the record names an intervention and its evaluation but does not say what the intervention consisted of.
```

### 4.3 Comparison Criteria

```
Question: Does the abstract report results for a period or group with the intervention against a period or group without it?

Inclusion criteria (any one line is enough):
- A different intervention or combination of interventions
- Baseline, standard or historical practice (before and after, interrupted time series)
- A control group or period with no intervention

Exclusion criteria:
- Results are reported for one point in time or one group only (single audit, survey, case series, description of a programme).
- "No intervention" above means a control group. A study in which no intervention was done at all is excluded.

Answer "maybe" only if the abstract names a comparison but does not say what was compared.
```

### 4.4 Outcome Criteria

```
Question: Does the abstract report a result for at least one of the outcomes below?

An outcome counts only if the abstract reports a result for it: a number, a direction of change or a statistical comparison. A planned outcome, a stated aim or a title is not an outcome. If the abstract reports no results at all, answer no.

Treat leading 1 markers (1, 1°, 1*, 1-) as primary outcomes and leading 2 markers (2, 2°, 2*, 2-) as secondary outcomes. Any one reported outcome, primary or secondary, is enough.

Inclusion criteria:
[keep the current 1* and 2* lines]
- If an antibiotic-use intervention was evaluated and the abstract reports only infection, resistance, clinical or cost results, answer yes.

Exclusion criteria:
- Studies that report only knowledge, attitudes, perceptions or satisfaction. Scores from questionnaires, including self-reported practice or behaviour, are not prescribing outcomes. A prescribing outcome comes from prescriptions, medical records, dispensing or consumption data.
- Studies that report only the clinical efficacy, pharmacokinetics or safety of one antibiotic treatment against another.
```

Remove from this section: "Studies that do not evaluate a specific intervention (only describe drug/antibiotic utilization, results of prescription audits, resistance patterns, reasons for antibiotic use, or stewardship metrics)". It is judged under Intervention and Comparison.

### 4.5 Study Design Criteria

```
Question: Is the record an empirical evaluation of an eligible design that reports findings?

Inclusion criteria (any one line is enough):
[keep the current five lines: randomised; non-randomised intervention studies; observational comparative; mixed methods with quantitative prescribing outcomes; published from 2000]

Exclusion criteria (each line excludes on its own):
- Records that report no finding: only background, aims, hypotheses, design or planned methods. This holds for every design, including randomised trials.
- Study protocols and trial-registry records, whether or not they state a result.
- Conference abstracts, posters and meeting proceedings, whether or not they report results.
- Reviews and meta-analyses.
- Editorials, commentaries, opinion pieces, letters without data, news items, and digests of a study published elsewhere.
- Qualitative-only studies.
- Modelling or simulation studies without empirical evaluation of an intervention.
- Implementation-only studies: they describe how a guideline or programme was rolled out or received (readiness, fidelity, barriers, uptake, lessons learnt) and do not compare antibiotic prescribing or use against a baseline or control. A study that reports before-and-after prescribing data is not implementation-only.
```

### 4.6 Other Criteria (country)

```
Question: Is the study set in a low- or middle-income country?

Rules, in this order:
1. Use everything in the record to find the setting: title, abstract, city, province, institution, health-system terms, currency, named national guidelines or programmes, journal or citation line, language.
2. A country is named and the list says low, lower middle or upper middle income: yes. High income: no.
3. If the study is in Chinese, assume the setting is China: yes.
4. Several countries are named: yes if at least half are low or middle income, otherwise no.
5. Only a region is named: yes if most countries of the region are low or middle income (Latin America, sub-Saharan Africa, South Asia, Southeast Asia). For a mixed region (Europe, the Middle East, East Asia): maybe.
6. No country is named, but the record describes its setting as developing, low-income, low-resource or resource-limited, or points to a low- or middle-income country: yes, and name the evidence.
7. No country is named and something points to a high-income country (a national society, grading system, guideline, currency or policy term of a high-income country): no.
8. No country is named and nothing points anywhere: maybe. State "country not in record" as the reason.
9. If a country's income group is blank in the list, use its most recent World Bank group. Venezuela, RB: Lower middle income.

Inclusion criteria:
Studies from low- and middle-income countries (low, lower-middle and upper-middle income). Use the list below.
[list]

Exclusion criteria:
Studies from high-income countries.
```

Fill in "Venezuela, RB | Lower middle income" in the list. The list is the World Bank list for fiscal year 2026; the fiscal year 2027 list (1 July 2026) has no blank entries and keeps every country in the same broad group except six that move within the low- and middle-income group. Check the published list before replacing.

Rule 8 is where suggestion 11 would have applied. With rules 6 and 7 most of the 37 no-country records in com 5 get a decided answer; the rest stay "maybe" on this section only, which the platform can flag (5.3).

## 5. Wrapper and system prompt refinements

How the prompt is built for cov 6 today (Anthropic provider, title + abstract):

- **System prompt:** `SINGLE_PROMPT_SYSTEM_PROMPT_ANTHROPIC` in `src/agent/judge/judgeSinglePromptSystemPrompt.ts:85`. Hard-coded, the same for every project, not editable in the UI. It frames the task as "judge if the article provided to you answers the question the user has", asks for JSON with `answer`, a brief `explanation` and up to 3 verbatim `quotes`, and shows two examples with `output_type: 'yes' | 'no' | 'unsure'`.
- **User prompt:** `judgeGetSinglePrompt` in `src/agent/judge/judgeGetPrompt.ts:149-204`. It is `## article_title`, `## article_summary`, `## Question` followed by the stored section text, then `output_type: 'yes' | 'no' | 'maybe'`. No journal, year, publication type or affiliations. The title is always sent (suggestion 17).
- **Section text:** what `GET /api/projects/:id` returns as `originalText`. It is the team's lines wrapped at Covidence import by `covidenceImportService.ts:410-479` (question, decision rules, "maybe" rule, headings). It can be edited afterwards on the project edit page or with `PATCH /api/prompts/:id`. A re-import from Covidence regenerates the wrapper.
- **Six separate calls.** Each section is judged on its own; the model never sees the other five sections or their answers. Overall decision: any "no" gives "no"; otherwise any "maybe" gives "maybe"; otherwise "yes".
- The preview endpoint (`GET /api/projects/:id/prompts/:promptId/preview`) answers "unavailable, stale" for cov 6 because the project has no serving snapshot yet. The texts above were taken from the source.

Order of work: paste the section texts (section 4) first, then change the import wrapper (5.1) so a re-import keeps the behaviour, then the system prompt (5.2), then the platform items (5.3).

### 5.1 Generated wrapper (import service)

Today every section starts with the same eight lines. Change them as follows, in `getCovidenceCombinedPromptDecisionRules` and `covidencePromptQuestionByMode`:

1. **Per-section question.** Every section now asks "Based on the inclusion and exclusion criteria, should this study be included for full text review?". That invites the model to judge everything under every section. It is the root of "country judged twice" and "one phrase carries six answers". For per-section grouping ask instead: "Does this study meet the {Section} criteria below? Judge only what these criteria ask about. The other sections are judged separately." Keep the full-text-review question for single-prompt grouping only.
2. **"Routes to inclusion".** Replace "Do not assume every inclusion item must match. Treat inclusion items as possible routes to inclusion unless the criteria text explicitly requires multiple conditions together" with: "The criteria text says whether one inclusion line is enough or all lines must hold. If it does not say, any one line is enough." The section texts in section 4 carry the marker on every list.
3. **Exclusion first.** Add: "Apply the exclusion lines first. If one applies, answer no."
4. **"Maybe" rule.** Replace the generic sentence with: "Answer maybe only when the record is silent on a fact these criteria need and the criteria text gives no default for that missing fact. Name the missing fact in the explanation." The section texts then decide: prescriber not named in a facility gives yes (4.1), no result reported gives no (4.4, 4.5), country not in the record gives maybe (4.6).
5. **Judge the record.** Add: "Judge the title and abstract as given. Do not assume what a full text might report." (Suggestions 6 and 17.)
6. **Where the evidence must be.** Add: "Base the answer on what the study did and found (methods and results). Words that appear only in the title, background, aims or conclusion do not count as an intervention, a comparison or an outcome." (Suggestions 13, 16, C4.) The current system prompt already hints at this ("not just superficially talked about"); make it a rule.
7. **Language.** Add: "The record may be in any language. Judge by meaning, not by particular words. Quote in the original language." (Chinese list, item 1.)

Until the generator is changed, pasting the section texts in section 4 gives the same effect, because each starts with its own question and rules and the current wrapper line "If the criteria text contains a more specific condition ... follow that text over any broader rule" makes them win. The risk is a later re-import, which puts the old wrapper back on top.

### 5.2 System prompt (`judgeSinglePromptSystemPrompt.ts`, Anthropic variant)

Implemented as the `screening_v1` system prompt variant (`judgeSinglePromptSystemPromptScreeningV1.ts`), selected per project through `app.project.system_prompt_variant`. Covidence projects created after the change use it; existing projects keep the legacy prompt. See `docs/system-prompt-variants.md`.

1. **Task framing.** "Your job is to judge if the article provided to you answers the question the user has" describes topic matching. Replace with: "You are screening records (title and abstract) for a systematic review against one section of the eligibility criteria at a time. Judge only the section you are given; the other sections are judged separately." Keep the sentence about results and methods versus superficial mention.
2. **Structured explanation.** Keep `explanation` a string, but require its form: first the criteria line applied, then the evidence from the record in one sentence, and for "maybe" a final part `Missing: prescriber | country | intervention | comparison | results | other`. Resolvers get a readable reason, and the platform can tell a country "maybe" from a results "maybe" (5.3).
3. **Examples.** The two examples use `'yes' | 'no' | 'unsure'` while the projects use `'yes' | 'no' | 'maybe'`. Build the examples from the prompt's own `output_type`, or write them with "maybe", and add a third example that shows a "maybe" answer with the `Missing:` part.
4. **Quotes.** Keep the rules. Add: "Quotes must come from the part of the record that concerns this section: for Intervention, what was done; for Comparison, what was compared; for Outcome, a reported result. Do not support the answer with a sentence that merely mentions the topic." Each section is a separate call, so this is the only way to stop one vague phrase from carrying every section (suggestion 13).
5. **Title.** Add: "The title is part of the record. Use it." The title is already sent; the line removes the doubt behind suggestion 17.
6. Keep the medical-research and safety framing as it is.

### 5.3 Platform changes (not prompt text)

1. **Metadata in the user prompt.** Add an `## article_metadata` block with year, journal, publication type and author affiliations when the import has them, behind a project setting like `useTitle`. It would settle most of the 37 no-country records in com 5 and make conference abstracts recognisable (suggestion 7). Without it, rules 6 to 8 in 4.6 are the best that title and abstract allow.
2. **Overall decision.** With the `Missing:` part in place, treat a record whose only "maybe" is on Other with `Missing: country` as "include, country to verify" or as its own status, so that these records stop appearing as conflicts. This is the platform-side alternative to suggestion 11, which stays out of the criteria.
3. **Import.** Titles are cut at 253 to 255 characters (3 of 299 resolved records in com 5; one lost "Burkina Faso" at the end). The review-detail route cuts the abstract at 2000 characters (`LEFT(article_summary, 2000)`) while the model sees the full abstract, so a resolver reads less than the model did.
4. **Preview.** The prompt preview needs a serving snapshot; for a fresh project the team cannot see the final prompt until articles are imported. A preview with a placeholder article would let them check the wrapper before importing.
5. **Model change.** The com 5 numbers describe GPT-5.5. Cov 6 runs Opus 4.7 with maximum thinking. The causes in section 2 are in the text and carry over; the sizes need the test in section 6.

## 6. How to test the change

1. Import the 299 resolved articles from com 5 into cov 6 (or a copy) and judge them with the revised text.
2. Create a comparison project against com 5 and count the differences by category as in the analysis. Expected movement from the 137: the 34 "prescriber not named" records become "yes"; the 15 publication-type records and the 9 "no intervention evaluated" records become "no"; the 37 "country not stated" records get one "maybe" (Other) instead of two, or a decided answer through rules 6 and 7.
3. Do not count the 39 resolutions marked for re-check as LLM errors until the team has looked at them.
4. Keep the six-section structure so the per-section explanations remain comparable with com 5.
