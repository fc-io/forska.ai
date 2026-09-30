# Criteria Resolution Fixes

Analysis target: `http://localhost:3000/compare-judgments/58f9ac02-6816-4853-9d8d-1e8f0f1b4c7e`

Comparison project: `com 5 - all resolutions`

Data used:

- Live comparison-project metadata from `/api/comparison-projects/58f9ac02-6816-4853-9d8d-1e8f0f1b4c7e`
- Read-only DuckDB studio snapshot created from the running app
- 137 rows where saved conflict resolution and LLM summary judgment differ

## Executive verdict

Most of the suggested changes would improve the disagreement pattern, especially the changes about LMIC handling, TB/antitubercular exclusions, implementation-only exclusions, public-plus-prescriber campaigns, multi-country LMIC handling, the title as evidence, implicit prescriber involvement, and dose/TDM/de-escalation stewardship.

The single most important caution is suggestion 11. A blanket rule that all `Maybe` answers become `Yes` would fix many false-negative title/abstract screens, but it would also wrongly include 32 rows where the LLM said `maybe` and conflict resolution was `no`. The safer rule is: include for full-text review when the record is plausibly eligible and no exclusion is clear; use `no` when a clear exclusion applies; reserve `maybe` for genuine scope uncertainty that cannot be resolved from title/abstract.

Several observed disagreements need wording beyond the listed suggestions:

- Do not treat the population/prescriber criterion as a standalone keyword gate. In a hospital/ward/clinic/perioperative setting, an evaluated change in antibiotic prescribing/use usually implies eligible prescriber involvement even when the abstract does not name doctors or prescribers. Setting alone is still insufficient: there must also be an evaluated antibiotic decision or prescribing/use outcome.
- Distinguish eligible surgical prophylaxis stewardship from ineligible surgical prophylaxis regimen/SSI-prevention efficacy comparisons.
- Exclude descriptive antibiotic-utilization audits, formulary/reimbursement studies, outbreak surveillance, restriction reports, and policy-compliance snapshots unless they evaluate a specific intervention's effect.
- Exclude reports, commentaries, editorials, letters, viewpoints, and similar non-original article types more explicitly.
- Exclude studies whose outcomes stop at knowledge, attitudes, perceptions, beliefs, intentions, awareness, or satisfaction without behavioral prescribing/use outcomes.
- Broaden the TB exclusion to vertical disease programs such as TB/IPT, syphilis, and malaria/antimalarial diagnostics when antibiotic stewardship is not the primary evaluated intervention.
- Clarify that biomarker/diagnostic/MIC/TDM work is eligible only when it is evaluated as a prescribing/use intervention, not merely as diagnostic performance, treatment efficacy, or PK/PD optimization.

## Decision split

| Conflict resolution | LLM judgment | Human summary | Rows | Main interpretation |
|---|---:|---:|---:|---|
| yes | maybe | yes | 57 | LLM was too cautious; most should have gone to full text. |
| yes | maybe | no | 27 | Conflict resolver overrode the original human no; usually plausible inclusion needing full text or broader interpretation. |
| yes | no | yes | 4 | Clearer false exclusions. |
| no | maybe | no | 32 | LLM was uncertain but an exclusion was actually clear. |
| no | yes | no | 17 | LLM false positives. |
| **Total** |  |  | **137** |  |

## Reason categories

### Conflict resolution yes, LLM maybe/no: 88 rows

These are mostly sensitivity misses.

