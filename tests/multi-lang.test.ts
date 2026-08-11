import { describe, it, expect } from 'vitest';
import { parseFile } from '../src/graph/parse.js';

describe('Multi-language Parsing', () => {
  it('should normalize Java class and method', async () => {
    const content = `
    public class MyClass {
      public void myMethod() {}
    }
    `;
    const result = await parseFile('Test.java', content);

    expect(result.symbols).toContainEqual(expect.objectContaining({
      name: 'MyClass',
      kind: 'class'
    }));
    expect(result.symbols).toContainEqual(expect.objectContaining({
      name: 'myMethod',
      kind: 'method'
    }));
  });

  it('should normalize Rust struct and function', async () => {
    const content = `
    struct MyStruct {
      field: i32,
    }
    fn my_fn() {}
    `;
    const result = await parseFile('Test.rs', content);

    expect(result.symbols).toContainEqual(expect.objectContaining({
      name: 'MyStruct',
      kind: 'class'
    }));
    expect(result.symbols).toContainEqual(expect.objectContaining({
      name: 'my_fn',
      kind: 'method'
    }));
  });

  it('should handle C++ declarators', async () => {
    const content = `
    class MyCppClass {};
    void my_func() {}
    `;
    const result = await parseFile('Test.cpp', content);

    expect(result.symbols).toContainEqual(expect.objectContaining({
      name: 'MyCppClass',
      kind: 'class'
    }));
    expect(result.symbols).toContainEqual(expect.objectContaining({
      name: 'my_func',
      kind: 'method'
    }));
  });
});
