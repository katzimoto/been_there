import { describe, expect, it } from 'vitest';
import { createContext } from '../src/index.js';

describe('resolution', () => {
  it('loads the package from source', () => {
    expect(createContext().audit.entries).toEqual([]);
  });
});
