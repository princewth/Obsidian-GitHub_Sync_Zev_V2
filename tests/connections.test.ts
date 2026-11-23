import { describe, expect, it } from 'vitest';
import { connectionConflicts, localInputPath } from '../src/connections';
import { connection } from './helpers';

describe('workspace paths', () => {
  const saved = connection({ localPath: 'Work/Café', remotePath: 'docs' });

  it('matches path segments and normalizes local case and Unicode without folding Git paths', () => {
    expect(connectionConflicts(connection({ id: 'other', localPath: 'work/Cafe\u0301/nested', remotePath: 'Docs' }), [saved])).toEqual({ local: [saved], writers: [] });
    expect(connectionConflicts(connection({ id: 'other', localPath: 'Work/Caféteria', remotePath: 'docs-old' }), [saved])).toEqual({ local: [], writers: [] });
  });

  it('checks the same GitHub repository and branch for overlapping writers', () => {
    const draft = connection({ id: 'other', owner: 'EXAMPLE', repo: 'NOTES', localPath: 'Different', remotePath: '' });
    expect(connectionConflicts(draft, [saved]).writers).toEqual([saved]);
    expect(connectionConflicts(draft, [{ ...saved, paused: true }]).writers).toEqual([{ ...saved, paused: true }]);
    expect(connectionConflicts({ ...draft, branch: 'preview' }, [saved]).writers).toEqual([]);
    expect(connectionConflicts({ ...draft, access: 'read-only' }, [saved]).writers).toEqual([]);
  });

  it('accepts relative Windows paths but rejects absolute paths and traversal', () => {
    expect(localInputPath(' Projects\\Notes\\ ')).toBe('Projects/Notes');
    for (const path of ['C:\\Notes', '\\\\server\\share', 'Projects\\..\\Notes', '/Notes']) {
      expect(() => localInputPath(path)).toThrow();
    }
  });
});
