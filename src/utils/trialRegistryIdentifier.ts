const trialRegistryIdentifierPatterns = [
  /NCT\d{8}/,
  /ISRCTN\d{8}/,
  /ACTRN\d{14}/,
  /ChiCTR(?:-[A-Z]{2,5}-)?\d{8,10}/,
  /CTRI\/\d{4}\/\d{2,3}\/\d{5,6}/,
  /IRCT\d{6,}N\d+/,
  /DRKS\d{8}/,
  /JPRN-(?:UMIN\d{9}|jRCT[a-z]?\d{9,10}|JapicCTI-\d{6}|JMA-IIA\d{5}|C\d{9})/,
  /UMIN\d{9}/,
  /jRCT[a-z]?\d{9,10}/,
  /JapicCTI-\d{6}/,
  /PACTR\d{12,16}/,
  /NTR\d{1,5}/,
  /NL-OMON\d+/,
  /NL\d{4,5}/,
  /EUCTR\d{4}-\d{6}-\d{2}(?:-[A-Z]{2,3})?/,
  /\d{4}-5\d{5}-\d{2}-\d{2}/,
  /\d{4}-\d{6}-\d{2}/,
  /KCT\d{7}/,
  /TCTR\d{11}/,
  /SLCTR[/-]\d{4}[/-]\d{3}/,
  /PER-\d{3}-\d{2}/,
  /RBR-[0-9a-z]{6,10}/,
  /RPCEC\d{8}/,
  /LBCTR\d{10}/,
  /ITMCTR\d{10,}/,
] as const

const trialRegistryIdentifierPattern = new RegExp(
  `\\b(?:${trialRegistryIdentifierPatterns
    .map((pattern) => {
      return pattern.source
    })
    .join('|')})\\b`,
  'i',
)

const trialRegistryHosts = [
  'anzctr.org.au',
  'chictr.org.cn',
  'clinicaltrials.gov',
  'clinicaltrialsregister.eu',
  'cris.nih.go.kr',
  'ctri.nic.in',
  'drks.de',
  'ensaiosclinicos.gov.br',
  'euclinicaltrials.eu',
  'irct.behdasht.gov.ir',
  'irct.ir',
  'isrctn.com',
  'isrctn.org',
  'itmctr.ccebtcm.org.cn',
  'jrct.mhlw.go.jp',
  'jrct.niph.go.jp',
  'lbctr.moph.gov.lb',
  'onderzoekmetmensen.nl',
  'pactr.org',
  'pactr.samrc.ac.za',
  'rctportal.niph.go.jp',
  'repec.ins.gob.pe',
  'rpcec.sld.cu',
  'slctr.lk',
  'thaiclinicaltrials.org',
  'trialregister.nl',
  'trialsearch.who.int',
  'umin.ac.jp',
] as const

export const getTrialRegistryIdentifier = (value: string | null | undefined): string | null => {
  return value?.match(trialRegistryIdentifierPattern)?.[0] ?? null
}

const getUrlHost = (value: string) => {
  return URL.canParse(value) ? new URL(value).hostname.toLowerCase() : null
}

export const isTrialRegistryUrl = (value: string): boolean => {
  const host = getUrlHost(value)

  return host === null
    ? false
    : trialRegistryHosts.some((registryHost) => {
        return host === registryHost || host.endsWith(`.${registryHost}`)
      })
}