| Category | Rows | Representative examples | Suggested changes that help |
|---|---:|---|---|
| LMIC/context too literal | 38 | `A Prospective Quality Improvement Program to Reduce Prolonged Postoperative Antibiotic Prophylaxis in Ethiopia`; `Antimicrobial stewardship programs in adult intensive care units in Latin America`; `Implementation of the Smart Use of Antibiotics Program... in a Developing Country`; `Decreasing Inappropriate Use of Antibiotics in Primary Care in Four Countries in South America` | 4, 10, 11, 17 |
| Chinese hospital/prescriber implicit pattern | 26 | `144例Ⅰ、Ⅱ类切口围手术期预防性应用抗菌药物干预前后对比与分析`; `PDCA循环法在抗菌药物管理中的应用效果研究`; `某大型教学医院实施抗菌药物整治项目的效果分析`; `骨科围手术期抗生素合理应用的价值` | 11, 14, 17, plus Chinese-specific wording below |
| Dose, diagnostic, TDM, de-escalation stewardship | 16 | `Evaluation of the Effectiveness of Dose Individualization to Achieve Therapeutic Vancomycin Concentrations`; `Exploring the potential impact of empiric antibiotic de-escalation...`; `Impact of implementing a vancomycin protocol to reduce kidney toxicity`; `降钙素原检测在慢性阻塞性肺疾病抗生素治疗中的应用` | 11, 12, 14 |
| Explicit-country stewardship/QI, target actor implicit | 4 | `Changes in antibiotic use associated with the National Centralized Drug Procurement policy in China`; `Effects of a national quality improvement program on ICUs in China`; `Impact of an antimicrobial stewardship program on colistin resistance... in Pakistan`; `Implementation of Smart Triage... in Kenya and Uganda` | 11, 14, 17 |
| Public plus prescriber mixed target | 2 | `An educational intervention to promote appropriate antibiotic use... in Egypt`; `Effect of Patient and Provider Education on Antibiotic Overuse for Respiratory Tract Infections` | 9 |
| Pharmacist/general medication intervention needing full-text check | 2 | `Direct economic impact of pharmacist's interventions in emergency department...`; `Impact of Clinical Pharmacists' Interventions on Medication Use...` | 11, 15 |

### Conflict resolution no, LLM maybe/yes: 49 rows

These are mostly specificity misses.

| Category | Rows | Representative examples | Suggested changes that help |
|---|---:|---|---|
| No-results, protocol-like, vague objective only | 12 | `Diagnostic Performance and Impact of a Multiplex PCR Pneumonia Panel...`; `Impact of a Procalcitonin-Guided Algorithm...`; `Dynamic Clinical Decision Support Algorithms...`; `An Individually Randomised Trial of Rapid Diagnostic Tests in Rural Ghana` | 6, 7, 13, 16 |
| Perioperative prophylaxis or SSI-prevention regimen studies | 10 | `Benefit of a Single Preoperative Dose of Antibiotics...`; `Impact of WHO's Surgical Safety Checklist-Based Program...`; `剖宫产围手术期预防应用抗生素的干预对照研究`; `乳腺癌围手术期抗菌药物应用的临床研究` | Needs extra wording; current suggestions do not fully cover this. |
| Implementation, audit, guideline-compliance only | 9 | `Poor compliance with the antibiotic policy in the ICU...`; `Provider performance and facility readiness...`; `Standards of inpatient care during acute exacerbation of COPD...`; `重庆市社区医务人员合理使用抗生素干预效果分析` | 8, 13, 16 |
| Descriptive utilization, restriction, formulary, or surveillance only | 8 | `Utilization of restricted antibiotics in a university hospital in Thailand`; `Long-term outbreak of Klebsiella pneumoniae...`; `医保目录调整对医院抗菌药物使用倾向的影响`; `门诊抗菌药物调整后的用量分析` | 13, 15, 16, plus extra wording |
| Vertical disease programs or non-target anti-infective care | 3 | TB PPIA quality-of-care study; syphilis screening/treatment trial; TB screening and isoniazid preventive therapy in HIV clinic | 5, plus broader vertical-program wording |
| Narrow clinical/drug-specific treatment, ADE, or broad medication intervention | 7 | ceftazidime/avibactam PK/PD target study; COVID telepharmacy emergency plan; antibiotic adverse-drug-event intervention; PCT guidance in critically ill neonates | 13, 15, 16, plus extra wording |

