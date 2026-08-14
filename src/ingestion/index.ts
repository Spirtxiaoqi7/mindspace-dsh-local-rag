/** Deterministic local-file parsing and provenance-preserving ingestion. */

import { createHash } from 'node:crypto'
import type { SourceDocument } from '../contracts.ts'
import {
  IngestionError,
  type DocxExtraction,
  type IngestedLocalDocument,
  type IngestionChunkInput,
  type IngestionInput,
  type LocalDocumentKind,
  type LocalDocumentParserPorts,
  type PdfExtraction,
  type SourceAuthority,
} from './types.ts'

const DECODER = new TextDecoder('utf-8', { fatal: false })
const SUPPORTED_EXTENSIONS: Readonly<Record<string, LocalDocumentKind>> = {
  '.pdf': 'pdf', '.docx': 'docx', '.tsv': 'tsv', '.txt': 'txt', '.md': 'md',
  '.markdown': 'md', '.csv': 'csv', '.json': 'json', '.html': 'html', '.htm': 'html',
}

/** Identify an accepted local document format from its filename only. */
export function localDocumentKind(fileName: string): LocalDocumentKind {
  const normalized = fileName.trim().toLocaleLowerCase()
  const extension = normalized.slice(normalized.lastIndexOf('.'))
  const kind = SUPPORTED_EXTENSIONS[extension]
  if (kind === undefined) throw new IngestionError('unsupported-format', `Unsupported local document format: ${fileName}`)
  return kind
}

/** Parse one local file into a SourceDocument and deterministic, cited semantic units. */
export async function ingestLocalDocument(
  input: IngestionInput,
  ports: LocalDocumentParserPorts = {},
  signal?: AbortSignal,
): Promise<IngestedLocalDocument> {
  assertInput(input)
  if (signal?.aborted) throw abortError()
  const kind = localDocumentKind(input.fileName)
  const documentId = input.documentId?.trim() || stableDocumentId(input.fileName, input.bytes)
  try {
    return kind === 'pdf'
      ? fromPdf(input, documentId, await requirePdf(ports).extract(input.bytes, signal))
      : kind === 'docx'
        ? fromDocx(input, documentId, await requireDocx(ports).extract(input.bytes, signal))
        : fromText(input, documentId, kind, decodeText(input.bytes))
  } catch (error: unknown) {
    if (error instanceof IngestionError || (error instanceof DOMException && error.name === 'AbortError')) throw error
    throw new IngestionError('malformed-document', `Unable to parse ${input.fileName}`, { cause: error })
  }
}

/** Content-addressed default ids make repeated selection of the same file an index upsert. */
export function stableDocumentId(fileName: string, bytes: Uint8Array): string {
  const digest = createHash('sha256').update(fileName).update('\0').update(bytes).digest('hex').slice(0, 32)
  return `local-file:${digest}`
}

function assertInput(input: IngestionInput): void {
  if (!input.fileName.trim()) throw new IngestionError('invalid-input', 'fileName must not be blank')
  if (input.bytes.byteLength === 0) throw new IngestionError('empty-document', `${input.fileName} is empty`)
  if (input.scope === 'conversation_summary' && !input.sessionId?.trim()) {
    throw new IngestionError('invalid-input', 'sessionId is required for conversation_summary ingestion')
  }
}

function requirePdf(ports: LocalDocumentParserPorts): NonNullable<LocalDocumentParserPorts['pdf']> {
  if (ports.pdf === undefined) throw new IngestionError('missing-parser', 'PDF ingestion needs a configured pure-JS PDF text extractor')
  return ports.pdf
}

function requireDocx(ports: LocalDocumentParserPorts): NonNullable<LocalDocumentParserPorts['docx']> {
  if (ports.docx === undefined) throw new IngestionError('missing-parser', 'DOCX ingestion needs a configured pure-JS DOCX text extractor')
  return ports.docx
}

