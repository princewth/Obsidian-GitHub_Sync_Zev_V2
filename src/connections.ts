import { inFolder, safePath } from './paths';
import { Connection } from './types';

function overlaps(first: string, second: string): boolean {
  return !first || !second || inFolder(first, second) || inFolder(second, first);
}

const localKey = (path: string): string => path.normalize('NFC').toLowerCase();

export function localPathsOverlap(first: string, second: string): boolean {
  return overlaps(localKey(first), localKey(second));
}

export function localInputPath(value: string): string {
  return safePath(value.trim().replaceAll('\\', '/'));
}

export function sameRemote(first: Connection, second: Connection): boolean {
  return first.owner.toLowerCase() === second.owner.toLowerCase()
    && first.repo.toLowerCase() === second.repo.toLowerCase()
    && first.branch === second.branch && first.remotePath === second.remotePath;
}

export function connectionConflicts(candidate: Connection, saved: Iterable<Connection>): { local: Connection[]; writers: Connection[] } {
  const local: Connection[] = [];
  const writers: Connection[] = [];
  for (const current of saved) {
    if (current.id === candidate.id) continue;
    if (localPathsOverlap(candidate.localPath, current.localPath)) local.push(current);
    if (candidate.access === 'read-write' && current.access === 'read-write'
      && candidate.owner.toLowerCase() === current.owner.toLowerCase()
      && candidate.repo.toLowerCase() === current.repo.toLowerCase()
      && candidate.branch === current.branch && overlaps(candidate.remotePath, current.remotePath)) {
      writers.push(current);
    }
  }
  return { local, writers };
}
