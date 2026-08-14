import type {
  IndexedChild,
  IndexedParent,
  SourceAuthority,
  SourceDocument,
  SourceDocumentUnit,
  SourceLocator,
} from '../contracts.ts'

export interface ChunkedDocument {
  parents: IndexedParent[]
  children: IndexedChild[]
}

export interface ChunkingOptions {
  parentCharacters: number
  childCharacters: number
  childMaxCharacters?: number
  childrenPerParent?: number
  childOverlap: number
}

interface Boundary {
  id: string
  text: string
  authority: SourceAuthority
  locator: SourceLocator
  segments: BoundarySegment[]
}

interface BoundarySegment {
  start: number
  end: number
  locator: SourceLocator
}

interface TextSpan {
  text: string
  start: number
  end: number
}

const SENTENCE_END = new Set(['.', '!', '?', ';', '。', '！', '？', '；', '\n', '\r', '…'])
const CLOSING_MARK = new Set(['"', "'", '”', '’', '」', '』', ')', '）', ']', '】'])
const DEFAULT_CHILD_MAX = 300
const DEFAULT_CHILDREN_PER_PARENT = 3

/** Deterministic fallback for legacy/plain-text documents without explicit authority. */
export function documentAuthority(document: SourceDocument): SourceAuthority {
  return document.authority === undefined
    ? {
      kind: document.scope === 'conversation_summary' ? 'conversation_summary' : 'text',
      documentTitle: document.title,
      ...(document.source === undefined ? {} : { source: document.source }),
    }
    : { ...document.authority }
}

function boundaryFromUnit(document: SourceDocument, unit: SourceDocumentUnit): Boundary | undefined {
  const text = unit.text.trim()
  if (text.length === 0) return undefined
  return {
    id: `unit:${unit.id}`,
    text,
    authority: unit.authority === undefined ? documentAuthority(document) : { ...unit.authority },
    locator: { ...unit.locator },
    segments: [{ start: 0, end: unicodeLength(text), locator: { ...unit.locator } }],
  }
}

function sameAuthority(left: SourceAuthority, right: SourceAuthority): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Merge adjacent units while retaining an honest coordinate range. Conversation
 * summary events remain hard boundaries; uploaded file pages/rows/paragraphs do
 * not, otherwise a short-row table degenerates into dozens of tiny chunks.
 */
function mergeLocator(left: SourceLocator, right: SourceLocator): SourceLocator | undefined {
  for (const field of ['summaryAt', 'turn'] as const) {
    if (left[field] !== right[field]) return undefined
  }
  if (JSON.stringify(left.header ?? null) !== JSON.stringify(right.header ?? null)) return undefined
  const pageNumber = minDefined(left.pageNumber, right.pageNumber)
  const pageEnd = maxDefined(left.pageEnd ?? left.pageNumber, right.pageEnd ?? right.pageNumber)
  const rowNumber = minDefined(left.rowNumber, right.rowNumber)
  const rowEnd = maxDefined(left.rowEnd ?? left.rowNumber, right.rowEnd ?? right.rowNumber)
  const paragraphNumber = minDefined(left.paragraphNumber, right.paragraphNumber)
  const paragraphEnd = maxDefined(left.paragraphEnd ?? left.paragraphNumber, right.paragraphEnd ?? right.paragraphNumber)
  const lineStart = minDefined(left.lineStart, right.lineStart)
  const lineEnd = maxDefined(left.lineEnd ?? left.lineStart, right.lineEnd ?? right.lineStart)
  const seqStart = minDefined(left.seqStart, right.seqStart)
  const seqEnd = maxDefined(left.seqEnd ?? left.seqStart, right.seqEnd ?? right.seqStart)
  const merged: SourceLocator = {
    ...left,
    ...right,
    ...(pageNumber === undefined ? {} : { pageNumber }),
    ...(pageEnd === undefined ? {} : { pageEnd }),
    ...(rowNumber === undefined ? {} : { rowNumber }),
    ...(rowEnd === undefined ? {} : { rowEnd }),
    ...(paragraphNumber === undefined ? {} : { paragraphNumber }),
    ...(paragraphEnd === undefined ? {} : { paragraphEnd }),
    ...(lineStart === undefined ? {} : { lineStart }),
    ...(lineEnd === undefined ? {} : { lineEnd }),
    ...(seqStart === undefined ? {} : { seqStart }),
    ...(seqEnd === undefined ? {} : { seqEnd }),
  }
  if (left.heading !== right.heading) delete merged.heading
  return merged
}

function minDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  return Math.min(left, right)
}

function maxDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  return Math.max(left, right)
}

