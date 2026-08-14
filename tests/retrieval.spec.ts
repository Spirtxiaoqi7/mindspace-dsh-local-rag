import { describe, expect, it } from 'vitest'

import type { EmbeddingProvider, SourceDocument } from '../src/contracts.ts'
import { LocalHybridRetriever, InMemoryRetrievalStore, resolveRetrievalConfig } from '../src/retrieval/index.ts'

class TestEmbeddingProvider implements EmbeddingProvider {
  readonly modelId = 'test-local-v1'
  readonly dimensions = 2

  async ready(): Promise<boolean> {
    return true
  }

  async embed(texts: readonly string[], _signal?: AbortSignal): Promise<number[][]> {
    return texts.map((text) => {
      const lowered = text.toLowerCase()
      return [
        Number(lowered.includes('鲸鱼') || lowered.includes('whale') || lowered.includes('海洋')),
        Number(lowered.includes('rust') || lowered.includes('java') || lowered.includes('代码')),
      ]
    })
  }
}

class CapturingEmbeddingProvider extends TestEmbeddingProvider {
  signal: AbortSignal | undefined
  override async embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    this.signal = signal
    return super.embed(texts, signal)
  }
}

function document(overrides: Partial<SourceDocument>): SourceDocument {
  return {
    id: 'knowledge-1',
    title: 'knowledge',
    text: '鲸鱼喜欢海洋。Whale memory.',
    scope: 'knowledge',
    updatedAt: 1,
    ...overrides,
  }
}

describe('LocalHybridRetriever', () => {
  it('returns vector and lexical evidence, with each lane capped at its configured default', async () => {
    const provider = new TestEmbeddingProvider()
    const retriever = new LocalHybridRetriever(provider, new InMemoryRetrievalStore(provider.modelId), {
      ...resolveRetrievalConfig(),
      parentCharacters: 200,
      childCharacters: 50,
      childOverlap: 0,
    })
    await retriever.index(Array.from({ length: 8 }, (_, index) => document({ id: `k-${index}`, text: `鲸鱼 whale 海洋 ${index}` })))

    const result = await retriever.search({ query: '鲸鱼 whale', scope: 'knowledge' })

    expect(result.vectorCandidates).toBe(5)
    expect(result.lexicalCandidates).toBe(5)
    expect(result.hits[0].evidence.map((item) => item.lane)).toEqual(['lexical', 'vector'])
    expect(result.hits[0].rrfScore).toBeCloseTo(2 / 61)
  })

  it('uses child matches as evidence while returning one parent result', async () => {
    const provider = new TestEmbeddingProvider()
    const retriever = new LocalHybridRetriever(provider, new InMemoryRetrievalStore(provider.modelId), {
      ...resolveRetrievalConfig(),
      parentCharacters: 200,
      childCharacters: 50,
      childOverlap: 0,
    })
    await retriever.index([document({ text: `${'前言内容无关。'.repeat(8)}鲸鱼生活在海洋。${'结尾内容无关。'.repeat(8)}` })])

    const result = await retriever.search({ query: '鲸鱼海洋', scope: 'knowledge' })

    expect(result.hits).toHaveLength(1)
    expect(result.hits[0].text).toContain('前言内容无关')
    expect(result.hits[0].matchedText).toContain('鲸鱼')
  })

  it('isolates conversation-summary documents and never leaks another session through both scope', async () => {
    const provider = new TestEmbeddingProvider()
    const retriever = new LocalHybridRetriever(provider, new InMemoryRetrievalStore(provider.modelId))
    await retriever.index([
      document({ id: 'a', title: 'A', text: '鲸鱼 海洋 A', scope: 'conversation_summary', sessionId: 'session-a' }),
      document({ id: 'b', title: 'B', text: '鲸鱼 海洋 B', scope: 'conversation_summary', sessionId: 'session-b' }),
      document({ id: 'k', title: 'K', text: '鲸鱼 海洋 knowledge', scope: 'knowledge', sourceId: 'source-sha256-k', sourceUri: 'local-rag://source/source-sha256-k' }),
    ])

    const a = await retriever.search({ query: '鲸鱼海洋', scope: 'both', sessionId: 'session-a' })
    const b = await retriever.search({ query: '鲸鱼海洋', scope: 'conversation_summary', sessionId: 'session-b' })
    const bBoth = await retriever.search({ query: '鲸鱼海洋', scope: 'both', sessionId: 'session-b' })
    const aSummary = await retriever.search({ query: '鲸鱼海洋', scope: 'conversation_summary', sessionId: 'session-a' })

    expect(a.hits.map((item) => item.documentId)).toEqual(expect.arrayContaining(['a', 'k']))
    expect(a.hits.map((item) => item.documentId)).not.toContain('b')
    expect(b.hits.map((item) => item.documentId)).toEqual(['b'])
    expect(bBoth.hits.map((item) => item.documentId)).toEqual(expect.arrayContaining(['b', 'k']))
    expect(bBoth.hits.map((item) => item.documentId)).not.toContain('a')
    expect(aSummary.hits.map((item) => item.documentId)).toEqual(['a'])
    const sourceOnly = await retriever.search({ query: '鲸鱼海洋', scope: 'knowledge', sourceId: 'source-sha256-k' })
    expect(sourceOnly.hits).toHaveLength(1)
    expect(sourceOnly.hits[0]).toMatchObject({ documentId: 'k', sourceId: 'source-sha256-k', sourceUri: 'local-rag://source/source-sha256-k' })
  })

  it('enforces the existing configuration boundaries', () => {
    expect(() => resolveRetrievalConfig({ vectorCandidates: 0 })).toThrow('vectorCandidates')
    expect(resolveRetrievalConfig({ childOverlap: 200 }).childOverlap).toBe(0)
    expect(resolveRetrievalConfig()).toMatchObject({ vectorCandidates: 5, lexicalCandidates: 5, rrfK: 60 })
  })

  it('accepts and forwards an AbortSignal for indexing and searching', async () => {
    const provider = new CapturingEmbeddingProvider()
    const retriever = new LocalHybridRetriever(provider, new InMemoryRetrievalStore(provider.modelId))
    const controller = new AbortController()
    await retriever.index([document({ id: 'signal-index' })], controller.signal)
    expect(provider.signal).toBe(controller.signal)

    await retriever.search({ query: '鲸鱼', scope: 'knowledge' }, controller.signal)
    expect(provider.signal).toBeDefined()
    expect(provider.signal?.aborted).toBe(false)
  })

  it('lists and removes source documents without touching another document', async () => {
    const provider = new TestEmbeddingProvider()
    const retriever = new LocalHybridRetriever(provider, new InMemoryRetrievalStore(provider.modelId))
    await retriever.index([document({ id: 'keep' }), document({ id: 'remove', text: 'Rust 代码' })])

    expect((await retriever.listDocuments()).map((item) => item.id)).toEqual(['keep', 'remove'])
    expect(await retriever.removeDocument('remove')).toBe(true)
    expect(await retriever.removeDocument('missing')).toBe(false)
    expect((await retriever.listDocuments()).map((item) => item.id)).toEqual(['keep'])
  })
})
