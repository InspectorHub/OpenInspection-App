import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as asar from '@electron/asar';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkElectronPackage } from './check-electron-package.mjs';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(over: { archiveFiles?: Record<string, string>; nativeFiles?: string[]; helper?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'oi-package-check-'));
  roots.push(root);
  const app = join(root, 'win-unpacked');
  const resources = join(app, 'resources');
  const staging = join(root, 'staging');
  const helperBytes = Buffer.from('native helper test executable');
  const archiveFiles = {
    'package.json': JSON.stringify({ oiHeicHelperSha256: createHash('sha256').update(helperBytes).digest('hex') }),
    'dist-electron/main/index.cjs': 'main',
    'dist-electron/preload/index.cjs': 'preload',
    'dist-electron/renderer/index-electron.html': 'renderer',
    LICENSE: 'app license text',
    'THIRD_PARTY_NOTICES.txt': 'runtime notices',
    ...over.archiveFiles,
  };
  for (const [path, contents] of Object.entries(archiveFiles)) {
    const target = join(staging, path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, contents);
  }
  await mkdir(resources, { recursive: true });
  await asar.createPackage(staging, join(resources, 'app.asar'));
  await writeFile(join(app, 'InspectorHub.exe'), 'electron');
  const helperPath = join(resources, 'heic-helper', 'win-heic-helper.exe');
  if (over.helper !== false) {
    await mkdir(join(resources, 'heic-helper'), { recursive: true });
    await writeFile(helperPath, helperBytes);
  }
  for (const path of over.nativeFiles ?? []) {
    const target = join(resources, 'app.asar.unpacked', path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, 'native');
  }
  return { root, app, helperPath };
}

const options = (app: string, over: Partial<Parameters<typeof checkElectronPackage>[0]> = {}) => ({ packageRoot: app, runFuses: vi.fn(() => 'RunAsNode: Disabled\nEnableNodeOptionsEnvironmentVariable: Disabled\nEnableNodeCliInspectArguments: Disabled\nOnlyLoadAppFromAsar: Enabled\nEnableEmbeddedAsarIntegrityValidation: Enabled'), authenticode: vi.fn(() => 'NotSigned'), ...over });

describe('checkElectronPackage', () => {
  it('accepts the expected asar layout, Windows SQLite native module, helper hash and fuses', async () => {
    const value = await fixture({ nativeFiles: ['node_modules/better-sqlite3-multiple-ciphers/prebuilds/win32-x64.node'] });
    expect(checkElectronPackage(options(value.app))).toMatchObject({ nativeModules: 1, installers: 0 });
  });

  it('rejects the Plan E space-name package path and duplicated native dependencies', async () => {
    const value = await fixture({ archiveFiles: { 'node_modules/react/index.js': 'duplicate' } });
    expect(() => checkElectronPackage(options(value.app))).toThrow('electron-package:duplicate-renderer-dependencies');
  });

  it('rejects native modules for another OS or architecture', async () => {
    const value = await fixture({ nativeFiles: ['node_modules/better-sqlite3-multiple-ciphers/prebuilds/darwin-arm64/better_sqlite3.node'] });
    expect(() => checkElectronPackage(options(value.app))).toThrow('electron-package:foreign-native-module');
  });

  it('rejects a helper missing from the installed resource directory', async () => {
    const value = await fixture({ helper: false });
    expect(() => checkElectronPackage(options(value.app))).toThrow('electron-package:helper-location');
  });

  it('rejects a helper whose bytes do not match the asar metadata hash', async () => {
    const value = await fixture();
    await writeFile(value.helperPath, 'modified helper');
    expect(() => checkElectronPackage(options(value.app))).toThrow('electron-package:helper-hash');
  });

  it('rejects a package containing libheif WASM or HEVC license text', async () => {
    const value = await fixture({ archiveFiles: { 'third_party/libheif.wasm': 'decoder' } });
    expect(() => checkElectronPackage(options(value.app))).toThrow('electron-package:forbidden-codec-artifact');
  });

  it('rejects a bundled LGPL notice even when no decoder filename exposes it', async () => {
    const value = await fixture({ archiveFiles: { 'third_party/NOTICE.txt': 'GNU Lesser General Public License version 3' } });
    expect(() => checkElectronPackage(options(value.app))).toThrow('electron-package:forbidden-codec-license');
  });

  it('rejects an enabled unsafe fuse', async () => {
    const value = await fixture();
    expect(() => checkElectronPackage(options(value.app, { runFuses: () => 'RunAsNode: Enabled' }))).toThrow('electron-package:fuse-RunAsNode');
  });

  it('requires valid Authenticode in Azure signing mode', async () => {
    const value = await fixture();
    expect(() => checkElectronPackage(options(value.app, { signing: 'azure' }))).toThrow('electron-package:authenticode');
  });

  it('rejects a latest.yml path that does not match the actual setup filename', async () => {
    const value = await fixture();
    await writeFile(join(value.app, 'latest.yml'), 'path: InspectorHub Setup 0.1.1.exe\n');
    expect(() => checkElectronPackage(options(value.app))).toThrow('electron-package:latest-yml-path');
  });
});

describe('Windows electron-builder configuration', () => {
  it('pins the app identity, x64 NSIS layout, safe fuses, updater metadata and helper copy', async () => {
    const config = (await import('../electron/builder/electron-builder.config.mjs')).default;
    expect(config).toMatchObject({
      appId: 'io.inspectorhub.app',
      productName: 'InspectorHub',
      directories: { output: 'release-win' },
      npmRebuild: false,
      asarUnpack: ['node_modules/better-sqlite3-multiple-ciphers/prebuilds/**'],
      electronLanguages: ['en-US'],
      win: { target: [{ target: 'nsis', arch: ['x64'] }], icon: 'electron/builder/icon.png' },
      nsis: { oneClick: true, perMachine: false, deleteAppDataOnUninstall: false, artifactName: '${productName}-Setup-${version}.${ext}' },
      protocols: [{ name: 'InspectorHub sign-in', schemes: ['io.inspectorhub.app'] }],
      publish: { provider: 'github', owner: 'InspectorHub', repo: 'OpenInspection-App' },
      electronFuses: { runAsNode: false, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false, onlyLoadAppFromAsar: true, enableEmbeddedAsarIntegrityValidation: true },
      extraMetadata: { main: 'dist-electron/main/index.cjs', oiSigned: false },
    });
    expect(config.files).toContain('!node_modules/**');
    expect(config.files).toContain('node_modules/better-sqlite3-multiple-ciphers/prebuilds/win32-x64.node');
    expect(config.extraResources).toEqual([{ from: 'dist-electron/native/win-heic-helper.exe', to: 'heic-helper/win-heic-helper.exe' }]);
    expect(config.extraMetadata.oiHeicHelperSha256).toMatch(/^[a-f\d]{64}$/);
    expect(config.win).not.toHaveProperty('azureSignOptions');
    const icon = readFileSync(config.win.icon);
    expect(icon.readUInt32BE(16)).toBeGreaterThanOrEqual(512);
    expect(icon.readUInt32BE(20)).toBeGreaterThanOrEqual(512);
  });
});
