import { join, resolve } from 'node:path'

import type { EmbeddingProvider, SearchLocalMemoryRequest, SourceDocument } from '../contracts.ts'
import {
  DEFAULT_MODEL_MANIFESTS,
  LocalModelLifecycle,
  LocalModelManager,
  ModelCatalog,
} from '../model/index.ts'
import { JsonAtomicRetrievalStore, LocalHybridRetriever } from '../retrieval/index.ts'
import type {
  ListLocalRagDocumentsRequest,
  LocalModelManagerPort,
  LocalRagDocumentInfo,
  LocalRagHostDependencies,
  LocalRagIndexPort,
  LocalRagIndexStatus,
  LocalRagModelStatus,
  ResolvedLocalRagHostConfig,
} from './types.ts'

class ProductionIndexAdapter implements LocalRagIndexPort {
  constructor(
    private readonly dataRoot: string,
    private readonly retriever: LocalHybridRetriever,
    private readonly modelReady: () => Promise<boolean>,
    private readonly initializeModels: () => Promise<void>,
  ) {}

  async initialize(dataRoot: string, signal?: AbortSignal): Promise<void> {
    if (resolve(dataRoot) !== resolve(this.dataRoot)) throw new Error('local RAG data root changed after composition')
    // This restores selection and, only when explicitly configured, may start
    // an already-user-enabled model. hydrate itself is lexical-only.
    await this.initializeModels()
    await this.retriever.hydrate(signal)
  }

  async status(): Promise<LocalRagIndexStatus> {
    const status = await this.retriever.status(undefined, false)
    const documents = await this.retriever.listDocuments()
    return {
      documentCount: status.documents,
      parentCount: status.parents,
      childCount: status.children,
      dirty: status.requiresRebuild,
      updatedAt: documents.reduce<number | null>((latest, document) => latest === null || document.updatedAt > latest ? document.updatedAt : latest, null),
    }
  }

  async importText(document: SourceDocument, signal?: AbortSignal): Promise<SourceDocument> {
    if (await this.modelReady()) await this.retriever.index([document], signal)
    else await this.retriever.stageDocuments([document], signal)
    return { ...document }
  }

  getDocument(documentId: string, signal?: AbortSignal): Promise<SourceDocument | undefined> {
    return this.retriever.getDocument(documentId, signal)
  }

  removeDocument(documentId: string, signal?: AbortSignal): Promise<boolean> {
    return this.retriever.removeDocument(documentId, signal)
  }

  async listDocuments(request: ListLocalRagDocumentsRequest = {}, signal?: AbortSignal): Promise<readonly LocalRagDocumentInfo[]> {
    const documents = await this.retriever.listDocuments(signal)
    return documents
      .filter(document => request.scope === undefined || request.scope === 'both' || document.scope === request.scope)
      .filter(document => document.scope !== 'conversation_summary'
        || request.sessionId === undefined
        || document.sessionId === request.sessionId)
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
      .map(document => ({
        id: document.id,
        title: document.title,
        scope: document.scope,
        ...(document.sessionId === undefined ? {} : { sessionId: document.sessionId }),
        ...(document.sourceId === undefined ? {} : { sourceId: document.sourceId }),
        ...(document.sourceUri === undefined ? {} : { sourceUri: document.sourceUri }),
        ...(document.source === undefined ? {} : { source: document.source }),
        updatedAt: document.updatedAt,
        characters: [...document.text].length,
        revision: 1,
        revisionCount: 1,
      }))
  }

  async rebuild(signal?: AbortSignal): Promise<void> {
    if (await this.modelReady()) await this.retriever.rebuildAll(signal)
    else {
      const documents = await this.retriever.listDocuments(signal)
      if (documents.length > 0) await this.retriever.stageDocuments(documents, signal)
    }
  }

  search(request: SearchLocalMemoryRequest, signal?: AbortSignal) {
    return this.retriever.search(request, signal)
  }
}

/**
 * A stable retriever-facing facade. It dynamically delegates to the selected
 * lifecycle provider, and its ready() check is side-effect-free.
 */
export class ProductionLifecycleEmbeddingAdapter implements EmbeddingProvider {
  constructor(private readonly lifecycle: LocalModelLifecycle) {}

  get modelId(): string {
    return this.lifecycle.selectedManifest.modelId
  }

  get dimensions(): number {
    return this.lifecycle.selectedManifest.dimensions || 0
  }

  async ready(): Promise<boolean> {
    return (await this.lifecycle.snapshot()).runtimeStatus === 'running'
  }

  embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    return this.lifecycle.embed(texts, signal)
  }
}

export class ProductionModelAdapter implements LocalModelManagerPort {
  private downloadTask?: { readonly modelId: string, readonly completion: Promise<void> }

  constructor(
    private readonly manager: LocalModelManager,
    private readonly modelCatalog: ModelCatalog,
    private readonly lifecycle: LocalModelLifecycle,
  ) {}

  async initialize(): Promise<void> {
    await this.lifecycle.initialize()
  }

  async isReady(): Promise<boolean> {
    return (await this.lifecycle.snapshot()).runtimeStatus === 'running'
  }

