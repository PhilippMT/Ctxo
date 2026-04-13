import JavaLanguage from 'tree-sitter-java';
import type { SyntaxNode } from 'tree-sitter';
import { TreeSitterAdapter } from './tree-sitter-adapter.js';
import type { SymbolNode, GraphEdge, ComplexityMetrics, SymbolKind } from '@ctxo/plugin-api';

const JAVA_BRANCH_TYPES = [
  'if_statement',
  'for_statement',
  'enhanced_for_statement',
  'while_statement',
  'do_statement',
  'switch_block_statement_group',
  'catch_clause',
  'conditional_expression',
];

export class JavaAdapter extends TreeSitterAdapter {
  readonly extensions = ['.java'] as const;

  constructor() {
    super(JavaLanguage);
  }

  async extractSymbols(filePath: string, source: string): Promise<SymbolNode[]> {
    try {
      const tree = this.parse(source);
      const symbols: SymbolNode[] = [];
      const pkg = this.extractPackageName(tree.rootNode);
      this.visitSymbols(tree.rootNode, filePath, pkg, symbols);
      return symbols;
    } catch (err) {
      console.error(`[ctxo:java] Symbol extraction failed for ${filePath}: ${(err as Error).message}`);
      return [];
    }
  }

  async extractEdges(filePath: string, source: string): Promise<GraphEdge[]> {
    try {
      const tree = this.parse(source);
      const edges: GraphEdge[] = [];
      const symbols = await this.extractSymbols(filePath, source);
      const firstSymbol = symbols.length > 0 ? symbols[0]!.symbolId : undefined;
      if (!firstSymbol) return edges;

      const pkg = this.extractPackageName(tree.rootNode);
      this.visitEdges(tree.rootNode, filePath, firstSymbol, pkg, edges);
      return edges;
    } catch (err) {
      console.error(`[ctxo:java] Edge extraction failed for ${filePath}: ${(err as Error).message}`);
      return [];
    }
  }

  async extractComplexity(filePath: string, source: string): Promise<ComplexityMetrics[]> {
    try {
      const tree = this.parse(source);
      const metrics: ComplexityMetrics[] = [];
      const pkg = this.extractPackageName(tree.rootNode);
      this.visitComplexity(tree.rootNode, filePath, pkg, metrics);
      return metrics;
    } catch (err) {
      console.error(`[ctxo:java] Complexity extraction failed for ${filePath}: ${(err as Error).message}`);
      return [];
    }
  }

  // ── Symbol visitor ──────────────────────────────────────────

  private visitSymbols(
    node: SyntaxNode,
    filePath: string,
    namespace: string,
    symbols: SymbolNode[],
  ): void {
    const typeMapping: Record<string, SymbolKind> = {
      class_declaration: 'class',
      record_declaration: 'class',
      interface_declaration: 'interface',
      enum_declaration: 'type',
      annotation_type_declaration: 'interface',
    };

    const kind = typeMapping[node.type];
    if (kind) {
      if (!this.isPublic(node)) return;
      const name = node.childForFieldName('name')?.text;
      if (!name) return;

      const qualifiedName = namespace ? `${namespace}.${name}` : name;
      const range = this.nodeToLineRange(node);
      symbols.push({
        symbolId: this.buildSymbolId(filePath, qualifiedName, kind),
        name: qualifiedName,
        kind,
        ...range,
      });

      // Extract methods inside classes, records, enums
      if (kind === 'class' || kind === 'type') {
        this.extractMethodSymbols(node, filePath, qualifiedName, symbols);
      }
      return;
    }

    // Recurse into child nodes
    for (let i = 0; i < node.childCount; i++) {
      this.visitSymbols(node.child(i)!, filePath, namespace, symbols);
    }
  }

