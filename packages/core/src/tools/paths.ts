import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getUserConfigDir } from "../user-config";

/** Agent-authored tool modules live under ~/.tinyclaw/tools/ by default. */
export function getCustomToolsDir(): string {
  const override = process.env.TINYCLAW_TOOLS_DIR?.trim();

  if (override) {
    return override;
  }

  return path.join(getUserConfigDir(), "tools");
}

// ---------------------------------------------------------------------------
// PathGuard — filesystem safety for LLM-controlled file operations
// ---------------------------------------------------------------------------

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const SPECIAL_PATH_PREFIXES = ["/dev/", "/proc/", "/sys/"];

export interface PathGuardOptions {
  /** Directories the tool is allowed to write/delete within. Defaults to [cwd]. */
  allowedDirs?: string[];
  /** Maximum file content size in bytes. Defaults to 10 MB. */
  maxFileBytes?: number;
  /** Working directory override (defaults to process.cwd()). */
  cwd?: string;
}

export interface GuardedPath {
  /** The canonical, symlink-resolved absolute path. */
  resolved: string;
  /** Whether the path is within an allowed directory. */
  allowed: boolean;
}

export class PathGuardError extends Error {
  constructor(
    message: string,
    public readonly code: "TRAVERSAL" | "ABSOLUTE" | "SPECIAL_FILE" | "NULL_BYTE" | "TOO_LARGE",
  ) {
    super(message);
    this.name = "PathGuardError";
  }
}

/**
 * Validates a file path from LLM input against a directory allowlist.
 * Resolves symlinks, rejects traversal attempts, rejects special files.
 */
export async function guardFilePath(
  rawPath: string,
  rawCwd: string | undefined | null,
  rawContentLength: number | undefined,
  options: PathGuardOptions = {},
): Promise<GuardedPath> {
  const allowedDirs = options.allowedDirs ?? [options.cwd ?? process.cwd()];
  const maxBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const defaultCwd = options.cwd ?? process.cwd();

  // Reject null bytes — attempt to hide file extension or bypass validation
  if (rawPath.includes("\0")) {
    throw new PathGuardError(
      `Path contains null byte: ${JSON.stringify(rawPath)}`,
      "NULL_BYTE",
    );
  }

  // Reject content that's too large
  if (rawContentLength != null && rawContentLength > maxBytes) {
    throw new PathGuardError(
      `File content exceeds maximum size of ${maxBytes} bytes (got ${rawContentLength}).`,
      "TOO_LARGE",
    );
  }

  // Resolve the target cwd — validate if LLM provided one
  const cwd = resolveSafeCwd(rawCwd, allowedDirs, defaultCwd);

  // Expand ~ and resolve to absolute
  const expanded = expandHome(rawPath);
  const absolute = path.resolve(cwd, expanded);

  // Check for special filesystem paths early (before symlink resolution)
  for (const prefix of SPECIAL_PATH_PREFIXES) {
    if (absolute === prefix.slice(0, -1) || absolute.startsWith(prefix)) {
      throw new PathGuardError(
        `Cannot operate on special filesystem path: ${absolute}`,
        "SPECIAL_FILE",
      );
    }
  }

  // Resolve symlinks to real path
  let realPath: string;
  try {
    realPath = await resolveRealPathCarefully(absolute);
  } catch {
    // File doesn't exist yet — resolve parent directory instead
    const dirname = path.dirname(absolute);
    try {
      const realDir = await resolveRealPathCarefully(dirname);
      realPath = path.resolve(realDir, path.basename(absolute));
    } catch {
      // Parent doesn't exist either — use the normalized path as-is
      realPath = absolute;
    }
  }

  // Validate the resolved path is within an allowed directory
  if (!isWithinDirs(realPath, allowedDirs)) {
    throw new PathGuardError(
      `Path is outside allowed directories: ${absolute}`,
      "TRAVERSAL",
    );
  }

  return { resolved: realPath, allowed: true };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function expandHome(filePath: string): string {
  if (filePath === "~") return getUserHome();
  if (filePath.startsWith("~/")) return path.join(getUserHome(), filePath.slice(2));
  return filePath;
}

function getUserHome(): string {
  return process.env.HOME ?? os.homedir();
}

async function resolveRealPathCarefully(target: string): Promise<string> {
  return await realpath(target);
}

function isWithinDirs(target: string, dirs: string[]): boolean {
  const normalized = target.endsWith(path.sep) ? target : target + path.sep;

  for (const dir of dirs) {
    const dirEnd = dir.endsWith(path.sep) ? dir : dir + path.sep;
    if (normalized === dirEnd || normalized.startsWith(dirEnd)) {
      return true;
    }
  }

  return false;
}

/**
 * Validates LLM-provided cwd against allowed directories.
 * Falls back to default cwd if the LLM's cwd is outside allowed dirs.
 */
function resolveSafeCwd(
  rawCwd: string | undefined | null,
  allowedDirs: string[],
  defaultCwd: string,
): string {
  if (rawCwd == null || rawCwd.trim() === "") {
    return defaultCwd;
  }

  const expanded = expandHome(rawCwd.trim());
  const absolute = path.resolve(expanded);

  if (isWithinDirs(absolute, allowedDirs)) {
    return absolute;
  }

  // LLM tried to use cwd outside allowed dirs — fall back to default
  return defaultCwd;
}
