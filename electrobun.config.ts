/* eslint-disable import/no-default-export */

import {readFileSync} from 'node:fs'

import type {ElectrobunConfig} from 'electrobun'

const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {version?: string}

export default {
  app: {
    identifier: 'ai.forska.desktop',
    name: 'Forska',
    version: typeof packageJson.version === 'string' ? packageJson.version : '0.0.0',
  },
  build: {
    artifactFolder: 'desktopArtifacts',
    buildFolder: 'desktopBuild',
    bun: {entrypoint: 'src/desktop/index.ts'},
    copy: {src: 'src', 'dist/assets': 'views/mainview/assets', 'dist/index.html': 'views/mainview/index.html'},
    watchIgnore: ['dist/**', 'desktopArtifacts/**', 'desktopBuild/**'],
  },
} satisfies ElectrobunConfig
