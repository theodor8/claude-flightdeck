#!/usr/bin/env node
// Runs the Flightdeck viewer, rebuilding it first whenever its sources or the mod's own hooks are
// newer than the last build (after a `git pull` from upstream, say). `--build` only builds.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const viewer = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = join(viewer, '..')
const out = join(viewer, 'dist', 'flightdeck.mjs')
const sources = [join(viewer, 'src'), join(repo, 'hooks'), join(repo, 'types')]

const newest = () => Math.max(...sources.flatMap(d => readdirSync(d).map(f => statSync(join(d, f)).mtimeMs)))
const onlyBuild = process.argv.includes('--build')

if (onlyBuild || !existsSync(out) || newest() > statSync(out).mtimeMs) {
  const { build } = await import('esbuild')
  await build({
    entryPoints: [join(viewer, 'src', 'main.tsx')],
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'external',
    jsx: 'transform',
    jsxFactory: 'h',
    // The repo's tsconfig extends one Claude Code writes on load; the viewer needs none of it.
    tsconfigRaw: '{}',
    alias: { 'claude-code': join(viewer, 'src', 'claude-code-shim.ts') },
    logLevel: 'warning',
  })
}

if (!onlyBuild) {
  // React's production build: no development warnings drawn over the window.
  process.env.NODE_ENV ??= 'production'
  await import(out)
}
