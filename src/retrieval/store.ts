import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { IndexedChild, IndexedParent, SourceDocument, SourceDocumentUnit } from '../contracts.ts'
import { documentAuthority } from './chunking.ts'

export interface RetrievalSnapshot {
  version: 2
  /** Model that owns non-empty child embeddings; lexical records do not depend on it. */
  modelId: string
  documents: SourceDocument[]
  parents: IndexedParent[]
  children: IndexedChild[]
}

export interface RetrievalStore {
  load(): Promise<RetrievalSnapshot>
  save(snapshot: RetrievalSnapshot): Promise<void>
}

export function emptySnapshot(modelId: string): RetrievalSnapshot {
  return { version: 2, modelId, documents: [], parents: [], children: [] }
}

/** JSON file persistence with temp-file then rename semantics. */
export class JsonAtomicRetrievalStore implements RetrievalStore {
  constructor(private readonly path: string, private readonly modelId: string) {}

  async load(): Promise<RetrievalSnapshot> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      return migrateSnapshot(parsed, this.modelId)
    } catch (error) {
      if (isMissingFile(error)) return emptySnapshot(this.modelId)
      throw error
    }
  }

  async save(snapshot: RetrievalSnapshot): Promise<void> {
    const validated = migrateSnapshot(snapshot, this.modelId)
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(validated)}\n`, 'utf8')
    await rename(temporary, this.path)
  }
}

export class InMemoryRetrievalStore implements RetrievalStore {
  private value: RetrievalSnapshot

  constructor(modelId: string, initial?: RetrievalSnapshot | unknown) {
    this.value = initial === undefined ? emptySnapshot(modelId) : migrateSnapshot(initial, modelId)
  }

  async load(): Promise<RetrievalSnapshot> {
    return cloneSnapshot(this.value)
  }

  async save(snapshot: RetrievalSnapshot): Promise<void> {
    this.value = cloneSnapshot(snapshot)
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function migrateScope(value: unknown): SourceDocument['scope'] {
  if (value === 'current_session' || value === 'conversation_summary') return 'conversation_summary'
  if (value === 'knowledge') return 'knowledge'
  throw new Error(`invalid retrieval scope: ${String(value)}`)
}

function copyUnit(value: unknown): SourceDocumentUnit {
  if (typeof value !== 'object' || value === null) throw new Error('invalid source document unit')
  const unit = value as SourceDocumentUnit
  if (!unit.id?.trim() || !Number.isSafeInteger(unit.order) || !unit.text?.trim()) throw new Error('invalid source document unit')
  return {
    id: unit.id,
    order: unit.order,
    text: unit.text,
    ...(unit.authority === undefined ? {} : { authority: { ...unit.authority } }),
    locator: { ...unit.locator },
  }
}

function copyDocument(value: unknown): SourceDocument {
  if (typeof value !== 'object' || value === null) throw new Error('invalid source document')
  const input = value as SourceDocument & { scope: unknown }
  const document: SourceDocument = {
    id: input.id,
    title: input.title,
    text: input.text,
    scope: migrateScope(input.scope),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
    ...(input.sourceUri === undefined ? {} : { sourceUri: input.sourceUri }),
    ...(input.source === undefined ? {} : { source: input.source }),
    ...(input.authority === undefined ? {} : { authority: { ...input.authority } }),
    ...(input.locator === undefined ? {} : { locator: { ...input.locator } }),
    ...(input.units === undefined ? {} : { units: input.units.map(copyUnit) }),
    updatedAt: input.updatedAt,
  }
  return document
}

/** Read both snapshot generations and return a normalized V2 snapshot. */
export function migrateSnapshot(value: unknown, fallbackModelId: string): RetrievalSnapshot {
  if (typeof value !== 'object' || value === null) throw new Error('retrieval snapshot must be an object')
  const input = value as {
    version?: unknown
    modelId?: unknown
    documents?: unknown
    parents?: unknown
    children?: unknown
  }
  if ((input.version !== 1 && input.version !== 2) || !Array.isArray(input.parents) || !Array.isArray(input.children)) {
    throw new Error('invalid retrieval snapshot')
  }
  const documents = Array.isArray(input.documents) ? input.documents.map(copyDocument) : []
  const documentById = new Map(documents.map(document => [document.id, document]))
  const parents = input.parents.map((valueParent): IndexedParent => {
    if (typeof valueParent !== 'object' || valueParent === null) throw new Error('invalid indexed parent')
    const parent = valueParent as IndexedParent
    const rawScope = (valueParent as { scope?: unknown }).scope
    const document = documentById.get(parent.documentId)
    return {
      id: parent.id,
      documentId: parent.documentId,
      title: parent.title,
      text: parent.text,
      scope: migrateScope(rawScope),
      ...(parent.sessionId === undefined ? {} : { sessionId: parent.sessionId }),
      ...(parent.sourceId === undefined ? {} : { sourceId: parent.sourceId }),
      ...(parent.sourceUri === undefined ? {} : { sourceUri: parent.sourceUri }),
      ...(parent.source === undefined ? {} : { source: parent.source }),
      authority: parent.authority === undefined
        ? document === undefined
          ? { kind: rawScope === 'current_session' ? 'conversation_summary' : 'text', documentTitle: parent.title }
          : documentAuthority(document)
        : { ...parent.authority },
      locator: { ...(parent.locator ?? document?.locator) },
      updatedAt: parent.updatedAt,
    }
  })
  const children = input.children.map((valueChild): IndexedChild => {
    if (typeof valueChild !== 'object' || valueChild === null) throw new Error('invalid indexed child')
    const child = valueChild as IndexedChild
    if (!Array.isArray(child.embedding)) throw new Error('invalid indexed child embedding')
    return { ...child, embedding: [...child.embedding] }
  })
  return {
    version: 2,
    modelId: typeof input.modelId === 'string' && input.modelId.length > 0 ? input.modelId : fallbackModelId,
    documents,
    parents,
    children,
  }
}

function cloneSnapshot(snapshot: RetrievalSnapshot): RetrievalSnapshot {
  return migrateSnapshot(snapshot, snapshot.modelId)
}
