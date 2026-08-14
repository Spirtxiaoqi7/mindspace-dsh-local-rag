/** Durable, append-only user governance history for both local-RAG libraries. */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SourceDocument } from '../contracts.ts'
import type {
  LocalRagDocumentRevisionAction,
  LocalRagDocumentRevisionInfo,
} from './types.ts'

interface StoredRevision {
  readonly revision: number
  readonly action: LocalRagDocumentRevisionAction
  readonly at: number
  readonly reason?: string
  readonly document: SourceDocument | null
}

interface StoredHistory {
  readonly version: 1
  readonly documentId: string
  readonly revisions: readonly StoredRevision[]
}

export interface DocumentHistoryView {
  readonly documentId: string
  readonly revision: number
  readonly deleted: boolean
  readonly current?: SourceDocument
  readonly lastDocument?: SourceDocument
  readonly versions: readonly LocalRagDocumentRevisionInfo[]
}

export class LocalRagDocumentHistory {
  private readonly root: string

  constructor(dataRoot: string) { this.root = join(dataRoot, 'document-history') }

  async ensure(document: SourceDocument): Promise<DocumentHistoryView> {
    const existing = await this.read(document.id)
    if (existing !== undefined) {
      const latest = existing.revisions.at(-1)?.document
      if (latest !== null && latest !== undefined && JSON.stringify(latest) !== JSON.stringify(document)) {
        return this.append(document.id, 'edited', document, 'Recovered indexed document state')
      }
      return view(existing)
    }
    return this.append(document.id, 'created', document, 'Initial indexed document')
  }

  async current(documentId: string): Promise<DocumentHistoryView | undefined> {
    const stored = await this.read(documentId)
    return stored === undefined ? undefined : view(stored)
  }

  async append(
    documentId: string,
    action: LocalRagDocumentRevisionAction,
    document: SourceDocument | null,
    reason?: string,
  ): Promise<DocumentHistoryView> {
    const previous = await this.read(documentId)
    if (previous === undefined && action !== 'created') throw new Error('document history is unavailable')
    if (document !== null && document.id !== documentId) throw new Error('document history id does not match document')
    const revisions = previous?.revisions ?? []
    const revision = revisions.length + 1
    const normalizedReason = reason?.trim()
    const next: StoredHistory = {
      version: 1,
      documentId,
      revisions: [...revisions, {
        revision,
        action,
        at: Date.now(),
        ...(normalizedReason ? { reason: normalizedReason } : {}),
        document: document === null ? null : cloneDocument(document),
      }],
    }
    await this.write(next)
    return view(next)
  }

  async assertRevision(documentId: string, expectedRevision: number): Promise<DocumentHistoryView> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('expectedRevision must be a positive safe integer')
    const current = await this.current(documentId)
    if (current === undefined) throw new Error('document history is unavailable')
    if (current.revision !== expectedRevision) {
      throw new Error(`document revision conflict: expected ${String(expectedRevision)}, current ${String(current.revision)}`)
    }
    return current
  }

  async revision(documentId: string, revision: number): Promise<SourceDocument> {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('revision must be a positive safe integer')
    const stored = await this.read(documentId)
    const entry = stored?.revisions.find(item => item.revision === revision)
    if (entry?.document === undefined || entry.document === null) throw new Error('selected revision has no restorable document')
    return cloneDocument(entry.document)
  }

  async list(): Promise<readonly DocumentHistoryView[]> {
    try {
      const names = await readdir(this.root)
      const histories = await Promise.all(names.filter(name => name.endsWith('.json')).map(async name => {
        try { return view(parseHistory(JSON.parse(await readFile(join(this.root, name), 'utf8')))) } catch { return undefined }
      }))
      return histories.filter((item): item is DocumentHistoryView => item !== undefined)
    } catch (error: unknown) {
      if (isMissing(error)) return []
      throw error
    }
  }

  private file(documentId: string): string {
    const key = createHash('sha256').update(documentId).digest('hex')
    return join(this.root, `${key}.json`)
  }

  private async read(documentId: string): Promise<StoredHistory | undefined> {
    try {
      const history = parseHistory(JSON.parse(await readFile(this.file(documentId), 'utf8')))
      if (history.documentId !== documentId) throw new Error('document history id mismatch')
      return history
    } catch (error: unknown) {
      if (isMissing(error)) return undefined
      throw error
    }
  }

  private async write(history: StoredHistory): Promise<void> {
    const target = this.file(history.documentId)
    await mkdir(dirname(target), { recursive: true })
    const temporary = `${target}.${randomUUID()}.partial`
    await writeFile(temporary, `${JSON.stringify(history)}\n`, 'utf8')
    try { await rename(temporary, target) } catch (error) { await rm(temporary, { force: true }); throw error }
  }
}

function view(history: StoredHistory): DocumentHistoryView {
  const latest = history.revisions.at(-1)!
  const lastDocument = [...history.revisions].reverse().find(entry => entry.document !== null)?.document ?? undefined
  return {
    documentId: history.documentId,
    revision: latest.revision,
    deleted: latest.document === null,
    ...(latest.document === null ? {} : { current: cloneDocument(latest.document) }),
    ...(lastDocument === undefined ? {} : { lastDocument: cloneDocument(lastDocument) }),
    versions: history.revisions.map(entry => ({
      revision: entry.revision,
      action: entry.action,
      at: entry.at,
      ...(entry.reason === undefined ? {} : { reason: entry.reason }),
      ...(entry.document === null ? {} : { title: entry.document.title }),
      characters: entry.document === null ? 0 : [...entry.document.text].length,
      deleted: entry.document === null,
    })),
  }
}

function parseHistory(value: unknown): StoredHistory {
  if (typeof value !== 'object' || value === null) throw new Error('document history is invalid')
  const item = value as Partial<StoredHistory>
  if (item.version !== 1 || typeof item.documentId !== 'string' || !Array.isArray(item.revisions) || item.revisions.length === 0) {
    throw new Error('document history has an unsupported shape')
  }
  for (const [index, revision] of item.revisions.entries()) {
    if (typeof revision !== 'object' || revision === null || revision.revision !== index + 1
      || !['created', 'edited', 'deleted', 'restored'].includes(revision.action)
      || !Number.isFinite(revision.at)
      || (revision.document !== null && (typeof revision.document !== 'object' || revision.document.id !== item.documentId))) {
      throw new Error('document revision is invalid')
    }
  }
  return item as StoredHistory
}

function cloneDocument(document: SourceDocument): SourceDocument {
  return structuredClone(document)
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}
