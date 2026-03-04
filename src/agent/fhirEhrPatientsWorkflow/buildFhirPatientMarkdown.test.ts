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
  expect(built.markdown).toContain('# FHIR Patient p1')
  expect(built.markdown).toContain('## Patient')
  expect(built.markdown).toContain('## Timeline')
  expect(built.markdown).toContain('### 2024-01-02')
  expect(built.markdown).toContain('#### Encounter: Visit')
  expect(built.markdown).toContain('##### Note (DocumentReference.content[0].attachment.data)')
  expect(built.markdown).toContain('###### Plan')
  expect(built.markdown).toContain('Encounter (status: finished')
  expect(built.markdown).not.toContain('Encounter/e1')
})