## Suggestion-by-suggestion verdict

| # | Suggested change | Present in project criteria? | Would it fix observed differences? | Recommendation |
|---:|---|---|---|---|
| 4 | Ethiopia listed as LMIC | No. The criteria contain `Ethiopia |` with a blank income group. | Yes, directly. At least the Ethiopia rows should move from maybe/no uncertainty toward inclusion. | Set `Ethiopia | Low income` and add a rule that Ethiopian settings are LMIC unless contradicted. |
| 5 | Exclude TB treatment / antitubercular drugs | No. | Yes for TB/IPT false positives; it should catch isoniazid preventive therapy and TB care programs. | Add TB screening, case-finding, DOTS, TB treatment/prevention, IPT, isoniazid, rifampicin-based regimens as exclusions unless the study evaluates a general antibiotic stewardship intervention outside TB care. |
| 6 | Exclude clinical trials with no reported results | Mostly. Current study-characteristics exclusion covers protocols, registry records, database summaries, and short reports without results. | Partly. Some trial-like records still look plausible because they are written in future tense or report objectives/methods only. | Sharpen no-results language: future-tense trial records, protocol records, registry entries, and aims/methods-only records are excluded even if they describe an eligible intervention. |
| 7 | Exclude conference abstracts | Partly. Current wording excludes conference abstracts only when they do not report results. | Low to medium. There was one clear congress/meeting abstract pattern, but it is not the dominant cause. | If the review wants full articles only, exclude conference abstracts/posters/proceedings even with preliminary results. Also state that a normal journal article should not be excluded merely because the abstract starts with "Abstract". |
| 8 | Exclude implementation-only studies | Partly. Criteria exclude modelling/simulation and some non-empirical reports, but not all implementation-only/readiness/gap-analysis papers. | Yes, for readiness, gap-analysis, lessons-learnt, facility-readiness, and implementation reports without quantitative intervention effect. | Add explicit implementation-only exclusion unless the paper quantitatively evaluates the effect of a specific intervention on eligible antibiotic prescribing/use or related outcomes. |
| 9 | Do not exclude public-targeted interventions if prescribers are also targeted | No. Current intervention exclusion says `Public awareness campaigns`, which can over-exclude mixed campaigns. | Yes for the public-plus-prescriber rows. | Exclude public-only awareness campaigns. Include campaigns with prescriber/clinician/health-worker components and antibiotic prescribing/use outcomes. |
| 10 | Multi-country studies include if majority LMIC | No. | Yes for Latin America/South America and region-only multicountry records. | Include if all countries are LMICs or most study sites, participants, or data are from LMICs. If the abstract names only LMIC regions/countries or says LMIC/developing country, treat the setting as eligible unless contradicted. |
| 11 | LLM `Maybe` plus human `Yes` should be included for full text | No. The current prompt preserves `maybe`. | High volume but unsafe as a blanket rule. It would help 84 yes-vs-maybe rows, but 32 maybe rows were resolved no. | Use a triage rule: at title/abstract screening, answer yes for full-text review when plausibly eligible and no exclusion is clear. Answer no when a clear exclusion applies. Use maybe only for unresolved scope uncertainty. |
| 12 | Dose individualization, de-escalation, TDM can be antibiotic prescribing interventions | Partly. Outcomes mention dosing, IV-to-oral, de-escalation, discontinuation, and biomarkers, but intervention examples are thin. | Yes. This is a major inclusive-miss bucket. | Add these as explicit intervention examples: antibiotic selection, initiation, route, timing, dose, serum-level/TDM adjustment, MIC reporting/suppression, duration, IV-to-oral switch, de-escalation, discontinuation, biomarker-guided stopping. |
| 13 | Avoid inclusion from vague single-sentence mentions | Partly. The prompt says maybe when information is insufficient, but does not require concrete evidence for each inclusion route. | Yes for false positives where the LLM reused vague "antibiotic policy", "rational use", or "intervention" language. | Require a clearly described intervention/exposure/evaluation and an eligible antibiotic prescribing/use outcome for `yes`. Do not answer yes from a vague title or one sentence merely mentioning antibiotic use, resistance, policy, or management. |
| 14 | Prescriber target can be implicit when clinical antibiotic use is targeted | Partly/no. Population criteria require prescribers, but do not tell reviewers when to infer prescriber involvement. | Yes. This fixes many hospital, ward, ICU, surgical prophylaxis, and stewardship records marked maybe. | In clinical healthcare settings, infer independent prescriber involvement from antibiotic prescribing/use, treatment, prophylaxis, dose, route, or duration decisions unless the text says the actors are only patients, students, community pharmacists/drug sellers, informal providers, or other non-prescribers. |
| 15 | Broad all-drug interventions require antibiotic outcomes as a primary/key/major component | Yes, almost exact. | Medium. It already helps, but some false positives still need stronger wording around incidental antibiotic mentions. | Keep it and sharpen: include broad all-medicine, quality, financing, procurement, or formulary interventions only when antibiotic prescribing/use is a named objective and primary/key secondary/major reported outcome. Exclude incidental antibiotic mentions. |
| 16 | Mentions an intervention but does not evaluate it should be excluded | Partly. Outcome criteria already exclude studies that do not evaluate a specific intervention. | Yes. This addresses outbreak, compliance, gap-analysis, descriptive utilization, proposed-intervention, and policy-only rows. | Add operational wording: exclude papers that mention, recommend, describe, or plan an intervention, policy, or guideline but do not evaluate its effect using before-after, randomized, controlled, exposed/unexposed, interrupted time-series, or another empirical outcome comparison. |
| 17 | Screen title, not just abstract | Partly. Project uses title and abstract, but criteria do not say title can satisfy setting. | Yes, especially for LMIC/title-named country rows and Chinese rows. | State that title, abstract, and source metadata are all evidence. A country, region, hospital setting, or intervention in the title can satisfy the relevant criterion unless contradicted by the abstract. |

