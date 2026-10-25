import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ANDROID = join(process.cwd(), 'android', 'app', 'src', 'main');
const read = (...parts: string[]): string => readFileSync(join(ANDROID, ...parts), 'utf8');

describe('the share sheet can read an export from the cache directory', () => {
  it('the file provider the Share plugin uses covers the cache directory', () => {
    const paths = read('res', 'xml', 'file_paths.xml');
    expect(paths).toMatch(/<cache-path\s+name="[^"]+"\s+path="\."\s*\/>/);
  });

  it('the manifest declares the provider with that path file, not exported, with URI grants', () => {
    const manifest = read('AndroidManifest.xml');
    expect(manifest).toContain('android:authorities="${applicationId}.fileprovider"');
    expect(manifest).toContain('androidx.core.content.FileProvider');
    expect(manifest).toContain('android:exported="false"');
    expect(manifest).toContain('android:grantUriPermissions="true"');
    expect(manifest).toContain('@xml/file_paths');
  });

  it('the Share plugin is a dependency of the app', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(pkg.dependencies['@capacitor/share']).toBeDefined();
    expect(pkg.dependencies['@capacitor/filesystem']).toBeDefined();
  });
});