  async status(_signal?: AbortSignal): Promise<LocalRagModelStatus> {
    const snapshot = await this.lifecycle.snapshot()
    const manifest = this.lifecycle.selectedManifest
    const operation = snapshot.download
    const running = snapshot.runtimeStatus === 'running'
    const state: LocalRagModelStatus['state'] = running
      ? 'ready'
      : operation.status === 'downloading' || operation.status === 'resolving' || operation.status === 'verifying'
        ? 'downloading'
        : operation.status === 'error' || snapshot.runtimeStatus === 'error'
          ? 'error'
          : 'missing'
    return {
      modelId: manifest.modelId,
      ready: running,
      dimensions: running ? manifest.dimensions || null : null,
      state,
      message: snapshot.error || operation.message,
      // These fields become visible as the host schema adopts lifecycle APIs.
      selectedModelId: snapshot.selectedModelId,
      autoStart: snapshot.autoStart,
      running,
      indexRebuildRequired: snapshot.indexRebuildRequired,
      catalog: this.modelCatalog.list().map(item => ({
        id: item.id,
        modelId: item.modelId,
        ...(item.name ? { name: item.name } : {}),
        ...(item.dimensions ? { dimensions: item.dimensions } : {}),
      })),
    }
  }

  async catalogModels(_signal?: AbortSignal) {
    return this.modelCatalog.list().map(item => ({
      id: item.id,
      modelId: item.modelId,
      ...(item.name ? { name: item.name } : {}),
      ...(item.dimensions ? { dimensions: item.dimensions } : {}),
    }))
  }

  async catalog(_signal?: AbortSignal) {
    return this.catalogModels()
  }

  async select(modelId: string, _signal?: AbortSignal): Promise<LocalRagModelStatus> {
    if (this.downloadTask) throw new Error('cannot select a model while a model download is active; cancel it first')
    const selected = this.modelCatalog.list().find(item => item.id === modelId || item.modelId === modelId)
    if (!selected) throw new Error(`unsupported embedding model: ${modelId}`)
    await this.lifecycle.select(selected.id)
    return this.status()
  }

  async setAutoStart(value: boolean, _signal?: AbortSignal): Promise<LocalRagModelStatus> {
    await this.lifecycle.setAutoStart(value)
    return this.status()
  }

  async start(_signal?: AbortSignal): Promise<LocalRagModelStatus> {
    if (this.downloadTask) throw new Error('model download is still in progress')
    await this.lifecycle.start()
    return this.status()
  }

  async stop(_signal?: AbortSignal): Promise<LocalRagModelStatus> {
    await this.lifecycle.stop()
    return this.status()
  }

  async acknowledgeIndexRebuilt(modelId?: string, _signal?: AbortSignal): Promise<LocalRagModelStatus> {
    await this.lifecycle.acknowledgeIndexRebuilt(modelId)
    return this.status()
  }

  async download(modelId: string | undefined, _signal?: AbortSignal): Promise<LocalRagModelStatus> {
    if (this.downloadTask) {
      if (modelId !== undefined) {
        const requested = this.modelCatalog.list().find(item => item.id === modelId || item.modelId === modelId)
        if (!requested) throw new Error(`unsupported embedding model: ${modelId}`)
        if (requested.id !== this.downloadTask.modelId) throw new Error('another model download is already active; cancel it first')
      }
      return this.status()
    }
    if (modelId !== undefined) await this.select(modelId)
    await this.lifecycle.initialize()
    const manifest = this.lifecycle.selectedManifest
    // A model is hundreds of megabytes. Do not bind that operation to the
    // browser RPC lifetime: proxies commonly abort a long request even though
    // the local download is healthy. The manager publishes state synchronously
    // before its first await, and the settings page polls that state. Only the
    // explicit cancel Remote interrupts the controller.
    const completion = this.manager.download(manifest)
      .then(() => undefined, () => undefined)
      .finally(() => {
        if (this.downloadTask?.completion === completion) this.downloadTask = undefined
      })
    this.downloadTask = { modelId: manifest.id, completion }
    return this.status()
  }

  async cancelDownload(_signal?: AbortSignal): Promise<LocalRagModelStatus> {
    this.manager.cancel()
    return this.status()
  }
}

/** Compose local storage, a non-eager model lifecycle, and the hybrid retriever. */
export function createLocalRagRuntime(config: ResolvedLocalRagHostConfig): LocalRagHostDependencies {
  const modelRoot = config.dataRoot
  const catalog = new ModelCatalog(DEFAULT_MODEL_MANIFESTS)
  const manager = new LocalModelManager({ root: modelRoot })
  const lifecycle = new LocalModelLifecycle({ root: modelRoot, catalog, manager })
  const embedding = new ProductionLifecycleEmbeddingAdapter(lifecycle)
  const retriever = new LocalHybridRetriever(
    embedding,
    new JsonAtomicRetrievalStore(join(config.dataRoot, 'index', 'snapshot.json'), embedding.modelId),
    {
      vectorCandidates: config.vectorCandidates,
      lexicalCandidates: config.lexicalCandidates,
      resultLimit: config.resultLimit,
      rrfK: 60,
      parentCharacters: 600,
      childCharacters: 200,
      childOverlap: 40,
    },
  )
  const models = new ProductionModelAdapter(manager, catalog, lifecycle)
  return {
    index: new ProductionIndexAdapter(config.dataRoot, retriever, () => models.isReady(), () => models.initialize()),
    models,
  }
}
