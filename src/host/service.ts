/** Host Service, Remote methods, and lifecycle ownership for local RAG. */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { SearchLocalMemoryRequest, SourceAuthority, SourceDocument } from '../contracts.ts'
import { createLocalRagRuntime } from './runtime.ts'
import { CompactionSummaryIndexer } from './summary-indexing.ts'
import { limitModelSearchResult } from './tool.ts'
import { registerLocalRagTool } from './tool.ts'
import { LocalRagSourceArchive } from './sources.ts'
import { LocalRagDocumentHistory, type DocumentHistoryView } from './document-history.ts'
import { DEFAULT_MAX_UPLOAD_BYTES, LocalRagUploadManager } from './upload.ts'
import type {
  AppendUploadRequest,
  AppendUploadResult,
  BeginUploadRequest,
  BeginUploadResult,
  CompleteUploadResult,
  DeleteLocalRagDocumentRequest,
  GetSourcePreviewRequest,
  GetSourcePreviewResult,
  GetLocalRagDocumentRequest,
  ImportTextRequest,
  ListLocalRagDocumentsRequest,
  LocalRagHostConfig,
  LocalRagHostDependencies,
  LocalRagStatusView,
  LocalRagDocumentContent,
  RestoreLocalRagDocumentRequest,
  UpdateLocalRagDocumentRequest,
  ModelSearchResult,
  ResolvedLocalRagHostConfig,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    localRag: LocalRagService
  }
}

const DEFAULT_DATA_DIRECTORY = 'mindspace-local-rag'

/** Validate a deployment-controlled positive integer. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`mindspace-local-rag: ${name} must be a positive integer`)
}

/** Resolve all configuration in one place before any tool or lifecycle effect is installed. */
export function resolveLocalRagHostConfig(config: LocalRagHostConfig = {}): ResolvedLocalRagHostConfig {
  const resolved: ResolvedLocalRagHostConfig = {
    enabled: config.enabled ?? true,
    dataRoot: config.dataRoot === undefined || config.dataRoot.trim().length === 0
      ? join(resolveDshHome(), DEFAULT_DATA_DIRECTORY)
      : config.dataRoot,
    vectorCandidates: config.vectorCandidates ?? 5,
    lexicalCandidates: config.lexicalCandidates ?? 5,
    resultLimit: config.resultLimit ?? 5,
    timeoutMs: config.timeoutMs ?? 15_000,
    maxOutputChars: config.maxOutputChars ?? 12_000,
    autoStart: config.autoStart ?? false,
    maxUploadBytes: config.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES,
  }
  for (const [name, value] of Object.entries({
    vectorCandidates: resolved.vectorCandidates,
    lexicalCandidates: resolved.lexicalCandidates,
    resultLimit: resolved.resultLimit,
    timeoutMs: resolved.timeoutMs,
    maxOutputChars: resolved.maxOutputChars,
    maxUploadBytes: resolved.maxUploadBytes,
  })) assertPositiveInteger(name, value)
  return resolved
}

/** Resolve runtime ports from explicit tests first, then from the composed Host tree. */
/** Global local-RAG service and generated-Remote source of truth. */
export class LocalRagService extends TypertRemoteService {
  // The composition adapter mounts both ports before this service. Declaring
  // them keeps Cordis startup ordering explicit instead of relying on a race
  // in ctx.get() during construction.
  static inject = ['sessions', 'tools', 'systemPrompt']
  static Config: z<LocalRagHostConfig> = z.object({
    enabled: z.boolean().default(true),
    // No caller-supplied directory is needed: resolveLocalRagHostConfig()
    // anchors the default beneath the active DSH home at runtime.
    dataRoot: z.string().default(''),
    vectorCandidates: z.number().step(1).min(1).default(5),
    lexicalCandidates: z.number().step(1).min(1).default(5),
    resultLimit: z.number().step(1).min(1).default(5),
    timeoutMs: z.number().step(1).min(1).default(15_000),
    maxOutputChars: z.number().step(1).min(1).default(12_000),
    autoStart: z.boolean().default(false),
    maxUploadBytes: z.number().step(1).min(1).default(DEFAULT_MAX_UPLOAD_BYTES),
  })