function fromPdf(input: IngestionInput, documentId: string, extraction: PdfExtraction): IngestedLocalDocument {
  const pages = [...extraction.pages]
    .filter(page => Number.isSafeInteger(page.pageNumber) && page.pageNumber > 0)
    .sort((left, right) => left.pageNumber - right.pageNumber)
  if (pages.length === 0) throw new IngestionError('empty-document', `PDF ${input.fileName} has no extractable pages`)
  if (pages.some((page, index) => index > 0 && page.pageNumber === pages[index - 1]!.pageNumber)) {
    throw new IngestionError('malformed-document', `PDF ${input.fileName} repeats a page number`)
  }
  const titlePageText = normalizeText(pages[0]!.text)
  const title = preferredTitle(extraction.title, firstLine(titlePageText), input.fileName)
  const authority: SourceAuthority = {
    kind: 'pdf', fileName: input.fileName, documentTitle: title,
    ...cleanOptional(extraction.author, 'author'),
    ...cleanOptional(input.url, 'url'),
    titlePage: {
      pageNumber: pages[0]!.pageNumber,
      ...cleanOptional(firstLine(titlePageText), 'title'),
      text: clip(titlePageText, 1_000),
    },
  }
  const chunks = pages
    .map(page => ({ page, text: normalizeText(page.text) }))
    .filter(({ text }) => text.length > 0)
    .map(({ page, text }, order) => chunk(documentId, order, title, `Page ${String(page.pageNumber)}\n${text}`, authority, { pageNumber: page.pageNumber }))
  return complete(input, documentId, title, authority, chunks)
}

function fromDocx(input: IngestionInput, documentId: string, extraction: DocxExtraction): IngestedLocalDocument {
  const normalized = extraction.paragraphs
    .map((paragraph, index) => ({ paragraph, index, text: normalizeText(paragraph.text) }))
    .filter(({ text }) => text.length > 0)
  if (normalized.length === 0) throw new IngestionError('empty-document', `DOCX ${input.fileName} has no extractable paragraphs`)
  const titleParagraph = normalized.find(({ paragraph }) => isTitleStyle(paragraph.style))
  const title = preferredTitle(extraction.title, titleParagraph?.text, input.fileName)
  const authority: SourceAuthority = {
    kind: 'docx', fileName: input.fileName, documentTitle: title,
    ...cleanOptional(extraction.author, 'author'),
    ...cleanOptional(input.url, 'url'),
  }
  let heading: string | undefined
  const chunks = normalized.map(({ paragraph, index, text }, order) => {
    if (isHeadingStyle(paragraph.style)) heading = text
    return chunk(documentId, order, title, text, authority, {
      paragraphNumber: index + 1,
      ...heading === undefined ? {} : { heading },
    })
  })
  return complete(input, documentId, title, authority, chunks)
}

function fromText(input: IngestionInput, documentId: string, kind: Exclude<LocalDocumentKind, 'pdf' | 'docx'>, raw: string): IngestedLocalDocument {
  const text = normalizeByKind(raw, kind)
  if (!text) throw new IngestionError('empty-document', `${input.fileName} has no extractable text`)
  const title = preferredTitle(undefined, kind === 'md' ? markdownTitle(text) : undefined, input.fileName)
  const authority: SourceAuthority = {
    kind, fileName: input.fileName, documentTitle: title,
    ...cleanOptional(input.url, 'url'),
  }
  const chunks = kind === 'tsv' || kind === 'csv'
    ? tableChunks(documentId, title, text, authority, kind === 'tsv' ? '\t' : ',')
    : [chunk(documentId, 0, title, text, authority, {})]
  return complete(input, documentId, title, authority, chunks)
}

function complete(
  input: IngestionInput,
  documentId: string,
  title: string,
  authority: SourceAuthority,
  chunks: readonly IngestionChunkInput[],
): IngestedLocalDocument {
  if (chunks.length === 0) throw new IngestionError('empty-document', `${input.fileName} has no extractable text`)
  const sourceDocument: SourceDocument = {
    id: documentId,
    title,
    text: chunks.map(item => item.text).join('\n\n'),
    scope: input.scope,
    ...input.sessionId === undefined ? {} : { sessionId: input.sessionId },
    source: input.source?.trim() || authority.url || authority.fileName,
    authority,
    locator: chunks[0]!.locator,
    units: chunks.map(item => ({
      id: item.id,
      order: item.order,
      text: item.text,
      authority: item.authority,
      locator: item.locator,
    })),
    updatedAt: input.updatedAt ?? Date.now(),
  }
  return { kind: authority.kind, sourceDocument, authority, chunks }
}

function chunk(
  documentId: string,
  order: number,
  title: string,
  text: string,
  authority: SourceAuthority,
  locator: IngestionChunkInput['locator'],
): IngestionChunkInput {
  return { id: `${documentId}:unit:${String(order)}`, documentId, order, title, text, authority, locator }
}

