import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import config from '../capacitor.config';

const read = (name: string): string => readFileSync(join(process.cwd(), name), 'utf8');
const pkg = JSON.parse(read('package.json')) as { dependencies: Record<string, string> };

describe('edge to edge and the system bars', () => {
  it('lets the page draw under the bars and puts the insets in the page (css handling)', () => {
    expect(read('index.html')).toMatch(/viewport-fit=cover/);
    expect(config.plugins?.SystemBars).toEqual({ insetsHandling: 'css' });
  });

  it('pads the screen frame with all four insets, from the plugin variables with env() as the fallback', () => {
    const css = read('src/styles.css');
    const utility = /@utility safe-pad\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    for (const side of ['top', 'bottom', 'left', 'right']) {
      expect(utility).toContain(`padding-${side}:`);
      expect(utility).toContain(`var(--safe-area-inset-${side}, env(safe-area-inset-${side}`);
    }
  });

  it('every screen frame uses the padded frame (control: the pattern is what the page shell is built on)', () => {
    expect(read('src/ui/kit.tsx')).toContain('safe-pad');
  });

  it('follows the colour scheme of the system for the bars through the plugin', () => {
    expect(read('src/main.tsx')).toMatch(/followSystemColorScheme\([\s\S]*?createSystemBarsSync\(SystemBars\)/);
  });
});

describe('keyboard', () => {
  it('shrinks the web view when the keyboard opens, so an input is never behind it', () => {
    expect(config.plugins?.Keyboard).toMatchObject({ resize: 'native', resizeOnFullScreen: true });
    expect(pkg.dependencies['@capacitor/keyboard']).toBeDefined();
  });
});

describe('fonts', () => {
  it('uses the system font stack for the display and the body face, after the theme is imported', () => {
    const css = read('src/styles.css');
    const theme = css.indexOf("@import '@inspectorhub/field-ui/theme.css'");
    const override = /@theme\s*\{([^}]*)\}/.exec(css);
    expect(theme).toBeGreaterThan(-1);
    expect(override).not.toBeNull();
    expect(css.indexOf(override?.[0] ?? '')).toBeGreaterThan(theme);
    expect(override?.[1]).toMatch(/--font-ih-display:\s*system-ui/);
    expect(override?.[1]).toMatch(/--font-ih-body:\s*system-ui/);
  });
});

describe('plugins the platform details rely on', () => {
  it('haptics and the notification permission come from the official Capacitor plugins at the Capacitor 8 line', () => {
    expect(pkg.dependencies['@capacitor/haptics']).toMatch(/^\^8\./);
    expect(pkg.dependencies['@capacitor/local-notifications']).toMatch(/^\^8\./);
  });

  it('adds no push service: the notification is only the upload one, so no Firebase-backed plugin belongs here', () => {
    expect(Object.keys(pkg.dependencies).filter((name) => /push-notifications|firebase/i.test(name))).toEqual([]);
  });
});

describe('dates', () => {
  it('has no date field yet: the editor will need a native date input (type="date") when it arrives', () => {
    const files = ['src/ui/ServerSetup.tsx', 'src/ui/SignIn.tsx', 'src/ui/Settings.tsx', 'src/ui/ExportFlow.tsx'].map(read).join('\n');
    expect(files).not.toMatch(/type="(date|time|datetime-local)"/);
  });
});
