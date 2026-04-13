import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JavaAdapter } from '../java-adapter.js';

const FIXTURES_DIR = join(import.meta.dirname, 'fixtures');

function readFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), 'utf-8');
}

describe('JavaAdapter — symbol extraction', () => {
  const adapter = new JavaAdapter();

  it('extracts public class with package qualification', async () => {
    const source = readFixture('java-sample.java.fixture');
    const symbols = await adapter.extractSymbols('src/main/java/Payment.java', source);

    const cls = symbols.find(s => s.name === 'com.example.payment.PaymentResult');
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe('class');
    expect(cls!.symbolId).toBe('src/main/java/Payment.java::com.example.payment.PaymentResult::class');
  });

  it('extracts public interface with package', async () => {
    const source = readFixture('java-sample.java.fixture');
    const symbols = await adapter.extractSymbols('src/main/java/Payment.java', source);

    const iface = symbols.find(s => s.name === 'com.example.payment.PaymentProcessor');
    expect(iface).toBeDefined();
    expect(iface!.kind).toBe('interface');
  });

  it('extracts public methods inside classes', async () => {
    const source = readFixture('java-sample.java.fixture');
    const symbols = await adapter.extractSymbols('src/main/java/Payment.java', source);

    const method = symbols.find(s => s.name === 'com.example.payment.CardProcessor.process(1)');
    expect(method).toBeDefined();
    expect(method!.kind).toBe('method');
  });

  it('extracts constructor as method', async () => {
    const source = readFixture('java-sample.java.fixture');
    const symbols = await adapter.extractSymbols('src/main/java/Payment.java', source);

    const ctor = symbols.find(s => s.name === 'com.example.payment.CardProcessor.CardProcessor(1)');
    expect(ctor).toBeDefined();
    expect(ctor!.kind).toBe('method');
  });

  it('skips private methods', async () => {
    const source = readFixture('java-sample.java.fixture');
    const symbols = await adapter.extractSymbols('src/main/java/Payment.java', source);

    const priv = symbols.find(s => s.name.includes('log'));
    expect(priv).toBeUndefined();
  });

  it('extracts enum as type kind', async () => {
    const source = readFixture('java-sample.java.fixture');
    const symbols = await adapter.extractSymbols('src/main/java/Payment.java', source);

    const en = symbols.find(s => s.name === 'com.example.payment.PaymentStatus');
    expect(en).toBeDefined();
    expect(en!.kind).toBe('type');
  });

  it('extracts record as class kind (Java 21+)', async () => {
    const source = readFixture('java-sample.java.fixture');
    const symbols = await adapter.extractSymbols('src/main/java/Payment.java', source);

    const rec = symbols.find(s => s.name === 'com.example.payment.PaymentEvent');
    expect(rec).toBeDefined();
    expect(rec!.kind).toBe('class');
  });

  it('extracts all expected symbols', async () => {
    const source = readFixture('java-sample.java.fixture');
    const symbols = await adapter.extractSymbols('src/main/java/Payment.java', source);

    const names = symbols.map(s => s.name);
    expect(names).toContain('com.example.payment.PaymentProcessor');
    expect(names).toContain('com.example.payment.PaymentResult');
    expect(names).toContain('com.example.payment.CardProcessor');
    expect(names).toContain('com.example.payment.PaymentStatus');
    expect(names).toContain('com.example.payment.PaymentEvent');
    expect(names).toContain('com.example.payment.PaymentResult.isSuccess(0)');
    expect(names).toContain('com.example.payment.PaymentResult.getMessage(0)');
    expect(names).toContain('com.example.payment.CardProcessor.process(1)');
  });

  it('includes byte offsets on all symbols', async () => {
    const source = readFixture('java-sample.java.fixture');
    const symbols = await adapter.extractSymbols('src/main/java/Payment.java', source);

    for (const sym of symbols) {
      expect(sym.startOffset).toBeDefined();
      expect(sym.endOffset).toBeDefined();
      expect(sym.startOffset).toBeLessThan(sym.endOffset!);
    }
  });

  it('includes correct line numbers', async () => {
    const source = readFixture('java-sample.java.fixture');
    const symbols = await adapter.extractSymbols('src/main/java/Payment.java', source);

    const iface = symbols.find(s => s.name === 'com.example.payment.PaymentProcessor');
    expect(iface!.startLine).toBeGreaterThanOrEqual(0);
    expect(iface!.endLine).toBeGreaterThan(iface!.startLine);
  });
});

