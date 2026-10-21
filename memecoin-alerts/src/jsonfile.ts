import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Parsed contents, or undefined if the file doesn't exist yet. */
export async function readJsonFile<T>(path: string): Promise<T | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(`Couldn't read ${path} (${(err as Error).message}). Delete it to start fresh.`);
  }
}

/** Writes to a temp file and renames, so a crash mid-write can't corrupt the file. */
export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, JSON.stringify(data));
  await rename(`${path}.tmp`, path);
}

/** Appends one JSON object as a line. */
export async function appendJsonLine(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(data) + "\n");
}
