export interface AtomicStatement {
  text: string;
  type: 'modal' | 'bullet' | 'general';
}

export function extractAtomicStatements(text: string): { statements: AtomicStatement[] } {
  const statements: AtomicStatement[] = [];

  // Heuristic: Split by bullets (•, -, *) or Modal phrases (Shall, Must, Should)
  const lines = text.split(/\n/).map(l => l.trim()).filter(Boolean);

  for (const line of lines) {
    if (/^(•|-|\*)\s+/.test(line)) {
      statements.push({ text: line.replace(/^(•|-|\*)\s+/, ''), type: 'bullet' });
    } else if (/\b(shall|must|should|will)\b/i.test(line)) {
      statements.push({ text: line, type: 'modal' });
    } else {
      statements.push({ text: line, type: 'general' });
    }
  }

  return { statements };
}
