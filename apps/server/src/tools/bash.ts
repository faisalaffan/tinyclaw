import { spawn } from "node:child_process";
import type { ToolDefinition } from "@tinyclaw/core";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 32_000;
const MAX_COMMAND_CHARS = 8_000;

/** Patterns that indicate attempts to bypass single-command execution. */
const REJECT_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /[\n\r]/, reason: "Multi-line commands are not allowed." },
  { pattern: /\/dev\/tcp\//, reason: "Network redirect via /dev/tcp is not allowed." },
  { pattern: /\/dev\/udp\//, reason: "Network redirect via /dev/udp is not allowed." },
];

export interface BashInput {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface BashOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export const bashTool: ToolDefinition<BashInput, BashOutput> = {
  name: "bash",
  description:
    "Run a one-off shell command within the allowed workspace. Returns stdout, stderr, and exit code. Do not use this to create persistent tools, tool files, shell wrappers, or .sh scripts. If the user wants a reusable tool, translate shell examples into JavaScript instead.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description:
          "Shell command to run. Single line only — no newlines or command chaining via control characters.",
      },
      cwd: {
        type: "string",
        description: "Working directory. Defaults to server cwd.",
      },
      timeoutMs: {
        type: "number",
        description: "Timeout in milliseconds. Defaults to 30000, max 120000.",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
  run(input) {
    const command = readString(input, "command");

    if (!command) {
      throw new Error("command is required.");
    }

    if (command.length > MAX_COMMAND_CHARS) {
      throw new Error(
        `Command exceeds maximum length of ${MAX_COMMAND_CHARS} characters (got ${command.length}).`,
      );
    }

    for (const { pattern, reason } of REJECT_PATTERNS) {
      if (pattern.test(command)) {
        throw new Error(reason);
      }
    }

    const cwd = readString(input, "cwd") ?? process.cwd();
    const timeoutMs = readTimeout(input.timeoutMs);

    return runShellCommand(command, cwd, timeoutMs);
  },
};

function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<BashOutput> {
  return new Promise((resolve, reject) => {
    // Use -c (not -lc) — no login shell, no profile sourcing
    const child = spawn("/bin/bash", ["-c", command], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout = appendOutput(stdout, String(chunk));
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = appendOutput(stderr, String(chunk));
    });

    child.on("error", (error) => {
      clearTimeout(timeoutId);
      reject(error);
    });

    child.on("close", (exitCode) => {
      clearTimeout(timeoutId);
      resolve({
        exitCode,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

function appendOutput(current: string, chunk: string): string {
  const combined = current + chunk;

  if (combined.length <= MAX_OUTPUT_CHARS) {
    return combined;
  }

  return combined.slice(0, MAX_OUTPUT_CHARS) + "\n...[truncated]";
}

function readTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }

  return Math.min(value, 120_000);
}

function readString(input: unknown, key: string): string | null {
  if (typeof input !== "object" || input === null || !(key in input)) {
    return null;
  }

  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
