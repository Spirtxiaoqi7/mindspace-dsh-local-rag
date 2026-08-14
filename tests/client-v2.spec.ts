import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const sectionUrl = new URL('../src/client/LocalRagSection.tsx', import.meta.url)
const indexUrl = new URL('../src/client/index.ts', import.meta.url)

describe('local RAG settings v2', () => {
  it('uses the conversation-summary scope and keeps lexical search available without the vector runtime', async () => {
    const source = await readFile(sectionUrl, 'utf8')
    expect(source).toContain('value="conversation_summary"')
    expect(source).not.toContain("scope === 'current_session'")
    expect(source).not.toMatch(/disabled=\{[^}]*model\?\.ready/)
    expect(source).toContain('results.laneStatus')
    expect(source).toContain('results.partial')
  })

  it('accepts every supported file type and uploads through bounded chunks', async () => {
    const source = await readFile(sectionUrl, 'utf8')
    expect(source).toContain(".pdf,.docx,.tsv,.csv,.txt,.md,.json,.html")
    expect(source).toContain('multiple accept={ACCEPTED_FILES}')
    expect(source).toContain('UPLOAD_CHUNK_BYTES')
    expect(source).toContain('appendUploadChunk')
    expect(source).toContain('cancelUpload')
  })

  it('wires explicit model lifecycle and source locators', async () => {
    const [section, index] = await Promise.all([readFile(sectionUrl, 'utf8'), readFile(indexUrl, 'utf8')])
    for (const method of ['selectModel', 'downloadModel', 'cancelDownload', 'startModel', 'stopModel', 'setModelAutoStart']) {
      expect(index).toContain(`'${method}'`)
    }
    for (const locator of ['pageNumber', 'rowNumber', 'summaryAt', 'turn']) expect(section).toContain(locator)
  })

  it('reads source previews through the bounded Remote and never opens arbitrary file URLs', async () => {
    const [section, index] = await Promise.all([readFile(sectionUrl, 'utf8'), readFile(indexUrl, 'utf8')])
    expect(index).toContain("call('getSourcePreview', request)")
    expect(section).toContain('api.getSourcePreview')
    expect(section).toContain('sourceAddress')
    expect(section).toContain('hit.sourceUri')
    expect(section).toContain('hit.documentId')
    expect(section).toContain('navigator.clipboard.writeText')
    expect(section).toContain('nextCursor')
    expect(section).not.toContain('file://')
    expect(section).not.toContain('window.open(')
  })
})
