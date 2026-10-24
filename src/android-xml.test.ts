import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const RES_DIR = join(process.cwd(), 'android', 'app', 'src');

const xmlFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'build' ? [] : xmlFiles(path);
    return name.endsWith('.xml') ? [path] : [];
  });

/** XML forbids a double hyphen inside a comment; Gradle then fails at mergeDebugResources. */
const badComments = (xml: string): string[] =>
  [...xml.matchAll(/<!--([\s\S]*?)-->/g)].map((m) => m[1] ?? '').filter((body) => body.includes('--') || body.endsWith('-'));

describe('Android XML resources', () => {
  it('flags a comment that contains a double hyphen (control for the scan below)', () => {
    expect(badComments('<!-- field-ui --ih-bg-app -->')).toHaveLength(1);
    expect(badComments('<!-- the ih-bg-app token of field-ui -->')).toHaveLength(0);
  });

  it('has no comment with a double hyphen in any source resource or manifest', () => {
    const files = xmlFiles(RES_DIR);
    expect(files.length).toBeGreaterThan(5);
    const offenders = files.filter((file) => badComments(readFileSync(file, 'utf8')).length > 0);
    expect(offenders).toEqual([]);
  });
});
