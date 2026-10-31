import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Local update rehearsals only: OI_UPDATE_FEED_URL switches publish to a generic feed. Loopback http(s) only, so a
// release build can never point at a stray feed. Unset (the default) keeps the GitHub release feed.
export function resolveUpdateFeedUrl(value) {
  if (value === undefined || value === '') return undefined;
  let url;
  try { url = new URL(value); } catch { throw new Error('OI_UPDATE_FEED_URL must be a valid URL.'); }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !loopback || url.username !== '' || url.password !== '') {
    throw new Error('OI_UPDATE_FEED_URL must be an http(s) loopback URL (127.0.0.1 or localhost).');
  }
  return url.href;
}

export function createElectronBuilderConfig({ helperPath = join(process.cwd(), 'dist-electron', 'native', 'win-heic-helper.exe'), updateFeedUrl = process.env.OI_UPDATE_FEED_URL } = {}) {
  const feedUrl = resolveUpdateFeedUrl(updateFeedUrl);
  const helperHash = createHash('sha256').update(readFileSync(helperPath)).digest('hex');
  const signing = process.env.OI_WINDOWS_SIGNING ?? 'none';
  if (signing !== 'none' && signing !== 'azure') throw new Error('OI_WINDOWS_SIGNING must be none or azure.');

  return {
  appId: 'io.inspectorhub.app',
  productName: 'InspectorHub',
  directories: { output: 'release-win' },
  npmRebuild: false,
  asar: true,
  asarUnpack: ['node_modules/better-sqlite3-multiple-ciphers/prebuilds/**'],
  files: [
    '!node_modules/**',
    'package.json',
    'LICENSE',
    'THIRD_PARTY_NOTICES.txt',
    'dist-electron/**/*',
    'node_modules/better-sqlite3-multiple-ciphers/package.json',
    'node_modules/better-sqlite3-multiple-ciphers/lib/**/*',
    'node_modules/better-sqlite3-multiple-ciphers/prebuilds/win32-x64.node',
    '!node_modules/better-sqlite3-multiple-ciphers/prebuilds/linux-*',
    '!node_modules/better-sqlite3-multiple-ciphers/prebuilds/darwin-*',
    '!node_modules/better-sqlite3-multiple-ciphers/prebuilds/win32-arm64*',
  ],
  extraResources: [{ from: 'dist-electron/native/win-heic-helper.exe', to: 'heic-helper/win-heic-helper.exe' }, { from: 'electron/builder/icon.png', to: 'icon.png' }],
  electronLanguages: ['en-US'],
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'electron/builder/icon.ico',
    // The Azure job signs this helper before electron-builder reads the helper hash into app.asar.
    // Keep the already-signed bytes intact while still signing the main app and NSIS installer.
    signExts: ['!win-heic-helper.exe'],
    ...(signing === 'azure' ? {
      azureSignOptions: {
        endpoint: process.env.AZURE_SIGNING_ENDPOINT,
        codeSigningAccountName: process.env.AZURE_SIGNING_ACCOUNT,
        certificateProfileName: process.env.AZURE_SIGNING_PROFILE,
        publisherName: process.env.WINDOWS_PUBLISHER_NAME,
      },
    } : {}),
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    deleteAppDataOnUninstall: false,
    artifactName: '${productName}-Setup-${version}.${ext}',
    include: 'electron/builder/installer.nsh',
  },
  protocols: [{ name: 'InspectorHub sign-in', schemes: ['io.inspectorhub.app'] }],
  publish: feedUrl ? { provider: 'generic', url: feedUrl } : { provider: 'github', owner: 'InspectorHub', repo: 'OpenInspection-App' },
  extraMetadata: {
    main: 'dist-electron/main/index.cjs',
    oiSigned: signing === 'azure',
    oiHeicHelperSha256: helperHash,
  },
  electronFuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    onlyLoadAppFromAsar: true,
    enableEmbeddedAsarIntegrityValidation: true,
  },
  };
}