## Criteria wording improvements

These are written to be usable by both human reviewers and LLM reviewers.

### Global screening rule

Add this before the section-specific criteria:

```text
This is title/abstract screening for full-text review. Use the title, abstract, and source metadata together.

Answer yes when the record is plausibly eligible for full-text review and no exclusion criterion is clearly met.
Answer no when an exclusion criterion is clearly met or the record clearly lacks an eligible intervention, setting, population, outcome, or study type.
Answer maybe only when the record remains genuinely ambiguous after using title, abstract, and metadata together.

Do not answer yes from a vague phrase alone. A yes decision needs evidence of a specific intervention/exposure/evaluation and an eligible antibiotic prescribing/use or related outcome.
```

### Population / prescriber target

Add:

```text
Do not apply the population/prescriber criterion as an isolated keyword requirement. Evaluate population together with setting, intervention, and outcome.

In clinical healthcare settings such as hospitals, wards, ICUs, clinics, outpatient departments, emergency departments, operating rooms, and perioperative care, infer eligible prescriber involvement when the evaluated intervention affects antibiotic prescribing/use, antibiotic treatment, prophylaxis, selection, initiation, route, dose, timing, duration, de-escalation, discontinuation, or IV-to-oral switch. Do not require the abstract to say "doctor", "physician", or "prescriber" explicitly.

Do not infer eligibility from setting alone. A hospital, ward, or clinic setting still needs evidence of an evaluated antibiotic prescribing/use intervention or outcome.

Do not infer eligible prescriber involvement when the only target actors are patients, community members, students without independent prescribing roles, community pharmacists/drug sellers, informal providers, veterinarians, or public-only audiences, unless prescribers/clinicians/health workers are also targeted.

Public/patient/community components do not exclude a study if clinicians, prescribers, or health workers are also targeted and antibiotic prescribing/use outcomes are evaluated. Exclude public-only awareness campaigns.
```