  readonly config: ResolvedLocalRagHostConfig
  private readonly dependencies: LocalRagHostDependencies
  private readonly summaries: CompactionSummaryIndexer
  private readonly sources: LocalRagSourceArchive
  private readonly uploads: LocalRagUploadManager
  private readonly history: LocalRagDocumentHistory

  /**
   * @param ctx - Host Context that owns the service and all registration effects.
   * @param config - Deployment-local tool and storage limits.
   * @param dependencies - Explicit ports for tests; production resolves composed services.
   */
  constructor(ctx: Context, config: LocalRagHostConfig = {}, dependencies?: LocalRagHostDependencies) {
    super(ctx, 'localRag')
    this.config = resolveLocalRagHostConfig(config)
    this.dependencies = dependencies ?? createLocalRagRuntime(this.config)
    this.summaries = new CompactionSummaryIndexer(this.dependencies.index, this.config.dataRoot)
    this.sources = new LocalRagSourceArchive(this.config.dataRoot)
    this.history = new LocalRagDocumentHistory(this.config.dataRoot)
    this.uploads = new LocalRagUploadManager(this.config.dataRoot, this.dependencies.index, this.config.maxUploadBytes, this.sources)
    if (this.config.enabled) {
      ctx.effect(
        () => registerLocalRagTool(ctx, this.dependencies.index, this.config, this.sources),
        'mindspace-local-rag: search_local_memory',
      )
      ctx.on('session/event', (session, event) => {
        this.summaries.observe(session, event)
      })
    }
  }

  /** Initialize the local index before exposing the service, then close it after all effects unwind. */
  async *[Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
    await this.dependencies.index.initialize(this.config.dataRoot)
    await this.summaries.initialize(this.ctx.get('sessions')?.list() ?? [])
    if (this.config.autoStart) {
      const model = await this.dependencies.models.status()
      if (model.autoStart) await this.dependencies.models.start()
    }
    yield async () => { await this.dependencies.index.close?.() }
  }

  /** Return local index and model availability for the settings page. */
  @Remote
  async status(signal: AbortSignal): Promise<LocalRagStatusView> {
    const [index, model] = await Promise.all([
      this.dependencies.index.status(),
      this.dependencies.models.status(signal),
    ])
    return { enabled: this.config.enabled, index, model, backgroundIndexing: this.summaries.view() }
  }

  /** Import one user-supplied text document into the local index. */
  @Remote
  async importText(request: ImportTextRequest, signal: AbortSignal): Promise<{ readonly documentId: string }> {
    const title = request.title.trim()
    const text = request.text.trim()
    if (title.length === 0) throw new Error('title must not be blank')
    if (text.length === 0) throw new Error('text must not be blank')
    if (request.scope === 'conversation_summary' && (request.sessionId === undefined || request.sessionId.length === 0)) {
      throw new Error('sessionId is required for conversation_summary imports')
    }
    const document = await this.dependencies.index.importText({
      id: request.id ?? randomUUID(), title, text, scope: request.scope,
      ...request.sessionId === undefined ? {} : { sessionId: request.sessionId },
      ...request.source === undefined ? {} : { source: request.source },
      updatedAt: Date.now(),
    }, signal)
    await this.history.ensure(document)
    return { documentId: document.id }
  }

  /** Delete one indexed document and report whether it existed. */
  @Remote
  async removeDocument(documentId: string, signal: AbortSignal): Promise<{ readonly removed: boolean }> {
    if (documentId.trim().length === 0) throw new Error('documentId must not be blank')
    const current = await this.getIndexedDocument(documentId, signal)
    if (current === undefined && this.dependencies.index.getDocument === undefined) {
      const removed = await this.dependencies.index.removeDocument(documentId, signal)
      if (removed) await this.sources.removeForDocument(documentId)
      return { removed }
    }
    if (current === undefined) return { removed: false }
    const state = await this.history.ensure(current)
    const removed = await this.dependencies.index.removeDocument(documentId, signal)
    if (removed) await this.history.append(documentId, 'deleted', null, `Deleted revision ${String(state.revision)}`)
    return { removed }
  }

