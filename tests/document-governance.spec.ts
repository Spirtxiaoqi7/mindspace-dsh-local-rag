import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import type { SearchLocalMemoryRequest, SourceDocument } from '../src/contracts.ts'
import { LocalRagService } from '../src/host/service.ts'
import type { ListLocalRagDocumentsRequest, LocalRagIndexPort } from '../src/host/types.ts'

const roots: string[] = []

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function indexPort(): LocalRagIndexPort {
  const documents = new Map<string, SourceDocument>()
  return {
    initialize: async () => undefined,
    status: async () => ({ documentCount: documents.size, parentCount: documents.size, childCount: documents.size, dirty: false, updatedAt: null }),
    importText: async document => { documents.set(document.id, structuredClone(document)); return structuredClone(document) },
    getDocument: async id => { const item = documents.get(id); return item === undefined ? undefined : structuredClone(item) },
    removeDocument: async id => documents.delete(id),
    listDocuments: async (request: ListLocalRagDocumentsRequest = {}) => [...documents.values()]
      .filter(document => request.scope === undefined || request.scope === 'both' || document.scope === request.scope)
      .filter(document => document.scope !== 'conversation_summary' || request.sessionId === undefined || document.sessionId === request.sessionId)
      .map(document => ({ id: document.id, title: document.title, scope: document.scope, ...(document.sessionId ? { sessionId: document.sessionId } : {}), updatedAt: document.updatedAt, characters: [...document.text].length, revision: 1, revisionCount: 1 })),
    rebuild: async () => undefined,
    search: async (request: SearchLocalMemoryRequest) => ({ query: request.query, scope: request.scope ?? 'both', hits: [], vectorCandidates: 0, lexicalCandidates: 0, modelId: 'test', laneStatus: { vector: { lane: 'vector', state: 'empty', candidates: 0 }, lexical: { lane: 'lexical', state: 'empty', candidates: 0 } }, partial: false }),
  }
}

function models() {
  const status = { modelId: 'test', ready: false, dimensions: null, state: 'missing' as const }
  return {
    status: async () => status, catalog: async () => [], select: async () => status, download: async () => status,
    cancelDownload: async () => status, start: async () => status, stop: async () => status,
    setAutoStart: async () => status, acknowledgeIndexRebuilt: async () => status,
  }
}

describe('document governance', () => {
  it('edits, logically deletes, lists, and restores immutable revisions', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'local-rag-governance-')); roots.push(dataRoot)
    const service = new LocalRagService(new Context(), { enabled: false, dataRoot }, { index: indexPort(), models: models() })
    const created = await service.importText({ id: 'knowledge-1', title: 'Guide', text: 'first body', scope: 'knowledge' }, new AbortController().signal)
    expect(created.documentId).toBe('knowledge-1')
    const v1 = await service.getDocument({ documentId: 'knowledge-1' }, new AbortController().signal)
    expect(v1).toMatchObject({ revision: 1, deleted: false, text: 'first body' })

    const v2 = await service.updateDocument({ documentId: 'knowledge-1', title: 'Guide 2', text: 'second body', expectedRevision: 1 }, new AbortController().signal)
    expect(v2).toMatchObject({ revision: 2, deleted: false, text: 'second body' })
    await expect(service.updateDocument({ documentId: 'knowledge-1', title: 'stale', text: 'stale', expectedRevision: 1 }, new AbortController().signal)).rejects.toThrow('revision conflict')

    await expect(service.deleteDocument({ documentId: 'knowledge-1', expectedRevision: 2 }, new AbortController().signal)).resolves.toEqual({ removed: true })
    const deleted = await service.getDocument({ documentId: 'knowledge-1' }, new AbortController().signal)
    expect(deleted).toMatchObject({ revision: 3, deleted: true, text: 'second body' })
    await expect(service.listDocuments({ scope: 'knowledge' }, new AbortController().signal)).resolves.toEqual([
      expect.objectContaining({ id: 'knowledge-1', deleted: true, revision: 3, revisionCount: 3 }),
    ])

    const restored = await service.restoreDocument({ documentId: 'knowledge-1', revision: 1, expectedRevision: 3 }, new AbortController().signal)
    expect(restored).toMatchObject({ revision: 4, deleted: false, title: 'Guide', text: 'first body' })
    expect(restored.versions.map(item => item.action)).toEqual(['created', 'edited', 'deleted', 'restored'])
  })

  it('never exposes a conversation summary through another session id', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'local-rag-session-')); roots.push(dataRoot)
    const service = new LocalRagService(new Context(), { enabled: false, dataRoot }, { index: indexPort(), models: models() })
    await service.importText({ id: 'summary-a', title: 'A', text: 'private summary', scope: 'conversation_summary', sessionId: 'session-a' }, new AbortController().signal)
    await expect(service.getDocument({ documentId: 'summary-a', sessionId: 'session-b' }, new AbortController().signal)).rejects.toThrow('isolated')
    await expect(service.getDocument({ documentId: 'summary-a', sessionId: 'session-a' }, new AbortController().signal)).resolves.toMatchObject({ text: 'private summary' })
    await expect(service.listDocuments({ scope: 'both', sessionId: 'session-b' }, new AbortController().signal)).resolves.toEqual([])
  })
})
