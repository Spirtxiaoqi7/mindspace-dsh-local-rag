/** Production pure-JavaScript PDF and DOCX parser adapters. */

import type {
  DocxExtraction,
  DocxParagraph,
  LocalDocumentParserPorts,
  PdfExtraction,
  PdfPageText,
} from './types.ts'

export function createDefaultDocumentParserPorts(): LocalDocumentParserPorts {
  return {
    pdf: { extract: extractPdfWithPdfJs },
    docx: { extract: extractDocxWithMammoth },
  }
}

export async function extractPdfWithPdfJs(bytes: Uint8Array, signal?: AbortSignal): Promise<PdfExtraction> {
  throwIfAborted(signal)
  ensurePdfJsTextExtractionGlobals()
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  // PDF.js may transfer/detach the supplied ArrayBuffer; keep the caller's
  // immutable upload bytes intact for content-addressed ids and later rebuilds.
  const data = Uint8Array.from(bytes)
  const task = pdfjs.getDocument({ data, useSystemFonts: true, disableFontFace: true })
  let document: Awaited<typeof task.promise> | undefined
  const abort = () => { void task.destroy() }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    document = await task.promise
    const metadata = await document.getMetadata().catch(() => undefined)
    const info = metadata?.info as { Title?: unknown; Author?: unknown } | undefined
    const pages: PdfPageText[] = []
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      throwIfAborted(signal)
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      const pieces: string[] = []
      for (const item of content.items) {
        if (!('str' in item)) continue
        const value = String(item.str || '')
        if (value) pieces.push(value)
        if ('hasEOL' in item && item.hasEOL) pieces.push('\n')
        else if (value) pieces.push(' ')
      }
      pages.push({ pageNumber, text: pieces.join('').replace(/[ \t]+\n/g, '\n').trim() })
      page.cleanup()
    }
    return {
      ...textField(info?.Title, 'title'),
      ...textField(info?.Author, 'author'),
      pages,
    }
  } finally {
    signal?.removeEventListener('abort', abort)
    if (document !== undefined) await document.cleanup()
    await task.destroy()
  }
}

/**
 * PDF.js eagerly constructs one DOMMatrix for its optional canvas renderer,
 * even when this plugin only calls getTextContent(). Some pnpm deployments do
 * not materialize pdfjs-dist's optional native canvas binding. A six-value
 * matrix is sufficient for module initialization and the text-only path; real
 * browser/native implementations are never replaced.
 */
function ensurePdfJsTextExtractionGlobals(): void {
  if (typeof globalThis.DOMMatrix !== 'undefined') return
  class TextExtractionDOMMatrix {
    a = 1
    b = 0
    c = 0
    d = 1
    e = 0
    f = 0

    constructor(init?: string | readonly number[]) {
      if (Array.isArray(init)) [this.a, this.b, this.c, this.d, this.e, this.f] = [
        Number(init[0] ?? 1), Number(init[1] ?? 0), Number(init[2] ?? 0),
        Number(init[3] ?? 1), Number(init[4] ?? 0), Number(init[5] ?? 0),
      ]
    }
  }
  Object.defineProperty(globalThis, 'DOMMatrix', { configurable: true, value: TextExtractionDOMMatrix })
}

export async function extractDocxWithMammoth(bytes: Uint8Array, signal?: AbortSignal): Promise<DocxExtraction> {
  throwIfAborted(signal)
  const mammoth = await import('mammoth')
  const result = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) })
  throwIfAborted(signal)
  const paragraphs: DocxParagraph[] = []
  const matcher = /<(h[1-6]|p|li)(?:\s[^>]*)?>([\s\S]*?)<\/\1\s*>/gi
  for (const match of result.value.matchAll(matcher)) {
    const tag = match[1]!.toLocaleLowerCase()
    const text = htmlFragmentText(match[2]!)
    if (!text) continue
    paragraphs.push({
      text,
      style: tag === 'p' || tag === 'li' ? 'Normal' : `Heading ${tag.slice(1)}`,
    })
  }
  return {
    ...textField(paragraphs.find(item => item.style === 'Heading 1')?.text, 'title'),
    paragraphs,
  }
}

function htmlFragmentText(value: string): string {
  const blocks = value.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')
  return decodeEntities(blocks).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  return value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos|nbsp));/gi, (entity, decimal, hex, name) => {
    if (name) return named[String(name).toLocaleLowerCase()] ?? entity
    const codePoint = Number.parseInt(hex ?? decimal, hex === undefined ? 10 : 16)
    return Number.isSafeInteger(codePoint) ? String.fromCodePoint(codePoint) : entity
  })
}

function textField<Key extends 'title' | 'author'>(value: unknown, key: Key): Partial<Record<Key, string>> {
  return typeof value === 'string' && value.trim() ? { [key]: value.trim() } as Record<Key, string> : {}
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Document parsing cancelled', 'AbortError')
}
