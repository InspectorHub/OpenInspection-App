import { createHash } from 'node:crypto';
import { join } from 'node:path';

interface ReadFileLike {
  readFile(path: string): Promise<Uint8Array>;
}

interface HelperPathOptions {
  packaged: boolean;
  appPath: string;
  resourcesPath: string;
  developmentPath: string | undefined;
  envOverride: string | undefined;
  readFile: ReadFileLike['readFile'];
  log(code: string): void;
}

/** Resolves only a fixed packaged location; test paths are available only to unpackaged builds. */
export function createHeicHelperPathResolver(options: HelperPathOptions): () => Promise<string | null> {
  if (!options.packaged) {
    return async () => options.envOverride || options.developmentPath || null;
  }

  const helperPath = join(options.resourcesPath, 'heic-helper', 'win-heic-helper.exe');
  let resolved: Promise<string | null> | undefined;
  return async () => {
    resolved ??= (async () => {
      try {
        const [metadataBytes, helperBytes] = await Promise.all([
          options.readFile(join(options.appPath, 'package.json')),
          options.readFile(helperPath),
        ]);
        const metadata: unknown = JSON.parse(new TextDecoder().decode(metadataBytes));
        if (typeof metadata !== 'object' || metadata === null || !('oiHeicHelperSha256' in metadata)) {
          options.log('helper-hash-mismatch');
          return null;
        }
        const expected = metadata.oiHeicHelperSha256;
        const actual = createHash('sha256').update(helperBytes).digest('hex');
        if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/i.test(expected) || actual !== expected.toLowerCase()) {
          options.log('helper-hash-mismatch');
          return null;
        }
        return helperPath;
      } catch {
        options.log('helper-hash-mismatch');
        return null;
      }
    })();
    return resolved;
  };
}
