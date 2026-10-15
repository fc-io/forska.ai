import {expect, test} from 'bun:test'

import {
  getProjectTransferCanonicalJson,
  getProjectTransferCanonicalNdjson,
  getProjectTransferCanonicalPayloadChecksum,
  getProjectTransferLogicalFingerprintValue,
  getProjectTransferLogicalPackageFingerprint,
  getProjectTransferPackageFingerprint,
  getProjectTransferSchemaVNextLogicalPackageFingerprintFromDigests,
  getProjectTransferSchemaVNextLogicalPayloadDigest,
  getProjectTransferSchemaVNextLogicalPayloadDigestFromDigests,
  getProjectTransferSchemaVNextSingletonPayloadDigest,
  getProjectTransferSchemaVNextStagedRowDigest,
  getProjectTransferSha256Checksum,
  projectTransferLogicalFingerprintExcludedKeys,
} from './projectTransferFingerprint.ts'

const rows = [
  {z: [{b: false, a: null}, [], {}], a: {y: [true, 1, 'x'], x: {b: 2, a: 1}}},
  {
    text: 'quote" slash/ backslash\\ controls\b\f\n\r\t\u0000\u001f',
    unicode: '\u00C5\u6F22\u5B57\u{1f642}\u{1d11e}\u2028\u2029',
    surrogates: ['\ud800', '\udc00', '\ud800x\udfff', '\ud800\ud800\udc00'],
  },
  {numbers: [1, 1.5, 1e21, -0, 0.1 + 0.2, 9007199254740991, 9007199254740992, 1e-7, 1e-6], empty: ['', [], {}, null]},
  {
    ...Object.fromEntries(
      projectTransferLogicalFingerprintExcludedKeys.map((key) => {
        return [key, 'excluded']
      }),
    ),
    sourceArticleId: 'a',
    targetProjectId: 'p',
    sourceId: 's',
    targetId: 't',
    sourceArticleIds: ['kept'],
    sourceIdentity: 'kept',
    SourceArticleId: 'kept',
    nested: {id: 'drop', createdAt: 'drop', sourceModelId: 'drop', keep: true},
  },
  JSON.parse('{"z":1,"__proto__":{"nested":true,"id":"drop"},"constructor":"own","10":"ten","2":"two"}') as unknown,
  {z: undefined, a: [undefined, null, false], b: {omitted: undefined, kept: 'yes'}},
  {'\ud800': '\udfff', '\u{1f642}': 'astral key', '\n': 'control key', a: {z: 0, a: 1}},
  {a: {a: 1, z: 0}, '\n': 'control key', '\u{1f642}': 'astral key', '\ud800': '\udfff'},
]

