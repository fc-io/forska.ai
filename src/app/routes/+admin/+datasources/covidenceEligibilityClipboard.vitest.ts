import {describe, expect, test} from 'vitest'

import {covidenceEligibilitySections, parseCovidenceEligibilityClipboardText} from './covidenceEligibilityClipboard.ts'

describe('parseCovidenceEligibilityClipboardText', () => {
  test('uses the current Covidence topic labels for generated prompts', () => {
    expect(
      covidenceEligibilitySections.map((section) => {
        return section.label
      }),
    ).toEqual(['Population', 'Intervention', 'Comparison', 'Outcome', 'Study Design', 'Other'])
  })

  test('parses updated Covidence criteria text with section descriptions and short headings', () => {
    const parsed = parseCovidenceEligibilityClipboardText(`Population

Group(s) of individuals, organizations, or entities that are the primary focus of the study
Include
Interventions that target antibiotic prescribing/use
Involving prescribers from low- and middle-income countries (doctors/physicians/dentists)
Working in all levels of healthcare: primary (outpatients), secondary and tertiary (hospitals, inpatients)
Pharmacist- or nurse-led interventions can be included if they were aimed at prescribing/use (usually clinical pharmacists in hospital settings)
Exclude
Informal healthcare providers
Community pharmacists or drug sellers
Veterinarians
Medical, pharmacy, or nursing students without independent prescribing roles
Patients or community members
Intervention

Treatments, procedures, assessments, programmes, policy or other change being evaluated in the study
Include
Intervention(s) to improve antibiotic prescribing/use/ practices/behavior
For any antibiotic
For any infectious disease (including surgical antibiotic prophylaxis)
For any age group
At any healthcare level (primary, secondary, tertiary, inpatient, outpatient)
Intervention can target use of all drugs but antibiotic prescribing/use outcomes are explicitly reported as a primary outcome, key secondary outcome, or major component of the intervention evaluation
Antimicrobial stewardship and use of biomarkers (e.g., procalcitonin, CRP) can be interventions
Antibiotic stewardship interventions may involve, either as the primary intervention or as one component of a broader intervention, any of the following: individualization or optimization of antibiotic dosing; antibiotic de-escalation or narrowing of antibiotic therapy; delayed or deferred antibiotic prescribing; switching antibiotics from intravenous (IV) to oral administration; discontinuation or cessation of antibiotic therapy; and/or therapeutic drug monitoring (TDM) to guide antibiotic dosing or treatment.
Exclude
Interventions that target drugs other than antibiotics (exclude interventions that target antituberculosis drugs (e.g., isoniazid), antiretrovirals, antifungals, antimalarials)
Interventions aimed to decrease antibiotic sales/dispensing at community pharmacies level
Studies where the intervention primarily compares the clinical efficacy, pharmacokinetics, duration, timing, or superiority of one antibiotic regimen versus another
Public awareness campaigns
Infection prevention without antibiotic prescribing/use outcomes
Comparison

Alternative(s) or reference point against which the intervention is being evaluated
Include
Different intervention or combination of interventions
Baseline, standard or historical practices
No intervention
Exclude
Outcome

Specific results or effects that are measured or assessed as a result of the intervention
Include
Primary:
1*: Change in antibiotic prescription rates/volume/frequency and initiation of antibiotic therapy
1*:Compliance with relevant antibiotic prescribing guidelines used in the studies
1*:Change in incidence/prevalence of resistant organisms and/or bacterial sensitivity/resistance patterns
1*:Change in antibiotic prescription/use patterns- selection (e.g., per AWaRe classification, spectrum (broad to narrow)), timing, route of administration, dosing, duration
1*:Change in the ability to differentiate bacterial from non-bacterial infections
Secondary:
2*:Change in delayed/deferred prescribing, IV to oral switch, de-escalation or discontinuation of antibiotics
2*:Change in hospitalization, length of hospital stay, mortality or clinical recovery/failure rates
2*:Change in occurrence of adverse drug events or toxicity
2*: Change in cost or cost-effectiveness of treatment
Exclude
Studies that do not evaluate a specific intervention (only describe drug/antibiotic utilization, results of prescription audits, resistance patterns, reasons for antibiotic use, or stewardship metrics)
Studies that report only knowledge, attitudes, perceptions, or satisfaction outcomes without behavioral or prescribing-related outcomes
Studies that focus on clinical efficacy comparisons between antibiotic regimens without prescribing or stewardship outcomes
Study Design

Research design used in the study
Include
Randomized studies (RCTs and randomized trials)
Non-randomized intervention studies: quasi-experimental studies, interrupted time series, before- and after- (pre-post) studies
Observational comparative studies: cohort studies comparing exposure to an intervention, prospective or retrospective studies evaluating intervention
Mixed-methods studies if quantitative intervention outcomes related to antibiotic prescribing/use are reported
Published from year 2000 (if no information about publication year available, assume study was published from 2000)
Exclude
Reviews and meta-analyses
Qualitative-only studies
Modelling or simulation studies without empirical intervention evaluation
Implementation-only studies
Editorials, commentaries, opinion pieces
Study protocols, conference abstracts, registry records, database summaries, or other short reports that only describe the background, objective, intervention, or methods, and do not report results
Other

Any additional information that affects a study's eligibility for your review or is helpful to consider during screening
Include
Studies from developing/ low- and middle-income countries (both upper- and lower-middle income countries). If study is in Chinese, assume the setting is China. Use designation from this list:

Economy | Income group
Afghanistan | Low income
Albania | Upper middle income
Algeria | Upper middle income
American Samoa | High income
Andorra | High income
Angola | Lower middle income
Antigua and Barbuda | High income
Argentina | Upper middle income
Armenia | Upper middle income
Aruba | High income
Australia | High income
Austria | High income
Azerbaijan | Upper middle income
Bahamas, The | High income
Bahrain | High income
Bangladesh | Lower middle income
Barbados | High income
Belarus | Upper middle income
Belgium | High income
Belize | Upper middle income
Benin | Lower middle income
Bermuda | High income
Bhutan | Lower middle income
Bolivia | Lower middle income
Bosnia and Herzegovina | Upper middle income
Botswana | Upper middle income
Brazil | Upper middle income
British Virgin Islands | High income
Brunei Darussalam | High income
Bulgaria | High income
Burkina Faso | Low income
Burundi | Low income
Cabo Verde | Upper middle income
Cambodia | Lower middle income
Cameroon | Lower middle income
Canada | High income
Cayman Islands | High income
Central African Republic | Low income
Chad | Low income
Channel Islands | High income
Chile | High income
China | Upper middle income
Colombia | Upper middle income
Comoros | Lower middle income
Congo, Dem. Rep. | Low income
Congo, Rep. | Lower middle income
Costa Rica | High income
Côte d’Ivoire | Lower middle income
Croatia | High income
Cuba | Upper middle income
Curaçao | High income
Cyprus | High income
Czechia | High income
Denmark | High income
Djibouti | Lower middle income
Dominica | Upper middle income
Dominican Republic | Upper middle income
Ecuador | Upper middle income
Egypt, Arab Rep. | Lower middle income
El Salvador | Upper middle income
Equatorial Guinea | Upper middle income
Eritrea | Low income
Estonia | High income
Eswatini | Lower middle income
Ethiopia | Low income
Faroe Islands | High income
Fiji | Upper middle income
Finland | High income
France | High income
French Polynesia | High income
Gabon | Upper middle income
Gambia, The | Low income
Georgia | Upper middle income
Germany | High income
Ghana | Lower middle income
Gibraltar | High income
Greece | High income
Greenland | High income
Grenada | Upper middle income
Guam | High income
Guatemala | Upper middle income
Guinea | Lower middle income
Guinea-Bissau | Low income
Guyana | High income
Haiti | Lower middle income
Honduras | Lower middle income
Hong Kong SAR, China | High income
Hungary | High income
Iceland | High income
India | Lower middle income
Indonesia | Upper middle income
Iran, Islamic Rep. | Upper middle income
Iraq | Upper middle income
Ireland | High income
Isle of Man | High income
Israel | High income
Italy | High income
Jamaica | Upper middle income
Japan | High income
Jordan | Lower middle income
Kazakhstan | Upper middle income
Kenya | Lower middle income
Kiribati | Lower middle income
Korea, Dem. People's Rep. | Low income
Korea, Rep. | High income
Kosovo | Upper middle income
Kuwait | High income
Kyrgyz Republic | Lower middle income
Lao PDR | Lower middle income
Latvia | High income
Lebanon | Lower middle income
Lesotho | Lower middle income
Liberia | Low income
Libya | Upper middle income
Liechtenstein | High income
Lithuania | High income
Luxembourg | High income
Macao SAR, China | High income
Madagascar | Low income
Malawi | Low income
Malaysia | Upper middle income
Maldives | Upper middle income
Mali | Low income
Malta | High income
Marshall Islands | Upper middle income
Mauritania | Lower middle income
Mauritius | Upper middle income
Mexico | Upper middle income
Micronesia, Fed. Sts. | Lower middle income
Moldova | Upper middle income
Monaco | High income
Mongolia | Upper middle income
Montenegro | Upper middle income
Morocco | Lower middle income
Mozambique | Low income
Myanmar | Lower middle income
Namibia | Lower middle income
Nauru | High income
Nepal | Lower middle income
Netherlands | High income
New Caledonia | High income
New Zealand | High income
Nicaragua | Lower middle income
Niger | Low income
Nigeria | Lower middle incomeNorth Macedonia | Upper middle income
Northern Mariana Islands | High income
Norway | High income
Oman | High income
Pakistan | Lower middle income
Palau | High income
Panama | High income
Papua New Guinea | Lower middle income
Paraguay | Upper middle income
Peru | Upper middle income
Philippines | Lower middle income
Poland | High income
Portugal | High income
Puerto Rico (U.S.) | High income
Qatar | High income
Romania | High income
Russian Federation | High income
Rwanda | Low income
Samoa | Upper middle income
San Marino | High income
São Tomé and Príncipe | Lower middle income
Saudi Arabia | High income
Senegal | Lower middle income
Serbia | Upper middle income
Seychelles | High income
Sierra Leone | Low income
Singapore | High income
Sint Maarten (Dutch part) | High income
Slovak Republic | High income
Slovenia | High income
Solomon Islands | Lower middle income
Somalia, Fed. Rep. | Low income
South Africa | Upper middle income
South Sudan | Low income
Spain | High income
Sri Lanka | Lower middle income
St. Kitts and Nevis | High income
St. Lucia | Upper middle income
St. Martin (French part) | High income
St. Vincent and the Grenadines | Upper middle income
Sudan | Low income
Suriname | Upper middle income
Sweden | High income
Switzerland | High income
Syrian Arab Republic | Low income
Taiwan, China | High income
Tajikistan | Lower middle income
Tanzania | Lower middle income
Thailand | Upper middle income
Timor-Leste | Lower middle income
Togo | Low income
Tonga | Upper middle income
Trinidad and Tobago | High income
Tunisia | Lower middle income
Türkiye | Upper middle income
Turkmenistan | Upper middle income
Turks and Caicos Islands | High income
Tuvalu | Upper middle income
Uganda | Low income
Ukraine | Upper middle income
United Arab Emirates | High income
United Kingdom | High income
United States | High income
Uruguay | High income
Uzbekistan | Lower middle income
Vanuatu | Lower middle income
Venezuela, RB |${' '}
Vietnam | Lower middle income
Virgin Islands (U.S.) | High income
West Bank and Gaza | Lower middle income
Yemen, Rep. | Low income
Zambia | Lower middle income
Zimbabwe | Lower middle income

Exclude
Studies from high-income countries`)

    expect(parsed).not.toBeNull()
    expect(parsed?.population.include).toBe(
      [
        'Interventions that target antibiotic prescribing/use',
        'Involving prescribers from low- and middle-income countries (doctors/physicians/dentists)',
        'Working in all levels of healthcare: primary (outpatients), secondary and tertiary (hospitals, inpatients)',
        'Pharmacist- or nurse-led interventions can be included if they were aimed at prescribing/use (usually clinical pharmacists in hospital settings)',
      ].join('\n'),
    )
    expect(parsed?.population.exclude).toBe(
      [
        'Informal healthcare providers',
        'Community pharmacists or drug sellers',
        'Veterinarians',
        'Medical, pharmacy, or nursing students without independent prescribing roles',
        'Patients or community members',
      ].join('\n'),
    )
    expect(parsed?.interventionExposure.include).toContain(
      'Intervention(s) to improve antibiotic prescribing/use/ practices/behavior',
    )
    expect(parsed?.interventionExposure.include).toContain('therapeutic drug monitoring (TDM)')
    expect(parsed?.interventionExposure.exclude).toContain('Public awareness campaigns')
    expect(parsed?.comparatorContext.include).toBe(
      [
        'Different intervention or combination of interventions',
        'Baseline, standard or historical practices',
        'No intervention',
      ].join('\n'),
    )
    expect(parsed?.comparatorContext.exclude).toBe('')
    expect(parsed?.outcome.include).toContain('Primary:\n1*: Change in antibiotic prescription rates')
    expect(parsed?.outcome.include).toContain('1*:Compliance with relevant antibiotic prescribing guidelines')
    expect(parsed?.outcome.include).toContain('Secondary:\n2*:Change in delayed/deferred prescribing')
    expect(parsed?.outcome.exclude).toContain('Studies that do not evaluate a specific intervention')
    expect(parsed?.studyCharacteristics.include).toContain('Randomized studies (RCTs and randomized trials)')
    expect(parsed?.studyCharacteristics.exclude).toContain('Study protocols, conference abstracts')
    expect(parsed?.other.include).toContain('Studies from developing/ low- and middle-income countries')
    expect(parsed?.other.include).toContain('Use designation from this list:')
    expect(parsed?.other.include).toContain('Economy | Income group')
    expect(parsed?.other.include).toContain('Afghanistan | Low income')
    expect(parsed?.other.include).toContain('Nigeria | Lower middle incomeNorth Macedonia | Upper middle income')
    expect(parsed?.other.include).toContain('São Tomé and Príncipe | Lower middle income')
    expect(parsed?.other.include).toContain('Venezuela, RB |\nVietnam | Lower middle income')
    expect(parsed?.other.include).toContain('Zimbabwe | Lower middle income')
    expect(parsed?.other.exclude).toBe('Studies from high-income countries')
    expect(parsed?.population.include).not.toContain('Group(s) of individuals')
    expect(parsed?.interventionExposure.include).not.toContain('Treatments, procedures')
    expect(parsed?.outcome.include).not.toContain('Specific results or effects')
    expect(parsed?.studyCharacteristics.include).not.toContain('Research design used in the study')
    expect(parsed?.other.include).not.toContain('Any additional information')
    expect(parsed?.other.include).not.toContain('Studies from high-income countries')
  })

  test('accepts punctuation and inclusion/exclusion criteria labels from older exports', () => {
    const parsed = parseCovidenceEligibilityClipboardText(`Intervention / Exposure:
Inclusion criteria:
Prescribing feedback
Comparator / Context:
Exclusion criteria:
No clinical comparator`)

    expect(parsed?.interventionExposure.include).toBe('Prescribing feedback')
    expect(parsed?.comparatorContext.exclude).toBe('No clinical comparator')
  })

  test('returns null for text without recognizable Covidence criteria sections', () => {
    expect(parseCovidenceEligibilityClipboardText('Include\nOnly this line')).toBeNull()
  })
})
