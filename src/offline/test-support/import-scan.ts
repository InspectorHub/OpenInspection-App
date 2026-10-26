import ts from 'typescript';

/** One module reference found in a source file. `names` is `'*'` when the syntax cannot say which exports are used. */
export interface ImportRef {
  /** The specifier exactly as written, or `<non-literal>` for a dynamic import or require whose argument is not a plain string. */
  specifier: string;
  names: string[] | '*';
  kind: 'import' | 'import-type' | 'export-from' | 'dynamic-import' | 'require' | 'import-equals';
}

const STAR = '*' as const;
const UNREADABLE = '<non-literal>';

function literalText(node: ts.Node | undefined): string | null {
  return node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
}

function importedNames(clause: ts.ImportClause | undefined): string[] | '*' {
  if (clause === undefined) return [];
  if (clause.name !== undefined) return STAR;
  const bindings = clause.namedBindings;
  if (bindings === undefined) return [];
  if (ts.isNamespaceImport(bindings)) return STAR;
  return bindings.elements.map((element) => (element.propertyName ?? element.name).text);
}

/**
 * Every module a source file refers to, whatever the syntax: `import x`, `import * as`, `import type`, named imports,
 * `export { } from` / `export * from`, `import('x')`, `require('x')`, `import x = require('x')` and `import('x').T` types.
 * Parsed with the TypeScript compiler, so quotes, line breaks and comments cannot hide a reference, and text inside a
 * comment or a string is never mistaken for one.
 */
export function scanImports(fileName: string, text: string): ImportRef[] {
  const kind = fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const refs: ImportRef[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      refs.push({ specifier: literalText(node.moduleSpecifier) ?? UNREADABLE, names: importedNames(node.importClause), kind: 'import' });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      const clause = node.exportClause;
      const names = clause !== undefined && ts.isNamedExports(clause) ? clause.elements.map((element) => (element.propertyName ?? element.name).text) : STAR;
      refs.push({ specifier: literalText(node.moduleSpecifier) ?? UNREADABLE, names, kind: 'export-from' });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      refs.push({ specifier: literalText(node.moduleReference.expression) ?? UNREADABLE, names: STAR, kind: 'import-equals' });
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      refs.push({ specifier: ts.isLiteralTypeNode(argument) ? (literalText(argument.literal) ?? UNREADABLE) : UNREADABLE, names: STAR, kind: 'import-type' });
    } else if (ts.isCallExpression(node)) {
      const isDynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamic || isRequire) refs.push({ specifier: literalText(node.arguments[0]) ?? UNREADABLE, names: STAR, kind: isDynamic ? 'dynamic-import' : 'require' });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return refs;
}