const expected = [
  {
    canonical: '{"a":{"x":{"a":1,"b":2},"y":[true,1,"x"]},"z":[{"a":null,"b":false},[],{}]}',
    checksum: 'ab52273e2ad9b2405739d147ab9f028ec831cb8db2100c610b5db4ea71f0c7bc',
    logicalJson: '{"a":{"x":{"a":1,"b":2},"y":[true,1,"x"]},"z":[{"a":null,"b":false},[],{}]}',
    stagedDigest: {
      digestSha256: 'ab52273e2ad9b2405739d147ab9f028ec831cb8db2100c610b5db4ea71f0c7bc',
      payloadKey: 'judgments',
      sortKey: 'ab52273e2ad9b2405739d147ab9f028ec831cb8db2100c610b5db4ea71f0c7bc',
    },
    singletonDigest: {
      digestSha256: 'ab52273e2ad9b2405739d147ab9f028ec831cb8db2100c610b5db4ea71f0c7bc',
      payloadKey: 'project',
    },
  },
  {
    canonical:
      '{"surrogates":["\\ud800","\\udc00","\\ud800x\\udfff","\\ud800𐀀"],"text":"quote\\" slash/ backslash\\\\ controls\\b\\f\\n\\r\\t\\u0000\\u001f","unicode":"Å漢字🙂𝄞  "}',
    checksum: '6f5a6ef3ed26ea32124ebf278a2a63f567adf15fe40d526f96dcc2d5fab24b0b',
    logicalJson:
      '{"surrogates":["\\ud800","\\udc00","\\ud800x\\udfff","\\ud800𐀀"],"text":"quote\\" slash/ backslash\\\\ controls\\b\\f\\n\\r\\t\\u0000\\u001f","unicode":"Å漢字🙂𝄞  "}',
    stagedDigest: {
      digestSha256: '6f5a6ef3ed26ea32124ebf278a2a63f567adf15fe40d526f96dcc2d5fab24b0b',
      payloadKey: 'judgments',
      sortKey: '6f5a6ef3ed26ea32124ebf278a2a63f567adf15fe40d526f96dcc2d5fab24b0b',
    },
    singletonDigest: {
      digestSha256: '6f5a6ef3ed26ea32124ebf278a2a63f567adf15fe40d526f96dcc2d5fab24b0b',
      payloadKey: 'project',
    },
  },
  {
    canonical:
      '{"empty":["",[],{},null],"numbers":[1,1.5,1e+21,0,0.30000000000000004,9007199254740991,9007199254740992,1e-7,0.000001]}',
    checksum: '4436935ec66a3c76cf64b5764bbfdeeca8ec5e01c6ea196f444b10cfab241c66',
    logicalJson:
      '{"empty":["",[],{},null],"numbers":[1,1.5,1e+21,0,0.30000000000000004,9007199254740991,9007199254740992,1e-7,0.000001]}',
    stagedDigest: {
      digestSha256: '4436935ec66a3c76cf64b5764bbfdeeca8ec5e01c6ea196f444b10cfab241c66',
      payloadKey: 'judgments',
      sortKey: '4436935ec66a3c76cf64b5764bbfdeeca8ec5e01c6ea196f444b10cfab241c66',
    },
    singletonDigest: {
      digestSha256: '4436935ec66a3c76cf64b5764bbfdeeca8ec5e01c6ea196f444b10cfab241c66',
      payloadKey: 'project',
    },
  },
  {
    canonical:
      '{"SourceArticleId":"kept","byteLength":"excluded","commitId":"excluded","completedAt":"excluded","createdAt":"excluded","deletedAt":"excluded","expiresAt":"excluded","exportedAt":"excluded","generatedAt":"excluded","heartbeatAt":"excluded","historyId":"excluded","id":"excluded","importedAt":"excluded","nested":{"createdAt":"drop","id":"drop","keep":true,"sourceModelId":"drop"},"ownerToken":"excluded","packageFingerprint":"excluded","sessionId":"excluded","sortKey":"excluded","sourceArticleId":"a","sourceArticleIds":["kept"],"sourceId":"s","sourceIdentity":"kept","sourceProjectName":"excluded","sourceRecordHash":"excluded","sourceRecordKey":"excluded","sourceRef":"excluded","targetId":"t","targetProjectId":"p","targetProjectName":"excluded","transferId":"excluded","updatedAt":"excluded"}',
    checksum: 'e6fa122f493b2846132680642dc710e95d3efff25d4f12668f729a3524ce4dc4',
    logicalJson:
      '{"SourceArticleId":"kept","nested":{"keep":true},"sourceArticleIds":["kept"],"sourceIdentity":"kept"}',
    stagedDigest: {
      digestSha256: 'ec6afd5eaf207e2006a6a012ee36165b9cc74558599224037067295404a39b91',
      payloadKey: 'judgments',
      sortKey: 'ec6afd5eaf207e2006a6a012ee36165b9cc74558599224037067295404a39b91',
    },
    singletonDigest: {
      digestSha256: 'ec6afd5eaf207e2006a6a012ee36165b9cc74558599224037067295404a39b91',
      payloadKey: 'project',
    },
  },
  {
    canonical: '{"10":"ten","2":"two","__proto__":{"id":"drop","nested":true},"constructor":"own","z":1}',
    checksum: 'bf85ee64fbb8e5b48ef17684e6728739fdf47408363edcd4f03374bda61c8da6',
    logicalJson: '{"2":"two","10":"ten","__proto__":{"nested":true},"constructor":"own","z":1}',
    stagedDigest: {
      digestSha256: '47cc78eb2b6797d6bc6952ad0c2a764454c0054c5f7b3e3035f955bcf54f2535',
      payloadKey: 'judgments',
      sortKey: '47cc78eb2b6797d6bc6952ad0c2a764454c0054c5f7b3e3035f955bcf54f2535',
    },
    singletonDigest: {
      digestSha256: '47cc78eb2b6797d6bc6952ad0c2a764454c0054c5f7b3e3035f955bcf54f2535',
      payloadKey: 'project',
    },
  },
  {
    canonical: '{"a":[null,null,false],"b":{"kept":"yes"}}',
    checksum: '8276d1f33608cd049a8147d9daaa23b215f80a25907747e973d23843cdaaba8d',
    logicalJson: '{"a":[null,null,false],"b":{"kept":"yes"}}',
    stagedDigest: {
      digestSha256: '8276d1f33608cd049a8147d9daaa23b215f80a25907747e973d23843cdaaba8d',
      payloadKey: 'judgments',
      sortKey: '8276d1f33608cd049a8147d9daaa23b215f80a25907747e973d23843cdaaba8d',
    },
    singletonDigest: {
      digestSha256: '8276d1f33608cd049a8147d9daaa23b215f80a25907747e973d23843cdaaba8d',
      payloadKey: 'project',
    },
  },
  {
    canonical: '{"\\n":"control key","a":{"a":1,"z":0},"\\ud800":"\\udfff","🙂":"astral key"}',
    checksum: '034800dd3cea674c0f5b3dbf46232ccc8702cd408d15c2051221151ee2cc7f7b',
    logicalJson: '{"\\n":"control key","a":{"a":1,"z":0},"\\ud800":"\\udfff","🙂":"astral key"}',
    stagedDigest: {
      digestSha256: '034800dd3cea674c0f5b3dbf46232ccc8702cd408d15c2051221151ee2cc7f7b',
      payloadKey: 'judgments',
      sortKey: '034800dd3cea674c0f5b3dbf46232ccc8702cd408d15c2051221151ee2cc7f7b',
    },
    singletonDigest: {
      digestSha256: '034800dd3cea674c0f5b3dbf46232ccc8702cd408d15c2051221151ee2cc7f7b',
      payloadKey: 'project',
    },
  },
  {
    canonical: '{"\\n":"control key","a":{"a":1,"z":0},"\\ud800":"\\udfff","🙂":"astral key"}',
    checksum: '034800dd3cea674c0f5b3dbf46232ccc8702cd408d15c2051221151ee2cc7f7b',
    logicalJson: '{"\\n":"control key","a":{"a":1,"z":0},"\\ud800":"\\udfff","🙂":"astral key"}',
    stagedDigest: {
      digestSha256: '034800dd3cea674c0f5b3dbf46232ccc8702cd408d15c2051221151ee2cc7f7b',
      payloadKey: 'judgments',
      sortKey: '034800dd3cea674c0f5b3dbf46232ccc8702cd408d15c2051221151ee2cc7f7b',
    },
    singletonDigest: {
      digestSha256: '034800dd3cea674c0f5b3dbf46232ccc8702cd408d15c2051221151ee2cc7f7b',
      payloadKey: 'project',
    },
  },
] as const
const aggregate = {
  ndjson:
    '{"10":"ten","2":"two","__proto__":{"id":"drop","nested":true},"constructor":"own","z":1}\n{"SourceArticleId":"kept","byteLength":"excluded","commitId":"excluded","completedAt":"excluded","createdAt":"excluded","deletedAt":"excluded","expiresAt":"excluded","exportedAt":"excluded","generatedAt":"excluded","heartbeatAt":"excluded","historyId":"excluded","id":"excluded","importedAt":"excluded","nested":{"createdAt":"drop","id":"drop","keep":true,"sourceModelId":"drop"},"ownerToken":"excluded","packageFingerprint":"excluded","sessionId":"excluded","sortKey":"excluded","sourceArticleId":"a","sourceArticleIds":["kept"],"sourceId":"s","sourceIdentity":"kept","sourceProjectName":"excluded","sourceRecordHash":"excluded","sourceRecordKey":"excluded","sourceRef":"excluded","targetId":"t","targetProjectId":"p","targetProjectName":"excluded","transferId":"excluded","updatedAt":"excluded"}\n{"\\n":"control key","a":{"a":1,"z":0},"\\ud800":"\\udfff","🙂":"astral key"}\n{"\\n":"control key","a":{"a":1,"z":0},"\\ud800":"\\udfff","🙂":"astral key"}\n{"a":[null,null,false],"b":{"kept":"yes"}}\n{"a":{"x":{"a":1,"b":2},"y":[true,1,"x"]},"z":[{"a":null,"b":false},[],{}]}\n{"empty":["",[],{},null],"numbers":[1,1.5,1e+21,0,0.30000000000000004,9007199254740991,9007199254740992,1e-7,0.000001]}\n{"surrogates":["\\ud800","\\udc00","\\ud800x\\udfff","\\ud800𐀀"],"text":"quote\\" slash/ backslash\\\\ controls\\b\\f\\n\\r\\t\\u0000\\u001f","unicode":"Å漢字🙂𝄞  "}\n',
  ndjsonChecksum: 'ef41b1c41ee103b7a11242da3bb2d45399eb24b222f0e344464c6b5a9cbeb889',
  payloadDigest: '8a81d79db289a1892b17ed55fabdba1c88ed2e8cf8cba540b91c44c34778a0a7',
  singletonPayloadDigest: '5d2e387f6020a4893465ed4e9d98a016dec31c3b4372e51704e017c731f5e02f',
  packageFingerprint: '27f6b8cbc808695e16ce987166614d9857f86b315c046c1be814ce49b8e600b2',
  legacyLogicalFingerprint: '0470b64aa855f63090e961320a3ca9e3d487c696f2db8560984e08828e893bb8',
}
const manifest = {
  schemaVersion: 2,
  payloads: {
    judgments: {byteLength: 0, checksumSha256: '', format: 'ndjson', path: 'payloads/judgments.ndjson', recordCount: 8},
    project: {byteLength: 0, checksumSha256: '', format: 'json', path: 'payloads/project.json', recordCount: 1},
  },
} as const
const single = {sourceProjectId: 'excluded', name: 'Unicode 🙂', settings: {z: null, a: true}}