describe('JavaAdapter — edge extraction', () => {
  const adapter = new JavaAdapter();

  it('extracts import edges from import declarations', async () => {
    const source = readFixture('java-sample.java.fixture');
    const edges = await adapter.extractEdges('src/main/java/Payment.java', source);

    const importEdges = edges.filter(e => e.kind === 'imports');
    expect(importEdges.length).toBeGreaterThanOrEqual(2);
    expect(importEdges.some(e => e.to.includes('java.util.List'))).toBe(true);
    expect(importEdges.some(e => e.to.includes('java.util.Optional'))).toBe(true);
  });

  it('extracts implements edge for class implementing interface', async () => {
    const source = readFixture('java-sample.java.fixture');
    const edges = await adapter.extractEdges('src/main/java/Payment.java', source);

    const implEdge = edges.find(e => e.kind === 'implements');
    expect(implEdge).toBeDefined();
    expect(implEdge!.from).toContain('CardProcessor');
    expect(implEdge!.to).toContain('PaymentProcessor');
  });

  it('extracts extends edge for class inheritance', async () => {
    const source = `
package com.example;

public class Base {
    public void run() {}
}

public class Child extends Base {
    public void work() {}
}
`;
    const edges = await adapter.extractEdges('src/Child.java', source);
    const extendsEdge = edges.find(e => e.kind === 'extends');
    expect(extendsEdge).toBeDefined();
    expect(extendsEdge!.to).toContain('Base');
  });

  it('returns empty edges for file with no public symbols', async () => {
    const source = `
package com.example;

class InternalHelper {
    void doStuff() {}
}
`;
    const edges = await adapter.extractEdges('src/Internal.java', source);
    expect(edges).toEqual([]);
  });

  it('returns empty edges for file with no imports', async () => {
    const source = `
package com.example;

public class Simple {
    public String greet() { return "hi"; }
}
`;
    const edges = await adapter.extractEdges('src/Simple.java', source);
    // No import edges, no extends/implements edges
    expect(edges).toEqual([]);
  });
});

describe('JavaAdapter — complexity extraction', () => {
  const adapter = new JavaAdapter();

  it('counts if statement as branch', async () => {
    const source = readFixture('java-sample.java.fixture');
    const metrics = await adapter.extractComplexity('src/main/java/Payment.java', source);

    const processMetric = metrics.find(m => m.symbolId.includes('CardProcessor.process'));
    expect(processMetric).toBeDefined();
    expect(processMetric!.cyclomatic).toBeGreaterThan(1);
  });

  it('returns complexity 1 for simple method', async () => {
    const source = `
package com.example;

public class Svc {
    public int get() { return 42; }
}
`;
    const metrics = await adapter.extractComplexity('src/Svc.java', source);
    expect(metrics).toHaveLength(1);
    expect(metrics[0]!.cyclomatic).toBe(1);
  });

  it('skips private methods', async () => {
    const source = readFixture('java-sample.java.fixture');
    const metrics = await adapter.extractComplexity('src/main/java/Payment.java', source);

    const priv = metrics.find(m => m.symbolId.includes('log'));
    expect(priv).toBeUndefined();
  });

  it('counts switch cases', async () => {
    const source = `
package com.example;

public class Router {
    public String route(String path) {
        switch (path) {
            case "/home":
                return "home";
            case "/about":
                return "about";
            default:
                return "404";
        }
    }
}
`;
    const metrics = await adapter.extractComplexity('src/Router.java', source);
    expect(metrics).toHaveLength(1);
    // 1 base + 3 switch_block_statement_group = 4
    expect(metrics[0]!.cyclomatic).toBeGreaterThanOrEqual(3);
  });

  it('counts for and while loops', async () => {
    const source = `
package com.example;

import java.util.List;

public class Processor {
    public void process(List<String> items) {
        for (String item : items) {
            while (item.length() > 0) {
                item = item.substring(1);
            }
        }
    }
}
`;
    const metrics = await adapter.extractComplexity('src/Processor.java', source);
    expect(metrics).toHaveLength(1);
    // 1 base + 1 enhanced_for + 1 while = 3
    expect(metrics[0]!.cyclomatic).toBeGreaterThanOrEqual(3);
  });
});

