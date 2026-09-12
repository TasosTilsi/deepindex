import { describe, it, expect } from 'vitest';
import { parseFile } from '../src/graph/parse.js';

describe('Multi-language Parsing', () => {
  it('should parse Java class as normalized "class"', async () => {
    const content = 'public class MyJavaClass { public void myMethod() {} }';
    const result = await parseFile('test.java', content);
    console.log('Java Result:', JSON.stringify(result, null, 2));
    
    const javaClass = result.symbols.find(s => s.name === 'MyJavaClass');
    expect(javaClass).toBeDefined();
    expect(javaClass?.kind).toBe('class');
  });

  it('should parse Rust function as normalized "method"', async () => {
    const content = 'fn my_rust_fn() { println!("hello"); }';
    const result = await parseFile('test.rs', content);
    console.log('Rust Result:', JSON.stringify(result, null, 2));
    
    const rustFn = result.symbols.find(s => s.name === 'my_rust_fn');
    expect(rustFn).toBeDefined();
    expect(rustFn?.kind).toBe('method');
  });

  it('should parse Java record as normalized "class" (DI-02)', async () => {
    const content =
      'import java.math.BigDecimal;\n' +
      'public record Money(BigDecimal amount, String currency) {\n' +
      '  public Money add(Money other) { return new Money(amount.add(other.amount), currency); }\n' +
      '}';
    const result = await parseFile('Money.java', content);
    const record = result.symbols.find((s) => s.name === 'Money');
    expect(record).toBeDefined();
    expect(record?.kind).toBe('class');
  });

  it('should parse Java enum as normalized "enum" (DI-02)', async () => {
    const content = 'public enum Status {\n  ACTIVE,\n  CLOSED\n}';
    const result = await parseFile('Status.java', content);
    const en = result.symbols.find((s) => s.name === 'Status');
    expect(en).toBeDefined();
    expect(en?.kind).toBe('enum');
  });
});
