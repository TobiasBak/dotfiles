import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const stats = await fs.promises.lstat(directory);
  if (!stats.isDirectory()) {
    throw new Error(`Refusing to use non-directory subtask output path: ${directory}`);
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error(`Refusing to use subtask output directory owned by another user: ${directory}`);
  }
  await fs.promises.chmod(directory, 0o700);
}

function safeSessionId(sessionId: string): string {
  const sanitized = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return sanitized && !/^\.{1,2}$/.test(sanitized) ? sanitized : `session-${process.pid}`;
}

function requireGeneratedId(value: string, pattern: RegExp, kind: string): string {
  if (!pattern.test(value)) throw new Error(`Invalid ${kind}: ${value}`);
  return value;
}

export function createOverflowResultWriter(
  sessionId: string,
  groupId: string,
  retainTemporaryPath: (path: string) => void,
): (taskId: string, content: string) => Promise<string> {
  const safeGroupId = requireGeneratedId(groupId, /^g-[0-9a-f]{6}$/, "subtask group ID");
  const rootDirectory = path.join(os.tmpdir(), "pi-subtasks");
  const sessionDirectory = path.join(rootDirectory, safeSessionId(sessionId));
  const outputDirectory = path.join(sessionDirectory, safeGroupId);
  let directoryPreparation: Promise<void> | undefined;

  const prepareDirectory = () => {
    directoryPreparation ??= (async () => {
      for (const directory of [rootDirectory, sessionDirectory]) {
        await ensurePrivateDirectory(directory);
      }
      retainTemporaryPath(sessionDirectory);
      await ensurePrivateDirectory(outputDirectory);
    })();
    return directoryPreparation;
  };

  return async (taskId: string, content: string): Promise<string> => {
    const safeTaskId = requireGeneratedId(taskId, /^[0-9a-f]{6}$/, "subtask ID");
    await prepareDirectory();
    const outputPath = path.join(outputDirectory, `${safeTaskId}.md`);
    await fs.promises.writeFile(outputPath, content, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return outputPath;
  };
}
