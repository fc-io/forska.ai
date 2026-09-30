# Eligibility criteria vs conflict resolutions: analysis and suggested fixes (Fable)

- Comparison project: "com 5 – all resolutions" (`58f9ac02-6816-4853-9d8d-1e8f0f1b4c7e`)
- Source project: "cov | GPT 5.5 xhigh | 5 (original)" (`81f72e85-a8d1-416b-bc13-b4a524db2e2c`), GPT-5.5 xhigh, title + abstract
- Date: 2026-09-29. Orchestrated by Fable 5.1 with nine Fable subworkers.

## 1. Short answer

**Would the suggested changes fix the differences? Partly.** The suggestions point at the right problems, but most of them are written as observations, not as rules a screener can apply. Three findings decide the outcome:

1. **Two missing facts cause most differences.** In 71 of the 137 differences the LLM answered "maybe" because the abstract does not name the prescribers (34) or does not name the country (37). The resolution was "include" in all 71.
2. **Suggestion 11 ("maybe means include") is the biggest lever and the biggest risk.** It closes 75 of the 84 "maybe → include" differences. Applied as a blanket rule it also turns 26 of the 32 "maybe → exclude" records into confident includes. 44 of the 85 differences that the list fixes are fixed by suggestion 11 alone.
3. **The Population contradiction (Chinese list, item 1) is real and is caused by the prompt, not by the abstracts.** The LLM answered Population "yes" in 70 agreed-include records that name no prescriber, and "maybe" in 63 differing records that name no prescriber. Two records with the same title got opposite answers. The words 我院, 本院 and 某院 were understood as "hospital" every time, so they are not the cause.

| Result for the 137 differences | Count |
|---|---|
| Fixed by the listed suggestions as worded | 85 |
| of which fixed by suggestion 11 alone | 44 |
| of which fixed by another suggestion (with or without 11) | 41 |
| Partly fixed (right idea, wording needs a rule, or a second cause remains) | 43 |
| Not fixed by any listed suggestion | 9 |

Other results:

- **Suggestion 17 (title not screened) is not supported.** The title is sent to the LLM in every judgment, and the LLM used the title whenever the country was there. In no record was the country named in the title and missed.
- **39 of the 137 resolutions should be re-checked** (9 look wrong, 30 are debatable). Several near-identical records were resolved in opposite directions. No criteria wording can reproduce labels that differ for the same content.

Section 5 contains a full revised criteria text. Section 6 lists eleven boundary decisions the team has to make before the text is final.

## 2. Data and method

- All 299 articles with a conflict resolution were pulled from the local API, with the six LLM answers, explanations and quotes per article.
- The LLM answers six questions per article (Population, Intervention, Comparator, Outcome, Study characteristics, Other = country). Overall LLM decision: any "no" gives "no"; otherwise any "maybe" gives "maybe"; otherwise "yes". This rule reproduces all 299 overall decisions.
- The criteria text in the project is the original version. Items the team marked "corrected now" or "added now" (Ethiopia, tuberculosis, implementation-only, dose individualisation) are not in it, so the judgments show the behaviour before those changes.

| Human | LLM | Resolution | Articles | LLM equals resolution |
|---|---|---|---|---|
| no | yes | yes | 115 | yes |
| yes | no | no | 47 | yes |
| yes | maybe | yes | 57 | no |
| no | maybe | yes | 27 | no |
| no | maybe | no | 32 | no |
| no | yes | no | 17 | no |
| yes | no | yes | 4 | no |

The LLM equals the resolution in 162 of 299 and differs in 137. Of the 137, 116 are LLM "maybe" and 21 are direct contradictions.

Work split:

| Batch | Content | Articles |
|---|---|---|
| A1, A2 | LLM maybe, resolution yes, not Chinese | 52 |
| B | LLM maybe, resolution yes, Chinese | 32 |
| C | LLM maybe, resolution no, not Chinese | 23 |
| D | LLM maybe or yes, resolution no, Chinese | 18 |
| E | LLM yes → no (8) and LLM no → yes (4), not Chinese | 12 |
| F1a, F1b, F2 | Control: LLM yes and resolution yes | 115 |

Each subworker read every title, abstract (Chinese in Chinese) and all six LLM explanations, assigned a root cause from a shared list, and rated every relevant suggestion as fixes, partial, no effect or would worsen. Coverage was checked by script: 137 of 137 differences and 115 of 115 control records are coded, each exactly once.

Correction made during the run: the review-detail API cuts abstracts at 2000 characters. This affected 24 of the 137 differences. The four affected subworkers re-coded those records from the full abstracts. Two codings changed, both in batch E.

Supporting data (per-article JSON, subworker notes, scripts): `~/Developer/forska-criteria-analysis/2026-09-29-com5/`.

## 3. Reasons for the differences, by category

### 3.1 LLM undecided or excluding, resolution is include (88 articles)

| Category | Articles | What happens |
|---|---|---|
| Country not stated in the record | 37 | No country name in title or abstract. The LLM requires a country name to look up in the list. It rejects "developing country", health-system terms, journal and citation lines. All 37 are non-Chinese records. |
| Prescriber not named | 34 | The intervention targets antibiotic use in a hospital or clinic, but no doctor is named. The LLM reads "Involving prescribers" as a condition the text must prove. 26 Chinese, 8 other. |
| Resolution questionable | 6 | Three US studies, a general ICU quality programme, a nursing study, and a pharmacist study with no antibiotic content. The LLM's doubt or "no" follows the criteria. |
| Intervention type not recognised | 4 | Before and after a date or event with no intervention named (3, Chinese: a cut-off date, hospital accreditation, a guideline-referenced survey). IV-to-oral switch cohort (1). |
| Country list gap or several countries | 3 | Ethiopia has no income group in the list (2). Four South American countries, one of them high income (1). |
| Outcome or design uncertain | 3 | Infection result only (1), groups not described (1), all-drug clause applied to an antibiotic-only programme (1). |
| Mixed target group | 1 | Campaign aimed at the public and at prescribers (Egypt). |

### 3.2 LLM undecided or including, resolution is exclude (49 articles)

| Category | Articles | What happens |
|---|---|---|
| Publication type or no results | 15 | 12 records with aims only (11 of them registry-style), 1 registry record that states a result, 1 conference abstract, 1 news digest. The LLM saw "aims only" and still answered maybe or yes, because results might exist in the full text. |
| No intervention evaluated | 9 | One-off audits, utilisation surveys, gap analysis. The word "intervention" (干预) appears in the title, aim or conclusion only. |
| Criteria silent | 6 | Insurance list policy, disease-programme screen-and-treat (syphilis), a title-only record, country unknown, two ambiguous two-group designs. |
| Regimen comparison | 5 | Prophylaxis versus none, short versus long course. The LLM argued around the exclusion ("antibiotic versus none is not regimen versus regimen"). |
| Antibiotics peripheral | 3 | COPD care standards, COVID-19 telepharmacy, asthma guideline trial. |
| Resolution questionable | 3 | Three Chinese records with intervention, comparison and prescribing outcome, resolved "no" while twins were resolved "yes". |
| Infection prevention or clinical care | 2 | Surgical safety bundle, infusion adverse events. |
| Non-antibiotic antimicrobial | 2 | Tuberculosis programme, isoniazid preventive therapy. |
| Implementation only | 2 | Provider performance and readiness (Bangladesh), lessons learnt (Uganda). |
| KAP-only outcomes | 1 | Knowledge, attitude and self-reported practice questionnaire (知信行). |
| Vague mention | 1 | Klebsiella outbreak study; one sentence on antibiotic policy carried all six answers. |

### 3.3 Contributing causes across categories

| Contributing cause | Articles | Note |
|---|---|---|
| Country judged twice | 31 | The Population text says "prescribers from low- and middle-income countries". One missing country gives "maybe" on Population and on Other. The rule "Chinese means China" sits only in the Other prompt, so 7 Chinese records got a country doubt under Population. |
| Vague phrase reused | 13 | One phrase justifies four to six answers. |
| Criteria silent | 17 | The criteria do not address the situation (see section 6). |
| Study sample read as target | 12 | Counted in the Chinese include batch. The LLM wrote that the abstract "only describes patients". Abstracts describe the sample as patients, records or prescriptions as a matter of form. |