test.each(
  expected.map((fixture, index) => {
    return {row: rows[index], fixture, index}
  }),
)('preserves canonical and logical bytes for fixture $index', ({row, fixture}) => {
  const stagedDigest = getProjectTransferSchemaVNextStagedRowDigest({payloadKey: 'judgments', row})
  expect({
    canonical: getProjectTransferCanonicalJson(row),
    checksum: getProjectTransferCanonicalPayloadChecksum({format: 'json', value: row}),
    logicalJson: JSON.stringify(getProjectTransferLogicalFingerprintValue(row)),
    stagedDigest,
    singletonDigest: getProjectTransferSchemaVNextSingletonPayloadDigest({payloadKey: 'project', value: row}),
  }).toEqual(fixture)
  expect(
    getProjectTransferSha256Checksum(getProjectTransferCanonicalJson(getProjectTransferLogicalFingerprintValue(row))),
  ).toBe(stagedDigest.digestSha256)
})

test('preserves payload and package fingerprints from values and staged digests', () => {
  const rowDigests = rows.map((row) => {
    return getProjectTransferSchemaVNextStagedRowDigest({payloadKey: 'judgments', row})
  })
  const singleton = getProjectTransferSchemaVNextSingletonPayloadDigest({payloadKey: 'project', value: single})
  expect(getProjectTransferCanonicalNdjson(rows)).toBe(aggregate.ndjson)
  expect(getProjectTransferCanonicalPayloadChecksum({format: 'ndjson', records: rows})).toBe(aggregate.ndjsonChecksum)
  expect(getProjectTransferSchemaVNextLogicalPayloadDigest({payloadKey: 'judgments', value: rows})).toBe(
    aggregate.payloadDigest,
  )
  expect(
    getProjectTransferSchemaVNextLogicalPayloadDigestFromDigests({
      payloadKey: 'judgments',
      rowDigestSha256: rowDigests.map((row) => {
        return row.digestSha256
      }),
      singletonDigestSha256: null,
    }),
  ).toBe(aggregate.payloadDigest)
  expect(getProjectTransferSchemaVNextLogicalPayloadDigest({payloadKey: 'project', value: single})).toBe(
    aggregate.singletonPayloadDigest,
  )
  expect(
    getProjectTransferSchemaVNextLogicalPackageFingerprintFromDigests({
      manifest,
      rowDigests,
      singletonPayloadDigests: [singleton],
    }),
  ).toBe(aggregate.packageFingerprint)
  expect(getProjectTransferLogicalPackageFingerprint({manifest, payloads: {judgments: rows, project: single}})).toBe(
    aggregate.packageFingerprint,
  )
  expect(getProjectTransferPackageFingerprint({manifest, payloads: {judgments: rows, project: single}})).toBe(
    aggregate.packageFingerprint,
  )
  expect(
    getProjectTransferLogicalPackageFingerprint({
      manifest: {...manifest, schemaVersion: 1},
      payloads: {judgments: rows, project: single},
    }),
  ).toBe(aggregate.legacyLogicalFingerprint)
})
