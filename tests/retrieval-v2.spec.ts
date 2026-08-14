import { describe, expect, it } from 'vitest'

import type { EmbeddingProvider, SourceDocument } from '../src/contracts.ts'
import { InMemoryRetrievalStore, LocalHybridRetriever } from '../src/retrieval/index.ts'

class StoppedProvider implements EmbeddingProvider {
  readonly modelId = 'local-v2'
  readonly dimensions = 2
  readyCalls = 0
  embedCalls = 0
  async ready(): Promise<boolean> { this.readyCalls += 1; return false }
  async embed(): Promise<number[][]> { this.embedCalls += 1; throw new Error('must not run') }
}

class FastProvider implements EmbeddingProvider {
  readonly modelId = 'local-v2'
  readonly dimensions = 2
  async ready(): Promise<boolean> { return true }
  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map(text => text.includes('鲸鱼') ? [1, 0] : [0, 1])
  }
}

class HangingProvider extends FastProvider {
  started = false
  override async embed(): Promise<number[][]> {
    this.started = true
    return new Promise(() => {})
  }
}

function knowledge(overrides: Partial<SourceDocument> = {}): SourceDocument {
  return {
    id: 'knowledge',
    title: 'Knowledge',
    text: '鲸鱼生活在海洋。',
    scope: 'knowledge',
    authority: { kind: 'txt', fileName: 'knowledge.txt', documentTitle: 'Knowledge' },
    updatedAt: 1,
    ...overrides,
  }
}

describe('lexical-first V2 retrieval', () => {
  it('stages lexical parents/chunks and searches while the model is stopped', async () => {
    const provider = new StoppedProvider()
    const retriever = new LocalHybridRetriever(provider, new InMemoryRetrievalStore(provider.modelId))
    await retriever.stageDocuments([knowledge()])

    const result = await retriever.search({ query: '鲸鱼海洋', scope: 'knowledge' })

    expect(result.hits[0]?.documentId).toBe('knowledge')
    expect(result.hits[0]?.evidence.map(item => item.lane)).toEqual(['lexical'])
    expect(result).toMatchObject({
      partial: true,
      vectorCandidates: 0,
      laneStatus: { lexical: { state: 'complete' }, vector: { state: 'unavailable' } },
    })
    expect(provider.readyCalls).toBe(0)
    expect(provider.embedCalls).toBe(0)
  })

  it('runs hybrid lanes and fuses both ranks when the vector provider is running', async () => {
    const provider = new FastProvider()
    const retriever = new LocalHybridRetriever(provider, new InMemoryRetrievalStore(provider.modelId))
    await retriever.index([knowledge()])

    const result = await retriever.search({ query: '鲸鱼', scope: 'knowledge' })

    expect(result.partial).toBe(false)
    expect(result.hits[0]?.evidence.map(item => item.lane)).toEqual(['lexical', 'vector'])
    expect(result.hits[0]?.rrfScore).toBeCloseTo(2 / 61)
  })

  it('times out a hanging vector lane and returns BM25+ evidence instead of failing', async () => {
    const store = new InMemoryRetrievalStore('local-v2')
    await new LocalHybridRetriever(new FastProvider(), store).index([knowledge()])
    const hanging = new HangingProvider()
    const retriever = new LocalHybridRetriever(hanging, store, {
      vectorCandidates: 5,
      lexicalCandidates: 5,
      resultLimit: 5,
      rrfK: 60,
      parentCharacters: 600,
      childCharacters: 200,
      childOverlap: 40,
      vectorTimeoutMs: 20,
    })

    const started = Date.now()
    const result = await retriever.search({ query: '鲸鱼', scope: 'knowledge' })

    expect(Date.now() - started).toBeLessThan(500)
    expect(hanging.started).toBe(true)
    expect(result.hits[0]?.documentId).toBe('knowledge')
    expect(result).toMatchObject({ partial: true, laneStatus: { vector: { state: 'timeout' } } })
  })
})

