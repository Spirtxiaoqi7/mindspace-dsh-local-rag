import type {
  EmbeddingProvider,
  IndexedChild,
  IndexedParent,
  LaneEvidence,
  LocalRagHit,
  RetrievalConfig,
  RetrievalLaneStatus,
  SearchLocalMemoryRequest,
  SearchLocalMemoryResult,
  SourceDocument,
} from '../contracts.ts'
import { DEFAULT_RETRIEVAL_CONFIG } from '../contracts.ts'
import { chunkDocument } from './chunking.ts'
import { Bm25Plus } from './lexical.ts'
import { emptySnapshot, type RetrievalSnapshot, type RetrievalStore } from './store.ts'

const MAX_CANDIDATES_PER_LANE = 50
const MAX_RESULT_LIMIT = 50
const MAX_PARENT_CHARACTERS = 10_000

export interface IndexingResult {
  documentIds: string[]
  parentCount: number
  childCount: number
  modelId: string
}

export interface LocalRetrievalStatus {
  modelId: string
  indexedModelId: string
  ready: boolean
  requiresRebuild: boolean
  documents: number
  parents: number
  children: number
}

interface RankedChild {
  child: IndexedChild
  rank: number
  score: number
}

interface VectorLaneOutcome {
  ranked: RankedChild[]
  status: RetrievalLaneStatus
}

/** Local retrieval remains lexical-first; vector state may improve ranking but can never gate access to source text. */
export class LocalHybridRetriever {
  private snapshot: RetrievalSnapshot
  private loaded = false
  readonly config: Required<RetrievalConfig>

  constructor(
    private readonly embedding: EmbeddingProvider,
    private readonly store: RetrievalStore,
    config: RetrievalConfig = DEFAULT_RETRIEVAL_CONFIG,
  ) {
    this.config = resolveRetrievalConfig(config)
    this.snapshot = emptySnapshot(embedding.modelId)
  }

  /** Loading a durable lexical index must never start or wait for an embedding model. */
  async hydrate(signal?: AbortSignal): Promise<void> {
    await this.loadSnapshot(signal)
  }

  async index(documents: readonly SourceDocument[], signal?: AbortSignal): Promise<IndexingResult> {
    await this.loadSnapshot(signal)
    if (documents.length === 0) return { documentIds: [], parentCount: 0, childCount: 0, modelId: this.embedding.modelId }
    throwIfAborted(signal)
    for (const document of documents) validateDocument(document)
    assertUniqueDocumentIds(documents)

    // Persist lexical chunks first. If vectorization fails or is interrupted,
    // the newly imported source remains immediately searchable.
    await this.stageDocuments(documents, signal)
    await this.ensureEmbeddingReady(signal)
    const replacements = new Map(documents.map(document => [document.id, document]))
    const allDocuments = this.snapshot.modelId === this.embedding.modelId
      ? documents
      : [
        ...this.snapshot.documents.map(document => replacements.get(document.id) ?? document),
        ...documents.filter(document => !this.snapshot.documents.some(existing => existing.id === document.id)),
      ]
    return this.snapshot.modelId === this.embedding.modelId
      ? this.vectorizeDocuments(documents, signal, false)
      : this.rebuildDocuments(allDocuments, signal)
  }

  /** Stage source plus parent/child lexical records with empty embeddings. */
  async stageDocuments(documents: readonly SourceDocument[], signal?: AbortSignal): Promise<void> {
    await this.loadSnapshot(signal)
    throwIfAborted(signal)
    for (const document of documents) validateDocument(document)
    assertUniqueDocumentIds(documents)
    const chunked = documents.map(document => ({ document, ...chunkDocument(document, this.config) }))
    const documentIds = new Set(documents.map(document => document.id))
    this.snapshot = {
      ...this.snapshot,
      version: 2,
      documents: [
        ...this.snapshot.documents.filter(document => !documentIds.has(document.id)),
        ...documents.map(document => cloneDocument(document)),
      ],
      parents: [
        ...this.snapshot.parents.filter(parent => !documentIds.has(parent.documentId)),
        ...chunked.flatMap(item => item.parents),
      ],
      children: [
        ...this.snapshot.children.filter(child => !documentIds.has(child.documentId)),
        ...chunked.flatMap(item => item.children),
      ],
    }
    await this.store.save(this.snapshot)
  }

