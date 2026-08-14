import { describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { SearchLocalMemoryResult, SourceDocument } from '../src/contracts.ts'
import { LocalRagService } from '../src/host/service.ts'
import type { LocalRagHostDependencies } from '../src/host/types.ts'

function dependencies(): LocalRagHostDependencies {
  const search: SearchLocalMemoryResult = {
    query: 'q', scope: 'knowledge', hits: [], vectorCandidates: 5, lexicalCandidates: 5, modelId: 'test-model',
    laneStatus: {
      vector: { lane: 'vector', state: 'empty', candidates: 0 },
      lexical: { lane: 'lexical', state: 'empty', candidates: 0 },
    },
    partial: false,
  }
  return {
    index: {
      initialize: vi.fn(),
      close: vi.fn(),
      status: vi.fn(async () => ({ documentCount: 0, parentCount: 0, childCount: 0, dirty: false, updatedAt: null })),
      importText: vi.fn(async (document: SourceDocument) => document),
      removeDocument: vi.fn(async () => true),
      listDocuments: vi.fn(async () => []),
      rebuild: vi.fn(),
      search: vi.fn(async () => search),
    },
    models: {
      status: vi.fn(async () => ({ modelId: 'test-model', ready: true, dimensions: 384, state: 'ready' as const })),
      catalog: vi.fn(async () => [{ id: 'test-model', modelId: 'test-model', dimensions: 384 }]),
      select: vi.fn(async () => ({ modelId: 'test-model', ready: true, dimensions: 384, state: 'ready' as const })),
      download: vi.fn(async () => ({ modelId: 'test-model', ready: true, dimensions: 384, state: 'ready' as const })),
      cancelDownload: vi.fn(async () => ({ modelId: 'test-model', ready: true, dimensions: 384, state: 'ready' as const })),
      start: vi.fn(async () => ({ modelId: 'test-model', ready: true, dimensions: 384, state: 'ready' as const })),
      stop: vi.fn(async () => ({ modelId: 'test-model', ready: false, dimensions: 384, state: 'missing' as const })),
      setAutoStart: vi.fn(async () => ({ modelId: 'test-model', ready: true, dimensions: 384, state: 'ready' as const })),
      acknowledgeIndexRebuilt: vi.fn(async () => ({ modelId: 'test-model', ready: true, dimensions: 384, state: 'ready' as const })),
    },
  }
}

describe('local RAG Host Remote source', () => {
  it('exposes a valid Cordis async lifecycle and closes the index through its disposer', async () => {
    const ports = dependencies()
    const context = new Context()
    const service = new LocalRagService(context, { enabled: false }, ports)
    const lifecycle = service[Service.init]()
    const first = await lifecycle.next()

    expect(first.done).toBe(false)
    expect(ports.index.initialize).toHaveBeenCalledWith(service.config.dataRoot)
    if (!first.done) await first.value()
    expect(ports.index.close).toHaveBeenCalledOnce()
    await lifecycle.return()
  })

  it('exposes the required Remote operations', () => {
    const methods = Object.getOwnPropertyNames(LocalRagService.prototype)
    expect(methods).toEqual(expect.arrayContaining([
      'status', 'importText', 'removeDocument', 'listDocuments', 'rebuild',
      'catalogModels', 'selectModel', 'downloadModel', 'cancelDownload', 'startModel', 'stopModel', 'setModelAutoStart',
      'beginUpload', 'appendUpload', 'completeUpload', 'cancelUpload', 'search', 'manual',
    ]))
  })

  it('rejects a session-scoped import without a session identity before the index mutates', async () => {
    const ports = dependencies()
    const context = new Context()
    const service = new LocalRagService(context, { enabled: false }, ports)
    await expect(service.importText({ title: 'note', text: 'body', scope: 'conversation_summary' }, new AbortController().signal))
      .rejects.toThrow('sessionId')
    expect(ports.index.importText).not.toHaveBeenCalled()
  })

  it('makes a normalized manual query run through the bounded local index path', async () => {
    const ports = dependencies()
    const context = new Context()
    const service = new LocalRagService(context, { enabled: false }, ports)
    await service.manual('  project memory  ', 'knowledge', new AbortController().signal)
    expect(ports.index.search).toHaveBeenCalledWith(
      { query: 'project memory', scope: 'knowledge' },
      expect.any(AbortSignal),
    )
  })

  it('forwards document management and local-model download controls through narrow ports', async () => {
    const ports = dependencies()
    const context = new Context()
    const service = new LocalRagService(context, { enabled: false }, ports)
    const signal = new AbortController().signal
    await service.listDocuments({ scope: 'knowledge' }, signal)
    await service.downloadModel('nomic-embed-text', signal)
    await service.cancelDownload(signal)
    expect(ports.index.listDocuments).toHaveBeenCalledWith({ scope: 'knowledge' }, signal)
    expect(ports.models.download).toHaveBeenCalledWith('nomic-embed-text', signal)
    expect(ports.models.cancelDownload).toHaveBeenCalledWith(signal)
  })
})
