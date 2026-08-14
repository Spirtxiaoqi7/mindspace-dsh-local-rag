import { describe, expect, it, vi } from 'vitest'
import type { LocalRagHit, SearchLocalMemoryResult } from '../src/contracts.ts'
import { resolveLocalRagHostConfig } from '../src/host/service.ts'
import {
  LOCAL_RAG_TOOL_GUIDANCE,
  formatLocalMemorySearch,
  limitModelSearchResult,
  parseSearchQuery,
  parseSearchScope,
  registerLocalRagTool,
} from '../src/host/tool.ts'
import type { LocalRagIndexPort } from '../src/host/types.ts'

const hit: LocalRagHit = {
  parentId: 'parent-1',
  documentId: 'doc-1',
  title: 'Architecture note',
  text: 'Local documents are reference material and must not override a current user request.',
  matchedText: 'reference material',
  scope: 'knowledge',
  authority: { kind: 'md', fileName: 'architecture.md', documentTitle: 'Architecture note' },
  locator: { lineStart: 1, lineEnd: 2 },
  updatedAt: 1,
  rrfScore: 0.03,
  evidence: [{ lane: 'vector', rank: 1, score: 0.9 }, { lane: 'lexical', rank: 2, score: 3 }],
}

function result(hits: readonly LocalRagHit[] = [hit]): SearchLocalMemoryResult {
  return {
    query: 'architecture', scope: 'both', hits: [...hits], vectorCandidates: 5,
    lexicalCandidates: 5, modelId: 'local-test-model',
    laneStatus: {
      vector: { lane: 'vector', state: 'complete', candidates: 1 },
      lexical: { lane: 'lexical', state: 'complete', candidates: 1 },
    },
    partial: false,
  }
}