  async search(request: SearchLocalMemoryRequest, signal?: AbortSignal): Promise<SearchLocalMemoryResult> {
    await this.loadSnapshot(signal)
    throwIfAborted(signal)
    const query = request.query.trim()
    if (query.length === 0) throw new Error('search query must not be blank')
    const scope = request.scope ?? 'both'
    const candidates = this.snapshot.children.filter(child => (
      isChildInScope(child, this.snapshot.parents, scope, request)
    ))
    if (candidates.length === 0) return emptySearchResult(query, scope, this.embedding.modelId)

    // Both lanes start in the same turn. BM25+ is independent and remains the
    // guaranteed answer when model startup, readiness, or embedding times out.
    const lexicalPromise = Promise.resolve().then(() => (
      rankLexicalCandidates(query, candidates, this.config.lexicalCandidates)
    ))
    const vectorPromise = this.runVectorLane(query, candidates, signal)
    const [lexicalLane, vector] = await Promise.all([lexicalPromise, vectorPromise])
    throwIfAborted(signal)
    const lexicalStatus: RetrievalLaneStatus = {
      lane: 'lexical',
      state: lexicalLane.length === 0 ? 'empty' : 'complete',
      candidates: lexicalLane.length,
    }
    const hits = foldAndFuse(vector.ranked, lexicalLane, this.snapshot.parents, this.config)
    return {
      query,
      scope,
      hits: hits.slice(0, this.config.resultLimit),
      vectorCandidates: vector.ranked.length,
      lexicalCandidates: lexicalLane.length,
      modelId: this.embedding.modelId,
      laneStatus: { vector: vector.status, lexical: lexicalStatus },
      partial: vector.status.state !== 'complete' && vector.status.state !== 'empty',
    }
  }

  async status(signal?: AbortSignal, checkProvider = true): Promise<LocalRetrievalStatus> {
    await this.loadSnapshot(signal)
    throwIfAborted(signal)
    let ready = false
    if (checkProvider) {
      try { ready = await this.embedding.ready() } catch { ready = false }
    }
    return {
      modelId: this.embedding.modelId,
      indexedModelId: this.snapshot.modelId,
      ready,
      requiresRebuild: this.snapshot.modelId !== this.embedding.modelId
        || this.snapshot.children.some(child => child.embedding.length === 0),
      documents: this.snapshot.documents.length,
      parents: this.snapshot.parents.length,
      children: this.snapshot.children.length,
    }
  }

  async listDocuments(signal?: AbortSignal): Promise<SourceDocument[]> {
    await this.loadSnapshot(signal)
    throwIfAborted(signal)
    return this.snapshot.documents.map(document => cloneDocument(document))
  }

  async getDocument(documentId: string, signal?: AbortSignal): Promise<SourceDocument | undefined> {
    await this.loadSnapshot(signal)
    throwIfAborted(signal)
    const document = this.snapshot.documents.find(item => item.id === documentId)
    return document === undefined ? undefined : cloneDocument(document)
  }

  async removeDocument(documentId: string, signal?: AbortSignal): Promise<boolean> {
    await this.loadSnapshot(signal)
    throwIfAborted(signal)
    if (!this.snapshot.documents.some(document => document.id === documentId)) return false
    this.snapshot = {
      ...this.snapshot,
      documents: this.snapshot.documents.filter(document => document.id !== documentId),
      parents: this.snapshot.parents.filter(parent => parent.documentId !== documentId),
      children: this.snapshot.children.filter(child => child.documentId !== documentId),
    }
    await this.store.save(this.snapshot)
    return true
  }

  async rebuildAll(signal?: AbortSignal): Promise<IndexingResult> {
    await this.loadSnapshot(signal)
    throwIfAborted(signal)
    if (this.snapshot.documents.length === 0 && this.snapshot.children.length > 0) {
      throw new Error('retrieval index has no source-document ledger; index the original documents again before rebuilding')
    }
    return this.rebuildDocuments(this.snapshot.documents, signal)
  }

