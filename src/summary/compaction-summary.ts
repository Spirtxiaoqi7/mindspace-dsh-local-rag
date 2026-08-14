/** DSH-native compaction bridge: accept committed summaries and derive cited deltas. */

export interface SessionEventLike {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
  readonly surfaceOp?: unknown
  readonly sourceEventSeqs?: readonly number[]
}

export interface SessionLike {
  readonly id: string
  readonly events: readonly SessionEventLike[]
  readonly surface: { readonly nodes: readonly number[] }
}

export interface CommittedCompactionSummary {
  readonly documentId: string
  readonly sessionId: string
  readonly compactionId: string
  readonly text: string
  readonly provider: string
  readonly model: string
  readonly createdAt: number
  readonly startTime: number
  readonly endTime: number
  readonly startTurn?: number
  readonly endTurn?: number
  readonly startSeq: number
  readonly summarySeq: number
  readonly checkpointSeq: number
  readonly endSeq: number
  readonly shadowedSeqs: readonly number[]
  readonly recentSurfaceText: readonly string[]
}

interface CompactionStartData { compactionId: string; turn: number | null }
interface CompactionSummaryData {
  compactionId: string
  summary: readonly unknown[]
  shadowedSeqs: readonly number[]
  provider: string
  model: string
}
interface CompactionEndData { compactionId: string; turn: number | null; error?: string }

/**
 * Accept only the complete DSH transaction:
 * start -> summary -> adjacent compact checkpoint -> successful end.
 */
export function committedCompactionSummary(
  session: SessionLike,
  endEvent: SessionEventLike,
  recentSurfaceLimit = 16,
): CommittedCompactionSummary | undefined {
  if (endEvent.type !== 'compaction/end') return
  const end = objectData<CompactionEndData>(endEvent.data)
  if (!end || !nonBlank(end.compactionId) || nonBlank(end.error)) return

  const candidates = session.events.filter(event => event.seq <= endEvent.seq)
  const startEvent = findLast(candidates, event => event.type === 'compaction/start'
    && objectData<CompactionStartData>(event.data)?.compactionId === end.compactionId)
  const summaryEvent = findLast(candidates, event => event.type === 'compaction/summary'
    && objectData<CompactionSummaryData>(event.data)?.compactionId === end.compactionId)
  if (!startEvent || !summaryEvent || startEvent.seq >= summaryEvent.seq || summaryEvent.seq >= endEvent.seq) return

  const start = objectData<CompactionStartData>(startEvent.data)
  const summary = objectData<CompactionSummaryData>(summaryEvent.data)
  if (!start || !summary || !Array.isArray(summary.shadowedSeqs) || summary.shadowedSeqs.length === 0) return
  const checkpoint = session.events.find(event => event.seq === summaryEvent.seq + 1)
  if (!checkpoint || checkpoint.type !== 'user/message' || !isCommittedCheckpoint(checkpoint, end.compactionId)) return
  const cited = new Set(checkpoint.sourceEventSeqs ?? [])
  if (![startEvent.seq, summaryEvent.seq, ...summary.shadowedSeqs].every(seq => cited.has(seq))) return

  const text = blocksText(summary.summary)
  if (!text) return
  const shadowed = summary.shadowedSeqs
    .map(seq => session.events.find(event => event.seq === seq))
    .filter((event): event is SessionEventLike => event !== undefined)
  const turns = shadowed.map(eventTurn).filter((turn): turn is number => turn !== undefined)
  const times = shadowed.map(event => event.time).filter(Number.isFinite)
  const recentSurfaceText = session.surface.nodes
    .map(seq => session.events.find(event => event.seq === seq))
    .filter((event): event is SessionEventLike => event !== undefined && !isCompactCheckpointEvent(event))
    .slice(-Math.max(0, recentSurfaceLimit))
    .map(messageEventText)
    .filter(nonBlank)

  return {
    documentId: `dsh-compaction:${session.id}:${end.compactionId}:${String(summaryEvent.seq)}`,
    sessionId: session.id,
    compactionId: end.compactionId,
    text,
    provider: String(summary.provider || 'unknown'),
    model: String(summary.model || 'unknown'),
    createdAt: summaryEvent.time,
    startTime: times.length ? Math.min(...times) : startEvent.time,
    endTime: times.length ? Math.max(...times) : summaryEvent.time,
    ...(turns.length ? { startTurn: Math.min(...turns), endTurn: Math.max(...turns) } : start.turn === null ? {} : { startTurn: start.turn, endTurn: start.turn }),
    startSeq: startEvent.seq,
    summarySeq: summaryEvent.seq,
    checkpointSeq: checkpoint.seq,
    endSeq: endEvent.seq,
    shadowedSeqs: [...summary.shadowedSeqs],
    recentSurfaceText,
  }
}