### Intervention / exposure

Add:

```text
Antibiotic prescribing/use interventions include antimicrobial stewardship, audit and feedback, formulary or restriction policies, education/training for clinicians, clinical decision support, pharmacist/nurse-led prescribing support, microbiology or susceptibility-reporting changes, biomarker-guided antibiotic decisions, procalcitonin/CRP-guided stopping, MIC reporting/suppression, therapeutic drug monitoring, serum-level guided dose adjustment, dose individualization, de-escalation, discontinuation, delayed/deferred prescribing, IV-to-oral switch, and surgical prophylaxis stewardship when prescribing/use behavior is evaluated.

Exclude studies whose main purpose is clinical efficacy, pharmacokinetics/pharmacodynamics, safety, toxicity, or superiority of one antibiotic regimen, treatment plan, dose, duration, route, prophylaxis schedule, or timing versus another, unless the study evaluates prescribing/use behavior as a stewardship intervention.

Head-to-head comparisons of antibiotic treatment plans or prophylaxis regimens are excluded when the evaluated question is "which regimen works better clinically?" rather than "did an intervention change prescribing/use behavior?" Examples include antibiotic A versus antibiotic B, single-dose versus multi-dose prophylaxis, preoperative versus postoperative prophylaxis, or one duration/timing protocol versus another when the outcome is primarily cure, surgical-site infection, adverse events, resistance, or pharmacologic target attainment.

For surgical/perioperative prophylaxis, include stewardship or policy interventions that evaluate prescribing/use behavior, guideline adherence, antibiotic volume, selection, route, timing, dose, or duration. Exclude regimen-comparison or SSI-prevention efficacy studies when the evaluated question is primarily clinical efficacy or infection prevention rather than prescribing/use behavior.

For interventions aimed at all medicines, all clinical care, financing, procurement, formularies, or general quality improvement, include only when antibiotic prescribing/use is a named objective and a primary, key secondary, or major reported outcome. Exclude when antibiotics are incidental or mentioned only as a side effect.
```

### Study characteristics / evidence of evaluation

Add:

```text
Exclude reports, commentaries, editorials, letters, viewpoints, perspectives, opinions, narrative reports, news items, and expert comments when they do not present original empirical evaluation of an eligible intervention with eligible outcomes.

Exclude implementation-only, readiness, gap-analysis, barriers/facilitators, lessons-learnt, policy-description, guideline-description, intervention-development, or feasibility-description papers unless they quantitatively evaluate the effect of a specific intervention on antibiotic prescribing/use or another eligible outcome.

Exclude descriptive antibiotic-utilization audits, prescription audits, resistance surveillance, stewardship metric dashboards, outbreak reports, formulary/reimbursement analyses, restriction reports, and policy-compliance snapshots unless they evaluate a specific intervention with a before-after, randomized, controlled, exposed/unexposed, interrupted time-series, or other empirical outcome comparison.

Exclude trial registry entries, protocol records, study descriptions in future tense, and aims/methods-only clinical-trial records that report no participant results or outcome data.

Exclude conference abstracts, posters, meeting proceedings, and congress/supplement abstracts if the review is restricted to full journal articles, even when preliminary results are present.
```

### Outcomes / behavioral evidence

Add:

```text
Eligible outcomes must include antibiotic prescribing/use behavior, antibiotic consumption, guideline-concordant prescribing, initiation, selection, dose, route, timing, duration, de-escalation, discontinuation, IV-to-oral switch, prophylaxis appropriateness, or a closely related stewardship outcome.

Exclude studies that report only knowledge, attitudes, perceptions, beliefs, intentions, awareness, self-reported confidence, acceptability, feasibility perceptions, or satisfaction, without any behavioral prescribing/use outcome.

Knowledge/attitude/satisfaction outcomes can be included only when they accompany an eligible behavioral prescribing/use or stewardship outcome and the study otherwise evaluates a specific intervention.
```