  private async runVectorLane(
    query: string,
    candidates: IndexedChild[],
    signal?: AbortSignal,
  ): Promise<VectorLaneOutcome> {
    if (this.snapshot.modelId !== this.embedding.modelId) {
      return laneUnavailable('stale_model', `vectors belong to ${this.snapshot.modelId}; lexical retrieval remains current`)
    }
    const vectorized = candidates.filter(child => validVector(child.embedding, this.embedding.dimensions))
    if (vectorized.length === 0) return laneUnavailable('unavailable', 'no current-model vectors; lexical retrieval used')
    try {
      const ranked = await withTimeout(async (laneSignal) => {
        if (!await this.embedding.ready()) throw new ProviderUnavailableError('embedding model is not running')
        const [queryVector] = await this.embedding.embed([query], laneSignal)
        validateVector(queryVector, this.embedding.dimensions)
        return rankVectorCandidates(queryVector, vectorized, this.config.vectorCandidates)
      }, this.config.vectorTimeoutMs, signal)
      return {
        ranked,
        status: { lane: 'vector', state: ranked.length === 0 ? 'empty' : 'complete', candidates: ranked.length },
      }
    } catch (error: unknown) {
      if (signal?.aborted) throw abortReason(signal)
      if (error instanceof LaneTimeoutError) return laneUnavailable('timeout', error.message)
      if (error instanceof ProviderUnavailableError) return laneUnavailable('unavailable', error.message)
      return laneUnavailable('error', error instanceof Error ? error.message : String(error))
    }
  }

  private async vectorizeDocuments(
    documents: readonly SourceDocument[],
    signal: AbortSignal | undefined,
    replaceAll: boolean,
  ): Promise<IndexingResult> {
    const chunked = documents.map(document => ({ document, ...chunkDocument(document, this.config) }))
    const children = chunked.flatMap(item => item.children)
    const vectors = await this.embedding.embed(children.map(child => child.text), signal)
    if (vectors.length !== children.length) throw new Error('embedding provider returned an unexpected vector count')
    for (const [index, child] of children.entries()) {
      const vector = vectors[index]
      validateVector(vector, this.embedding.dimensions)
      child.embedding = [...vector]
    }
    const ids = new Set(documents.map(document => document.id))
    this.snapshot = {
      version: 2,
      modelId: this.embedding.modelId,
      documents: replaceAll
        ? documents.map(document => cloneDocument(document))
        : [...this.snapshot.documents.filter(document => !ids.has(document.id)), ...documents.map(cloneDocument)],
      parents: replaceAll
        ? chunked.flatMap(item => item.parents)
        : [...this.snapshot.parents.filter(parent => !ids.has(parent.documentId)), ...chunked.flatMap(item => item.parents)],
      children: replaceAll
        ? children
        : [...this.snapshot.children.filter(child => !ids.has(child.documentId)), ...children],
    }
    await this.store.save(this.snapshot)
    return {
      documentIds: [...ids],
      parentCount: chunked.reduce((sum, item) => sum + item.parents.length, 0),
      childCount: children.length,
      modelId: this.embedding.modelId,
    }
  }

  private async rebuildDocuments(documents: readonly SourceDocument[], signal?: AbortSignal): Promise<IndexingResult> {
    await this.ensureEmbeddingReady(signal)
    for (const document of documents) validateDocument(document)
    assertUniqueDocumentIds(documents)
    return this.vectorizeDocuments(documents, signal, true)
  }

  private async loadSnapshot(signal?: AbortSignal): Promise<void> {
    if (this.loaded) return
    throwIfAborted(signal)
    this.snapshot = await this.store.load()
    this.loaded = true
  }

  private async ensureEmbeddingReady(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    if (!await this.embedding.ready()) throw new Error(`embedding provider is not ready: ${this.embedding.modelId}`)
    throwIfAborted(signal)
  }
}

