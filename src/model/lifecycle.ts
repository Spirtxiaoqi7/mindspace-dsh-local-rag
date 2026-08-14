import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { EmbeddingProvider } from '../contracts.ts'
import { TransformersJsLocalEmbeddingProvider } from './embedding-provider.ts'
import { ModelCatalog } from './catalog.ts'
import { ModelNotReadyError, ModelNotRunningError } from './errors.ts'
import { type LocalModelManager, type ModelInstallState } from './manager.ts'
import type { ModelManifest } from './manifest.ts'

export type ModelRuntimeStatus = 'stopped' | 'starting' | 'running' | 'error'

export interface PersistedModelSelection {
  schemaVersion: 1
  selectedModelId: string
  autoStart: boolean
  /** Kept across restarts so a model swap cannot silently reuse an old index. */
  indexRebuildRequired?: boolean
}

export interface ModelLifecycleSnapshot {
  selectedModelId: string
  autoStart: boolean
  runtimeStatus: ModelRuntimeStatus
  /** True whenever a selected-model change invalidates the existing vector index. */
  indexRebuildRequired: boolean
  ready: boolean
  download: Readonly<ModelInstallState>
  error?: string
}

export type EmbeddingProviderFactory = (manifest: ModelManifest, modelDirectory: string) => EmbeddingProvider

export interface ModelLifecycleOptions {
  root: string
  catalog: ModelCatalog
  manager: LocalModelManager
  providerFactory?: EmbeddingProviderFactory
  selectionFile?: string
}

function defaultProviderFactory(manifest: ModelManifest, modelDirectory: string): EmbeddingProvider {
  return new TransformersJsLocalEmbeddingProvider({
    modelId: manifest.modelId,
    modelDirectory,
    dimensions: manifest.dimensions,
  })
}

/**
 * Owns model selection and ONNX lifetime. Constructing or initializing this
 * class never imports Transformers.js or initializes ONNX; only start() does.
 */
export class LocalModelLifecycle {
  private readonly providerFactory: EmbeddingProviderFactory
  private initialized = false
  private selectedModelId = ''
  private autoStart = false
  private runtimeStatus: ModelRuntimeStatus = 'stopped'
  private indexRebuildRequired = false
  private runtimeError = ''
  private provider?: EmbeddingProvider

  constructor(private readonly options: ModelLifecycleOptions) {
    const fallback = options.catalog.list()[0]
    if (!fallback) throw new Error('Local model catalog has no registered manifests')
    // Retrievers read modelId synchronously during composition. Persistence is
    // restored later by initialize(), without creating an ONNX provider.
    this.selectedModelId = fallback.id
    this.providerFactory = options.providerFactory || defaultProviderFactory
  }

  get selectedManifest(): ModelManifest {
    return this.options.catalog.require(this.selectedModelId)
  }

  get selectionPath(): string {
    return this.options.selectionFile || path.join(this.options.root, 'model-selection.json')
  }

  async initialize(): Promise<ModelLifecycleSnapshot> {
    if (this.initialized) return this.snapshot()
    const persisted = await this.readSelection()
    this.selectedModelId = persisted && this.options.catalog.get(persisted.selectedModelId)
      ? persisted.selectedModelId
      : this.selectedModelId
    this.autoStart = persisted?.autoStart === true
    this.indexRebuildRequired = persisted?.indexRebuildRequired === true
    this.initialized = true
    // Initialization intentionally does not call start(), even if autoStart is enabled.
    return this.snapshot()
  }

  async snapshot(): Promise<ModelLifecycleSnapshot> {
    await this.ensureInitialized()
    const manifest = this.selectedManifest
    return {
      selectedModelId: manifest.id,
      autoStart: this.autoStart,
      runtimeStatus: this.runtimeStatus,
      indexRebuildRequired: this.indexRebuildRequired,
      ready: await this.options.manager.isReady(manifest),
      download: this.options.manager.state(manifest),
      ...(this.runtimeError ? { error: this.runtimeError } : {}),
    }
  }

