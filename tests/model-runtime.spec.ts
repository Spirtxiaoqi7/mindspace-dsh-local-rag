import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { EmbeddingProvider } from '../src/contracts.ts'
import { createLocalRagRuntime, ProductionLifecycleEmbeddingAdapter, ProductionModelAdapter } from '../src/host/runtime.ts'
import { ModelCatalog } from '../src/model/catalog.ts'
import { ModelNotRunningError } from '../src/model/errors.ts'
import { LocalModelLifecycle } from '../src/model/lifecycle.ts'
import { LocalModelManager } from '../src/model/manager.ts'
import type { ModelManifest } from '../src/model/manifest.ts'

const roots: string[] = []
const artifact = Buffer.from('runtime ONNX fixture')
const digest = createHash('sha256').update(artifact).digest('hex')

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), 'mindspace-dsh-runtime-'))
  roots.push(value)
  return value
}

function manifest(): ModelManifest {
  return {
    id: 'runtime-fixture',
    modelId: 'fixture/runtime',
    targetDir: 'models/runtime-fixture',
    dimensions: 2,
    required: ['onnx/model.onnx'],
    sources: [{ kind: 'modelscope', repo: 'fixture/runtime' }],
  }
}

function manager(rootPath: string): LocalModelManager {
  return new LocalModelManager({
    root: rootPath,
    resolveFiles: async () => [{ path: 'onnx/model.onnx', size: artifact.length, sha256: digest, url: 'https://fixture.test/onnx/model.onnx' }],
    fetch: async () => new Response(artifact, { status: 200 }),
  })
}

describe('production model runtime', () => {
  it('keeps ONNX unloaded until lifecycle.start and returns to lexical-only after stop', async () => {
    const rootPath = await root()
    const selected = manifest()
    const localManager = manager(rootPath)
    let factoryCalls = 0
    const lifecycle = new LocalModelLifecycle({
      root: rootPath,
      catalog: new ModelCatalog([selected]),
      manager: localManager,
      providerFactory: (): EmbeddingProvider => {
        factoryCalls += 1
        return { modelId: selected.modelId, dimensions: 2, ready: async () => true, embed: async () => [[1, 0]] }
      },
    })
    const adapter = new ProductionLifecycleEmbeddingAdapter(lifecycle)

    expect(await adapter.ready()).toBe(false)
    expect(factoryCalls).toBe(0)
    await expect(adapter.embed(['before start'])).rejects.toBeInstanceOf(ModelNotRunningError)

    await lifecycle.downloadSelected()
    expect(factoryCalls).toBe(0)
    expect(await adapter.ready()).toBe(false)

    await lifecycle.start()
    expect(factoryCalls).toBe(1)
    expect(await adapter.ready()).toBe(true)
    await expect(adapter.embed(['after start'])).resolves.toEqual([[1, 0]])

    await lifecycle.stop()
    expect(await adapter.ready()).toBe(false)
    await expect(adapter.embed(['after stop'])).rejects.toBeInstanceOf(ModelNotRunningError)
  })

  it('hydrates a lexical index without downloading or loading a model', async () => {
    const dataRoot = await root()
    const runtime = createLocalRagRuntime({
      enabled: true,
      dataRoot,
      vectorCandidates: 5,
      lexicalCandidates: 5,
      resultLimit: 5,
      timeoutMs: 1_000,
      maxOutputChars: 1_000,
      autoStart: false,
      maxUploadBytes: 1024,
    })
    await runtime.index.initialize(dataRoot)
    const status = await runtime.models.status()
    expect(status.ready).toBe(false)
    expect(status.running).toBe(false)
    expect(status.state).toBe('missing')

    await runtime.index.importText({
      id: 'lexical-only', title: 'Local note', text: '鲸鱼可以在模型停止时被词法检索。', scope: 'knowledge', updatedAt: Date.now(),
    })
    const result = await runtime.index.search({ query: '鲸鱼', scope: 'knowledge' })
    expect(result.hits).toHaveLength(1)
    expect(result.laneStatus.vector.state).toBe('unavailable')
    expect(result.laneStatus.lexical.state).toBe('complete')
  })

  it('starts a model download in the host background so an aborted Web RPC cannot strand a valid partial', async () => {
    const rootPath = await root()
    const selected = manifest()
    let releaseListing!: (files: readonly { path: string, size: number, sha256: string, url: string }[]) => void
    const listing = new Promise<readonly { path: string, size: number, sha256: string, url: string }[]>(resolve => { releaseListing = resolve })
    const localManager = new LocalModelManager({
      root: rootPath,
      resolveFiles: async () => listing,
      fetch: async () => new Response(artifact, { status: 200 }),
    })
    const lifecycle = new LocalModelLifecycle({ root: rootPath, catalog: new ModelCatalog([selected]), manager: localManager })
    const adapter = new ProductionModelAdapter(localManager, new ModelCatalog([selected]), lifecycle)
    const rpc = new AbortController()

    const initial = await adapter.download(undefined, rpc.signal)
    expect(initial.state).toBe('downloading')
    expect(localManager.state(selected).status).toBe('resolving')
    rpc.abort()
    releaseListing([{ path: 'onnx/model.onnx', size: artifact.length, sha256: digest, url: 'https://fixture.test/onnx/model.onnx' }])

    await expect.poll(() => localManager.isReady(selected)).toBe(true)
    expect((await adapter.status()).running).toBe(false)
  })
})
