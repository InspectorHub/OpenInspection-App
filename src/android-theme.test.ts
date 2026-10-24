import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (name: string): string => readFileSync(join(process.cwd(), name), 'utf8');

/** The `--ih-bg-app` of the theme block whose selector starts with `selector`. */
function themeAppBackground(selector: string): string {
  const css = read('node_modules/@inspectorhub/field-ui/dist/theme.css');
  const start = css.indexOf(`\n${selector}`);
  expect(start, selector).toBeGreaterThan(-1);
  const match = /--ih-bg-app:\s*(#[0-9a-fA-F]{6})/.exec(css.slice(start));
  expect(match, selector).not.toBeNull();
  return (match?.[1] ?? '').toLowerCase();
}

function colorValue(file: string, name: string): string {
  const match = new RegExp(`<color name="${name}">(#[0-9a-fA-F]{6})</color>`).exec(read(file));
  return (match?.[1] ?? '').toLowerCase();
}

describe('Android window background', () => {
  it('is the app background in both schemes, so the system bars blend in', () => {
    expect(colorValue('android/app/src/main/res/values/colors.xml', 'app_background')).toBe(themeAppBackground(':root'));
    expect(colorValue('android/app/src/main/res/values-night/colors.xml', 'app_background')).toBe(themeAppBackground('html[data-color-scheme="dark"]'));
  });

  it('is what the activity theme paints behind the bars', () => {
    const styles = read('android/app/src/main/res/values/styles.xml');
    const theme = /<style name="AppTheme\.NoActionBar"[\s\S]*?<\/style>/.exec(styles)?.[0] ?? '';
    expect(theme).toContain('<item name="android:windowBackground">@color/app_background</item>');
  });

  it('is also painted by the page itself on the html element, behind the bars on a WebView that draws edge to edge', () => {
    expect(read('src/styles.css')).toMatch(/html\s*\{[^}]*background-color:\s*var\(--ih-bg-app\)/);
  });
});
