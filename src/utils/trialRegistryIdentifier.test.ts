import {expect, test} from 'bun:test'

import {getTrialRegistryIdentifier, isTrialRegistryUrl} from './trialRegistryIdentifier.ts'

test('getTrialRegistryIdentifier returns the registry id of every WHO ICTRP primary registry format', () => {
  const identifiers = [
    'NCT00005915',
    'ISRCTN10957189',
    'ACTRN12611000750987',
    'ChiCTR1800019246',
    'ChiCTR-INR-17010334',
    'ChiCTR-TRC-10000981',
    'CTRI/2019/09/021252',
    'CTRI/2009/091/000123',
    'IRCT138804092106N1',
    'IRCT20190528043768N1',
    'DRKS00012345',
    'JPRN-UMIN000012345',
    'JPRN-jRCTs031180123',
    'JPRN-JapicCTI-123456',
    'UMIN000028982',
    'jRCT1031190001',
    'JapicCTI-205123',
    'PACTR201501001016415',
    'NTR7216',
    'NL-OMON12345',
    'NL7834',
    'EUCTR2005-000060-16-ES',
    'EUCTR2015-001900-76',
    '2022-500123-45-00',
    '2015-001900-76',
    'KCT0001234',
    'TCTR20170210001',
    'SLCTR/2021/023',
    'slctr-2014-010',
    'PER-012-19',
    'RBR-2frpntv',
    'RPCEC00000383',
    'LBCTR2025075755',
    'ITMCTR2024000330',
  ]

  expect(identifiers.map(getTrialRegistryIdentifier)).toEqual(identifiers)
})

test('getTrialRegistryIdentifier finds the id inside registry urls and WHO ICTRP links', () => {
  expect(getTrialRegistryIdentifier('https://clinicaltrials.gov/study/NCT00005915')).toBe('NCT00005915')
  expect(getTrialRegistryIdentifier('http://clinicaltrials.gov/show/NCT00198640')).toBe('NCT00198640')
  expect(getTrialRegistryIdentifier('https://anzctr.org.au/ACTRN12611000750987.aspx')).toBe('ACTRN12611000750987')
  expect(getTrialRegistryIdentifier('https://www.thaiclinicaltrials.org/show/TCTR20170210001')).toBe('TCTR20170210001')
  expect(getTrialRegistryIdentifier('https://rpcec.sld.cu/en/trials/RPCEC00000275-En')).toBe('RPCEC00000275')
  expect(getTrialRegistryIdentifier('https://trialsearch.who.int/Trial2.aspx?TrialID=CTRI/2019/09/021252')).toBe(
    'CTRI/2019/09/021252',
  )
  expect(
    getTrialRegistryIdentifier(
      'https://www.clinicaltrialsregister.eu/ctr-search/search?query=eudract_number:2015-001900-76',
    ),
  ).toBe('2015-001900-76')
  expect(
    getTrialRegistryIdentifier(
      'https://www.embase.com/search/results?subaction=viewrecord&id=LNCT00144638&from=exporthttps://clinicaltrials.gov/study/NCT00144638',
    ),
  ).toBe('NCT00144638')
})

test('getTrialRegistryIdentifier ignores bibliographic accession numbers and near misses', () => {
  const values = [
    null,
    undefined,
    '',
    'WOS:000422265700030',
    'CN-01459790',
    '190799078',
    '38500000',
    'L2001234567',
    'LNCT00144638',
    'NCT0000591',
    'NCT000059150',
    'ISRCTN1095718',
    'ACTRN1261100075098',
    'IRCT13880409',
    '2015-01-01',
    'BMJ Open',
    'Trials',
    'https://www.cochranelibrary.com/central/doi/10.1002/central/CN-01800343/full',
    'http://www.ctri.nic.in/Clinicaltrials/pmaindet2.php?trialid=3379',
    'http://en.irct.ir/trial/1031',
    'http://www.chictr.org.cn/showproj.aspx?proj=15716',
  ]

  expect(values.map(getTrialRegistryIdentifier)).toEqual(
    values.map(() => {
      return null
    }),
  )
})

test('getTrialRegistryIdentifier returns the first id when the text holds several', () => {
  expect(getTrialRegistryIdentifier('ISRCTN10957189; NCT00005915')).toBe('ISRCTN10957189')
  expect(getTrialRegistryIdentifier('JPRN-UMIN000012345')).toBe('JPRN-UMIN000012345')
})

test('isTrialRegistryUrl accepts trial registry hosts and their subdomains only', () => {
  const registryUrls = [
    'https://clinicaltrials.gov/study/NCT00005915',
    'http://classic.clinicaltrials.gov/show/NCT00198640',
    'http://www.ctri.nic.in/Clinicaltrials/pmaindet2.php?trialid=3379',
    'http://en.irct.ir/trial/1031',
    'https://irct.behdasht.gov.ir/trial/78702',
    'http://www.chictr.org.cn/showproj.aspx?proj=15716',
    'https://www.isrctn.com/ISRCTN10957189',
    'https://anzctr.org.au/ACTRN12611000750987.aspx',
    'https://ensaiosclinicos.gov.br/rg/RBR-2frpntv',
    'https://www.thaiclinicaltrials.org/show/TCTR20170210001',
    'https://pactr.samrc.ac.za/TrialDisplay.aspx?TrialID=861',
    'http://itmctr.ccebtcm.org.cn/en-US/Home/ProjectView?pid=3c0f8348',
    'https://www.slctr.lk/trials/slctr-2014-010',
    'https://center6.umin.ac.jp/cgi-open-bin/ctr_e/ctr_view.cgi?recptno=R000028982',
    'https://onderzoekmetmensen.nl/en/trial/26918',
    'https://rpcec.sld.cu/en/trials/RPCEC00000275-En',
    'https://www.clinicaltrialsregister.eu/ctr-search/search?query=eudract_number:2015-001900-76',
    'https://trialsearch.who.int/Trial2.aspx?TrialID=NTR7216',
    'https://drks.de/search/en/trial/DRKS00012345',
  ]
  const otherUrls = [
    'https://dx.doi.org/10.1000/alpha',
    'https://www.cochranelibrary.com/central/doi/10.1002/central/CN-01800343/full',
    'https://www.embase.com/search/results?subaction=viewrecord&id=LNCT00144638',
    'https://pubmed.ncbi.nlm.nih.gov/31234567/',
    'https://notclinicaltrials.gov/study/NCT00005915',
    'https://clinicaltrials.gov.example.com/study/NCT00005915',
    'clinicaltrials.gov/study/NCT00005915',
    'not a url',
  ]

  expect(registryUrls.filter(isTrialRegistryUrl)).toEqual(registryUrls)
  expect(otherUrls.filter(isTrialRegistryUrl)).toEqual([])
})
