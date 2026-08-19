#!/usr/bin/env node
/**
 * dsh-app-electron — one-shot setup on a fresh machine.
 *
 *  1. installs dependencies (repo root workspace, app/, electron/)
 *  2. scaffolds ~/.dsh from scaffolds/ (credential-free: settings carry env
 *     VAR NAMES only; keys are never stored here)
 *  3. links packages/dsh-deepseek-chat into the web profile
 *  4. prints how to start and which env keys to provide
 *
 * Usage:
 *   node setup.js                 # full setup
 *   node setup.js --skip-install  # skip pnpm installs (deps already present)
 *   node setup.js --skip-profile  # skip web-profile dependency install
 */

'use strict'

const { execSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const REPO = __dirname
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const args = process.argv.slice(2)
const skipInstall = args.includes('--skip-install')
const skipProfile = args.includes('--skip-profile')

const run = (cmd, cwd) => {
  console.log(`\n$ ${cmd}  (in ${cwd})`)
  execSync(cmd, { cwd, stdio: 'inherit' })
}

function copyIfMissing(src, dest) {
  if (fs.existsSync(dest)) {
    console.log(`· keep ${path.relative(DSH_HOME, dest)} (exists)`)
    return
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(src, dest)
  console.log(`✓ ${path.relative(DSH_HOME, dest)}`)
}

function main() {
  console.log('=== dsh-app-electron setup ===')
  console.log(`repo:    ${REPO}`)
  console.log(`DSH_HOME: ${DSH_HOME}`)

  try { execSync('node --version', { stdio: 'ignore' }) } catch {
    console.error('✗ Node.js is required (nodejs.org)'); process.exit(1)
  }
  try { execSync('pnpm --version', { stdio: 'ignore' }) } catch {
    console.error('✗ pnpm is required (npm i -g pnpm)'); process.exit(1)
  }

  // 1. dependencies
  if (!skipInstall) {
    run('pnpm install', REPO)                    // workspace (packages/*)
    run('pnpm install', path.join(REPO, 'app'))  // @deepseek-ai/dsh + dsh-desktop-core
    run('pnpm install', path.join(REPO, 'electron')) // electron runtime
  } else {
    console.log('\n· skipping pnpm installs (--skip-install)')
  }

  // 2. scaffold ~/.dsh
  console.log('\n=== scaffolding DSH home (empty shell: official base only) ===')
  const sc = path.join(REPO, 'scaffolds')
  const profiles = path.join(DSH_HOME, 'profiles')

  copyIfMissing(path.join(sc, 'settings.yaml'), path.join(DSH_HOME, 'settings.yaml'))

  // web profile: official base bundles only — plugins are installed by the user
  const webPkgDest = path.join(profiles, 'web', 'package.json')
  if (!fs.existsSync(webPkgDest)) {
    fs.mkdirSync(path.dirname(webPkgDest), { recursive: true })
    fs.copyFileSync(path.join(sc, 'profiles', 'web', 'package.json'), webPkgDest)
    console.log('✓ profiles/web/package.json (official base only)')
  } else {
    console.log('· keep profiles/web/package.json (exists)')
  }
  copyIfMissing(path.join(sc, 'profiles', 'web', 'cordis.patch.yml'), path.join(profiles, 'web', 'cordis.patch.yml'))

  // desktop profile
  copyIfMissing(path.join(sc, 'profiles', 'desktop', 'package.json'), path.join(profiles, 'desktop', 'package.json'))
  copyIfMissing(path.join(sc, 'profiles', 'desktop', 'cordis.patch.yml'), path.join(profiles, 'desktop', 'cordis.patch.yml'))
  copyIfMissing(path.join(sc, 'profiles', 'desktop', 'micro-root.yml'), path.join(DSH_HOME, 'desktop', 'micro-root.yml'))

  // 3. web profile dependencies (fetches npm + github plugins)
  if (!skipProfile) {
    console.log('\n=== installing web profile plugins ===')
    run('pnpm install', path.join(profiles, 'web'))
  } else {
    console.log('\n· skipping web-profile install (--skip-profile)')
  }

  // 4. finish
  console.log('\n=== done ===')
  console.log('Start the desktop app:')
  console.log(`  cd ${REPO} && npm start`)
  console.log('  (electron/ holds main.js; the shell starts dsh web on :3080)')
  console.log('\nThis is an EMPTY shell — install your own plugins, e.g.:')
  console.log('  dsh plugin --profile web add dshmarket')
  console.log('  dsh plugin --profile web add github:Vingie1/dsh-deepseek-chat   # DeepSeek 快问 side window')
  console.log('\nEnvironment keys this setup expects (set them in your shell / .env):')
  console.log('  OPENCODE_GO_API_KEY   — model provider (llm-pi-ai.opencode-go)')
  console.log('  (any vision keys per installed vision plugins; see their docs)')
  console.log('\nSecrets are never scaffolded — configure them via the DSH UI (settings → models).')
}

main()
