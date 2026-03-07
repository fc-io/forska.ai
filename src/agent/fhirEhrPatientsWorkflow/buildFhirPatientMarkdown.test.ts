import {expect, test} from 'bun:test'

import {buildFhirPatientMarkdown} from './buildFhirPatientMarkdown.ts'

test('buildFhirPatientMarkdown builds strict headings and inlines refs', () => {
  const built = buildFhirPatientMarkdown({
    patientId: 'p1',
    importRoute: 'fhir:demo',
    assetsFolder: 'assets/demo',
    articleTitle: 'FHIR Patient p1',
    entries: [
      {
        resourceType: 'Patient',
        resourceId: 'p1',
        sortDate: null,
        rawLine: JSON.stringify({
          resourceType: 'Patient',
          id: 'p1',
          name: [{text: 'Alice Example'}],
          gender: 'female',
          birthDate: '2000-01-01',
          identifier: [{system: 'sys', value: '123'}],
          telecom: [{system: 'phone', value: '555-0101'}],
          address: [{line: ['Main St 1'], city: 'City'}],
        }),
        decodedNotes: [],
      },
      {
        resourceType: 'Encounter',
        resourceId: 'e1',
        sortDate: '2024-01-02T10:00:00Z',
        rawLine: JSON.stringify({
          resourceType: 'Encounter',
          id: 'e1',
          status: 'finished',
          type: [{text: 'Visit'}],
          subject: {reference: 'Patient/p1', display: 'Alice Example'},
          serviceProvider: {reference: 'Organization/o1', display: 'Org Example'},
          period: {start: '2024-01-02T10:00:00Z', end: '2024-01-02T11:00:00Z'},
        }),
        decodedNotes: [],
      },
      {
        resourceType: 'Observation',
        resourceId: 'obs1',
        sortDate: '2024-01-04T09:00:00Z',
        rawLine: JSON.stringify({
          resourceType: 'Observation',
          id: 'obs1',
          status: 'final',
          code: {text: 'Test'},
          subject: {reference: 'Patient/p1'},
          performer: [
            {reference: 'Practitioner?identifier=http://hl7.org/fhir/sid/us-npi|9999995993', display: 'Dr Example'},
          ],
        }),
        decodedNotes: [],
      },
      {
        resourceType: 'Observation',
        resourceId: 'lab1',
        sortDate: '2024-01-05T12:00:00Z',
        rawLine: JSON.stringify({
          resourceType: 'Observation',
          id: 'lab1',
          status: 'final',
          issued: '2024-01-05T12:00:00Z',
          code: {text: 'Leukocytes [#/volume] in Blood by Automated count'},
          subject: {reference: 'Patient/p1'},
          valueQuantity: {value: 5.1, unit: '10^3/uL'},
        }),
        decodedNotes: [],
      },
      {
        resourceType: 'Observation',
        resourceId: 'lab2',
        sortDate: '2024-01-05T12:00:00Z',
        rawLine: JSON.stringify({
          resourceType: 'Observation',
          id: 'lab2',
          status: 'final',
          issued: '2024-01-05T12:00:00Z',
          code: {text: 'Erythrocytes [#/volume] in Blood by Automated count'},
          subject: {reference: 'Patient/p1'},
          valueQuantity: {value: 4.8, unit: '10^6/uL'},
        }),
        decodedNotes: [],
      },
      {
        resourceType: 'DiagnosticReport',
        resourceId: 'dr1',
        sortDate: '2024-01-05T12:00:00Z',
        rawLine: JSON.stringify({
          resourceType: 'DiagnosticReport',
          id: 'dr1',
          status: 'final',
          issued: '2024-01-05T12:00:00Z',
          code: {text: 'CBC panel'},
          subject: {reference: 'Patient/p1'},
          result: [{reference: 'Observation/lab1'}, {reference: 'Observation/lab2'}],
        }),
        decodedNotes: [],
      },
      {
        resourceType: 'DocumentReference',
        resourceId: 'd1',
        sortDate: '2024-01-03T09:00:00Z',
        rawLine: JSON.stringify({
          resourceType: 'DocumentReference',
          id: 'd1',
          status: 'current',
          subject: {reference: 'Patient/p1'},
          date: '2024-01-03T09:00:00Z',
          content: [{attachment: {contentType: 'text/plain', data: 'ignored'}}],
        }),
        decodedNotes: [
          {path: 'DocumentReference.content[0].attachment.data', text: '# Plan\nSee Encounter/e1', truncated: false},
        ],
      },
    ],
  })

  expect(built.validationErrors).toEqual([])

  expect(built.summaryMarkdown).toContain('# FHIR Patient p1')
  expect(built.summaryMarkdown).toContain('## Patient')
  expect(built.summaryMarkdown).toContain('## Timeline')
  expect(built.summaryMarkdown).toContain('### 2024-01-02')
  expect(built.summaryMarkdown).toContain('#### Encounter: Visit')
  expect(built.summaryMarkdown).toContain('##### Note (DocumentReference)')
  expect(built.summaryMarkdown).toContain('###### Plan')
  expect(built.summaryMarkdown).toContain('Encounter (status: finished')
  expect(built.summaryMarkdown).not.toContain('Encounter/e1')
  expect(built.summaryMarkdown).not.toContain('?identifier=')
  expect(built.summaryMarkdown).not.toContain('system=')
  expect(built.summaryMarkdown).not.toContain('- id:')
  expect(built.summaryMarkdown).not.toContain('[0]')
  expect(built.summaryMarkdown).toContain('- performer: Dr Example')
  expect(built.summaryMarkdown).toContain('##### Results (2)')
  expect(built.summaryMarkdown).toContain('issued: 2024-01-05T12:00:00Z')
  expect(built.summaryMarkdown).toContain('  - Leukocytes [#/volume] in Blood by Automated count: 5.1 10^3/uL')
  expect(built.summaryMarkdown).not.toContain('result[0]:')

  expect(built.fulltextMarkdown).toContain('# FHIR Patient p1')
  expect(built.fulltextMarkdown).toContain('## Patient')
  expect(built.fulltextMarkdown).toContain('## Timeline')
  expect(built.fulltextMarkdown).toContain('### 2024-01-02')
  expect(built.fulltextMarkdown).toContain('#### Encounter: Visit')
  expect(built.fulltextMarkdown).toContain('##### Note (DocumentReference)')
  expect(built.fulltextMarkdown).toContain('###### Plan')
  expect(built.fulltextMarkdown).toContain('Encounter (status: finished')
  expect(built.fulltextMarkdown).not.toContain('Encounter/e1')
  expect(built.fulltextMarkdown).not.toContain('?identifier=')
  expect(built.fulltextMarkdown).not.toContain('system=')
  expect(built.fulltextMarkdown).not.toContain('- id:')
  expect(built.fulltextMarkdown).not.toContain('[0]')
  expect(built.fulltextMarkdown).toContain('- performer: Dr Example')
  expect(built.fulltextMarkdown).toContain('##### Results (2)')
  expect(built.fulltextMarkdown).toContain('issued: 2024-01-05T12:00:00Z')
  expect(built.fulltextMarkdown).toContain('  - Leukocytes [#/volume] in Blood by Automated count: 5.1 10^3/uL')
  expect(built.fulltextMarkdown).not.toContain('result[0]:')

  expect(built.summaryMarkdown.indexOf('### 2024-01-05')).toBeLessThan(built.summaryMarkdown.indexOf('### 2024-01-03'))
  expect(built.summaryMarkdown.indexOf('### 2024-01-03')).toBeLessThan(built.summaryMarkdown.indexOf('### 2024-01-02'))
  expect(built.fulltextMarkdown.indexOf('### 2024-01-05')).toBeLessThan(
    built.fulltextMarkdown.indexOf('### 2024-01-03'),
  )
  expect(built.fulltextMarkdown.indexOf('### 2024-01-03')).toBeLessThan(
    built.fulltextMarkdown.indexOf('### 2024-01-02'),
  )
})