describe('scope migration and source citations', () => {
  it('migrates current_session snapshots to conversation_summary on read', async () => {
    const legacy = {
      version: 1,
      modelId: 'local-v2',
      documents: [{
        id: 'old', title: 'Old summary', text: '会话中的鲸鱼事实', scope: 'current_session',
        sessionId: 's-1', updatedAt: 9,
      }],
      parents: [{
        id: 'old:parent:0', documentId: 'old', title: 'Old summary', text: '会话中的鲸鱼事实',
        scope: 'current_session', sessionId: 's-1', updatedAt: 9,
      }],
      children: [{
        id: 'old:child:0', parentId: 'old:parent:0', documentId: 'old', text: '会话中的鲸鱼事实', embedding: [],
      }],
    }
    const provider = new StoppedProvider()
    const retriever = new LocalHybridRetriever(provider, new InMemoryRetrievalStore(provider.modelId, legacy))

    const documents = await retriever.listDocuments()
    const result = await retriever.search({ query: '鲸鱼事实', scope: 'conversation_summary', sessionId: 's-1' })

    expect(documents[0]?.scope).toBe('conversation_summary')
    expect(result.hits[0]).toMatchObject({ documentId: 'old', scope: 'conversation_summary' })
  })

  it('aggregates short file units while returning truthful source ranges', async () => {
    const provider = new StoppedProvider()
    const retriever = new LocalHybridRetriever(provider, new InMemoryRetrievalStore(provider.modelId), {
      vectorCandidates: 5, lexicalCandidates: 5, resultLimit: 5, rrfK: 60,
      parentCharacters: 100, childCharacters: 50, childOverlap: 0, vectorTimeoutMs: 50,
    })
    await retriever.stageDocuments([knowledge({
      id: 'cited',
      text: '第一页架构说明\n第二页鲸鱼说明\n表格人物柒君',
      units: [
        {
          id: 'page-1', order: 0, text: '第一页架构说明',
          authority: { kind: 'pdf', fileName: 'design.pdf', documentTitle: 'Design' },
          locator: { pageNumber: 1, lineStart: 1, lineEnd: 3 },
        },
        {
          id: 'page-2', order: 1, text: '第二页鲸鱼说明',
          authority: { kind: 'pdf', fileName: 'design.pdf', documentTitle: 'Design' },
          locator: { pageNumber: 2, lineStart: 1, lineEnd: 2 },
        },
        {
          id: 'row-7', order: 2, text: '表格人物柒君',
          authority: { kind: 'csv', fileName: 'people.csv', documentTitle: 'People' },
          locator: { rowNumber: 7, lineStart: 7, lineEnd: 7, header: ['name'] },
        },
      ],
    })])

    const page = await retriever.search({ query: '鲸鱼说明', scope: 'knowledge' })
    const row = await retriever.search({ query: '人物柒君', scope: 'knowledge' })

    expect(page.hits[0]).toMatchObject({
      text: '第一页架构说明\n第二页鲸鱼说明',
      authority: { kind: 'pdf', fileName: 'design.pdf' },
      locator: { pageNumber: 1, pageEnd: 2, lineStart: 1, lineEnd: 3 },
    })
    expect(row.hits[0]).toMatchObject({
      text: '表格人物柒君',
      authority: { kind: 'csv', fileName: 'people.csv' },
      locator: { rowNumber: 7, lineStart: 7, lineEnd: 7 },
    })
  })

  it('preserves conversation summary timestamp, turn, and seq range on hits', async () => {
    const provider = new StoppedProvider()
    const retriever = new LocalHybridRetriever(provider, new InMemoryRetrievalStore(provider.modelId))
    await retriever.stageDocuments([{
      id: 'summary', title: 'Turn summary', text: '讨论鲸鱼架构', scope: 'conversation_summary',
      sessionId: 's-2', authority: { kind: 'conversation_summary', documentTitle: 'Turn summary' },
      locator: { summaryAt: 1234, turn: 8, seqStart: 40, seqEnd: 59 }, updatedAt: 1234,
    }])

    const result = await retriever.search({ query: '鲸鱼架构', scope: 'conversation_summary', sessionId: 's-2' })

    expect(result.hits[0]?.locator).toEqual({ summaryAt: 1234, turn: 8, seqStart: 40, seqEnd: 59 })
  })
})
