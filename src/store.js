// -----------------------------------------------------------------------------
// The state kept in /data (the only writable place of the container): the
// index guard, the serial and the number of inputs of the inverter, the time
// of the last connection attempt and of the last frame, so that a restart
// never forgets a jump the user has not accepted nor connects too soon. Never
// any text of the inverter. A small JSON file, written through a temporary
// file and a rename, one save after the other. Failures are logged, never
// fatal. Taken from gladys-omnik / gladys-imeon (approved).
// -----------------------------------------------------------------------------

import { readFileSync, statSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';

export const DEFAULT_STATE_FILE = '/data/envertech-state.json';
/** A larger file is not ours: ignored (read bounded). */
const MAX_STATE_BYTES = 64 * 1024;

export function createFileStore(file = DEFAULT_STATE_FILE) {
  /** The saves one after the other: two never share the temporary file. */
  let queue = Promise.resolve();
  const write = async (data) => {
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(data), 'utf8');
    await rename(tmp, file);
  };
  return {
    load() {
      try {
        if (statSync(file).size > MAX_STATE_BYTES) {
          return {};
        }
        const data = JSON.parse(readFileSync(file, 'utf8'));
        return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
      } catch {
        return {};
      }
    },
    save(data) {
      const job = queue.then(
        () => write(data),
        () => write(data),
      );
      queue = job.catch(() => {});
      return job;
    },
  };
}

/** The same in memory (tests). */
export function createMemoryStore(initial = {}) {
  let data = structuredClone(initial);
  return {
    load: () => structuredClone(data),
    async save(next) {
      data = structuredClone(next);
    },
    get data() {
      return data;
    },
  };
}