test('buildFhirPatientMarkdown collapses duplicate role bullets (location/provider)', () => {
  const built = buildFhirPatientMarkdown({
    patientId: 'p1',
    importRoute: 'fhir:demo',
    assetsFolder: 'assets/demo',
    articleTitle: 'FHIR Patient p1',
    entries: [
      {
        resourceType: 'Patient',
        resourceId: 'p1',
        sortDate: null,
        rawLine: JSON.stringify({resourceType: 'Patient', id: 'p1', name: [{text: 'Alice Example'}]}),
        decodedNotes: [],
      },
      {
        resourceType: 'Encounter',
        resourceId: 'e1',
        sortDate: '2024-01-02T10:00:00Z',
        rawLine: JSON.stringify({
          resourceType: 'Encounter',
          id: 'e1',
          status: 'finished',
          type: [{text: 'Visit'}],
          subject: {reference: 'Patient/p1'},
          serviceProvider: {reference: 'Organization/o1', display: 'PROVIDENCE MEDICAL CENTER'},
          location: [{location: {reference: 'Location/l1', display: 'PROVIDENCE MEDICAL CENTER'}}],
          period: {start: '2024-01-02T10:00:00Z', end: '2024-01-02T11:00:00Z'},
        }),
        decodedNotes: [],
      },
    ],
  })

  expect(built.validationErrors).toEqual([])
  expect(built.summaryMarkdown).toContain('- location, provider: PROVIDENCE MEDICAL CENTER')
  expect(built.summaryMarkdown).not.toContain('- location: PROVIDENCE MEDICAL CENTER')
  expect(built.summaryMarkdown).not.toContain('- provider: PROVIDENCE MEDICAL CENTER')
})