export function resolveRetrievalConfig(input: Partial<RetrievalConfig> = {}): Required<RetrievalConfig> {
  const value = { ...DEFAULT_RETRIEVAL_CONFIG, ...input }
  return {
    vectorCandidates: boundedInteger(value.vectorCandidates, 1, MAX_CANDIDATES_PER_LANE, 'vectorCandidates'),
    lexicalCandidates: boundedInteger(value.lexicalCandidates, 1, MAX_CANDIDATES_PER_LANE, 'lexicalCandidates'),
    resultLimit: boundedInteger(value.resultLimit, 1, MAX_RESULT_LIMIT, 'resultLimit'),
    rrfK: boundedInteger(value.rrfK, 1, 500, 'rrfK'),
    parentCharacters: boundedInteger(value.parentCharacters, 100, MAX_PARENT_CHARACTERS, 'parentCharacters'),
    childCharacters: boundedInteger(value.childCharacters, 50, Math.min(value.parentCharacters, 300), 'childCharacters'),
    childMaxCharacters: boundedInteger(
      value.childMaxCharacters ?? DEFAULT_RETRIEVAL_CONFIG.childMaxCharacters ?? 300,
      value.childCharacters,
      300,
      'childMaxCharacters',
    ),
    childrenPerParent: boundedInteger(
      value.childrenPerParent ?? DEFAULT_RETRIEVAL_CONFIG.childrenPerParent ?? 3,
      1,
      3,
      'childrenPerParent',
    ),
    childOverlap: 0,
    vectorTimeoutMs: boundedInteger(
      value.vectorTimeoutMs ?? DEFAULT_RETRIEVAL_CONFIG.vectorTimeoutMs ?? 1_500,
      10,
      120_000,
      'vectorTimeoutMs',
    ),
  }
}

function rankVectorCandidates(queryVector: number[], children: IndexedChild[], limit: number): RankedChild[] {
  return children
    .map(child => ({ child, score: cosine(queryVector, child.embedding) }))
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score || left.child.id.localeCompare(right.child.id))
    .slice(0, limit)
    .map((item, index) => ({ ...item, rank: index + 1 }))
}

function rankLexicalCandidates(query: string, children: IndexedChild[], limit: number): RankedChild[] {
  const scores = new Bm25Plus(children.map(child => child.text)).scores(query)
  return children
    .map((child, index) => ({ child, score: scores[index] ?? 0 }))
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score || left.child.id.localeCompare(right.child.id))
    .slice(0, limit)
    .map((item, index) => ({ ...item, rank: index + 1 }))
}

function foldAndFuse(
  vectorLane: RankedChild[],
  lexicalLane: RankedChild[],
  parents: IndexedParent[],
  config: RetrievalConfig,
): LocalRagHit[] {
  const parentById = new Map(parents.map(parent => [parent.id, parent]))
  const evidenceByParent = new Map<string, { matchedText: string; evidence: LaneEvidence[] }>()
  for (const [lane, ranked] of [['vector', vectorLane], ['lexical', lexicalLane]] as const) {
    for (const item of ranked) {
      const existing = evidenceByParent.get(item.child.parentId) ?? { matchedText: item.child.text, evidence: [] }
      if (!existing.evidence.some(evidence => evidence.lane === lane)) {
        existing.evidence.push({ lane, rank: item.rank, score: item.score })
        existing.matchedText = item.child.text
      }
      evidenceByParent.set(item.child.parentId, existing)
    }
  }
  const hits: LocalRagHit[] = []
  for (const [parentId, item] of evidenceByParent) {
    const parent = parentById.get(parentId)
    if (parent === undefined) continue
    hits.push({
      parentId: parent.id,
      documentId: parent.documentId,
      title: parent.title,
      text: parent.text,
      matchedText: item.matchedText,
      scope: parent.scope,
      ...(parent.sourceId === undefined ? {} : { sourceId: parent.sourceId }),
      ...(parent.sourceUri === undefined ? {} : { sourceUri: parent.sourceUri }),
      ...(parent.source === undefined ? {} : { source: parent.source }),
      authority: { ...parent.authority },
      locator: { ...parent.locator },
      updatedAt: parent.updatedAt,
      rrfScore: item.evidence.reduce((sum, evidence) => sum + 1 / (config.rrfK + evidence.rank), 0),
      evidence: item.evidence.sort((left, right) => left.lane.localeCompare(right.lane)),
    })
  }
  return hits.sort((left, right) => right.rrfScore - left.rrfScore || left.parentId.localeCompare(right.parentId))
}

