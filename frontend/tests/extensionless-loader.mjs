/**
 * 验证专用 ESM loader：让 Node 能解析 TypeScript 编译产物里的无扩展名相对导入
 * （业务源码沿用 Vite 的无扩展名风格，不在源码里写 .js 后缀）。
 */
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[cm]?js$/.test(specifier)) {
    const base = context.parentURL ? fileURLToPath(context.parentURL) : process.cwd()
    const candidates = [specifier, `${specifier}.js`, `${specifier}/index.js`]
    for (const candidate of candidates) {
      const url = new URL(candidate, pathToFileURL(base))
      if (existsSync(fileURLToPath(url))) {
        return nextResolve(url.href, context)
      }
    }
  }
  return nextResolve(specifier, context)
}