test('buildFhirPatientMarkdown de-duplicates identical note bodies across resources', () => {
  const noteText = '# Note\nSame text'

  const built = buildFhirPatientMarkdown({
    patientId: 'p1',
    importRoute: 'fhir:demo',
    assetsFolder: 'assets/demo',
    articleTitle: 'FHIR Patient p1',
    entries: [
      {
        resourceType: 'Patient',
        resourceId: 'p1',
        sortDate: null,
        rawLine: JSON.stringify({resourceType: 'Patient', id: 'p1'}),
        decodedNotes: [],
      },
      {
        resourceType: 'DiagnosticReport',
        resourceId: 'dr1',
        sortDate: '2024-01-03T09:00:00Z',
        rawLine: JSON.stringify({
          resourceType: 'DiagnosticReport',
          id: 'dr1',
          status: 'final',
          subject: {reference: 'Patient/p1'},
        }),
        decodedNotes: [{path: 'DiagnosticReport.presentedForm[0].data', text: noteText, truncated: false}],
      },
      {
        resourceType: 'DocumentReference',
        resourceId: 'd1',
        sortDate: '2024-01-03T09:00:00Z',
        rawLine: JSON.stringify({
          resourceType: 'DocumentReference',
          id: 'd1',
          status: 'current',
          subject: {reference: 'Patient/p1'},
        }),
        decodedNotes: [{path: 'DocumentReference.content[0].attachment.data', text: noteText, truncated: false}],
      },
    ],
  })

  expect(built.validationErrors).toEqual([])
  expect(built.fulltextMarkdown).toContain('##### Note')
  expect(built.fulltextMarkdown).toContain('- sources: DiagnosticReport, DocumentReference')
  expect((built.fulltextMarkdown.match(/Same text/g) ?? []).length).toBe(1)
  expect(built.fulltextMarkdown).not.toContain('##### Note (DiagnosticReport)')
  expect(built.fulltextMarkdown).not.toContain('##### Note (DocumentReference)')
})