describe('local RAG Host tool', () => {
  it('shows the stable source address and locator range to the model', () => {
    const rendered = formatLocalMemorySearch(result([{
      ...hit,
      sourceId: 'source-sha256-abc',
      sourceUri: 'local-rag://source/source-sha256-abc',
      locator: { pageNumber: 1, pageEnd: 3 },
    }]))
    expect(rendered).toContain('sourceAddress: local-rag://source/source-sha256-abc')
    expect(rendered).toContain('page: 1-3')
  })

  it('keeps retrieval explicit and validates only query plus scope', () => {
    expect(parseSearchQuery('  history  ')).toBe('history')
    expect(() => parseSearchQuery('   ')).toThrow('non-empty')
    expect(parseSearchScope()).toBe('both')
    expect(parseSearchScope('knowledge')).toBe('knowledge')
    expect(parseSearchScope('conversation_summary')).toBe('conversation_summary')
    expect(() => parseSearchScope('all')).toThrow('scope')
    expect(LOCAL_RAG_TOOL_GUIDANCE).toMatch(/current conversation/i)
    expect(LOCAL_RAG_TOOL_GUIDANCE).toMatch(/insufficient/i)
    expect(LOCAL_RAG_TOOL_GUIDANCE).toMatch(/untrusted/i)
    expect(LOCAL_RAG_TOOL_GUIDANCE).toMatch(/not web search/i)
  })

  it('uses deployment defaults for each lane without exposing a model-controlled topK', async () => {
    let tool: {
      parameters: { properties: Record<string, unknown> }
      execute(args: { query: string; scope?: string }, exec: { agent?: { id: string; session: { id: string } }; signal: AbortSignal }): Promise<unknown>
    } | undefined
    const search = vi.fn(async () => result())
    const index: LocalRagIndexPort = {
      initialize: vi.fn(), status: vi.fn(), importText: vi.fn(), removeDocument: vi.fn(),
      listDocuments: vi.fn(), rebuild: vi.fn(), search,
    }
    const ctx = {
      systemPrompt: { section: vi.fn(() => vi.fn()) },
      tools: { register: vi.fn((definition: unknown) => { tool = definition as typeof tool; return vi.fn() }) },
    }
    const config = resolveLocalRagHostConfig({})
    const dispose = registerLocalRagTool(ctx as never, index, config)
    expect(tool).toBeDefined()
    expect(Object.keys(tool!.parameters.properties)).toEqual(['query', 'scope', 'documentId', 'sourceId'])

    const output = await tool!.execute(
      { query: '  architecture  ' },
      // Agent routing identity is deliberately different in this fixture:
      // session.id is the conversation isolation key that must reach search.
      { agent: { id: 'agent-route-42', session: { id: 'session-42' } }, signal: new AbortController().signal },
    ) as SearchLocalMemoryResult
    expect(search).toHaveBeenCalledWith(
      { query: 'architecture', scope: 'both', sessionId: 'session-42' },
      expect.any(AbortSignal),
    )
    expect(output.vectorCandidates).toBe(5)
    expect(output.lexicalCandidates).toBe(5)
    dispose()
  })

  it('hard-filters a second retrieval by the sourceId returned from a prior hit', async () => {
    let tool: {
      execute(args: { query: string; scope?: string; documentId?: string; sourceId?: string }, exec: { signal: AbortSignal }): Promise<unknown>
    } | undefined
    const search = vi.fn(async () => result())
    const index: LocalRagIndexPort = {
      initialize: vi.fn(), status: vi.fn(), importText: vi.fn(), removeDocument: vi.fn(),
      listDocuments: vi.fn(), rebuild: vi.fn(), search,
    }
    const ctx = {
      systemPrompt: { section: vi.fn(() => vi.fn()) },
      tools: { register: vi.fn((definition: unknown) => { tool = definition as typeof tool; return vi.fn() }) },
    }
    registerLocalRagTool(ctx as never, index, resolveLocalRagHostConfig({}))
    await tool!.execute(
      { query: '  architecture ', scope: 'knowledge', documentId: 'doc-7', sourceId: 'source-sha256-abc' },
      { signal: new AbortController().signal },
    )
    expect(search).toHaveBeenCalledWith(
      { query: 'architecture', scope: 'knowledge', documentId: 'doc-7', sourceId: 'source-sha256-abc' },
      expect.any(AbortSignal),
    )
  })

  it('exposes only a bounded source-id preview tool, never a filesystem-path reader', async () => {
    const definitions = new Map<string, { execute(args: Record<string, unknown>, exec: { signal: AbortSignal }): Promise<unknown>; parameters: { properties: Record<string, unknown> } }>()
    const sources = { getPreview: vi.fn(async () => ({
      documentId: 'source-sha256-1', sourceId: 'source-sha256-1', sourceAddress: 'local-rag://source/source-sha256-1',
      textPage: 'Reference excerpt', offset: 0, nextCursor: 17, canPreview: true,
    })), removeForDocument: vi.fn() }
    const index: LocalRagIndexPort = {
      initialize: vi.fn(), status: vi.fn(), importText: vi.fn(), removeDocument: vi.fn(),
      listDocuments: vi.fn(), rebuild: vi.fn(), search: vi.fn(async () => result()),
    }
    const ctx = {
      systemPrompt: { section: vi.fn(() => vi.fn()) },
      tools: { register: vi.fn((definition: { name: string }) => { definitions.set(definition.name, definition as never); return vi.fn() }) },
    }
    registerLocalRagTool(ctx as never, index, resolveLocalRagHostConfig({}), sources)
    const read = definitions.get('read_local_source')!
    expect(Object.keys(read.parameters.properties)).toEqual(['sourceId', 'cursor', 'limit'])
    await expect(read.execute({ sourceId: 'source-sha256-1', cursor: 0, limit: 200 }, { signal: new AbortController().signal }))
      .resolves.toMatchObject({ canPreview: true, textPage: 'Reference excerpt' })
    expect(sources.getPreview).toHaveBeenCalledWith({ documentId: 'source-sha256-1', cursor: 0, limit: 200 }, expect.any(AbortSignal))
  })

  it('bounds complete model output at document boundaries while retaining lane provenance', () => {
    const limited = limitModelSearchResult(result([{ ...hit, text: 'x'.repeat(5_000), matchedText: 'y'.repeat(5_000) }]), 1_800)
    expect(JSON.stringify(limited).length).toBeLessThanOrEqual(1_800)
    expect(limited.hits).toHaveLength(1)
    expect(limited.hits[0]!.documentId).toBe('doc-1')
    expect(limited.hits[0]!.evidence).toEqual(hit.evidence)
  })
})