/**
 * Keep only summary statements not already represented by older summaries or
 * the current uncompressed surface. This makes repeated compactions a delta
 * ledger instead of an ever-growing copy of the same facts.
 */
export function dedupeCompactionSummary(
  summary: string,
  previousSummaries: readonly string[],
  recentSurfaceText: readonly string[],
  threshold = 0.82,
): string {
  const references = [...previousSummaries, ...recentSurfaceText]
    .flatMap(splitStatements)
    .map(normalizedStatement)
    .filter(nonBlank)
  const kept: string[] = []
  const seen = [...references]
  for (const statement of splitStatements(summary)) {
    const normalized = normalizedStatement(statement)
    if (!normalized || seen.some(reference => statementSimilarity(normalized, reference) >= threshold)) continue
    kept.push(statement.trim())
    seen.push(normalized)
  }
  return kept.join('\n').trim()
}

export function statementSimilarity(left: string, right: string): number {
  if (left === right) return 1
  if (left.length >= 12 && right.length >= 12 && (left.includes(right) || right.includes(left))) return 0.98
  const leftTerms = terms(left)
  const rightTerms = terms(right)
  if (!leftTerms.size || !rightTerms.size) return 0
  let intersection = 0
  for (const term of leftTerms) if (rightTerms.has(term)) intersection += 1
  const jaccard = intersection / (leftTerms.size + rightTerms.size - intersection)
  const containment = intersection / Math.min(leftTerms.size, rightTerms.size)
  return Math.max(jaccard, Math.min(0.96, containment * 0.96))
}

function splitStatements(value: string): string[] {
  return value
    .replace(/\r\n?/g, '\n')
    .split(/\n+|(?<=[。！？!?；;])\s*/u)
    .map(item => item.replace(/^\s*(?:[-*•]+|\d+[.)、])\s*/, '').trim())
    .filter(nonBlank)
}

function normalizedStatement(value: string): string {
  return value.toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '')
}

function terms(value: string): Set<string> {
  const ascii = value.match(/[a-z0-9_]+/g) ?? []
  const han = [...value].filter(character => /\p{Script=Han}/u.test(character))
  const grams = han.length < 2 ? han : han.slice(0, -1).map((character, index) => `${character}${han[index + 1]}`)
  return new Set([...ascii, ...grams])
}

function isCommittedCheckpoint(event: SessionEventLike, compactionId: string): boolean {
  const source = checkpointSource(event)
  return source?.kind === 'plugin' && source.plugin === 'compact' && source.compactionId === compactionId
}

function isCompactCheckpointEvent(event: SessionEventLike): boolean {
  if (event.type !== 'user/message') return false
  const source = checkpointSource(event)
  return source?.kind === 'plugin' && source.plugin === 'compact' && nonBlank(source.compactionId)
}

function checkpointSource(event: SessionEventLike): { kind?: string; plugin?: string; compactionId?: string } | undefined {
  const direct = objectData<{ source?: unknown }>(event.data)
  const wrapped = objectData<{ message?: unknown }>(event.data)
  return objectData(direct?.source) ?? objectData(objectData<{ source?: unknown }>(wrapped?.message)?.source)
}

function messageEventText(event: SessionEventLike): string {
  if (event.type === 'user/message') return blocksText(objectData<{ content?: readonly unknown[] }>(event.data)?.content ?? [])
  if (event.type === 'assistant/message') {
    return blocksText(objectData<{ message?: { content?: readonly unknown[] } }>(event.data)?.message?.content ?? [])
  }
  return ''
}

function blocksText(blocks: readonly unknown[]): string {
  return blocks
    .map(block => objectData<{ type?: string; text?: string }>(block))
    .filter((block): block is { type?: string; text?: string } => block !== undefined && block.type === 'text' && nonBlank(block.text))
    .map(block => block.text!.trim())
    .join('\n\n')
    .trim()
}

function eventTurn(event: SessionEventLike): number | undefined {
  const turn = objectData<{ turn?: unknown }>(event.data)?.turn
  return typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 0 ? turn : undefined
}

function objectData<T extends object>(value: unknown): T | undefined {
  return typeof value === 'object' && value !== null ? value as T : undefined
}

function nonBlank(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 }
function findLast<T>(items: readonly T[], predicate: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) if (predicate(items[index]!)) return items[index]
}