### 3.4 Structure problems behind the categories

1. **Inclusion lines can be read two ways.** The generated prompt says "Treat inclusion items as possible routes to inclusion unless the criteria text explicitly requires multiple conditions together". The Population list has four lines. The LLM sometimes takes line 1 ("Interventions that target antibiotic prescribing/use") as a sufficient route, and sometimes takes line 2 ("Involving prescribers ... doctors/physicians/dentists") as required. This produces the contradiction in the Chinese list, item 1.
2. **The Population section repeats two other sections.** Line 1 repeats Intervention and line 2 repeats the country. One issue then produces several "maybe" or "no" answers.
3. **The Comparator section cannot fail.** It has no exclusion and lists "No intervention" as an inclusion route. It answered "yes" in all 8 hard over-inclusions, also for one-off audits.
4. **"Maybe" has one meaning for every kind of missing information.** Missing prescriber name, missing country, missing intervention and missing results all give "maybe". The humans resolved the first two as include and the last two as exclude.
5. **Planned outcomes count as outcomes.** Outcome was "yes" in 8 of 12 records that report no results.

## 4. Answer to each suggestion

Effect counts are over the differing articles where the suggestion is relevant. The general list as received starts at item 4; items 1 to 3 were not in the request.

### General list

| # | Suggestion | Verdict | Fixes | Partial | No effect | Would worsen |
|---|---|---|---|---|---|---|
| 4 | Ethiopia not listed as LMIC | Fixes the cases where it mattered | 2 | 0 | 3 | 0 |
| 5 | Exclude tuberculosis treatment | Fixes | 2 | 0 | 1 | 0 |
| 6 | Trials with no reported results | Right problem, needs a rule | 0 | 14 | 0 | 0 |
| 7 | Exclude conference abstracts | Fixes, needs metadata | 1 | 0 | 0 | 0 |
| 8 | Exclude implementation-only studies | Fixes with a definition | 1 | 1 | 2 | 0 |
| 9 | Public and prescribers both targeted | Fixes | 1 | 1 | 1 | 0 |
| 10 | Several countries, majority LMIC | Fixes, needs a region rule | 1 | 3 | 2 | 0 |
| 11 | "Maybe" for lack of information means include | Replace by specific defaults | 75 | 9 | 7 | 26 |
| 12 | Dose individualisation, de-escalation, TDM | Does not fix alone | 0 | 4 | 2 | 0 |
| 13 | Lenient inclusion on a vague phrase | Right problem, needs a rule | 1 | 11 | 4 | 2 |
| 14 | Clinical antibiotic use implies prescribing | Main fix, write as a rule | 27 | 15 | 9 | 1 |
| 15 | All-drug interventions | Needs limits in both directions | 2 | 4 | 5 | 4 |
| 16 | Intervention mentioned, not evaluated | Useful, needs a test | 3 | 9 | 3 | 5 |
| 17 | Screen the title too | Not supported by the data | 0 | 3 | 56 | 0 |

**4. Ethiopia.** Fixes both records where the blank income group caused the "maybe" ("Optimizing prophylactic antibiotic use among surgery patients in Ethiopian hospitals"; "A Prospective Quality Improvement Program to Reduce Prolonged Postoperative Antibiotic Prophylaxis"). The LLM wrote: "the provided income-designation list leaves Ethiopia's income group blank". In three other Ethiopian records the LLM answered "yes" despite the blank. Venezuela is blank too. The blanks come from the World Bank list for fiscal year 2026, where both countries were unclassified. In the list for fiscal year 2027 (1 July 2026) Ethiopia is low income and Venezuela is lower middle income. Add a rule for blank entries so that the next list gap does not repeat the problem.

**5. Tuberculosis.** Fixes both records (isoniazid preventive therapy in an HIV clinic, Ethiopia; private provider programme for tuberculosis care, Mumbai). The LLM called isoniazid prescribing an "antibiotic-related outcome" because the original text does not mention tuberculosis. Write it as a definition of "antibiotic" and name the other groups as well (antivirals, antifungals, antimalarials, antiparasitic drugs). Not covered: disease programmes that screen and treat with an antibiotic, for example syphilis in antenatal care.

**6. Trials with no reported results.** Relevant in 14 records, partial in all. The exclusion is already in the criteria. The LLM noticed that a record "only states aims" and still answered "maybe" on Study characteristics in 9 of 12, and "yes" in 3, because results might exist in a full text. A restated observation will not change this. It needs the rule "judge the record you have" and the rule "an outcome counts only if a result is reported". With these two rules all 11 registry-style records in the exclude batch are excluded.

**7. Conference abstracts.** Fixes the one record found ("Evaluation of Antimicrobial Stewardship Program in the General Intensive Care Unit", annual scientific congress). The current sentence excludes conference abstracts only if they "do not report results"; the LLM read it that way and answered "yes". Make the exclusion unconditional and put it on its own line. Limit: a conference abstract can only be recognised when the record says so. The LLM receives title and abstract only, not the journal or publication type (see section 7).

**8. Implementation-only.** Fixes 1 (Bangladesh, the abstract calls itself an "implementation research study"), partial 1 (Uganda, lessons learnt). It needs a definition. Without one it can remove implementation studies that do report before and after prescribing data (two such records were resolved include).

**9. Public and prescribers.** Fixes the one record ("An educational intervention to promote appropriate antibiotic use ...", Minya, Egypt). The LLM contradicted itself: Population "yes" because the mixed target does not exclude, Intervention "no" because of "public awareness campaign". The exception must be written in the Intervention section, and the Population exclusions need the word "only".

**10. Several countries.** Fixes 1 (four South American countries, three of them LMIC). Partial in 3 records that name a region ("9 Latin American countries") and not the countries, so a majority cannot be counted. Add a sentence for region-only records and say whether "majority" means at least half.

**11. "Maybe" means include.** This suggestion matches what the resolvers did for missing prescriber names and missing countries. It cannot be used as worded, for three reasons:

- The LLM does not know the human decision, so "when AI says maybe and humans say yes" is not a rule it can apply.
- Every "maybe" in the exclude batches has the same stated reason, "not enough information". A blanket rule includes 26 of these 32 excluded records. Six are protected by suggestions 5, 7, 15 and 16.
- Among the 40 included records without a country name, a check of author affiliations found at least 7 from countries that the list classes as high income (United States 4, Saudi Arabia 1, Republic of Korea 1, Russian Federation 1). The rule reproduces the resolvers' choice at the price of full-text work on high-income studies.

Suggestions 11 and 6, 15, 16 pull in opposite directions on the same records. The criteria must say which wins. Replace suggestion 11 by a default per kind of missing information (section 5.1).

**12. Dose individualisation, de-escalation, TDM.** Does not fix any record alone. In both clear cases (vancomycin dose individualisation; neonatal de-escalation) the LLM already answered Intervention "yes". The doubt sat in Population: who acted. It works together with suggestion 14. Add IV-to-oral switch to the list. Open question: studies that compare patients managed with and without such a practice, with no programme introduced (section 6, decision 4).

**13. Lenient inclusion on a vague phrase.** The pattern is confirmed. One phrase typically carries four of the six answers. It is the main cause in 1 record and contributes in 12 more. In the control set 18 of 115 agreed includes rest on a vague phrase such as 采取相应对策 or 加强干预. As worded it gives the screener nothing to apply. It needs two rules: the intervention must be what the study sets out to evaluate, and a result with data must be reported. It would move 2 records away from their resolution (national ICU quality programme; clinical pharmacists in oncology), which are resolutions to re-check.

**14. Clinical antibiotic use implies prescribing.** The main fix: 27 fixed, 22 of them in the Chinese batch. Partial in 15 where a country doubt or a second "maybe" remains. Control evidence: the LLM already accepts this reasoning in 70 of 115 agreed includes. It must be written as a rule in the Population section. Caution: in the Chinese exclude batch the Population "maybe" worked as an accidental brake on 6 excluded records. Removing it flips 2 of them to "yes" unless the intervention rules are applied first.

