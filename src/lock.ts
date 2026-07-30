import { lstat, mkdir } from "node:fs/promises";
import lockfile from "proper-lockfile";

export async function withRepositoryLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  await mkdir(root, { recursive: true });
  const info = await lstat(root);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("local-memfs repository root must be a real directory, not a symlink");
  }
  const release = await lockfile.lock(root, {
    realpath: false,
    stale: 30_000,
    update: 5_000,
    retries: {
      retries: 8,
      factor: 1.5,
      minTimeout: 50,
      maxTimeout: 750,
      randomize: true,
    },
  });
  try {
    return await work();
  } finally {
    await release();
  }
}
