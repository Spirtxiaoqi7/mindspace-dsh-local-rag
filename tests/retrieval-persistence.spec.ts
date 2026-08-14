import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { EmbeddingProvider } from '../src/contracts.ts'
import { JsonAtomicRetrievalStore, LocalHybridRetriever } from '../src/retrieval/index.ts'

class Provider implements EmbeddingProvider {
  readonly modelId = 'persist-test-v1'
  get dimensions(): number { return 2 }
  async ready(): Promise<boolean> { return true }
  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((text) => (text.includes('鲸鱼') ? [1, 0] : [0, 1]))
  }
}

class ColdDimensionProvider extends Provider {
  readyCalls = 0
  private loaded = false
  override get dimensions(): number { return this.loaded ? 2 : 0 }
  override async ready(): Promise<boolean> {
    this.readyCalls += 1
    this.loaded = true
    return true
  }
}

class ReplacementProvider extends Provider {
  override readonly modelId = 'persist-test-v2'
}

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('JsonAtomicRetrievalStore', () => {
  it('stages source text durably before a local embedding model is available', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mindspace-rag-'))
    directories.push(directory)
    const provider = new Provider()
    const path = join(directory, 'index.json')
    const first = new LocalHybridRetriever(provider, new JsonAtomicRetrievalStore(path, provider.modelId))
    await first.stageDocuments([{
      id: 'staged', title: 'staged', text: '模型下载前也不能丢失的原文。', scope: 'knowledge', updatedAt: 1,
    }])

    const second = new LocalHybridRetriever(provider, new JsonAtomicRetrievalStore(path, provider.modelId))
    await second.hydrate()
    expect(await second.listDocuments()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'staged', text: '模型下载前也不能丢失的原文。' }),
    ]))
    expect(await second.status()).toMatchObject({ documents: 1, parents: 1, children: 1, requiresRebuild: true })
    const lexical = await second.search({ query: '模型下载前', scope: 'knowledge' })
    expect(lexical.hits[0]?.documentId).toBe('staged')
  })

  it('persists index records and reloads them with the same local model', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mindspace-rag-'))
    directories.push(directory)
    const provider = new Provider()
    const path = join(directory, 'index.json')
    const first = new LocalHybridRetriever(provider, new JsonAtomicRetrievalStore(path, provider.modelId))
    await first.index([{
      id: 'durable', title: 'durable', text: '鲸鱼的长期记忆。', scope: 'knowledge', updatedAt: Date.now(),
    }])

    const second = new LocalHybridRetriever(provider, new JsonAtomicRetrievalStore(path, provider.modelId))
    await second.hydrate()
    const result = await second.search({ query: '鲸鱼', scope: 'knowledge' })

    expect(result.hits.map((item) => item.documentId)).toEqual(['durable'])
    expect(result.modelId).toBe(provider.modelId)
  })

  it('persists opaque source provenance for a later source-filtered retrieval', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mindspace-rag-'))
    directories.push(directory)
    const provider = new Provider()
    const path = join(directory, 'index.json')
    const first = new LocalHybridRetriever(provider, new JsonAtomicRetrievalStore(path, provider.modelId))
    await first.index([{
      id: 'source-sha256-abc', title: 'durable source', text: '鲸鱼的原始资料。', scope: 'knowledge',
      sourceId: 'source-sha256-abc', sourceUri: 'local-rag://source/source-sha256-abc', updatedAt: 1,
    }])
    const second = new LocalHybridRetriever(provider, new JsonAtomicRetrievalStore(path, provider.modelId))
    await second.hydrate()
    const result = await second.search({ query: '鲸鱼', scope: 'knowledge', sourceId: 'source-sha256-abc' })
    expect(result.hits[0]).toMatchObject({ sourceId: 'source-sha256-abc', sourceUri: 'local-rag://source/source-sha256-abc' })
  })

  it('hydrates persisted lexical/vector records without starting a cold provider', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mindspace-rag-'))
    directories.push(directory)
    const firstProvider = new Provider()
    const path = join(directory, 'index.json')
    const first = new LocalHybridRetriever(firstProvider, new JsonAtomicRetrievalStore(path, firstProvider.modelId))
    await first.index([{ id: 'cold', title: 'cold', text: '鲸鱼', scope: 'knowledge', updatedAt: 1 }])

    const cold = new ColdDimensionProvider()
    const second = new LocalHybridRetriever(cold, new JsonAtomicRetrievalStore(path, cold.modelId))
    await second.hydrate()

    expect(cold.readyCalls).toBe(0)
  })

  it('rebuilds all retained source documents after an embedding-model change', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mindspace-rag-'))
    directories.push(directory)
    const path = join(directory, 'index.json')
    const firstProvider = new Provider()
    const first = new LocalHybridRetriever(firstProvider, new JsonAtomicRetrievalStore(path, firstProvider.modelId))
    await first.index([{ id: 'rebuild', title: 'rebuild', text: '鲸鱼的长期记忆。', scope: 'knowledge', updatedAt: 1 }])

    const replacement = new ReplacementProvider()
    const second = new LocalHybridRetriever(replacement, new JsonAtomicRetrievalStore(path, replacement.modelId))
    const before = await second.status()
    expect(before).toMatchObject({ requiresRebuild: true, documents: 1 })
    const degraded = await second.search({ query: '鲸鱼', scope: 'knowledge' })
    expect(degraded.hits[0]?.documentId).toBe('rebuild')
    expect(degraded).toMatchObject({ partial: true, laneStatus: { vector: { state: 'stale_model' } } })

    await second.rebuildAll()
    const after = await second.status()
    expect(after.requiresRebuild).toBe(false)
    expect((await second.search({ query: '鲸鱼', scope: 'knowledge' })).hits[0].documentId).toBe('rebuild')
  })
})