  /** Session-aware, revision-checked logical deletion used by the governance UI. */
  @Remote
  async deleteDocument(request: DeleteLocalRagDocumentRequest, signal: AbortSignal): Promise<{ readonly removed: boolean }> {
    const documentId = requireDocumentId(request.documentId)
    const current = await this.getIndexedDocument(documentId, signal)
    if (current === undefined) return { removed: false }
    assertSessionBoundary(current, request.sessionId)
    await this.history.ensure(current)
    await this.history.assertRevision(documentId, request.expectedRevision)
    const removed = await this.dependencies.index.removeDocument(documentId, signal)
    if (removed) await this.history.append(documentId, 'deleted', null, request.reason ?? `Deleted revision ${String(request.expectedRevision)}`)
    return { removed }
  }

  /** List document metadata for settings without exposing every document body. */
  @Remote
  async listDocuments(request: ListLocalRagDocumentsRequest, signal: AbortSignal) {
    const current = await this.dependencies.index.listDocuments(request, signal)
    const currentIds = new Set(current.map(document => document.id))
    const active = await Promise.all(current.map(async document => {
      const body = await this.getIndexedDocument(document.id, signal)
      const history = body === undefined ? undefined : await this.history.ensure(body)
      return {
        ...document,
        revision: history?.revision ?? document.revision,
        revisionCount: history?.versions.length ?? document.revisionCount,
        deleted: false,
      }
    }))
    const deleted = (await this.history.list())
      .filter(item => item.deleted && !currentIds.has(item.documentId) && item.lastDocument !== undefined)
      .filter(item => visibleDocument(item.lastDocument!, request))
      .map(item => historyInfo(item))
    return [...active, ...deleted].sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
  }

  /** Return the editable source document and its complete local revision trail. */
  @Remote
  async getDocument(request: GetLocalRagDocumentRequest, signal: AbortSignal): Promise<LocalRagDocumentContent> {
    const documentId = requireDocumentId(request.documentId)
    const indexed = await this.getIndexedDocument(documentId, signal)
    const state = indexed === undefined ? await this.history.current(documentId) : await this.history.ensure(indexed)
    if (state === undefined || state.lastDocument === undefined) throw new Error('document not found')
    assertSessionBoundary(state.lastDocument, request.sessionId)
    return historyContent(state)
  }

  /** Edit the canonical document, then atomically replace its derived chunks. */
  @Remote
  async updateDocument(request: UpdateLocalRagDocumentRequest, signal: AbortSignal): Promise<LocalRagDocumentContent> {
    const documentId = requireDocumentId(request.documentId)
    const current = await this.getIndexedDocument(documentId, signal)
    if (current === undefined) throw new Error('deleted documents must be restored before editing')
    assertSessionBoundary(current, request.sessionId)
    await this.history.ensure(current)
    await this.history.assertRevision(documentId, request.expectedRevision)
    const title = request.title.trim()
    const text = request.text.trim()
    if (!title) throw new Error('title must not be blank')
    if (!text) throw new Error('text must not be blank')
    const updatedAt = Date.now()
    const authority: SourceAuthority = current.authority === undefined
      ? { kind: current.scope === 'conversation_summary' ? 'conversation_summary' : 'text', documentTitle: title }
      : { ...current.authority, documentTitle: title }
    const document: SourceDocument = {
      ...current,
      title,
      text,
      authority,
      units: current.scope === 'conversation_summary'
        ? [{ id: `${current.id}:summary`, order: 0, text, authority, locator: { ...current.locator } }]
        : undefined,
      updatedAt,
    }
    await this.dependencies.index.importText(document, signal)
    await this.sources.replacePreview(documentId, text)
    const state = await this.history.append(documentId, 'edited', document, request.reason)
    return historyContent(state)
  }

