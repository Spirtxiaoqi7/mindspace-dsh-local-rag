import { describe, expect, it } from 'vitest'

import { localRagDescriptors } from '../src/generated/descriptors.ts'
import { TYPERT } from '../src/generated/typert.ts'
import { LocalRagService } from '../src/host/service.ts'

const REMOTE_METHODS = [
  'status', 'importText', 'removeDocument', 'deleteDocument', 'listDocuments', 'getDocument', 'updateDocument', 'restoreDocument', 'rebuild',
  'catalogModels', 'selectModel', 'downloadModel', 'cancelDownload', 'startModel', 'stopModel', 'setModelAutoStart',
  'beginUpload', 'appendUpload', 'completeUpload', 'cancelUpload', 'getSourcePreview', 'search', 'manual',
] as const

describe('checked-in Typert descriptors', () => {
  it('keeps strict runtime descriptors, contribution metadata, and Host methods in parity', () => {
    const descriptors = [...localRagDescriptors]
    const descriptorMethods = descriptors.map(item => item.method)
    const contributionMethods = TYPERT.model.services[0]?.members.map(item => item.name)
    const hostMethods = Object.getOwnPropertyNames(LocalRagService.prototype)

    expect(descriptorMethods).toEqual(REMOTE_METHODS)
    expect(contributionMethods).toEqual(REMOTE_METHODS)
    expect(hostMethods).toEqual(expect.arrayContaining(REMOTE_METHODS))
    expect(descriptors).toHaveLength(23)
    for (const descriptor of descriptors) {
      expect(descriptor.cancellation).toEqual({ parameter: 'signal' })
      expect(descriptor.result.mode).toBe('strict')
      expect(descriptor.result.schema).toBeDefined()
      for (const parameter of descriptor.parameters) {
        expect(parameter.codec.mode).toBe('strict')
        expect(parameter.codec.schema).toBeDefined()
      }
    }
  })

  it('strictly carries source provenance, lane degradation, uploads, and model lifecycle', () => {
    const search = localRagDescriptors.find(item => item.method === 'search')
    const result = search?.result.schema.safeParse({
      query: '鲸鱼', scope: 'knowledge', vectorCandidates: 0, lexicalCandidates: 1, modelId: 'local', partial: true,
      laneStatus: {
        vector: { lane: 'vector', state: 'unavailable', candidates: 0 },
        lexical: { lane: 'lexical', state: 'complete', candidates: 1 },
      },
      hits: [{
        parentId: 'p', documentId: 'd', title: 'PDF', text: '鲸鱼', matchedText: '鲸鱼', scope: 'knowledge',
        authority: { kind: 'pdf', fileName: 'a.pdf', documentTitle: 'A' }, locator: { pageNumber: 2 },
        updatedAt: 1, rrfScore: 0.1, evidence: [{ lane: 'lexical', rank: 1, score: 2 }],
      }],
    })
    expect(result?.success).toBe(true)
    expect(localRagDescriptors.map(item => item.method)).toEqual(expect.arrayContaining([
      'catalogModels', 'selectModel', 'startModel', 'stopModel', 'setModelAutoStart',
      'beginUpload', 'appendUpload', 'completeUpload', 'cancelUpload', 'getSourcePreview',
    ]))
  })

  it('does not expose retrieval limits or ranking controls to the model-facing search request', () => {
    const search = localRagDescriptors.find(item => item.method === 'search')
    const parsed = search?.parameters[0]?.codec.schema.safeParse({ query: '珊瑚灯塔', scope: 'both' })
    expect(parsed?.success).toBe(true)
    if (!parsed?.success) return
    expect(Object.keys(parsed.data).sort()).toEqual(['query', 'scope'])
  })
})