test('buildFhirPatientMarkdown formats sectioned note blobs into readable lines', () => {
  const noteText =
    'Chief Complaint No complaints. History of Present Illness Dawne25 is a 20 year-old nonhispanic white female. Patient has a history of reports of violence in the environment (finding), full-time employment (finding), stress (finding). Social History Patient is single. Patient has a documented history of opioid addiction. Patient has never smoked. Patient identifies as heterosexual. Patient comes from a middle socioeconomic background. Patient has completed some college courses. Patient currently has UnitedHealthcare. Allergies No Known Allergies. Medications lisinopril 10 mg oral tablet; albuterol 5 mg/ml inhalation solution; hydrochlorothiazide 12.5 MG / lisinopril 10 MG Oral Tablet. Assessment and Plan Plan The patient was prescribed the following medications: levora 0.15/30 28 day pack'

  const built = buildFhirPatientMarkdown({
    patientId: 'p1',
    importRoute: 'fhir:demo',
    assetsFolder: 'assets/demo',
    articleTitle: 'FHIR Patient p1',
    entries: [
      {
        resourceType: 'Patient',
        resourceId: 'p1',
        sortDate: null,
        rawLine: JSON.stringify({resourceType: 'Patient', id: 'p1'}),
        decodedNotes: [],
      },
      {
        resourceType: 'DocumentReference',
        resourceId: 'd1',
        sortDate: '2024-01-03T09:00:00Z',
        rawLine: JSON.stringify({
          resourceType: 'DocumentReference',
          id: 'd1',
          status: 'current',
          subject: {reference: 'Patient/p1'},
        }),
        decodedNotes: [{path: 'DocumentReference.content[0].attachment.data', text: noteText, truncated: false}],
      },
    ],
  })

  expect(built.validationErrors).toEqual([])

  expect(built.summaryMarkdown).toContain('###### Chief Complaint')
  expect(built.summaryMarkdown).toContain('- No complaints.')
  expect(built.summaryMarkdown).toContain('###### Social History')
  expect(built.summaryMarkdown).toContain('- Patient is single.')
  expect(built.summaryMarkdown).toContain('###### Allergies')
  expect(built.summaryMarkdown).toContain('- No Known Allergies.')
  expect(built.summaryMarkdown).toContain('###### Medications')
  expect(built.summaryMarkdown).toContain('- lisinopril 10 mg oral tablet')
  expect(built.summaryMarkdown).toContain('- albuterol 5 mg/ml inhalation solution')
  expect(built.summaryMarkdown).toContain('- hydrochlorothiazide 12.5 MG / lisinopril 10 MG Oral Tablet.')
  expect(built.summaryMarkdown).toContain('###### Assessment and Plan')
  expect(built.summaryMarkdown).toContain(
    '- The patient was prescribed the following medications: levora 0.15/30 28 day pack',
  )

  expect(built.fulltextMarkdown).toContain('###### Chief Complaint')
  expect(built.fulltextMarkdown).toContain('- No complaints.')
  expect(built.fulltextMarkdown).toContain('###### Social History')
  expect(built.fulltextMarkdown).toContain('- Patient is single.')
  expect(built.fulltextMarkdown).toContain('###### Allergies')
  expect(built.fulltextMarkdown).toContain('- No Known Allergies.')
  expect(built.fulltextMarkdown).toContain('###### Medications')
  expect(built.fulltextMarkdown).toContain('- lisinopril 10 mg oral tablet')
  expect(built.fulltextMarkdown).toContain('- albuterol 5 mg/ml inhalation solution')
  expect(built.fulltextMarkdown).toContain('- hydrochlorothiazide 12.5 MG / lisinopril 10 MG Oral Tablet.')
  expect(built.fulltextMarkdown).toContain('###### Assessment and Plan')
  expect(built.fulltextMarkdown).toContain(
    '- The patient was prescribed the following medications: levora 0.15/30 28 day pack',
  )
})