  /** Restore an immutable prior version as a new head revision. */
  @Remote
  async restoreDocument(request: RestoreLocalRagDocumentRequest, signal: AbortSignal): Promise<LocalRagDocumentContent> {
    const documentId = requireDocumentId(request.documentId)
    const state = await this.history.assertRevision(documentId, request.expectedRevision)
    if (state.lastDocument === undefined) throw new Error('document not found')
    assertSessionBoundary(state.lastDocument, request.sessionId)
    const previous = await this.history.revision(documentId, request.revision)
    const restored = { ...previous, updatedAt: Date.now() }
    await this.dependencies.index.importText(restored, signal)
    await this.sources.replacePreview(documentId, restored.text)
    const next = await this.history.append(documentId, 'restored', restored, request.reason ?? `Restored revision ${String(request.revision)}`)
    return historyContent(next)
  }

  /** Rebuild local index artifacts after a user-approved model or chunking change. */
  @Remote
  async rebuild(signal: AbortSignal): Promise<LocalRagStatusView> {
    await this.dependencies.index.rebuild(signal)
    const index = await this.dependencies.index.status()
    if (!index.dirty) await this.dependencies.models.acknowledgeIndexRebuilt(undefined, signal)
    return this.status(signal)
  }

  /** List installable local embedding models without exposing download origins. */
  @Remote
  catalogModels(signal: AbortSignal) {
    return this.dependencies.models.catalog(signal)
  }

  /** Select the model used on the next explicit start; no background download occurs. */
  @Remote
  async selectModel(modelId: string, signal: AbortSignal): Promise<LocalRagStatusView> {
    if (!modelId.trim()) throw new Error('modelId must not be blank')
    await this.dependencies.models.select(modelId.trim(), signal)
    return this.status(signal)
  }

  /** Start the selected local embedding-model download through the model adapter. */
  @Remote
  async downloadModel(modelId: string | undefined, signal: AbortSignal): Promise<LocalRagStatusView> {
    if (modelId !== undefined && modelId.trim().length === 0) throw new Error('modelId must not be blank')
    await this.dependencies.models.download(modelId?.trim(), signal)
    return this.status(signal)
  }

  /** Cooperatively cancel the active local embedding-model download. */
  @Remote
  async cancelDownload(signal: AbortSignal): Promise<LocalRagStatusView> {
    await this.dependencies.models.cancelDownload(signal)
    return this.status(signal)
  }

  /** Start the selected verified embedding runtime. Index rebuild remains an explicit operation. */
  @Remote
  async startModel(signal: AbortSignal): Promise<LocalRagStatusView> {
    await this.dependencies.models.start(signal)
    return this.status(signal)
  }

  /** Stop the local embedding runtime without deleting its verified model files. */
  @Remote
  async stopModel(signal: AbortSignal): Promise<LocalRagStatusView> {
    await this.dependencies.models.stop(signal)
    return this.status(signal)
  }

  /** Persist whether a verified, selected model may start on future Host boot. */
  @Remote
  async setModelAutoStart(enabled: boolean, signal: AbortSignal): Promise<LocalRagStatusView> {
    await this.dependencies.models.setAutoStart(enabled, signal)
    return this.status(signal)
  }

  /** Create a bounded, ordered upload staging record. */
  @Remote
  async beginUpload(request: BeginUploadRequest, signal: AbortSignal): Promise<BeginUploadResult> {
    throwIfAborted(signal)
    return this.uploads.begin(request)
  }

  /** Append one canonical base64 chunk at the exact next byte offset. */
  @Remote
  async appendUpload(request: AppendUploadRequest, signal: AbortSignal): Promise<AppendUploadResult> {
    throwIfAborted(signal)
    return this.uploads.append(request)
  }

  /** Parse a complete staged file with default local parsers and index it as knowledge. */
  @Remote
  completeUpload(uploadId: string, signal: AbortSignal): Promise<CompleteUploadResult> {
    return this.completeUploadAndTrack(uploadId, signal)
  }

  private async completeUploadAndTrack(uploadId: string, signal: AbortSignal): Promise<CompleteUploadResult> {
    const result = await this.uploads.complete(uploadId, signal)
    const document = await this.getIndexedDocument(result.documentId, signal)
    if (document !== undefined) await this.history.ensure(document)
    return result
  }

