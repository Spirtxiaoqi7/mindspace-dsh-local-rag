import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

describe('runtime package gate', () => {
  it('declares and verifies the Node ONNX runtime required by Transformers.js', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      scripts: Record<string, string>
    }
    const verifier = readFileSync(resolve(root, 'scripts/verify-runtime-deps.mjs'), 'utf8')

    expect(manifest.dependencies['onnxruntime-node']).toBe('1.24.3')
    expect(manifest.scripts.postinstall).toBe('node scripts/verify-runtime-deps.mjs')
    expect(verifier).toContain("'onnxruntime-node'")
    expect(verifier).toContain("'pdfjs-dist/legacy/build/pdf.mjs'")
    expect(verifier).toContain("'mammoth'")
  })
})
