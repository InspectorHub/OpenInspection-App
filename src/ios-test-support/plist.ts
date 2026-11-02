export type PlistValue = string | boolean | (string | Map<string, PlistValue>)[] | Map<string, PlistValue>;

const TOKEN = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z]+)(?:\s[^>]*?)?\s*(\/?)>|([^<]+)/g;

const ENTITIES = new Map([['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"], ['amp', '&']]);

function decode(text: string): string {
  return text.replace(/&([^;\s]*);?/g, (whole, name: string) => {
    const known = whole.endsWith(';') ? ENTITIES.get(name) : undefined;
    if (known === undefined) throw new Error(`plist: unsupported entity ${whole}`);
    return known;
  });
}

interface Tok {
  kind: 'open' | 'close' | 'empty' | 'text';
  name: string;
  text: string;
}

function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  let end = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index !== end) throw new Error(`plist: unsupported construct at offset ${String(end)}`);
    end = m.index + m[0].length;
    if (m[4] !== undefined) {
      if (m[4].trim() !== '') out.push({ kind: 'text', name: '', text: decode(m[4]) });
    } else if (m[2] !== undefined) {
      const kind = m[1] === '/' ? 'close' : m[3] === '/' ? 'empty' : 'open';
      out.push({ kind, name: m[2], text: '' });
    }
  }
  if (end !== text.length) throw new Error(`plist: unsupported construct at offset ${String(end)}`);
  return out;
}

/**
 * Parse the top-level dict of an Info.plist or PrivacyInfo.xcprivacy into key -> value.
 * Supports string, true, false, array of strings or dicts, and nested dict; any other element throws
 * rather than being silently ignored.
 */
export function readPlist(text: string): Map<string, PlistValue> {
  const toks = tokenize(text);
  let pos = 0;
  const next = (): Tok => {
    const tok = toks[pos++];
    if (!tok) throw new Error('plist: unexpected end of input');
    return tok;
  };
  const expectClose = (name: string): void => {
    const tok = next();
    if (tok.kind !== 'close' || tok.name !== name) throw new Error(`plist: expected </${name}>`);
  };

  const value = (): PlistValue => {
    const tok = next();
    if (tok.kind === 'empty' && tok.name === 'true') return true;
    if (tok.kind === 'empty' && tok.name === 'false') return false;
    if (tok.kind === 'open' && tok.name === 'string') {
      const body = toks[pos];
      let result = '';
      if (body?.kind === 'text') {
        result = body.text;
        pos++;
      }
      expectClose('string');
      return result;
    }
    if (tok.kind === 'empty' && tok.name === 'string') return '';
    if (tok.kind === 'open' && tok.name === 'array') {
      const items: (string | Map<string, PlistValue>)[] = [];
      while (toks[pos]?.kind !== 'close') {
        const item = value();
        if (typeof item === 'boolean' || Array.isArray(item)) throw new Error('plist: only arrays of strings and dicts are supported');
        items.push(item);
      }
      expectClose('array');
      return items;
    }
    if (tok.kind === 'empty' && tok.name === 'array') return [];
    if (tok.kind === 'open' && tok.name === 'dict') return dict();
    if (tok.kind === 'empty' && tok.name === 'dict') return new Map();
    throw new Error(`plist: unsupported element <${tok.name}>`);
  };

  const dict = (): Map<string, PlistValue> => {
    const result = new Map<string, PlistValue>();
    while (toks[pos]?.kind !== 'close') {
      const key = next();
      if (key.kind !== 'open' || key.name !== 'key') throw new Error('plist: expected <key>');
      const name = next();
      if (name.kind !== 'text') throw new Error('plist: empty key');
      expectClose('key');
      if (result.has(name.text)) throw new Error(`plist: duplicate key ${name.text}`);
      result.set(name.text, value());
    }
    expectClose('dict');
    return result;
  };

  const root = next();
  if (root.kind !== 'open' || root.name !== 'plist') throw new Error('plist: missing <plist>');
  const top = next();
  if (top.kind !== 'open' || top.name !== 'dict') throw new Error('plist: top level must be a dict');
  return dict();
}
