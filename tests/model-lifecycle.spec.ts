import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { EmbeddingProvider } from '../src/contracts.ts'
import { ModelCatalog } from '../src/model/catalog.ts'
import { ModelNotRunningError } from '../src/model/errors.ts'
import { LocalModelLifecycle } from '../src/model/lifecycle.ts'
import { LocalModelManager } from '../src/model/manager.ts'
import type { ModelManifest } from '../src/model/manifest.ts'

const roots: string[] = []
const artifact = Buffer.from('locally verified ONNX fixture')
const digest = createHash('sha256').update(artifact).digest('hex')

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function fixtureManifest(id: string): ModelManifest {
  return {
    id,
    name: id,
    modelId: `fixture/${id}`,
    targetDir: `models/${id}`,
    dimensions: 2,
    required: ['onnx/model.onnx'],
    sources: [{ kind: 'modelscope', repo: `fixture/${id}` }],
  }
}

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mindspace-dsh-local-rag-lifecycle-'))
  roots.push(root)
  return root
}

function fixtureManager(root: string): LocalModelManager {
  return new LocalModelManager({
    root,
    resolveFiles: async () => [{
      path: 'onnx/model.onnx', size: artifact.length, sha256: digest, url: 'https://fixture.test/onnx/model.onnx',
    }],
    fetch: async () => new Response(artifact, { status: 200 }),
  })
}

describe('ModelCatalog and LocalModelLifecycle', () => {
  it('registers extensible manifests and rejects duplicate identifiers', () => {
    const first = fixtureManifest('first')
    const catalog = new ModelCatalog([first])
    catalog.register(fixtureManifest('second'))
    expect(catalog.list().map(manifest => manifest.id)).toEqual(['first', 'second'])
    expect(() => catalog.register(first)).toThrow('already registered')
  })

  it('keeps verified download separate from ONNX start, persists selection, and signals reindexing', async () => {
    const root = await fixtureRoot()
    const first = fixtureManifest('first')
    const second = fixtureManifest('second')
    const catalog = new ModelCatalog([first, second])
    const manager = fixtureManager(root)
    await manager.download(first)

    let factoryCalls = 0
    let readyCalls = 0
    const providerFactory = (): EmbeddingProvider => ({
      modelId: 'fixture/provider',
      dimensions: 2,
      ready: async () => { readyCalls += 1; return true },
      embed: async () => [[1, 0]],
    })
    const lifecycle = new LocalModelLifecycle({ root, catalog, manager, providerFactory: () => {
      factoryCalls += 1
      return providerFactory()
    } })

    const initial = await lifecycle.initialize()
    expect(initial.selectedModelId).toBe('first')
    expect(initial.ready).toBe(true)
    expect(initial.runtimeStatus).toBe('stopped')
    expect(factoryCalls).toBe(0)
    expect(readyCalls).toBe(0)
    await expect(lifecycle.embed(['must not initialize ONNX'])).rejects.toBeInstanceOf(ModelNotRunningError)

    await lifecycle.setAutoStart(true)
    const started = await lifecycle.start()
    expect(started.runtimeStatus).toBe('running')
    expect(factoryCalls).toBe(1)
    expect(readyCalls).toBe(1)

    const selected = await lifecycle.select('second')
    expect(selected.runtimeStatus).toBe('stopped')
    expect(selected.ready).toBe(false)
    expect(selected.indexRebuildRequired).toBe(true)
    await expect(readFile(path.join(root, 'model-selection.json'), 'utf8')).resolves.toContain('"indexRebuildRequired": true')

    await lifecycle.downloadSelected()
    expect(factoryCalls).toBe(1)
    const autoStarted = await lifecycle.startIfAutoStart()
    expect(autoStarted.runtimeStatus).toBe('running')
    expect(factoryCalls).toBe(2)
    expect((await lifecycle.acknowledgeIndexRebuilt()).indexRebuildRequired).toBe(false)
    await expect(readFile(path.join(root, 'model-selection.json'), 'utf8')).resolves.toContain('"indexRebuildRequired": false')

    let restoredFactoryCalls = 0
    const restored = new LocalModelLifecycle({
      root, catalog, manager,
      providerFactory: () => {
        restoredFactoryCalls += 1
        return providerFactory()
      },
    })
    const restoredState = await restored.initialize()
    expect(restoredState.selectedModelId).toBe('second')
    expect(restoredState.autoStart).toBe(true)
    expect(restoredState.runtimeStatus).toBe('stopped')
    expect(restoredFactoryCalls).toBe(0)
  })

  it('keeps failed ONNX health probes distinct from file readiness', async () => {
    const root = await fixtureRoot()
    const manifest = fixtureManifest('health')
    const manager = fixtureManager(root)
    await manager.download(manifest)
    const lifecycle = new LocalModelLifecycle({
      root,
      catalog: new ModelCatalog([manifest]),
      manager,
      providerFactory: () => ({ modelId: manifest.modelId, dimensions: 2, ready: async () => false, embed: async () => [[1, 0]] }),
    })
    await lifecycle.initialize()
    const state = await lifecycle.start()
    expect(state.ready).toBe(true)
    expect(state.runtimeStatus).toBe('error')
    expect(state.error).toContain('health probe failed')
  })
})
