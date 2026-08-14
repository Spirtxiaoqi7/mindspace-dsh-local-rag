import ts from 'typescript'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [{
    name: 'mindspace-lower-stage3-decorators',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?', 1)[0] ?? id
      if (!/\.[cm]?tsx?$/.test(file) || !/^\s*@[A-Za-z_$][\w$]*/m.test(code)) return
      const result = ts.transpileModule(code, {
        fileName: file,
        compilerOptions: {
          target: ts.ScriptTarget.ES2024,
          module: ts.ModuleKind.ESNext,
          ...(file.endsWith('x') ? { jsx: ts.JsxEmit.ReactJSX } : {}),
          sourceMap: true,
        },
      })
      return { code: result.outputText.replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'), map: result.sourceMapText }
    },
  }],
})
