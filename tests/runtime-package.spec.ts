import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

describe('runtime package gate', () => {
  it('declares the Node ONNX runtime without requiring a package postinstall hook', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      scripts: Record<string, string>
    }
    const verifier = readFileSync(resolve(root, 'scripts/verify-runtime-deps.mjs'), 'utf8')

    expect(manifest.dependencies['onnxruntime-node']).toBe('1.24.3')
    expect(manifest.scripts.postinstall).toBeUndefined()
    expect(verifier).toContain("'onnxruntime-node'")
    expect(verifier).toContain("'pdfjs-dist/legacy/build/pdf.mjs'")
    expect(verifier).toContain("'mammoth'")
  })

  it('pins the DSH 0.1.1 compatibility floor', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      version: string
      peerDependencies: Record<string, string>
    }
    expect(manifest.version).toBe('0.3.7')
    for (const [name, range] of Object.entries(manifest.peerDependencies)) {
      if (name.startsWith('@deepseek-ai/dsh-')) expect(range).toBe('>=0.1.1-rc.2 <0.2.0')
    }
  })
})