function boundaries(document: SourceDocument): Boundary[] {
  if (document.units === undefined || document.units.length === 0) {
    const text = document.text.trim()
    return text.length === 0 ? [] : [{
      id: 'document', text, authority: documentAuthority(document), locator: { ...document.locator },
      segments: [{ start: 0, end: unicodeLength(text), locator: { ...document.locator } }],
    }]
  }
  const source = [...document.units]
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .map(unit => boundaryFromUnit(document, unit))
    .filter((value): value is Boundary => value !== undefined)
  const merged: Boundary[] = []
  for (const current of source) {
    const previous = merged.at(-1)
    const locator = previous === undefined ? undefined : mergeLocator(previous.locator, current.locator)
    if (previous !== undefined && locator !== undefined && sameAuthority(previous.authority, current.authority)) {
      merged[merged.length - 1] = {
        ...previous,
        id: `${previous.id}+${current.id}`,
        text: `${previous.text}\n${current.text}`,
        locator,
        segments: [
          ...previous.segments,
          ...current.segments.map(segment => ({
            ...segment,
            start: segment.start + unicodeLength(previous.text) + 1,
            end: segment.end + unicodeLength(previous.text) + 1,
          })),
        ],
      }
    } else {
      merged.push(current)
    }
  }
  return merged
}

/** Split near the target, extending only to the first sentence end and never beyond max. */
export function sentenceAwareChildren(text: string, target: number, max: number): string[] {
  return sentenceAwareSpans(text, target, max).map(span => span.text)
}

function sentenceAwareSpans(text: string, target: number, max: number): TextSpan[] {
  const characters = [...text.trim()]
  const chunks: TextSpan[] = []
  let start = 0
  while (start < characters.length) {
    const remaining = characters.length - start
    if (remaining <= target) {
      const tail = characters.slice(start).join('').trim()
      if (tail.length > 0) chunks.push({ text: tail, start, end: characters.length })
      break
    }
    const targetEnd = Math.min(start + target, characters.length)
    const hardEnd = Math.min(start + max, characters.length)
    let end = -1
    for (let index = targetEnd - 1; index < hardEnd; index += 1) {
      if (!SENTENCE_END.has(characters[index]!)) continue
      end = index + 1
      while (end < hardEnd && CLOSING_MARK.has(characters[end]!)) end += 1
      break
    }
    if (end < 0) end = remaining <= max ? characters.length : hardEnd
    const chunk = characters.slice(start, end).join('').trim()
    if (chunk.length > 0) chunks.push({ text: chunk, start, end })
    start = end
    while (start < characters.length && /\s/u.test(characters[start]!)) start += 1
  }
  return chunks
}

/**
 * Build sentence-aligned children first, then group at most three consecutive
 * children into each parent. There is intentionally no overlap.
 */
export function chunkDocument(document: SourceDocument, options: ChunkingOptions): ChunkedDocument {
  const target = Math.max(1, Math.min(Math.floor(options.childCharacters), DEFAULT_CHILD_MAX))
  const max = Math.max(target, Math.min(options.childMaxCharacters ?? DEFAULT_CHILD_MAX, DEFAULT_CHILD_MAX))
  const perParent = Math.max(1, Math.min(
    Math.floor(options.childrenPerParent ?? DEFAULT_CHILDREN_PER_PARENT),
    DEFAULT_CHILDREN_PER_PARENT,
  ))
  const sourceBoundaries = boundaries(document)
  if (sourceBoundaries.length === 0) throw new Error('source document text must not be blank')

  const parents: IndexedParent[] = []
  const children: IndexedChild[] = []
  for (const boundary of sourceBoundaries) {
    const spans = sentenceAwareSpans(boundary.text, target, max)
    for (let offset = 0, parentIndex = 0; offset < spans.length; offset += perParent, parentIndex += 1) {
      const grouped = spans.slice(offset, offset + perParent)
      const parentId = `${document.id}:${boundary.id}:parent:${String(parentIndex)}`
      const locator = locatorForRange(boundary, grouped[0]!.start, grouped.at(-1)!.end)
      parents.push({
        id: parentId,
        documentId: document.id,
        title: document.title,
        text: grouped.map(span => span.text).join('\n'),
        scope: document.scope,
        ...(document.sessionId === undefined ? {} : { sessionId: document.sessionId }),
        ...(document.sourceId === undefined ? {} : { sourceId: document.sourceId }),
        ...(document.sourceUri === undefined ? {} : { sourceUri: document.sourceUri }),
        ...(document.source === undefined ? {} : { source: document.source }),
        authority: { ...boundary.authority },
        locator,
        updatedAt: document.updatedAt,
      })
      for (const [childIndex, child] of grouped.entries()) {
        children.push({
          id: `${parentId}:child:${String(childIndex)}`,
          parentId,
          documentId: document.id,
          text: child.text,
          embedding: [],
        })
      }
    }
  }
  return { parents, children }
}

function locatorForRange(boundary: Boundary, start: number, end: number): SourceLocator {
  const locators = boundary.segments
    .filter(segment => segment.end > start && segment.start < end)
    .map(segment => segment.locator)
  if (locators.length === 0) return { ...boundary.locator }
  let result = { ...locators[0]! }
  for (const locator of locators.slice(1)) result = mergeLocator(result, locator) ?? result
  return result
}

function unicodeLength(value: string): number {
  return [...value].length
}