**15. All-drug interventions.** The clause is already in the criteria as an inclusion line. Fixes 2 (COPD care standards, Karachi; COVID-19 telepharmacy, Egypt). Partial in 4 because the wording covers "all drugs" and not a bundle item, one indicator among many, or care for a non-infectious disease. Would worsen 4: in one record the LLM already misapplied the clause to an antibiotic-only programme (colistin stewardship), and three records resolved "include" have no antibiotic outcome (national ICU quality programme; pharmacists in oncology; pharmacists in an emergency department, where neither title nor abstract mentions antibiotics). Limit the clause to all-drug and general-care interventions, and re-check those three resolutions.

**16. Intervention mentioned, not evaluated.** The most useful rule for the exclude batches: fixes 3, partial 9. It needs a test: the abstract must say what was done and must report a comparison. It must also say where the evidence has to be. In two Chinese records the word 干预 appears in the title only. Note that the suggestion speaks of "maybe" answers, while the LLM also answered "yes" in such records. Would worsen 5 records resolved "include" where no intervention is named or where the event is organisational (a cut-off date, hospital accreditation, a pharmacy department's role, a survey title, the Ethiopian IV-to-oral switch cohort). The team must decide these (section 6, decisions 4 and 5).

**17. Screen the title.** Not supported. Checked in the code: the prompt has a section `article_title`, and all 1,794 judgments were made with the title. In all 8 records where a country name appears only in the title (7 differences, 1 control), the LLM used it. The LLM quoted "developing country" from a title and still answered "maybe", because no country name means the list cannot be applied. What the team observed has two real causes:

- The country is not in the record at all (27 records) or only indirectly (22 records).
- One title was cut at import: "Impact of a package of point-of-care diagnostic tests ... during the COVID-19 pandemic in" ends at 253 characters, just before "Burkina Faso". The LLM wrote "the provided title is truncated". Three of the 299 resolved records have titles cut at 253 to 255 characters.

The fix is a rule on what counts as evidence for the country, plus the import fix.

### Chinese studies list

| # | Suggestion | Verdict | Fixes | Partial | No effect | Would worsen |
|---|---|---|---|---|---|---|
| 1 | Population contradiction, combine with setting | Confirmed, fix by meaning | 23 | 16 | 7 | 2 |
| 2 | Reports and commentaries | Rare here, define "report" | 0 | 1 | 1 | 0 |
| 3 | Comparison of two regimens | Needs a test, emphasis is not enough | 0 | 7 | 5 | 0 |
| 4 | No specific intervention evaluated | Same as general 16 | 1 | 9 | 4 | 5 |
| 5 | Knowledge, attitude, perception only | Close the self-report gap | 0 | 2 | 2 | 0 |

**1. Population contradiction.** Confirmed with numbers.

| Records that name no prescriber | Population yes | Population maybe or no |
|---|---|---|
| Control, LLM yes and resolution yes (115) | 70 | 0 |
| Differences, Chinese (42) | 10 | 32 |
| Differences, other languages (55) | 23 | 32 |

- Twin records: "降钙素原指导重症感染患者抗生素应用的临床意义" exists twice. The record that writes 我院 got "maybe" ("does not explicitly state that prescribers ... were the intervention target"). The record with no facility term got "yes" ("targets antibiotic prescribing/use in a hospital inpatient setting"). Three more pairs show the same.
- The facility wording does not explain the answers. The LLM translated 我院, 本院, 某院 and 该院 as "hospital" in every case. The team's caveat is still important for the rule: the string 医院 is absent in 17 of the 32 Chinese "maybe → include" records and in 54 of the 89 Chinese control records. A rule tied to a word would fail. The rule has to go by meaning and has to accept clinical context (围手术期, 手术病例, 处方, 住院) when no facility is named.
- Combining Population with setting fixes 23 and is partial in 16, where no facility term exists, a country doubt remains, or the work is nurse-centred.

**2. Reports and commentaries.** Only one record in the differences is of this kind: a news digest of a study published in Health Affairs ("中国按人头付费改革对控制抗生素滥用效果显著"), LLM "yes". Define the term. "Report" alone can also hit primary research, which often calls itself a report.

**3. Comparison of two regimens.** Relevant in 12, fixes none as worded. The exclusion was in the criteria and the LLM set it aside with a reason each time. Two inclusion texts pull these studies in: "including surgical antibiotic prophylaxis" and the outcome "timing, route, dosing, duration". The rule needs a plain test (section 5.3). The resolutions are not consistent on this boundary either: two short-course prophylaxis studies were excluded and two similar ones included.

**4. No specific intervention evaluated.** Same finding as general suggestion 16. The added words "results of prescription audits" fix one record (帕累托法处方点评). In the others the LLM had the exclusion and hesitated because the title or aim mentions an intervention.

**5. Knowledge, attitude, perception only.** Partial in 2. The Chongqing community study (知信行) has a self-reported "behaviour" score, and the words "without behavioural outcomes" leave exactly that open. Say that questionnaire scores, including self-reported practice, are not prescribing outcomes.

### Causes that no listed suggestion covers

1. Country judged in two sections (31 records).
2. No rule on what counts as evidence for the country, and no rule for records with no country at all.
3. No definition of "evaluates an intervention". No section requires a reported comparison.
4. Planned outcomes accepted as outcomes.
5. No test that separates regimen studies from prescribing interventions.
6. Biomarker studies without a biomarker-guided group.
7. Interventions not aimed at antibiotic use: adverse-event handling, insurance list policy, general quality programmes.
8. Disease programmes that screen and treat (syphilis).
9. Registry records that state a result, title-only records, stub records (first paragraph in place of an abstract), news digests.
10. No stated order between "include when information is missing" and the exclusion rules.
11. Which year's income classification applies (Russian Federation: high income in the list, upper middle income in the study period).
12. Titles cut at import, and metadata (journal, affiliations) not given to the LLM.

## 5. Suggested criteria

Written in plain language so that a human screener and an LLM apply them the same way. No rule depends on a particular word. Each section judges one thing. The text keeps the six Covidence sections, with inclusion and exclusion lines that can be pasted in.

### 5.1 Rules that apply to all sections

1. Judge the record you have: title and abstract. Do not judge the paper that may exist behind it.
2. Each section asks one question. Do not judge the country under Population. Do not judge the intervention under Population or Outcome.
3. Apply the exclusion lines first.
4. When information is missing, use this table:

| What is missing | Answer |
|---|---|
| The prescribers are not named, and care takes place in a health facility | Yes |
| The country is not named, and nothing in the record points to a high-income country | Yes, with the note "country to verify at full text" |
| What was done (the intervention) is not described anywhere | No |
| No comparison is reported (with and without, before and after) | No |
| No result is reported, only aims or methods | No |
| The intervention concerns all drugs or general care, and no antibiotic result is reported | No |
| Anything else that cannot be decided | Maybe |

5. Base each answer on the part of the abstract that concerns that section. One sentence cannot carry every section.

### 5.2 Population

Question: is the intervention aimed at people who prescribe antibiotics in a formal health facility?

Inclusion criteria (any one line is enough):

- The intervention is meant to change how antibiotics are chosen, started, dosed, timed or stopped for patients cared for in a formal health facility, at any level of care (primary, secondary, tertiary; inpatient or outpatient).
- The prescribers do not have to be named. In a health facility antibiotics are prescribed by doctors, dentists or other authorised prescribers, so assume they are involved.
- A health facility can be described in any way: a named hospital, "our hospital", "this hospital", "a hospital", a department, ward, intensive care unit, clinic or health centre, or patients described as inpatients, outpatients or surgical patients. Judge by meaning, in any language.
- Abstracts describe the study sample as patients, medical records or prescriptions. That is the sample. It is not the target of the intervention and is no reason for doubt.
- Pharmacist-led or nurse-led interventions are included when they concern what is prescribed: whether an antibiotic is given, which one, dose, timing, route or duration.
- National or regional policies are included when their effect is measured as antibiotic prescribing or use in health facilities.
- If the intervention is aimed at several groups and prescribers are one of them, include.

Exclusion criteria (the intervention is aimed only at these groups):

- Informal healthcare providers
- Community pharmacists or drug sellers
- Veterinarians
- Medical, pharmacy or nursing students without independent prescribing roles
- Patients, carers or community members
- Pharmacists or nurses whose work concerns only supply, storage, dispensing, preparation or administration of drugs, or patient education

Answer "maybe" only if nothing in the record shows where care was delivered or who was targeted.

### 5.3 Intervention

Definitions:

- Antibiotic: a drug against bacteria, used to treat or prevent a bacterial infection. Drugs for tuberculosis (treatment or preventive therapy, for example isoniazid), antivirals, antifungals, antimalarials and antiparasitic drugs are not antibiotics in this review.
- Intervention: something done to change how prescribers use antibiotics. Examples: a policy, restriction or pre-authorisation; education or training; audit with feedback; prescription review by pharmacists; a guideline, protocol or clinical pathway; decision support; an antimicrobial stewardship programme; a test used to decide on antibiotics (procalcitonin, CRP, rapid diagnostic test, culture and susceptibility workflow); therapeutic drug monitoring; dose individualisation; de-escalation; switch from intravenous to oral treatment.

Inclusion criteria (all three must be true):

1. What was done is an intervention as defined above. It may be named in general terms (management measures, supervision, rectification) and may be a hospital-wide or national event (campaign, guideline roll-out, quality-improvement cycle).
2. The intervention is what the study sets out to evaluate: it is named in the objective or is the main exposure.
3. The abstract reports a comparison between a period or group with the intervention and one without it.

Further inclusion rules:

- Any antibiotic, any infectious disease (including surgical antibiotic prophylaxis), any age group, any level of care.
- If the intervention targets all medicines, general quality of care or the care of one condition, include only if antibiotic prescribing or use is reported as a named result with data. This condition does not apply to interventions that are about antibiotics.
- If the same intervention is aimed at the public and at prescribers, include.

Exclusion criteria:

- Descriptions without an evaluated intervention: antibiotic utilisation, prescription audits or appropriateness measured at one point in time, resistance patterns, surveillance, stewardship metrics, gap analyses, needs assessments.
- An intervention that appears only in the title, aim, background or conclusion, or that is only recommended or called for.
- Regimen studies: patients are put into groups by the antibiotic treatment they receive (one drug or schedule against another, short against long course, prophylaxis against no prophylaxis, antibiotic against placebo), and the study asks which group has better clinical results. Test: does the study ask which antibiotic treatment works better for patients (exclude), or whether an action changed what prescribers do (include)?
- Biomarker studies that only measure levels or diagnostic value. Include only if the test result was used to decide on antibiotics in one group, compared with a group managed without the test.
- Interventions that target drugs other than antibiotics.
- Interventions aimed at antibiotic sales or dispensing in community pharmacies.
- Public awareness campaigns aimed only at patients or the public.
- Infection prevention, surgical safety or nursing care bundles, unless improving antibiotic use is a stated aim and an antibiotic result is reported.
- Implementation-only studies: they describe how a guideline or programme was rolled out or received (readiness, fidelity, barriers, uptake, lessons learnt) and do not compare antibiotic prescribing or use against a baseline or control.

### 5.4 Comparator

Inclusion criteria:

- The abstract reports results for a period or group with the intervention against a period or group without it: a different intervention, baseline, standard or historical practice, or a control group with no intervention.

Exclusion criteria:

- Results are reported for one point in time or one group only (single audit, survey, case series).
- "No intervention" means a control group. It does not mean that studies without any intervention are eligible.

### 5.5 Outcome

An outcome counts only if the abstract reports a result for it (a number or a direction of change). A planned outcome, a stated aim or a title is not an outcome.

Inclusion criteria: the primary and secondary outcomes as in the current text. Add:

- If an antibiotic-use intervention was evaluated and the abstract reports only infection, resistance, clinical or cost results, answer yes.

Exclusion criteria:

- Studies that report only knowledge, attitudes, perceptions or satisfaction. Scores from questionnaires, including self-reported practice, are not prescribing outcomes. A prescribing outcome comes from prescriptions, medical records, dispensing or consumption data.
- Studies that report only clinical efficacy of one antibiotic treatment against another.

Remove the exclusion "Studies that do not evaluate a specific intervention" from this section. It is judged under Intervention and Comparator.

### 5.6 Study characteristics

Inclusion criteria: designs as in the current text, published from year 2000.

Exclusion criteria, each on its own line:

- Records that report no finding: only background, aims, hypotheses, design or planned methods. This holds for every design, also for randomised trials.
- Study protocols and trial-registry records.
- Conference abstracts, posters and meeting proceedings, whether or not they report results.
- Reviews and meta-analyses.
- Editorials, commentaries, opinion pieces, letters without data, news items, and digests of a study published elsewhere.
- Qualitative-only studies.
- Modelling or simulation studies without empirical evaluation of an intervention.

### 5.7 Other (country)

Inclusion criteria:

1. Use everything in the record to find the setting: title, abstract, city, province, institution, health-system terms, currency, named national guidelines, journal or citation line, language.
2. A country is named and it is low or middle income in the list: yes. It is high income: no.
3. If the study is in Chinese, assume the setting is China.
4. Several countries: yes if at least half are low or middle income.
5. Only a region is named: yes if most countries of the region are low or middle income (for example Latin America, sub-Saharan Africa, South Asia). For a mixed region, yes with the note "country to verify".
6. No country is named, but the record describes its setting as developing, low-income, low-resource or resource-limited, or points to a low- or middle-income country: yes, and name the evidence.
7. No country is named and nothing points anywhere: yes, with the note "country to verify at full text".
8. If the income group of a country is blank in the list, use its most recent World Bank group. Ethiopia: low income. Venezuela: lower middle income.

Exclusion criteria:

- Studies from high-income countries, including records with no country name that point to a high-income country (for example a national society, a grading system or a policy term of a high-income country).

Replace the country list with the World Bank list for fiscal year 2027, which has no blank entries for Ethiopia and Venezuela. The six changes in that list (Jordan, Micronesia, Philippines, Sri Lanka, Togo, Viet Nam) all stay inside the low- and middle-income group. These facts come from the World Bank's summary of changes of 1 July 2026; check them against the published list before use.

## 6. Decisions for the team

The resolutions are not consistent on these points, or the criteria are silent. The wording in section 5 assumes the first option where one is marked "assumed".

| # | Decision | Evidence |
|---|---|---|
| 1 | Country unknown: include with a note (assumed), or keep as "maybe" for a human. | Resolvers included all 40 such records. At least 7 are high-income studies. |
| 2 | Income group: current list (assumed) or the group at the time of the study. | Russian record, study period 2006 to 2012. |
| 3 | Prescribers who are not doctors: clinical officers, prescribing nurses, village doctors, "health workers". | Resolvers accepted them (Kenya, Burkina Faso, rural China). |
| 4 | A prescribing practice as exposure, with no programme introduced (IV-to-oral switch, de-escalation cohorts). | Ethiopia and Brazil resolved include. Suggestion 16 would exclude them. |
| 5 | Before and after a date or an organisational event, with no intervention described (cut-off date, hospital accreditation). | "2011年我院应用抗菌药物的回顾性分析" included, "抗菌药物在新生儿病房中的应用" excluded. |
| 6 | Financing, reimbursement, pricing and insurance list policies. | Capitation reform treated as in scope, insurance list change excluded. |
| 7 | Disease programmes that screen and treat with an antibiotic (syphilis). | Meets every criterion as written, resolved exclude. |
| 8 | Registry records that state a result. | Tanzania single-dose prophylaxis, resolved exclude. |
| 9 | Title-only records: decide from the title, or always send to a human. | Cuba and Thailand records. |
| 10 | Surgical prophylaxis: protocol against habit (include) versus short against long course (exclude). | Two pairs resolved in opposite directions. |
| 11 | Nurse-delivered preparation and administration quality. | Two records included although the criteria admit nurse-led work only if aimed at prescribing. |

## 7. Notes for the platform (forska.ai)

These are not criteria changes, but they cause part of the differences.

1. **Generated prompt text.** The sentence "Treat inclusion items as possible routes to inclusion unless the criteria text explicitly requires multiple conditions together" comes from the import service, not from the team. It is the source of the two readings in section 3.4. The revised criteria state "any one line" or "all three" per section, so the generated sentence should defer to that.
2. **One "maybe" rule for all sections.** The generated rule "Answer maybe if the report does not provide enough information" applies to every kind of missing information. The table in section 5.1 should replace it.
3. **Metadata.** Journal name, publication type, year and author affiliations are not given to the LLM. They would settle most of the 37 country cases and would make conference abstracts recognisable.
4. **Titles cut at import.** 3 of 299 resolved records have titles cut at 253 to 255 characters.
5. **Abstract cut at 2000 characters in the review-detail route** (`LEFT(article_summary, 2000)` in `projectsRoutesPostArticleReviewDetails.ts`). 52 of the 299 resolved records are longer. The LLM saw the full abstract. A person reading the detail view sees less than the LLM did.
6. **Confidence is 50 in every judgment**, so it carries no information.
7. **Overall decision.** A "maybe" on Other alone could count as include with a flag, so that these records do not show up as conflicts.
8. **Measuring the effect.** The revised criteria can be tested by running them on the same 299 resolved articles in a new project and comparing with this run. This has not been done.

## 8. Resolutions to re-check

Nine resolutions look wrong when read against the criteria and against similar records:

| Id | Title | LLM | Resolution | Reason |
|---|---|---|---|---|
| dba33fdb | Implementation of an antimicrobial stewardship program in a rural hospital | maybe | yes | Affiliation in Washington State, United States. |
| 3c62f0b2 | Reducing Vancomycin Use in a Level IV NICU | maybe | yes | Journal Pediatrics; affiliation in Washington DC, United States. |
| 4c3bb173 | Remote Stewardship for Medically Underserved Nurseries | maybe | yes | Affiliations in Texas, United States. |
| f17cb287 | Effects of a national quality improvement program on ICUs in China | maybe | yes | General quality programme, no antibiotic prescribing outcome. |
| b3343e32 | 护理管理对神经外科抗菌药物应用的影响 | maybe | yes | Nursing management of preparation and infusion, no prescribing aim. |
| 088f6d19 | Direct economic impact of pharmacist's interventions in emergency department | no | yes | Title and abstract do not mention antibiotics. |
| 393fa915 | 抗生素合理干预对血流感染患者的预后研究 | maybe | no | Intervention against no intervention, with prescribing outcome. Twins resolved yes. |
| a54245eb | 抗生素不合理应用的原因分析与解决对策 | yes | no | Pharmacist-led measures, 4.76% against 23.11%. Six records of the same design resolved yes. |
| 44fc4a18 | 门诊抗菌药物调整后的用量分析 | yes | no | Restriction with before and after consumption. Three similar records resolved yes. |

The country of the three United States records was taken from author affiliations, which are outside the screened text.

Thirty more resolutions are debatable. They are marked in the appendix. If the questionable resolutions are counted as LLM errors, the LLM error rate is overstated.

## 9. Appendix: all 137 differences

Category codes:

| Code | Meaning |
|---|---|
| U1 | Prescriber not named |
| U2 | Country not stated in the record |
| U3 | Country list gap or several countries |
| U4 | Intervention type not recognised |
| U5 | Mixed target group |
| U6 | Outcome or design uncertain |
| U7 | Sparse record |
| O1 | No intervention evaluated |
| O2 | Regimen comparison |
| O3 | Publication type or no results |
| O5 | Antibiotics peripheral |
| O6 | Non-antibiotic antimicrobial |
| O7 | KAP-only outcomes |
| O8 | Not LMIC |
| O9 | Implementation only |
| O10 | Infection prevention or clinical care |
| O11 | Vague mention |
| X1 | Resolution questionable |
| X2 | Criteria silent |
| X9 | Other (named in the row) |

Columns: "Not yes" lists the sections where the LLM did not answer yes (P Population, I Intervention, C Comparator, O Outcome, S Study characteristics, X Other; m maybe, n no). "Fixed" is the result of applying the listed suggestions as worded. "Suggestions" shows each relevant suggestion with its effect, for example G14:+ (+ fixes, ~ partial, 0 no effect, − would worsen); G is the general list, C the Chinese list. "Check" marks resolutions to re-check (W looks wrong, D debatable).

### LLM maybe, resolution yes (84)

| # | Id | Title | Lang | Human | Not yes | Cause | Also | Fixed | Suggestions | Check |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | cd179aea | Changes in antibiotic use associated with the National Centralized Dr… | other | yes | Pm | U1 | X2 | yes | G11:+ G14:~ C1:+ |  |
| 2 | 06c1fd04 | Evaluation of the Effectiveness of Dose Individualization to Achieve… | other | yes | Pm | U1 | U4 | yes | G11:+ G12:~ G14:+ C1:+ |  |
| 3 | 6338a651 | Exploring the potential impact of empiric antibiotic de-escalation fo… | other | yes | Pm | U1 | U4 | yes | G11:+ G12:~ G14:+ C1:+ | D |
| 4 | 678c39f4 | Impact of implementing a vancomycin protocol to reduce kidney toxicit… | other | no | Pm | U1 | U4 | yes | G11:+ G12:~ G14:+ C1:~ |  |
| 5 | 5dab9cbc | Implementation of Smart Triage combined with a quality improvement pr… | other | yes | Pm | U1 | U4 | yes | G10:0 G11:+ G14:~ G15:0 C1:~ |  |
| 6 | fe328769 | Overuse of antibiotics for urinary tract infections in pregnant refug… | other | no | Pm | U1 |  | yes | G11:+ G14:+ G16:0 C1:~ | D |
| 7 | 5a02a920 | Serum Procalcitonin as a Biomarker to Determine the Duration of Antib… | other | yes | Pm | U1 |  | yes | G11:+ G14:+ C1:~ |  |
| 8 | 06065f62 | The impact of optimizing microbial diagnosis processes on clinical an… | other | yes | Pm | U1 |  | yes | G11:+ G14:~ C1:~ |  |
| 9 | 4b5045f9 | A new antibiotic stewardship program approach is effective on inappro… | other | yes | Xm | U2 |  | yes | G11:+ G17:0 |  |
| 10 | c4fdc6b1 | Antibiotic Stewardship in the Preoperative Surgical Setting: Optimizi… | other | yes | Xm | U2 |  | yes | G10:0 G11:+ G17:0 | D |
| 11 | bd32a775 | Antibiotic stewardship and nosocomial infection prevention in critica… | other | yes | Pm Xm | U2 | U1 | yes | G11:+ G14:~ G17:0 C1:~ |  |
| 12 | 19c307ea | Antibiotics prescribing patterns before vs after minimum inhibitory c… | other | yes | Xm | U2 |  | yes | G11:+ G17:0 | D |
| 13 | 61d6d757 | Antimicrobial stewardship interventions reduce the time to the first… | other | yes | Xm | U2 | U3 | yes | G10:~ G11:+ G17:0 |  |
| 14 | 4f8dae9e | Antimicrobial stewardship programs in adult intensive care units in L… | other | yes | Xm | U2 | U3 | yes | G10:~ G11:+ G17:0 |  |
| 15 | 4006c6d2 | Antimicrobial stewardship programs in seven Latin American countries:… | other | yes | Xm | U2 | U3 | yes | G8:0 G10:~ G11:+ G17:0 | D |
| 16 | e4bb2f05 | Assessment of perioperative antimicrobial prophylaxis using ATC/DDD m… | other | yes | Pm Xm | U2 |  | yes | G11:+ G14:0 G17:0 |  |
| 17 | 8e7dff98 | Cost minimization analysis on IV to oral conversion of antimicrobial… | other | yes | Xm | U2 |  | yes | G11:+ G17:0 |  |
| 18 | 30a9209a | Different antibiotic strategies in transient tachypnea of the newborn… | other | yes | Pm Xm | U2 | U1 | yes | G11:+ G14:~ G17:0 |  |
| 19 | cae51a0a | Educational intervention program to optimize the use of antibiotics:… | other | yes | Xm | U2 |  | yes | G11:+ G17:0 |  |
| 20 | 3b2d05e3 | Effect and cost of perioperative use of antibiotics in coronary arter… | other | yes | Xm | U2 |  | yes | G11:+ G17:0 |  |
| 21 | 27c71927 | Effect of Patient and Provider Education on Antibiotic Overuse for Re… | other | yes | Pm Xm | U2 |  | yes | G9:0 G11:+ G14:0 G17:0 | D |
| 22 | 241cdfa2 | Effect of an intervention targeting inappropriate continued empirical… | other | yes | Pm Xm | U2 |  | yes | G11:+ G14:0 G17:0 | D |
| 23 | b140ef84 | Effects of clinical pharmacist intervention on the quality monitoring… | other | yes | Xm | U2 |  | yes | G11:+ G15:0 G17:0 | D |
| 24 | 324b6577 | Evaluación de la implementación de un Programa de Uso Optimizado de A… | other | yes | Pm Xm | U2 | U1 | yes | G11:+ G14:~ G17:0 |  |
| 25 | c6c3253b | Impact of Clinical Pharmacists' Interventions on Medication Use and D… | other | no | Pm Xm | U2 | X1 | partial | G11:+ G13:− G15:− G17:0 | D |
| 26 | bed4ef47 | Impact of a package of point-of-care diagnostic tests, a clinical dia… | other | yes | Pm Xm | U2 | U1 | yes | G11:+ G14:~ G17:~ |  |
| 27 | d0bb86d4 | Impact of an Antibiotic Stewardship Program on Antibiotic Prescriptio… | other | yes | Pm Xm | U2 |  | yes | G11:+ G14:0 G17:0 |  |
| 28 | 0cb40038 | Impact of an Antimicrobial Stewardship Intervention on Within- and Be… | other | no | Xm | U2 |  | yes | G11:+ G17:0 | D |
| 29 | 33fdf57c | Impact of an Antimicrobial Stewardship Program on Broad Spectrum Anti… | other | yes | Pm Xm | U2 | U1 | yes | G11:+ G14:~ G17:0 |  |
| 30 | e63c7a67 | Impact of antibiotic restriction on broad spectrum antibiotic usage i… | other | yes | Xm | U2 |  | yes | G11:+ G17:~ |  |
| 31 | 82cf1dcd | Impact of the Antibiotic Stewardship Program on Prevention and Contro… | other | yes | Pm Xm | U2 | X9 (lmic condition duplicated in population) | yes | G11:+ G17:0 |  |
| 32 | 34860326 | Impacto del panel respiratorio molecular multiplex FilmArray® en la p… | other | yes | Pm Xm | U2 | X9 (lmic condition duplicated in population) | yes | G11:+ G17:0 |  |
| 33 | 1b2ba0f5 | Implementation of the Smart Use of Antibiotics Program to Reduce Unne… | other | yes | Xm | U2 |  | yes | G11:+ G17:~ |  |
| 34 | 5413d7c0 | Interventions by Clinical Pharmacists Reduced Unnecessary Antibiotics… | other | yes | Pm Xm | U2 | X9 (lmic condition duplicated in population) | yes | G11:+ G17:0 |  |
| 35 | 7a3ee10d | Mobile health application to assist doctors in antibiotic prescriptio… | other | yes | Xm | U2 |  | yes | G11:+ G17:0 |  |
| 36 | b06eac91 | Multidisciplinary administrative-professional-technical interventions… | other | yes | Pm Xm | U2 | X9 (lmic condition duplicated in population) | yes | G11:+ G17:0 |  |
| 37 | a2adf7f9 | Peri-operative antibiotic prophylaxis: adherence to guidelines and ef… | other | yes | Pm Xm | U2 | X9 (lmic condition duplicated in population) | yes | G11:+ G17:0 |  |
| 38 | e34dde0f | Reversing the Trend of Antimicrobial Resistance in ICU: Role of Antim… | other | yes | Xm | U2 |  | yes | G11:+ G17:0 |  |
| 39 | d38cf23c | Sustained Improvement of Appropriateness in Surgical Antimicrobial Pr… | other | yes | Xm | U2 |  | yes | G11:+ G17:0 |  |
| 40 | 9004038e | The Impact of an Antibiotic Stewardship Program on the Consumption of… | other | yes | Pm Xm | U2 | X9 (lmic condition duplicated in population) | yes | G11:+ G17:0 |  |
| 41 | 6b122899 | The effect of limiting antimicrobial therapy duration on antimicrobia… | other | yes | Pm Xm | U2 | X9 (lmic condition duplicated in population) | yes | G11:+ G17:0 |  |
| 42 | 9a6f8018 | The impact of policy guidelines on hospital antibiotic use over a dec… | other | yes | Pm Xm | U2 | X9 (lmic condition duplicated in population) | yes | G11:+ G17:0 |  |
| 43 | b174c76c | The impact of prescriptions audit and feedback for antibiotic use in… | other | yes | Pm Xm | U2 | X9 (lmic condition duplicated in population) | yes | G11:+ G17:0 |  |
| 44 | befd1f00 | The potential counter effect of COVID-19 outbreak on an antimicrobial… | other | yes | Pm Xm | U2 | X9 (lmic condition duplicated in population) | yes | G11:+ G17:0 |  |
| 45 | 1147d81f | [Efficacy of Management for Rational Use of Antibiotics in Surgical D… | other | yes | Pm Xm | U2 | X9 (lmic condition duplicated in population), X2 | partial | G11:~ G17:0 | D |
| 46 | 8c8ebc2a | A Prospective Quality Improvement Program to Reduce Prolonged Postope… | other | yes | Xm | U3 |  | yes | G4:+ G11:+ G17:0 |  |
| 47 | 1cfa40e2 | Optimizing prophylactic antibiotic use among surgery patients in Ethi… | other | yes | Xm | U3 |  | yes | G4:+ G11:+ G17:0 |  |
| 48 | eb81a956 | Impact of an antimicrobial stewardship program on colistin resistance… | other | yes | Im | U6 | X9 (all drugs outcome clause misapplied) | yes | G11:+ G15:− |  |
| 49 | f17cb287 | Effects of a national quality improvement program on ICUs in China: a… | other | yes | Pm | X1 | U1 | partial | G11:~ G13:− G14:0 G15:− C1:~ | W |
| 50 | dba33fdb | Implementation of an antimicrobial stewardship program in a rural hos… | other | yes | Xm | X1 | U2 | partial | G8:0 G11:~ G17:0 | W |
| 51 | 3c62f0b2 | Reducing Vancomycin Use in a Level IV NICU. | other | yes | Pm Xm | X1 | U2, X9 (lmic condition duplicated in population) | partial | G11:~ G17:0 | W |
| 52 | 4c3bb173 | Remote Stewardship for Medically Underserved Nurseries: A Stepped-Wed… | other | yes | Pm Xm | X1 | U2, X9 (lmic condition duplicated in population) | partial | G11:~ G17:0 | W |
| 53 | 8c401caf | 144例Ⅰ、Ⅱ类切口围手术期预防性应用抗菌药物干预前后对比与分析 | zh | yes | Pm | U1 |  | yes | G11:+ G14:+ C1:+ |  |
| 54 | 93bac06e | 220例剖宫产患者围手术期抗菌药物应用情况对比分析 | zh | yes | Pm | U1 |  | yes | G11:+ G14:+ C1:+ |  |
| 55 | ee1a7d8e | 259例Ⅰ类切口围手术期预防用抗菌药物干预效果分析 | zh | yes | Pm | U1 | X9 (lmic doubt in population prompt) | yes | G11:+ G14:~ C1:~ |  |
| 56 | bbf017a8 | 3种清洁手术干预前后围术期预防性应用抗菌药物分析 | zh | yes | Pm | U1 |  | yes | G11:+ G14:+ C1:+ |  |
| 57 | 7800840d | PDCA循环法在抗菌药物管理中的应用效果研究 | zh | yes | Pm | U1 |  | yes | G11:+ G14:+ C1:+ |  |
| 58 | cd96eeab | 不合理使用抗菌药物的相关因素及干预措施分析 | zh | no | Pm | U1 | U5, X9 (lmic doubt in population prompt) | yes | G9:~ G11:+ G14:~ C1:~ |  |
| 59 | af2b6175 | 儿科抗生素合理应用价值分析 | zh | no | Pm | U1 |  | yes | G11:+ G14:+ C1:+ C3:0 | D |
| 60 | fe4a1db6 | 围手术期患者抗生素合理应用分析 | zh | no | Pm | U1 |  | yes | G11:+ G14:+ C1:~ |  |
| 61 | 64c44709 | 围手术期患者抗生素合理应用探析 | zh | no | Pm | U1 |  | yes | G11:+ G14:+ C1:+ |  |
| 62 | 2e522269 | 干预前后我院普外科围术期患者抗生素使用情况分析 | zh | yes | Pm | U1 |  | yes | G11:+ G14:+ C1:+ |  |
| 63 | b2be8528 | 德尔菲法构建的敏感指标在碳青霉烯类抗菌药物合理应用中的研究 | zh | no | Pm | U1 |  | yes | G11:+ G14:+ C1:+ |  |
| 64 | afed9f4a | 心内科抗菌药物安全监护与不良反应管理对策 | zh | no | Pm | U1 | X1 | yes | G11:+ G14:~ C1:~ C5:0 | D |
| 65 | 692c03c4 | 我院抗菌药物应用合理性评价与管理分析 | zh | no | Pm | U1 |  | yes | G11:+ G14:+ C1:+ |  |
| 66 | f5c573a8 | 我院门诊输液室抗菌药物针剂使用现状与管理对策 | zh | no | Pm | U1 |  | yes | G11:+ G14:+ C1:+ |  |
| 67 | 02924afe | 抗菌药物在儿科感染性疾病治疗中的应用情况分析 | zh | no | Pm | U1 |  | yes | G11:+ G14:+ C1:+ C3:0 | D |
| 68 | d86f7682 | 抗菌药物的应用与医院感染控制探讨 | zh | yes | Pm | U1 |  | yes | G11:+ G14:+ C1:+ |  |
| 69 | 973df167 | 某大型教学医院实施抗菌药物整治项目的效果分析 | zh | yes | Pm | U1 | X9 (lmic doubt in population prompt) | yes | G11:+ G14:~ C1:~ |  |
| 70 | cff0d0bd | 滥用抗生素的危害与应对措施 | zh | no | Pm | U1 | X9 (lmic doubt in population prompt) | yes | G11:+ G14:+ C1:+ |  |
| 71 | 649e0ff5 | 监测血清降钙素原对骨折手术感染抗菌药物应用影响分析 | zh | no | Pm | U1 | X9 (lmic doubt in population prompt) | yes | G11:+ G14:+ C1:~ |  |
| 72 | 8fc8790d | 肾功能不全患者抗生素应用现状分析 | zh | no | Pm | U1 |  | yes | G11:+ G14:+ C1:+ |  |
| 73 | 3bbeb89b | 血液科发热患者抗菌药物的应用探析 | zh | no | Pm | U1 | X2 | yes | G11:+ G14:+ C1:+ | D |
| 74 | cf57e130 | 降钙素原(PCT)指导重症加强治疗病房(ICU)严重感染的抗生素应用研究 | zh | no | Pm | U1 |  | yes | G11:+ G14:+ C1:+ |  |
| 75 | 85d5fb6b | 降钙素原指导重症感染患者抗生素应用的临床意义 | zh | no | Pm | U1 | X9 (lmic doubt in population prompt) | yes | G11:+ G14:+ C1:+ |  |
| 76 | b3d6e1a3 | 降钙素原检测在小儿呼吸道感染抗生素治疗中的应用探讨 | zh | no | Pm | U1 |  | yes | G11:+ G14:+ C1:+ C3:0 |  |
| 77 | 5756a6c9 | 降钙素原检测在慢性阻塞性肺疾病抗生素治疗中的应用 | zh | no | Pm | U1 | X9 (lmic doubt in population prompt) | yes | G11:+ G14:+ C1:+ |  |
| 78 | 23fab958 | 骨科围手术期抗生素合理应用的价值 | zh | no | Pm | U1 |  | yes | G11:+ G14:+ C1:+ |  |
| 79 | 1ea2f9c0 | 2011年我院应用抗菌药物的回顾性分析 | zh | yes | Im | U4 | X2 | partial | G11:~ G14:0 G16:− C1:0 C4:− | D |
| 80 | a16f6faa | 剑河县人民医院创建“二级甲等医院”前后抗生素应用情况分析 | zh | no | Pm Im | U4 | U1, X2 | partial | G11:~ G14:~ G16:− C1:~ C4:− | D |
| 81 | c9ba4a38 | 颅脑择期Ⅰ类清洁手术抗菌药物应用调查分析 | zh | no | Pm Im Om | U4 | U1, U6 | partial | G11:~ G14:~ G16:− C1:~ C4:− | D |
| 82 | c14c5b02 | 医院药剂科抗菌药物的使用与感染管理 | zh | no | Om | U6 | X2 | partial | G11:~ G14:0 G16:− C1:0 C4:− | D |
| 83 | 34477310 | 应用抗菌药物导致医院感染发生的控制措施 | zh | no | Om | U6 | X2 | yes | G11:+ G14:0 C1:0 | D |
| 84 | b3343e32 | 护理管理对神经外科抗菌药物应用的影响 | zh | no | Pm | X1 | U1 | yes | G11:+ G14:~ C1:~ | W |

### LLM maybe, resolution no (32)

| # | Id | Title | Lang | Human | Not yes | Cause | Also | Fixed | Suggestions | Check |
|---|---|---|---|---|---|---|---|---|---|---|
| 85 | 1eea21f1 | Gap analysis on antimicrobial stewardship program in central Thailand. | other | no | Pm Im Cm Om Sm | O1 | U7 | partial | G11:− G16:~ G17:0 C4:~ |  |
| 86 | 7e068efa | Poor compliance with the antibiotic policy in the intensive care unit… | other | no | Om | O1 |  | partial | G11:− G16:~ G17:0 C4:~ |  |
| 87 | abb10132 | Utilization of restricted antibiotics in a university hospital in Tha… | other | no | Sm | O1 | O11 | partial | G11:− G13:~ G16:~ C4:~ |  |
| 88 | eedb5ed8 | Impact of WHO's Surgical Safety Checklist-Based Program on Cleft-lip… | other | no | Im | O10 | O11, O5 | partial | G4:0 G11:− G13:~ G15:~ |  |
| 89 | d9f21e45 | [Prevention of wound infection in cardiac surgery: how much is topica… | other | no | Xm | O2 | O8 | partial | G11:− G17:0 C3:~ |  |
| 90 | ff5fbf6f | Assessment of the Use and Impact of a Molecular Identification Assay… | other | no | Pm Im Om Sm | O3 | O10, O7 | partial | G6:~ G11:− G17:0 C5:~ |  |
| 91 | 35d9e51b | Diagnostic Performance and Impact of a Multiplex PCR Pneumonia Panel… | other | no | Pm Xm | O3 | O10 | partial | G6:~ G11:− G16:~ G17:0 |  |
| 92 | 90f1b687 | Dynamic Clinical Decision Support Algorithms to Manage Sick Children… | other | no | Im Om Sm | O3 | O11 | partial | G6:~ G11:− G13:~ |  |
| 93 | 712a9b68 | Evaluation of Antimicrobial Stewardship Program in the General Intens… | other | no | Xm | O3 |  | yes | G7:+ G11:0 G17:0 |  |
| 94 | d6cba4a7 | Impact of Implementation of Antimicrobial Stewardship Comprehensive C… | other | no | Sm Xm | O3 | O10 | partial | G6:~ G11:− G13:~ G17:0 |  |
| 95 | 1a70c61f | Impact of a Procalcitonin-Guided Algorithm on Antimicrobial Utilizati… | other | no | Pm Sm Xm | O3 |  | partial | G6:~ G11:− G17:0 |  |
| 96 | 43924b10 | Introduction of Nitrofurantoin in Place of Ciprofloxacin in Patients… | other | no | Pm Sm Xm | O3 |  | partial | G6:~ G11:− G17:0 |  |
| 97 | 3ebc9615 | Lung Ultrasound in Procalcitonin- Guided Antibiotic Discontinuation i… | other | no | Pm Sm Xm | O3 |  | partial | G6:~ G11:− G17:0 |  |
| 98 | 618bbda6 | Non-antibiotic Prescribing for Acute Upper Respiratory Tract Infectio… | other | no | Pm Xm | O3 | O2 | partial | G6:~ G11:− G17:0 C3:~ |  |
| 99 | d3f32074 | Operational Research on Management at First Level Facilities for Chil… | other | no | Pm Im Sm Xm | O3 | O10 | partial | G6:~ G11:− G15:~ G17:0 |  |
| 100 | f7a8cbb2 | The Effect of Mobile Phone Text Message Reminders on Health Workers'… | other | no | Pm Im Om Sm | O3 | O5, O6 | partial | G6:~ G11:− G15:~ |  |
| 101 | 7444acb1 | The Use of a Procalcitonin (PCT)-Guided Protocol to Shorten the Durat… | other | no | Sm | O3 |  | partial | G6:~ G11:− |  |
| 102 | 1ade6660 | An emergency plan for management of COVID-19 patients in rural areas | other | no | Im | O5 | O11 | yes | G11:0 G13:~ G15:+ |  |
| 103 | 49b4979c | Use of an 'evidence-based implementation' strategy to implement evide… | other | no | Pm Im Xm | O5 | O11 | partial | G11:− G13:~ G15:~ G17:0 |  |
| 104 | e366969e | An Impact Evaluation of the Private Provider Interface Agency Program… | other | no | Pm Im Om | O6 | O3 | yes | G5:+ G6:~ G11:0 |  |
| 105 | d930586f | Opportunities and Challenges for Improving Anti-Microbial Stewardship… | other | no | Sm | O9 |  | partial | G8:~ G11:− |  |
| 106 | 79db4b4c | A pre-post quasi-experimental study of antimicrobial stewardship expl… | other | no | Pm Xm | X2 | O8, O2 | no | G11:− G12:0 G14:0 G17:0 | D |
| 107 | a4cde8d4 | Control de la utilización de antibióticos en los hospitales cubanos | other | no | Pm Im Cm Om Sm | X2 | U7 | no | G11:− G17:0 C4:0 | D |
| 108 | 68d8642c | 妇产科抗菌药物应用1075例的合理性分析及干预 | zh | no | Om Sm | O1 | O11, X9 (truncated abstract stub) | yes | G11:0 G13:~ G16:+ C4:~ | D |
| 109 | 3ef8eba0 | 我院门诊处方抗菌药物应用调查与分析 | zh | no | Pm Om | O1 | O11 | yes | G11:0 G16:+ C1:0 C4:~ |  |
| 110 | 56f1e871 | 抗菌药物在新生儿病房中的应用 | zh | no | Pm | O1 | X1 | partial | G11:− G16:~ C1:− C4:~ | D |
| 111 | 144f7024 | 血清降钙素原对危重新生儿应用抗菌药物的指导价值 | zh | no | Pm Im | O1 | O11 | partial | G11:− G16:~ C1:0 |  |
| 112 | cf9a3a97 | 门急诊不合理抗菌药物处方的帕累托法分析及干预效果 | zh | no | Om Sm | O1 | O11 | yes | G11:0 G13:~ G16:+ C4:+ |  |
| 113 | e1f92b1b | 急诊输液患者抗生素药物不良事件影响因素分析及干预体会 | zh | no | Pm Om | O10 | O11 | partial | G11:− G13:~ G16:~ C1:0 |  |
| 114 | e0baaace | 重庆市社区医务人员合理使用抗生素干预效果分析 | zh | no | Om | O7 |  | partial | G11:− C5:~ |  |
| 115 | 393fa915 | 抗生素合理干预对血流感染患者的预后研究 | zh | no | Pm | X1 | U1 | no | G11:− G14:− C1:− | W |
| 116 | 664e654e | Ⅰ类切口手术围手术期预防性应用抗菌药物的临床分析 | zh | no | Pm Im | X2 | X1, O2 | no | G11:− C1:0 C3:0 | D |

### LLM yes, resolution no (17)

| # | Id | Title | Lang | Human | Not yes | Cause | Also | Fixed | Suggestions | Check |
|---|---|---|---|---|---|---|---|---|---|---|
| 117 | 4bb5ee22 | Role of Prospective Audit in Antimicrobial Stewardship at the Surgery… | other | no | none | O1 | O9 | partial | G13:0 G16:~ C4:~ |  |
| 118 | 8c0af755 | Long-term outbreak of Klebsiella pneumoniae& third generation cephalo… | other | no | none | O11 | O1 | partial | G13:~ G16:~ C4:~ |  |
| 119 | da60d847 | An Individually Randomised Trial of Rapid Diagnostic Tests in Rural G… | other | no | none | O3 |  | partial | G6:~ G15:0 G17:0 |  |
| 120 | f79d0c81 | Benefit of a Single Preoperative Dose of Antibiotics in a Sub-Saharan… | other | no | none | O3 | X2 | partial | G6:~ C3:0 | D |
| 121 | 66029e44 | Standards of inpatient care during acute exacerbation of COPD in a te… | other | no | none | O5 | O11 | yes | G13:+ G15:+ G17:0 |  |
| 122 | 82fab51d | Improving tuberculosis screening and isoniazid preventive therapy in… | other | no | none | O6 | X2 | yes | G4:0 G5:+ |  |
| 123 | 6364be1e | Provider performance and facility readiness for managing infections i… | other | no | none | O9 | O1 | yes | G8:+ C4:~ |  |
| 124 | 35294bf0 | A multifaceted intervention to improve syphilis screening and treatme… | other | no | none | X2 | O10 | no | G5:0 G13:0 G15:0 | D |
| 125 | 44d41365 | 乳腺癌围手术期抗菌药物应用的临床研究 | zh | no | none | O2 | O1 | partial | C3:~ |  |
| 126 | 26e71046 | 慢性鼻窦炎围手术期抗生素合理应用 | zh | no | none | O2 | O11 | partial | G13:~ C3:~ |  |
| 127 | 4404744f | 普外科围手术期短程预防应用抗生素的效果观察 | zh | no | none | O2 |  | partial | C3:~ |  |
| 128 | 0337597d | 胸外科围手术期预防性应用抗生素研究 | zh | no | none | O2 |  | partial | C3:~ |  |
| 129 | cdae26c2 | 中国按人头付费改革对控制抗生素滥用效果显著 | zh | no | none | O3 | X9 (truncated abstract stub) | partial | C2:~ |  |
| 130 | a54245eb | 抗生素不合理应用的原因分析与解决对策 | zh | no | none | X1 |  | no | G16:0 C2:0 C4:0 | W |
| 131 | 44fc4a18 | 门诊抗菌药物调整后的用量分析 | zh | no | none | X1 |  | no | G16:0 C4:0 | W |
| 132 | aedb0f80 | 剖宫产围手术期预防应用抗生素的干预对照研究 | zh | no | none | X2 | O2, X1 | partial | C3:~ | D |
| 133 | 41b82db7 | 医保目录调整对医院抗菌药物使用倾向的影响 | zh | no | none | X2 | O5 | no | G15:0 C4:0 | D |

### LLM no, resolution yes (4)

| # | Id | Title | Lang | Human | Not yes | Cause | Also | Fixed | Suggestions | Check |
|---|---|---|---|---|---|---|---|---|---|---|
| 134 | 732b214a | Decreasing Inappropriate Use of Antibiotics in Primary Care in Four C… | other | yes | Xn | U3 |  | yes | G10:+ |  |
| 135 | 993f80e0 | Opportunities, associations, and impact of early intravenous to oral… | other | yes | Pn In On | U4 | X2 | partial | G4:0 G12:~ G16:− C4:− | D |
| 136 | 0219027b | An educational intervention to promote appropriate antibiotic use for… | other | yes | In | U5 | X2 | yes | G9:+ C5:0 |  |
| 137 | 088f6d19 | Direct economic impact of pharmacist's interventions in emergency dep… | other | yes | Pn In Cm On | X1 |  | no | G11:0 G12:0 G15:− | W |