describe('JavaAdapter — edge cases', () => {
  it('handles class without package declaration', async () => {
    const adapter = new JavaAdapter();
    const source = `
public class GlobalHelper {
    public void help() {}
}
`;
    const symbols = await adapter.extractSymbols('src/Global.java', source);
    const cls = symbols.find(s => s.name === 'GlobalHelper');
    expect(cls).toBeDefined();
    expect(cls!.kind).toBe('class');
    const method = symbols.find(s => s.name === 'GlobalHelper.help(0)');
    expect(method).toBeDefined();
  });

  it('resolves base type via symbol registry', async () => {
    const adapter = new JavaAdapter();
    const registry = new Map<string, import('@ctxo/plugin-api').SymbolKind>();
    registry.set('src/IHandler.java::com.example.Handler::interface', 'interface');
    adapter.setSymbolRegistry(registry);

    const source = `
package com.example;

public class Worker implements Handler {
    public void handle() {}
}
`;
    const edges = await adapter.extractEdges('src/Worker.java', source);
    const implEdge = edges.find(e => e.kind === 'implements');
    expect(implEdge).toBeDefined();
    // Should resolve via registry to full symbolId
    expect(implEdge!.to).toBe('src/IHandler.java::com.example.Handler::interface');

    adapter.setSymbolRegistry(new Map());
  });

  it('handles multiple import declarations', async () => {
    const adapter = new JavaAdapter();
    const source = `
package com.example;

import java.util.List;
import java.util.Map;
import java.util.Set;

public class Svc {
    public void run() {}
}
`;
    const edges = await adapter.extractEdges('src/Svc.java', source);
    const imports = edges.filter(e => e.kind === 'imports');
    expect(imports).toHaveLength(3);
  });

  it('handles wildcard import', async () => {
    const adapter = new JavaAdapter();
    const source = `
package com.example;

import java.util.*;

public class Svc {
    public void run() {}
}
`;
    const edges = await adapter.extractEdges('src/Svc.java', source);
    const imports = edges.filter(e => e.kind === 'imports');
    expect(imports.length).toBeGreaterThanOrEqual(1);
  });

  it('handles interface extending another interface', async () => {
    const adapter = new JavaAdapter();
    const source = `
package com.example;

public interface BaseService {
    void start();
}

public interface ExtendedService extends BaseService {
    void stop();
}
`;
    const edges = await adapter.extractEdges('src/ExtendedService.java', source);
    const extendsEdge = edges.find(e => e.kind === 'extends');
    expect(extendsEdge).toBeDefined();
    expect(extendsEdge!.from).toContain('ExtendedService');
    expect(extendsEdge!.to).toContain('BaseService');
  });

  it('handles class implementing multiple interfaces', async () => {
    const adapter = new JavaAdapter();
    const source = `
package com.example;

public interface Readable {
    String read();
}

public interface Writable {
    void write(String data);
}

public class FileHandler implements Readable, Writable {
    public String read() { return ""; }
    public void write(String data) {}
}
`;
    const edges = await adapter.extractEdges('src/FileHandler.java', source);
    const implEdges = edges.filter(e => e.kind === 'implements');
    expect(implEdges.length).toBe(2);
    expect(implEdges.some(e => e.to.includes('Readable'))).toBe(true);
    expect(implEdges.some(e => e.to.includes('Writable'))).toBe(true);
  });

  it('handles try-catch in complexity', async () => {
    const adapter = new JavaAdapter();
    const source = `
package com.example;

public class ErrorHandler {
    public void handle() {
        try {
            throw new RuntimeException();
        } catch (RuntimeException e) {
            System.out.println(e);
        } catch (Exception e) {
            System.out.println(e);
        }
    }
}
`;
    const metrics = await adapter.extractComplexity('src/ErrorHandler.java', source);
    expect(metrics).toHaveLength(1);
    // 1 base + 2 catch clauses = 3
    expect(metrics[0]!.cyclomatic).toBeGreaterThanOrEqual(3);
  });

  it('extracts method with varargs parameter', async () => {
    const adapter = new JavaAdapter();
    const source = `
package com.example;

public class Formatter {
    public String format(String template, Object... args) {
        return String.format(template, args);
    }
}
`;
    const symbols = await adapter.extractSymbols('src/Formatter.java', source);
    const method = symbols.find(s => s.name.includes('format'));
    expect(method).toBeDefined();
    expect(method!.kind).toBe('method');
  });

  it('handles annotation type declaration', async () => {
    const adapter = new JavaAdapter();
    const source = `
package com.example;

public @interface MyAnnotation {
    String value();
}
`;
    const symbols = await adapter.extractSymbols('src/MyAnnotation.java', source);
    const ann = symbols.find(s => s.name === 'com.example.MyAnnotation');
    expect(ann).toBeDefined();
    expect(ann!.kind).toBe('interface');
  });
});

describe('JavaAdapter — isSupported', () => {
  const adapter = new JavaAdapter();

  it('returns true for .java files', () => {
    expect(adapter.isSupported('src/main/java/App.java')).toBe(true);
  });

  it('returns false for .ts files', () => {
    expect(adapter.isSupported('src/main.ts')).toBe(false);
  });

  it('returns false for .go files', () => {
    expect(adapter.isSupported('cmd/main.go')).toBe(false);
  });

  it('returns false for .cs files', () => {
    expect(adapter.isSupported('src/App.cs')).toBe(false);
  });

  it('has syntax tier', () => {
    expect(adapter.tier).toBe('syntax');
  });
});
