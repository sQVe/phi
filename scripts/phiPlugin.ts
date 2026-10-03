import { existsSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ESTree, Plugin, Scope, Variable } from '@oxlint/plugins';

interface ModuleLocation {
  module: string;
  entry: boolean;
  directory: boolean;
}

type ImportSource =
  | ESTree.ImportDeclaration
  | ESTree.ExportNamedDeclaration
  | ESTree.ExportAllDeclaration;

const folderModules = new Set(['vt', 'rows', 'store', 'protocol', 'server', 'client', 'ui']);
const flatModules = new Set(['ids', 'invariant', 'layout', 'index']);

const allowedImports = new Map<string, Set<string>>([
  ['ids', new Set()],
  ['invariant', new Set()],
  ['vt', new Set(['invariant'])],
  ['rows', new Set(['ids', 'invariant'])],
  ['layout', new Set(['ids', 'invariant'])],
  ['store', new Set(['ids', 'invariant', 'layout'])],
  ['protocol', new Set(['ids', 'invariant', 'rows'])],
  ['server', new Set(['ids', 'invariant', 'vt', 'rows', 'layout', 'store', 'protocol'])],
  ['client', new Set(['ids', 'invariant', 'rows', 'protocol'])],
  ['ui', new Set(['ids', 'invariant', 'client'])],
  ['index', new Set([...folderModules, ...flatModules])],
]);

const typeOnlyImports = new Map([['protocol', new Set(['store'])]]);
const runtimeModules = new Set(['ids', 'invariant', 'rows', 'layout', 'store']);

const rendererFreeModules = new Set([
  'ids',
  'invariant',
  'vt',
  'rows',
  'layout',
  'store',
  'protocol',
  'server',
  'client',
]);

const packageRoots = new Map<string, string | undefined>();

// The nearest package.json marks the root, so a `src` segment above it never counts.
const packageRootOf = (directory: string): string | undefined => {
  if (packageRoots.has(directory)) {
    return packageRoots.get(directory);
  }

  const parent = dirname(directory);
  let root: string | undefined = directory;

  if (!existsSync(join(directory, 'package.json'))) {
    root = parent === directory ? undefined : packageRootOf(parent);
  }

  packageRoots.set(directory, root);

  return root;
};

const escapesDirectory = (path: string): boolean =>
  path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path);

const sourceDirectoryOf = (filename: string): string | undefined => {
  const root = packageRootOf(dirname(filename));

  return root === undefined ? undefined : join(root, 'src');
};

// Returns the path relative to `src/`, or `undefined` for a file outside it.
const sourcePathOf = (filename: string): string | undefined => {
  const sourceDirectory = sourceDirectoryOf(filename);

  if (sourceDirectory === undefined) {
    return undefined;
  }

  const path = relative(sourceDirectory, filename);

  return escapesDirectory(path) ? undefined : path;
};

const isTestFile = (filename: string): boolean => /\.test\.tsx?$/.test(filename);

const locate = (path: string): ModuleLocation | undefined => {
  const segments = path.replace(/\.[jt]sx?$/, '').split(sep);
  const [first = '', second] = segments;
  const flatModule = first.replace(/\.test$/, '');

  if (segments.length === 1 && flatModules.has(flatModule)) {
    return { module: flatModule, entry: first === flatModule, directory: false };
  }

  if (!folderModules.has(first)) {
    return undefined;
  }

  const entry = segments.length === 2 && second === first;

  return { module: first, entry, directory: segments.length === 1 };
};

const filePathOf = (url: string): string | undefined => {
  try {
    return fileURLToPath(url);
  } catch {
    return undefined;
  }
};

// Returns `undefined` for a package name and `null` for a file URL that names no local path.
const localPathOf = (specifier: string, directory: string): string | null | undefined => {
  if (/^file:/i.test(specifier)) {
    return filePathOf(specifier) ?? null;
  }

  if (!specifier.startsWith('.') && !isAbsolute(specifier)) {
    return undefined;
  }

  return resolve(directory, specifier);
};

const isRuntimeBuiltin = (specifier: string): boolean => {
  const bunBuiltin = specifier === 'bun' || specifier.startsWith('bun:');

  return bunBuiltin || specifier.startsWith('node:') || isBuiltin(specifier);
};

const isRendererPackage = (specifier: string): boolean =>
  specifier === 'react' || specifier.startsWith('react/') || specifier.startsWith('@opentui/');