  async select(modelId: string): Promise<ModelLifecycleSnapshot> {
    await this.ensureInitialized()
    const next = this.options.catalog.require(modelId)
    if (next.id === this.selectedModelId) return this.snapshot()
    await this.stop()
    this.selectedModelId = next.id
    this.indexRebuildRequired = true
    this.runtimeError = ''
    await this.persistSelection()
    return this.snapshot()
  }

  async setAutoStart(value: boolean): Promise<ModelLifecycleSnapshot> {
    await this.ensureInitialized()
    this.autoStart = value
    await this.persistSelection()
    return this.snapshot()
  }

  /** A host may call this after boot; it remains an explicit, opt-in operation. */
  async startIfAutoStart(): Promise<ModelLifecycleSnapshot> {
    await this.ensureInitialized()
    return this.autoStart ? this.start() : this.snapshot()
  }

  async start(): Promise<ModelLifecycleSnapshot> {
    await this.ensureInitialized()
    if (this.runtimeStatus === 'running') return this.snapshot()
    const manifest = this.selectedManifest
    this.runtimeStatus = 'starting'
    this.runtimeError = ''
    try {
      const directory = await this.options.manager.assertReady(manifest)
      const provider = this.providerFactory(manifest, directory)
      if (!await provider.ready()) throw new ModelNotReadyError(manifest.modelId, 'local ONNX health probe failed')
      const [probe] = await provider.embed(['Mindspace local embedding health check'])
      if (!probe || (manifest.dimensions !== undefined && probe.length !== manifest.dimensions)) {
        throw new ModelNotReadyError(manifest.modelId, 'local ONNX health probe returned an unexpected vector')
      }
      this.provider = provider
      this.runtimeStatus = 'running'
      return this.snapshot()
    } catch (error) {
      this.provider = undefined
      this.runtimeStatus = 'error'
      this.runtimeError = error instanceof Error ? error.message : String(error)
      return this.snapshot()
    }
  }

  async stop(): Promise<ModelLifecycleSnapshot> {
    await this.ensureInitialized()
    // Transformers.js does not expose a portable process-wide unload hook. Dropping
    // the provider reference guarantees no further ONNX invocation from this plugin.
    this.provider = undefined
    this.runtimeStatus = 'stopped'
    this.runtimeError = ''
    return this.snapshot()
  }

  async downloadSelected(signal?: AbortSignal): Promise<ModelLifecycleSnapshot> {
    await this.ensureInitialized()
    await this.options.manager.download(this.selectedManifest, signal)
    // Downloading verifies files/marker only. It deliberately does not start ONNX.
    return this.snapshot()
  }

  async embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    await this.ensureInitialized()
    if (!this.provider || this.runtimeStatus !== 'running') throw new ModelNotRunningError(this.selectedManifest.modelId)
    return this.provider.embed(texts, signal)
  }

  async acknowledgeIndexRebuilt(modelId = this.selectedModelId): Promise<ModelLifecycleSnapshot> {
    await this.ensureInitialized()
    if (modelId !== this.selectedModelId) throw new Error(`Cannot acknowledge an index for unselected model: ${modelId}`)
    this.indexRebuildRequired = false
    await this.persistSelection()
    return this.snapshot()
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) await this.initialize()
  }

  private async readSelection(): Promise<PersistedModelSelection | undefined> {
    try {
      const selection = JSON.parse(await readFile(this.selectionPath, 'utf8')) as PersistedModelSelection
      return selection?.schemaVersion === 1 && typeof selection.selectedModelId === 'string' && typeof selection.autoStart === 'boolean'
        ? selection
        : undefined
    } catch {
      return undefined
    }
  }

  private async persistSelection(): Promise<void> {
    const target = this.selectionPath
    await mkdir(path.dirname(target), { recursive: true })
    const temporary = `${target}.${randomUUID()}.partial`
    const selection: PersistedModelSelection = {
      schemaVersion: 1,
      selectedModelId: this.selectedModelId,
      autoStart: this.autoStart,
      indexRebuildRequired: this.indexRebuildRequired,
    }
    await writeFile(temporary, `${JSON.stringify(selection, null, 2)}\n`, 'utf8')
    await rename(temporary, target)
  }
}