function isChildInScope(
  child: IndexedChild,
  parents: IndexedParent[],
  scope: SearchLocalMemoryResult['scope'],
  request: SearchLocalMemoryRequest,
): boolean {
  const parent = parents.find(item => item.id === child.parentId)
  if (parent === undefined) return false
  if (request.documentId !== undefined && parent.documentId !== request.documentId) return false
  if (request.sourceId !== undefined && parent.sourceId !== request.sourceId) return false
  if (parent.scope === 'knowledge') return scope === 'knowledge' || scope === 'both'
  return Boolean(request.sessionId && parent.sessionId === request.sessionId && (scope === 'conversation_summary' || scope === 'both'))
}

function cosine(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length === 0) return 0
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!
    leftNorm += left[index]! * left[index]!
    rightNorm += right[index]! * right[index]!
  }
  if (leftNorm === 0 || rightNorm === 0) return 0
  return Math.max(0, Math.min(1, dot / Math.sqrt(leftNorm * rightNorm)))
}

function validateDocument(document: SourceDocument): void {
  if (!document.id.trim() || !document.title.trim() || !document.text.trim()) {
    throw new Error('document id, title, and text are required')
  }
  if (document.scope !== 'knowledge' && document.scope !== 'conversation_summary') throw new Error('document scope is invalid')
  if (document.scope === 'conversation_summary' && !document.sessionId?.trim()) {
    throw new Error('sessionId is required for conversation_summary documents')
  }
  if (!Number.isFinite(document.updatedAt)) throw new Error('updatedAt must be a finite timestamp')
  if (document.units !== undefined) {
    const ids = new Set<string>()
    for (const unit of document.units) {
      if (!unit.id.trim() || !unit.text.trim() || !Number.isSafeInteger(unit.order) || unit.order < 0) {
        throw new Error('document unit id, order, and text are required')
      }
      if (ids.has(unit.id)) throw new Error(`duplicate document unit id: ${unit.id}`)
      ids.add(unit.id)
    }
  }
}

function assertUniqueDocumentIds(documents: readonly SourceDocument[]): void {
  const ids = new Set<string>()
  for (const document of documents) {
    if (ids.has(document.id)) throw new Error(`duplicate document id: ${document.id}`)
    ids.add(document.id)
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal)
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError')
}

function validVector(vector: readonly number[], dimensions: number): boolean {
  return dimensions > 0 && vector.length === dimensions && vector.every(Number.isFinite)
}

function validateVector(vector: readonly number[] | undefined, dimensions: number): asserts vector is readonly number[] {
  if (vector === undefined || !validVector(vector, dimensions)) {
    throw new Error(`embedding dimension mismatch: expected ${String(dimensions)}`)
  }
}

function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in [${String(min)}, ${String(max)}]`)
  }
  return value
}

function emptySearchResult(
  query: string,
  scope: SearchLocalMemoryResult['scope'],
  modelId: string,
): SearchLocalMemoryResult {
  return {
    query,
    scope,
    hits: [],
    vectorCandidates: 0,
    lexicalCandidates: 0,
    modelId,
    laneStatus: {
      vector: { lane: 'vector', state: 'empty', candidates: 0 },
      lexical: { lane: 'lexical', state: 'empty', candidates: 0 },
    },
    partial: false,
  }
}

function laneUnavailable(state: RetrievalLaneStatus['state'], detail: string): VectorLaneOutcome {
  return { ranked: [], status: { lane: 'vector', state, candidates: 0, detail } }
}

class LaneTimeoutError extends Error {}
class ProviderUnavailableError extends Error {}

async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort(parentSignal === undefined ? undefined : abortReason(parentSignal))
  parentSignal?.addEventListener('abort', abort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new LaneTimeoutError(`vector lane timed out after ${String(timeoutMs)} ms`)
      controller.abort(error)
      reject(error)
    }, timeoutMs)
  })
  try {
    return await Promise.race([operation(controller.signal), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    parentSignal?.removeEventListener('abort', abort)
  }
}

function cloneDocument(document: SourceDocument): SourceDocument {
  return {
    ...document,
    ...(document.authority === undefined ? {} : { authority: { ...document.authority } }),
    ...(document.locator === undefined ? {} : { locator: { ...document.locator } }),
    ...(document.units === undefined ? {} : {
      units: document.units.map(unit => ({
        ...unit,
        ...(unit.authority === undefined ? {} : { authority: { ...unit.authority } }),
        locator: { ...unit.locator },
      })),
    }),
  }
}
