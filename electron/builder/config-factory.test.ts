import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createElectronBuilderConfig } from './config-factory.mjs';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function helper() {
  const root = await mkdtemp(join(tmpdir(), 'oi-builder-config-'));
  roots.push(root);
  const helperPath = join(root, 'win-heic-helper.exe');
  await writeFile(helperPath, 'helper');
  return helperPath;
}

describe('createElectronBuilderConfig update feed', () => {
  it('keeps the GitHub release feed by default', async () => {
    const config = createElectronBuilderConfig({ helperPath: await helper(), updateFeedUrl: undefined });
    expect(config.publish).toEqual({ provider: 'github', owner: 'InspectorHub', repo: 'OpenInspection-App' });
  });

  it('switches to a generic feed for a loopback rehearsal URL', async () => {
    for (const url of ['http://127.0.0.1:4545/', 'http://localhost:4545/feed/', 'https://127.0.0.1:4545/']) {
      const config = createElectronBuilderConfig({ helperPath: await helper(), updateFeedUrl: url });
      expect(config.publish).toEqual({ provider: 'generic', url });
    }
  });

  it('refuses anything that is not an http(s) loopback URL', async () => {
    const helperPath = await helper();
    for (const url of ['https://updates.example.com/', 'http://192.168.1.5:4545/', 'http://127.0.0.1.evil.test/', 'http://user:pw@127.0.0.1/', 'file:///C:/feed/', 'ftp://127.0.0.1/', 'not a url']) {
      expect(() => createElectronBuilderConfig({ helperPath, updateFeedUrl: url }), url).toThrow(/OI_UPDATE_FEED_URL/);
    }
  });
});

describe('NSIS uninstall cleanup of the protocol key', () => {
  it('references the include and the include only deletes the key when the command points into the install directory', async () => {
    const config = createElectronBuilderConfig({ helperPath: await helper(), updateFeedUrl: undefined });
    expect(config.nsis.include).toBe('electron/builder/installer.nsh');
    const script = await readFile(join(process.cwd(), config.nsis.include), 'utf8');
    expect(script).toContain('!macro customUnInstall');
    expect(script).toContain(String.raw`ReadRegStr $R8 HKCU "Software\Classes\io.inspectorhub.app\shell\open\command"`);
    expect(script).toContain(String.raw`StrCpy $R9 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'`);
    expect(script).toContain('${andIf} $R6 == $R9');
    expect(script).toContain('${ifNot} ${isUpdated}');
    const deleteAt = script.indexOf(String.raw`DeleteRegKey HKCU "Software\Classes\io.inspectorhub.app"`);
    expect(deleteAt).toBeGreaterThan(script.indexOf('${andIf} $R6 == $R9'));
    expect(script).not.toMatch(/MessageBox/);
  });
});