const packageBoundary = (
  importer: string,
  specifier: string,
  testFile: boolean,
): string | undefined => {
  const testRunner = testFile && specifier === 'bun:test';

  if (runtimeModules.has(importer) && !testRunner && isRuntimeBuiltin(specifier)) {
    return 'builtin';
  }

  return rendererFreeModules.has(importer) && isRendererPackage(specifier) ? 'renderer' : undefined;
};

const moduleBoundary = (
  importer: string,
  target: ModuleLocation,
  typeOnly: boolean,
): string | undefined => {
  if (target.directory) {
    return 'directory';
  }

  if (target.module === importer) {
    return undefined;
  }

  if (!target.entry) {
    return 'private';
  }

  if (allowedImports.get(importer)?.has(target.module) === true) {
    return undefined;
  }

  if (typeOnlyImports.get(importer)?.has(target.module) !== true) {
    return 'module';
  }

  return typeOnly ? undefined : 'typeOnly';
};

const isTypeOnly = (node: ImportSource): boolean => {
  if (node.type === 'ExportAllDeclaration') {
    return node.exportKind === 'type';
  }

  if (node.type === 'ExportNamedDeclaration') {
    const typeSpecifiers =
      node.specifiers.length > 0 &&
      node.specifiers.every((specifier) => specifier.exportKind === 'type');

    return node.exportKind === 'type' || typeSpecifiers;
  }

  const typeSpecifiers =
    node.specifiers.length > 0 &&
    node.specifiers.every(
      (specifier) => specifier.type === 'ImportSpecifier' && specifier.importKind === 'type',
    );

  return node.importKind === 'type' || typeSpecifiers;
};

const literalSourceOf = (source: ESTree.Expression): string | undefined => {
  if (source.type === 'Literal' && typeof source.value === 'string') {
    return source.value;
  }

  if (source.type !== 'TemplateLiteral' || source.expressions.length > 0) {
    return undefined;
  }

  return source.quasis[0]?.value.cooked ?? undefined;
};

const disposeSymbols = new Set(['dispose', 'asyncDispose']);

const isSymbolDispose = (key: ESTree.PropertyKey): boolean => {
  if (key.type !== 'MemberExpression' || key.computed) {
    return false;
  }

  const symbolObject = key.object.type === 'Identifier' && key.object.name === 'Symbol';

  return symbolObject && disposeSymbols.has(key.property.name);
};

const isDisposeKey = (member: ESTree.MethodDefinition): boolean => {
  if (member.computed) {
    return isSymbolDispose(member.key);
  }

  return member.key.type === 'Identifier' && member.key.name === 'dispose';
};

const isDisposeMethod = (member: ESTree.ClassElement): boolean => {
  if (member.type !== 'MethodDefinition') {
    return false;
  }

  const instanceMethod = member.kind === 'method' && !member.static;

  return instanceMethod && isDisposeKey(member);
};

const rootIdentifierOf = (expression: ESTree.Expression): string | undefined => {
  if (expression.type === 'Identifier') {
    return expression.name;
  }

  return expression.type === 'MemberExpression' ? rootIdentifierOf(expression.object) : undefined;
};

const variableOf = (scope: Scope | null, name: string): Variable | undefined =>
  scope === null ? undefined : (scope.set.get(name) ?? variableOf(scope.upper, name));

const importSourceOf = (variable: Variable | undefined): string | undefined => {
  const [definition] = variable?.defs ?? [];

  if (definition?.type !== 'ImportBinding') {
    return undefined;
  }

  return definition.parent?.type === 'ImportDeclaration'
    ? definition.parent.source.value
    : undefined;
};