function normalizeByKind(raw: string, kind: Exclude<LocalDocumentKind, 'pdf' | 'docx'>): string {
  try {
    if (kind === 'html') return htmlToText(raw)
    if (kind === 'json') return JSON.stringify(JSON.parse(raw), null, 2)
    return normalizeText(raw)
  } catch (error: unknown) {
    if (kind === 'json') throw new IngestionError('malformed-document', 'JSON document is not valid JSON', { cause: error })
    throw error
  }
}

function tableChunks(documentId: string, title: string, text: string, authority: SourceAuthority, separator: string): readonly IngestionChunkInput[] {
  const rows = parseDelimited(text, separator)
  if (rows.length < 2) throw new IngestionError('empty-document', `${authority.fileName} needs a header and at least one data row`)
  const header = rows[0]!.map(value => value.trim())
  if (header.every(value => !value)) throw new IngestionError('malformed-document', `${authority.fileName} has an empty table header`)
  const chunks: IngestionChunkInput[] = []
  for (const [rowOffset, row] of rows.slice(1).entries()) {
    if (!row.some(value => value.trim())) continue
    const rowNumber = rowOffset + 2
    const cells = header.map((name, index) => `${name}: ${row[index] ?? ''}`).join('\n')
    chunks.push(chunk(documentId, chunks.length, title, `Table header: ${header.join(' | ')}\nRow ${String(rowNumber)}\n${cells}`, authority, {
      rowNumber, header,
    }))
  }
  return chunks
}

/** Small deterministic CSV/TSV reader with quoted-cell support and no external runtime dependency. */
export function parseDelimited(raw: string, separator: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]!
    if (character === '"') {
      if (quoted && raw[index + 1] === '"') { cell += '"'; index += 1 } else quoted = !quoted
    } else if (!quoted && character === separator) {
      row.push(cell); cell = ''
    } else if (!quoted && (character === '\n' || character === '\r')) {
      if (character === '\r' && raw[index + 1] === '\n') index += 1
      row.push(cell); rows.push(row); row = []; cell = ''
    } else cell += character
  }
  if (quoted) throw new IngestionError('malformed-document', 'Delimited document has an unterminated quoted cell')
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row) }
  return rows
}

function decodeText(bytes: Uint8Array): string { return DECODER.decode(bytes).replace(/^\uFEFF/, '') }
function normalizeText(value: string): string { return value.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim() }
function preferredTitle(...values: Array<string | undefined>): string {
  return values.map(value => value?.trim()).find((value): value is string => Boolean(value)) ?? 'Untitled local document'
}
function firstLine(value: string): string | undefined { return value.split('\n').map(line => line.trim()).find(Boolean) }
function markdownTitle(value: string): string | undefined { return value.match(/^\s{0,3}#\s+(.+)$/m)?.[1]?.trim() }
function isTitleStyle(style: string | undefined): boolean { return /^(title|subtitle)$/i.test(style?.trim() ?? '') }
function isHeadingStyle(style: string | undefined): boolean { return /^(title|subtitle|heading(?:\s+\d+)?)$/i.test(style?.trim() ?? '') }
function clip(value: string, characters: number): string { return [...value].slice(0, characters).join('') }
function cleanOptional<Key extends 'author' | 'url' | 'title'>(value: string | undefined, key: Key): Partial<Record<Key, string>> {
  return value?.trim() ? { [key]: value.trim() } as Record<Key, string> : {}
}
function abortError(): DOMException { return new DOMException('Local document ingestion cancelled', 'AbortError') }

function htmlToText(html: string): string {
  const withoutUnsafe = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
  const blocks = withoutUnsafe.replace(/<\/?(?:p|div|section|article|h[1-6]|li|tr|br)[^>]*>/gi, '\n')
  return normalizeText(decodeHtmlEntities(blocks.replace(/<[^>]*>/g, '')))
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' }
  return value.replace(/&(amp|lt|gt|quot|nbsp);|&#39;|&#(\d+);|&#x([0-9a-f]+);/gi, (entity, _name, decimal, hex) => {
    if (named[entity.toLowerCase()] !== undefined) return named[entity.toLowerCase()]!
    const value = Number.parseInt(hex ?? decimal, hex === undefined ? 10 : 16)
    return Number.isSafeInteger(value) ? String.fromCodePoint(value) : entity
  })
}

export * from './types.ts'
export * from './parsers.ts'