  private extractMethodSymbols(
    classNode: SyntaxNode,
    filePath: string,
    className: string,
    symbols: SymbolNode[],
  ): void {
    const body = classNode.childForFieldName('body');
    if (!body) return;

    for (let i = 0; i < body.childCount; i++) {
      const child = body.child(i)!;
      if (child.type !== 'method_declaration' && child.type !== 'constructor_declaration') continue;
      if (!this.isPublic(child)) continue;

      const name = child.childForFieldName('name')?.text;
      if (!name) continue;

      const paramCount = this.countParameters(child);
      const qualifiedName = `${className}.${name}(${paramCount})`;
      const range = this.nodeToLineRange(child);
      symbols.push({
        symbolId: this.buildSymbolId(filePath, qualifiedName, 'method'),
        name: qualifiedName,
        kind: 'method',
        ...range,
      });
    }
  }

  // ── Edge visitor ────────────────────────────────────────────

  private visitEdges(
    node: SyntaxNode,
    filePath: string,
    fromSymbol: string,
    namespace: string,
    edges: GraphEdge[],
  ): void {
    if (node.type === 'import_declaration') {
      const importPath = this.extractImportPath(node);
      if (importPath) {
        edges.push({
          from: fromSymbol,
          to: `${importPath}::${importPath.split('.').pop()}::variable`,
          kind: 'imports',
        });
      }
      return;
    }

    if (node.type === 'class_declaration' || node.type === 'record_declaration') {
      if (!this.isPublic(node)) return;
      const name = node.childForFieldName('name')?.text;
      if (!name) return;

      const qualifiedName = namespace ? `${namespace}.${name}` : name;
      const classSymbolId = this.buildSymbolId(filePath, qualifiedName, 'class');

      // Check superclass for extends
      const superclass = node.childForFieldName('superclass');
      if (superclass) {
        const baseType = this.extractTypeName(superclass);
        if (baseType) {
          edges.push({
            from: classSymbolId,
            to: this.resolveBaseType(baseType, namespace, 'class'),
            kind: 'extends',
          });
        }
      }

      // Check interfaces for implements
      const interfaces = node.childForFieldName('interfaces');
      if (interfaces) {
        this.extractImplementsEdges(interfaces, classSymbolId, namespace, edges);
      }
    }

    if (node.type === 'interface_declaration') {
      if (!this.isPublic(node)) return;
      const name = node.childForFieldName('name')?.text;
      if (!name) return;

      const qualifiedName = namespace ? `${namespace}.${name}` : name;
      const ifaceSymbolId = this.buildSymbolId(filePath, qualifiedName, 'interface');

      // Check extends_interfaces for interface inheritance
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i)!;
        if (child.type === 'extends_interfaces') {
          this.extractExtendsInterfaceEdges(child, ifaceSymbolId, namespace, edges);
        }
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      this.visitEdges(node.child(i)!, filePath, fromSymbol, namespace, edges);
    }
  }

  private extractImplementsEdges(
    interfacesNode: SyntaxNode,
    fromSymbol: string,
    namespace: string,
    edges: GraphEdge[],
  ): void {
    const typeList = interfacesNode.children.find(c => c.type === 'type_list');
    if (!typeList) return;

    for (let i = 0; i < typeList.childCount; i++) {
      const child = typeList.child(i)!;
      const typeName = this.extractTypeIdentifier(child);
      if (typeName) {
        edges.push({
          from: fromSymbol,
          to: this.resolveBaseType(typeName, namespace, 'interface'),
          kind: 'implements',
        });
      }
    }
  }

  private extractExtendsInterfaceEdges(
    extendsNode: SyntaxNode,
    fromSymbol: string,
    namespace: string,
    edges: GraphEdge[],
  ): void {
    const typeList = extendsNode.children.find(c => c.type === 'type_list');
    if (!typeList) return;

    for (let i = 0; i < typeList.childCount; i++) {
      const child = typeList.child(i)!;
      const typeName = this.extractTypeIdentifier(child);
      if (typeName) {
        edges.push({
          from: fromSymbol,
          to: this.resolveBaseType(typeName, namespace, 'interface'),
          kind: 'extends',
        });
      }
    }
  }

  // ── Complexity visitor ──────────────────────────────────────

  private visitComplexity(
    node: SyntaxNode,
    filePath: string,
    namespace: string,
    metrics: ComplexityMetrics[],
  ): void {
    const typeMapping: Record<string, true> = {
      class_declaration: true,
      record_declaration: true,
      enum_declaration: true,
    };

    if (typeMapping[node.type]) {
      if (!this.isPublic(node)) return;
      const className = node.childForFieldName('name')?.text;
      if (!className) return;

      const qualifiedClass = namespace ? `${namespace}.${className}` : className;
      const body = node.childForFieldName('body');
      if (!body) return;

      for (let i = 0; i < body.childCount; i++) {
        const child = body.child(i)!;
        if (child.type !== 'method_declaration') continue;
        if (!this.isPublic(child)) continue;

        const methodName = child.childForFieldName('name')?.text;
        if (!methodName) continue;

        const paramCount = this.countParameters(child);
        metrics.push({
          symbolId: this.buildSymbolId(filePath, `${qualifiedClass}.${methodName}(${paramCount})`, 'method'),
          cyclomatic: this.countCyclomaticComplexity(child, JAVA_BRANCH_TYPES),
        });
      }
      return;
    }

    for (let i = 0; i < node.childCount; i++) {
      this.visitComplexity(node.child(i)!, filePath, namespace, metrics);
    }
  }

  // ── Helpers ─────────────────────────────────────────────────

  private extractPackageName(rootNode: SyntaxNode): string {
    for (let i = 0; i < rootNode.childCount; i++) {
      const node = rootNode.child(i)!;
      if (node.type === 'package_declaration') {
        // Package name can be identifier or scoped_identifier
        for (let j = 0; j < node.childCount; j++) {
          const child = node.child(j)!;
          if (child.type === 'identifier' || child.type === 'scoped_identifier') {
            return child.text;
          }
        }
      }
    }
    return '';
  }

  private extractImportPath(importNode: SyntaxNode): string | null {
    for (let i = 0; i < importNode.childCount; i++) {
      const child = importNode.child(i)!;
      if (child.type === 'scoped_identifier' || child.type === 'identifier') {
        return child.text;
      }
    }
    return null;
  }

  private extractTypeName(node: SyntaxNode): string | null {
    // Superclass node wraps the type
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
      if (child.type === 'type_identifier') return child.text;
      if (child.type === 'scoped_type_identifier') return child.text;
      if (child.type === 'generic_type') {
        // Generic type like List<String> — extract base type
        for (let j = 0; j < child.childCount; j++) {
          const gc = child.child(j)!;
          if (gc.type === 'type_identifier' || gc.type === 'scoped_type_identifier') return gc.text;
        }
      }
    }
    return null;
  }

  private extractTypeIdentifier(node: SyntaxNode): string | null {
    if (node.type === 'type_identifier') return node.text;
    if (node.type === 'scoped_type_identifier') return node.text;
    if (node.type === 'generic_type') {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i)!;
        if (child.type === 'type_identifier' || child.type === 'scoped_type_identifier') return child.text;
      }
    }
    return null;
  }

  private countParameters(methodNode: SyntaxNode): number {
    const params = methodNode.childForFieldName('parameters');
    if (!params) return 0;
    let count = 0;
    for (let i = 0; i < params.childCount; i++) {
      const child = params.child(i)!;
      if (child.type === 'formal_parameter' || child.type === 'spread_parameter') count++;
    }
    return count;
  }

  private isPublic(node: SyntaxNode): boolean {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
      if (child.type === 'modifiers') {
        return child.text.includes('public');
      }
    }
    return false;
  }

  private resolveBaseType(baseName: string, namespace: string, defaultKind: SymbolKind): string {
    // Check symbol registry first
    const prefix = namespace ? `${namespace}.${baseName}` : baseName;
    for (const [id] of this.symbolRegistry) {
      if (id.includes(`::${prefix}::`)) return id;
      if (id.includes(`::${baseName}::`)) return id;
    }
    // Fallback: assume same package
    const qualifiedName = namespace ? `${namespace}.${baseName}` : baseName;
    return `${qualifiedName}::${baseName}::${defaultKind}`;
  }
}