const phiPlugin: Plugin = {
  meta: { name: 'phi' },
  rules: {
    'module-boundaries': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          unknownFile: 'File "{{file}}" is not in a known module. Move it into one.',
          unknownTarget:
            'Module "{{importer}}" imports "{{target}}", which is not in a known module.',
          escape: 'Module "{{importer}}" imports "{{target}}", which is outside src/.',
          directory:
            'Module "{{importer}}" imports the directory "{{target}}". Import its entry file.',
          private:
            'Module "{{importer}}" imports "{{target}}", a private file of another module. Import its entry file.',
          module:
            'Module "{{importer}}" may not import "{{target}}": the module table refuses that edge.',
          typeOnly:
            'Module "{{importer}}" may import only types from "{{target}}". Use `import type`.',
          builtin: 'Module "{{importer}}" must not import the runtime built-in "{{target}}".',
          renderer: 'Module "{{importer}}" must not import the renderer package "{{target}}".',
          dynamic:
            'Module "{{importer}}" has a computed dynamic import or `require()`. Use a string literal so its boundary can be checked.',
        },
      },
      create(context) {
        const filename = context.physicalFilename;
        const sourceDirectory = sourceDirectoryOf(filename);

        if (sourceDirectory === undefined) {
          return {};
        }

        const path = relative(sourceDirectory, filename);

        if (escapesDirectory(path)) {
          return {};
        }

        // A file named after a folder module, such as `src/session.ts`, sits outside that folder.
        const location = locate(path);
        const importer = location?.directory === false ? location.module : undefined;

        if (importer === undefined) {
          return {
            Program(node) {
              context.report({ node, messageId: 'unknownFile', data: { file: path } });
            },
          };
        }

        const testFile = isTestFile(filename);

        const boundaryOf = (specifier: string, typeOnly: boolean): string | undefined => {
          const localPath = localPathOf(specifier, dirname(filename));

          if (localPath === undefined) {
            return packageBoundary(importer, specifier, testFile);
          }

          if (localPath === null) {
            return 'unknownTarget';
          }

          const targetPath = relative(sourceDirectory, localPath);

          if (escapesDirectory(targetPath)) {
            return 'escape';
          }

          const target = locate(targetPath);

          return target === undefined
            ? 'unknownTarget'
            : moduleBoundary(importer, target, typeOnly);
        };

        const check = (source: ESTree.StringLiteral, typeOnly: boolean) => {
          const messageId = boundaryOf(source.value, typeOnly);

          if (messageId !== undefined) {
            context.report({ node: source, messageId, data: { importer, target: source.value } });
          }
        };

        const checkSource = (node: ImportSource) => {
          if (node.source !== null) {
            check(node.source, isTypeOnly(node));
          }
        };

        const checkLoaded = (node: ESTree.Node, source: ESTree.Argument) => {
          const specifier = source.type === 'SpreadElement' ? undefined : literalSourceOf(source);

          if (specifier === undefined) {
            context.report({ node, messageId: 'dynamic', data: { importer } });

            return;
          }

          const messageId = boundaryOf(specifier, false);

          if (messageId !== undefined) {
            context.report({ node, messageId, data: { importer, target: specifier } });
          }
        };

        return {
          ImportDeclaration: checkSource,
          ExportNamedDeclaration: checkSource,
          ExportAllDeclaration: checkSource,
          TSImportType(node) {
            check(node.source, true);
          },
          TSImportEqualsDeclaration(node) {
            if (node.moduleReference.type === 'TSExternalModuleReference') {
              check(node.moduleReference.expression, node.importKind === 'type');
            }
          },
          ImportExpression(node) {
            checkLoaded(node, node.source);
          },
          CallExpression(node) {
            const [source] = node.arguments;
            const requireCall = node.callee.type === 'Identifier' && node.callee.name === 'require';

            if (requireCall && source !== undefined) {
              checkLoaded(node, source);
            }
          },
        };
      },
    },
    'throw-only-in-invariant': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          throw:
            'Throw only in `src/invariant.ts`. Return a typed result for an expected failure, or call `invariant` for a bug.',
        },
      },
      create(context) {
        const filename = context.physicalFilename;
        const path = sourcePathOf(filename);
        const exempt = path === undefined || path === 'invariant.ts' || isTestFile(filename);

        if (exempt) {
          return {};
        }

        return {
          ThrowStatement(node) {
            context.report({ node, messageId: 'throw' });
          },
        };
      },
    },
    'class-owns-resource': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          dispose:
            'A class must own a resource and declare `dispose()`, `[Symbol.dispose]()`, or `[Symbol.asyncDispose]()`, or extend an OpenTUI class. Use functions otherwise.',
          inheritance: 'A class may extend only a base class imported from an `@opentui/` package.',
        },
      },
      create(context) {
        if (sourcePathOf(context.physicalFilename) === undefined) {
          return {};
        }

        const extendsOpenTui = (node: ESTree.Class, superClass: ESTree.Expression): boolean => {
          const name = rootIdentifierOf(superClass);

          if (name === undefined) {
            return false;
          }

          const variable = variableOf(context.sourceCode.getScope(node), name);

          return importSourceOf(variable)?.startsWith('@opentui/') === true;
        };

        // An OpenTUI renderable ends its lifetime through OpenTUI's own `destroy()`.
        const check = (node: ESTree.Class) => {
          if (node.superClass !== null && extendsOpenTui(node, node.superClass)) {
            return;
          }

          if (node.superClass !== null) {
            context.report({ node: node.superClass, messageId: 'inheritance' });
          }

          if (!node.body.body.some(isDisposeMethod)) {
            context.report({ node, messageId: 'dispose' });
          }
        };

        return { ClassDeclaration: check, ClassExpression: check };
      },
    },
  },
};

export default phiPlugin;