  /** Delete staged bytes and invalidate the upload id. */
  @Remote
  cancelUpload(uploadId: string, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    return this.uploads.cancel(uploadId)
  }

  /** Return a bounded extracted-text page from an archived local source, never a filesystem path. */
  @Remote
  getSourcePreview(request: GetSourcePreviewRequest, signal: AbortSignal): Promise<GetSourcePreviewResult> {
    return this.sources.getPreview(request, signal)
  }

  /** Search through the Remote for UI previews without making it a prompt injection. */
  @Remote
  async search(request: SearchLocalMemoryRequest, signal: AbortSignal): Promise<ModelSearchResult> {
    return this.searchBounded(request, signal)
  }

  /** Manually run the same bounded search path as the model-visible tool. */
  @Remote
  async manual(query: string, scope: SearchLocalMemoryRequest['scope'], signal: AbortSignal): Promise<ModelSearchResult> {
    return this.searchBounded({ query: query.trim(), ...scope === undefined ? {} : { scope } }, signal)
  }

  private async searchBounded(request: SearchLocalMemoryRequest, signal: AbortSignal): Promise<ModelSearchResult> {
    if (request.query.trim().length === 0) throw new Error('query must not be blank')
    const result = await this.dependencies.index.search({
      ...request,
      query: request.query.trim(),
    }, signal)
    return limitModelSearchResult(result, this.config.maxOutputChars)
  }

  private async getIndexedDocument(documentId: string, signal?: AbortSignal) {
    if (this.dependencies.index.getDocument !== undefined) return this.dependencies.index.getDocument(documentId, signal)
    return undefined
  }

}

function requireDocumentId(value: string): string {
  const documentId = value.trim()
  if (!documentId) throw new Error('documentId must not be blank')
  return documentId
}

function assertSessionBoundary(document: { readonly scope: string; readonly sessionId?: string }, sessionId?: string): void {
  if (document.scope !== 'conversation_summary') return
  if (!sessionId || document.sessionId !== sessionId) throw new Error('conversation summary is isolated to its session')
}

function visibleDocument(document: { readonly scope: string; readonly sessionId?: string }, request: ListLocalRagDocumentsRequest): boolean {
  if (request.scope !== undefined && request.scope !== 'both' && document.scope !== request.scope) return false
  return document.scope !== 'conversation_summary' || request.sessionId === undefined || document.sessionId === request.sessionId
}

function historyInfo(state: DocumentHistoryView) {
  const document = state.lastDocument!
  return {
    id: document.id,
    title: document.title,
    scope: document.scope,
    ...(document.sessionId === undefined ? {} : { sessionId: document.sessionId }),
    ...(document.sourceId === undefined ? {} : { sourceId: document.sourceId }),
    ...(document.sourceUri === undefined ? {} : { sourceUri: document.sourceUri }),
    ...(document.source === undefined ? {} : { source: document.source }),
    updatedAt: state.versions.at(-1)?.at ?? document.updatedAt,
    characters: [...document.text].length,
    deleted: true,
    revision: state.revision,
    revisionCount: state.versions.length,
  }
}

function historyContent(state: DocumentHistoryView): LocalRagDocumentContent {
  const document = state.current ?? state.lastDocument
  if (document === undefined) throw new Error('document has no restorable content')
  return {
    documentId: state.documentId,
    title: document.title,
    text: document.text,
    scope: document.scope,
    ...(document.sessionId === undefined ? {} : { sessionId: document.sessionId }),
    ...(document.sourceId === undefined ? {} : { sourceId: document.sourceId }),
    ...(document.sourceUri === undefined ? {} : { sourceUri: document.sourceUri }),
    ...(document.source === undefined ? {} : { source: document.source }),
    updatedAt: document.updatedAt,
    revision: state.revision,
    deleted: state.deleted,
    versions: state.versions,
  }
}

export default LocalRagService

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Request cancelled', 'AbortError')
}