### Disease-program and anti-infective exclusions

Add:

```text
Exclude TB screening, TB case-finding, DOTS, TB care quality, TB treatment, TB prevention, isoniazid preventive therapy, rifampicin-based regimens, and other antitubercular therapy unless the study evaluates a general antibiotic prescribing/stewardship intervention outside TB care.

Exclude vertical infectious-disease screening or treatment programs such as syphilis, malaria/antimalarial diagnostics, and TB/IPT programs when antibiotic prescribing/use is not the primary evaluated intervention and outcome.
```

### LMIC / setting

Fix the country list and add:

```text
Ethiopia | Low income

Use title, abstract, and source metadata for setting. A country, region, city, hospital, or study network named in the title is valid setting evidence unless contradicted by the abstract.

For multi-country studies, include if all countries are LMICs or if most study sites, participants, facilities, or data are from LMICs. If the record says "LMIC", "low- and middle-income countries", "developing country", or names only LMIC countries/regions, treat setting as eligible unless contradicted.

If a study is in Chinese, assume the setting is China unless another country is explicitly stated.
```

### Chinese-study handling

The observed rows and follow-up note support these additions:

```text
For Chinese-language records, use both title and abstract. Do not require an exact "医院" token to recognize a hospital setting. In a medical antibiotic context, terms such as "我院" (our hospital), "本院" (this hospital), "院内" (in-hospital), "我科"/"本科" (our department/this department), "科室" (department), "病区" (ward), "门诊" (outpatient), "住院" (inpatient), ICU, perioperative/surgical terms, and specialty departments can indicate a hospital or clinical setting even though the character "医" is omitted.

Do not treat the character "院" alone as enough outside a medical context. The record still needs clinical antibiotic use plus an evaluated intervention or comparison with an eligible prescribing/use outcome.

Chinese hospital/department terms, perioperative/surgical terms, "rational use", "rectification", "management", "PDCA", "supervision", "intervention", and before-after comparisons can indicate a hospital clinical antibiotic-prescribing intervention even if prescribers are not named.

For Chinese-language records, do not include merely descriptive "analysis", "survey", "application status", "utilization", "rationality analysis", or "factors and countermeasures" papers unless the abstract reports an evaluated intervention/comparison and an eligible antibiotic prescribing/use outcome.

If the Chinese abstract reports intervention-before/intervention-after groups, management-before/management-after periods, rectification/policy implementation, or a control/intervention comparison with antibiotic-use outcomes, treat it as potentially eligible for full-text review unless another exclusion is clear.
```

## Bottom line

The proposed changes would probably reduce both false exclusions and false inclusions, but they should be implemented as precise title/abstract screening rules rather than as broad defaults. The most important additions are:

1. Repair LMIC setting handling, especially Ethiopia, title evidence, Chinese = China, and majority-LMIC multicountry studies.
2. Add a careful full-text triage rule for `maybe`: include plausible records when no clear exclusion applies; do not include clearly excluded maybes.
3. Treat population/prescriber involvement as an inference from clinical setting plus antibiotic decision behavior, not as a prescriber-keyword-only criterion and not as a setting-only criterion.
4. Explicitly include prescribing-intervention subtypes: TDM, dose individualization, MIC reporting, biomarker-guided stopping, de-escalation, discontinuation, IV-to-oral switch.
5. Explicitly exclude non-evaluative records, reports/commentaries, protocols/no-results records, implementation-only papers, descriptive utilization/policy/surveillance audits, KAP/satisfaction-only studies, vertical TB/syphilis/malaria programs, and regimen-efficacy/PK-PD studies without prescribing-use intervention evaluation.
6. Add Chinese-specific disambiguation for hospital intervention records versus descriptive utilization analyses, including `我院`/`本院`/department wording rather than relying only on `医院`.
