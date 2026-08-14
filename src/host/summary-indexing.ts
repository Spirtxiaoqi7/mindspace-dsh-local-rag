/** Durable, compaction-only session summary indexing. Never indexes raw turns. */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SourceDocument } from '../contracts.ts'
import { committedCompactionSummary, dedupeCompactionSummary, type CommittedCompactionSummary, type SessionEventLike, type SessionLike } from '../summary/compaction-summary.ts'
import type { LocalRagBackgroundIndexStatus, LocalRagIndexPort } from './types.ts'

interface LedgerEntry {
  readonly sessionId: string
  readonly state: 'indexed' | 'skipped'
  readonly text?: string
  readonly at: number
}

interface SummaryLedger {
  readonly version: 1
  readonly processed: Record<string, LedgerEntry>
}

const EMPTY_LEDGER: SummaryLedger = { version: 1, processed: {} }

/**
 * Owns the crash-safe summary ledger. An index write followed by a crash before
 * ledger persistence is harmless because summary document ids are stable upserts.
 */
export class CompactionSummaryIndexer {
  private ledger: SummaryLedger = EMPTY_LEDGER
  private loaded = false
  private readonly pending = new Set<string>()
  private serial: Promise<void> = Promise.resolve()
  private status: LocalRagBackgroundIndexStatus = { lastDocumentId: null, lastIndexedAt: null, lastError: null }

  constructor(private readonly index: LocalRagIndexPort, private readonly dataRoot: string) {}

  view(): LocalRagBackgroundIndexStatus { return this.status }

  /** Load prior decisions, remove obsolete raw-turn documents, then recover every committed summary. */
  async initialize(sessions: Iterable<SessionLike>): Promise<void> {
    await this.loadLedger()
    await this.removeLegacyTurnDocuments()
    for (const session of sessions) {
      for (const event of session.events) {
        if (event.type === 'compaction/end') await this.process(session, event)
      }
    }
  }

  /** Fire-and-forget post-commit observer; failures are visible through view(). */
  observe(session: SessionLike, event: SessionEventLike): void {
    if (event.type !== 'compaction/end') return
    const summary = committedCompactionSummary(session, event)
    if (summary === undefined || this.ledger.processed[summary.documentId] !== undefined || this.pending.has(summary.documentId)) return
    this.pending.add(summary.documentId)
    this.serial = this.serial.catch(() => undefined).then(async () => {
      try {
        await this.process(session, event)
      } catch (error: unknown) {
        this.recordError(error)
      } finally {
        this.pending.delete(summary.documentId)
      }
    })
  }

  private async process(session: SessionLike, event: SessionEventLike): Promise<void> {
    const summary = committedCompactionSummary(session, event)
    if (summary === undefined || this.ledger.processed[summary.documentId] !== undefined) return
    const delta = dedupeCompactionSummary(
      summary.text,
      this.previousSummaryTexts(summary.sessionId),
      summary.recentSurfaceText,
    )
    if (!delta) {
      await this.mark(summary, { sessionId: summary.sessionId, state: 'skipped', at: summary.createdAt })
      this.status = { lastDocumentId: summary.documentId, lastIndexedAt: Date.now(), lastError: null }
      return
    }
    await this.index.importText(summaryDocument(summary, delta))
    await this.mark(summary, { sessionId: summary.sessionId, state: 'indexed', text: delta, at: summary.createdAt })
    this.status = { lastDocumentId: summary.documentId, lastIndexedAt: Date.now(), lastError: null }
  }

  private previousSummaryTexts(sessionId: string): string[] {
    return Object.values(this.ledger.processed)
      .filter(entry => entry.sessionId === sessionId && entry.state === 'indexed' && entry.text !== undefined)
      .map(entry => entry.text!)
  }

  private async mark(summary: CommittedCompactionSummary, entry: LedgerEntry): Promise<void> {
    this.ledger = { version: 1, processed: { ...this.ledger.processed, [summary.documentId]: entry } }
    await this.writeLedger()
  }

  private ledgerPath(): string { return join(this.dataRoot, 'summary-index', 'processed-ledger.json') }

  private async loadLedger(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const value = JSON.parse(await readFile(this.ledgerPath(), 'utf8')) as Partial<SummaryLedger>
      if (value.version !== 1 || value.processed === null || typeof value.processed !== 'object' || Array.isArray(value.processed)) {
        throw new Error('summary ledger has an unsupported shape')
      }
      this.ledger = { version: 1, processed: value.processed as Record<string, LedgerEntry> }
    } catch (error: unknown) {
      if (isMissingFile(error)) { this.ledger = EMPTY_LEDGER; return }
      throw error
    }
  }

  /** Atomic replace in the same directory: no partial ledger is ever observable. */
  private async writeLedger(): Promise<void> {
    const target = this.ledgerPath()
    await mkdir(join(this.dataRoot, 'summary-index'), { recursive: true })
    const temporary = `${target}.${randomUUID()}.partial`
    await writeFile(temporary, `${JSON.stringify(this.ledger)}\n`, 'utf8')
    try {
      await rename(temporary, target)
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
  }

  /** Migration cleanup: raw dsh-turn documents are forbidden once summary indexing is active. */
  private async removeLegacyTurnDocuments(): Promise<void> {
    // Do not filter by the new scope here: an older build may have stored raw
    // turns under its former scope name, and those must not survive migration.
    const documents = await this.index.listDocuments()
    for (const document of documents) if (document.id.startsWith('dsh-turn:')) await this.index.removeDocument(document.id)
  }

  private recordError(error: unknown): void {
    this.status = {
      ...this.status,
      lastError: error instanceof Error ? error.message : String(error),
    }
  }
}

function summaryDocument(summary: CommittedCompactionSummary, text: string): SourceDocument {
  const authority = {
    kind: 'conversation_summary',
    documentTitle: `Compacted summary · ${summary.sessionId}`,
    source: 'dsh-compaction',
  }
  const locator = {
    summaryAt: summary.createdAt,
    ...(summary.endTurn === undefined ? {} : { turn: summary.endTurn }),
    seqStart: summary.startSeq,
    seqEnd: summary.endSeq,
  }
  return {
    id: summary.documentId,
    title: `Compacted summary · ${summary.sessionId}`,
    text,
    scope: 'conversation_summary',
    sessionId: summary.sessionId,
    source: `DSH compaction ${summary.compactionId}; ${summary.provider}/${summary.model}; seq ${String(summary.startSeq)}-${String(summary.endSeq)}`,
    authority,
    locator,
    units: [{ id: `${summary.documentId}:summary`, order: 0, text, authority, locator }],
    updatedAt: summary.createdAt,
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}
