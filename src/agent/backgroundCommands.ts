import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs/promises";

const MAX_OUTPUT = 64_000;
const MAX_JOBS = 8;

export interface BackgroundJob {
  id: string;
  command: string;
  cwdDisplay: string;
  startedAt: number;
  done: boolean;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

const jobs = new Map<string, BackgroundJob & { child?: ChildProcess }>();
let seq = 0;

function clip(s: string): string {
  return s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n…(truncated)` : s;
}

function formatJob(j: BackgroundJob): string {
  const age = Math.round((Date.now() - j.startedAt) / 1000);
  if (!j.done) {
    return [
      `job: ${j.id}`,
      `status: running (${age}s)`,
      `cwd: ${j.cwdDisplay}`,
      `command: ${j.command}`,
      "",
      "--- stdout (so far) ---",
      clip(j.stdout) || "(empty)",
      "",
      "--- stderr (so far) ---",
      clip(j.stderr) || "(empty)",
    ].join("\n");
  }
  return [
    `job: ${j.id}`,
    j.timedOut
      ? "status: timeout"
      : j.error
        ? `status: error (${j.error})`
        : `status: done exit=${j.exitCode ?? "null"}`,
    `cwd: ${j.cwdDisplay}`,
    `command: ${j.command}`,
    "",
    "--- stdout ---",
    clip(j.stdout) || "(empty)",
    "",
    "--- stderr ---",
    clip(j.stderr) || "(empty)",
  ].join("\n");
}

function pruneFinished(): void {
  if (jobs.size <= MAX_JOBS) {
    return;
  }
  const finished = [...jobs.values()]
    .filter((j) => j.done)
    .sort((a, b) => a.startedAt - b.startedAt);
  while (jobs.size > MAX_JOBS && finished.length) {
    const old = finished.shift();
    if (old) {
      jobs.delete(old.id);
    }
  }
}

/** Start a shell command without blocking the agent loop. */
export async function startBackgroundCommand(opts: {
  command: string;
  cwdAbsolute: string;
  cwdDisplay: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; content: string; jobId?: string }> {
  const cmd = (opts.command || "").trim();
  if (!cmd) {
    return { ok: false, content: "background command requires a non-empty command." };
  }
  try {
    const st = await fs.stat(opts.cwdAbsolute);
    if (!st.isDirectory()) {
      return { ok: false, content: `cwd is not a directory: ${opts.cwdDisplay}` };
    }
  } catch {
    return { ok: false, content: `cwd does not exist: ${opts.cwdDisplay}` };
  }

  pruneFinished();
  const id = `bg-${++seq}-${Date.now().toString(36)}`;
  const timeout = Math.min(
    Math.max(5_000, opts.timeoutMs ?? 300_000),
    600_000
  );

  const job: BackgroundJob & { child?: ChildProcess } = {
    id,
    command: cmd,
    cwdDisplay: opts.cwdDisplay,
    startedAt: Date.now(),
    done: false,
    exitCode: null,
    timedOut: false,
    stdout: "",
    stderr: "",
  };

  const child = spawn(cmd, {
    cwd: opts.cwdAbsolute,
    shell: true,
    windowsHide: true,
    env: process.env,
  });
  job.child = child;
  jobs.set(id, job);

  child.stdout?.on("data", (buf: Buffer) => {
    job.stdout += buf.toString("utf8");
    if (job.stdout.length > MAX_OUTPUT * 2) {
      job.stdout = job.stdout.slice(-MAX_OUTPUT);
    }
  });
  child.stderr?.on("data", (buf: Buffer) => {
    job.stderr += buf.toString("utf8");
    if (job.stderr.length > MAX_OUTPUT * 2) {
      job.stderr = job.stderr.slice(-MAX_OUTPUT);
    }
  });

  const timer = setTimeout(() => {
    job.timedOut = true;
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, 2_000);
  }, timeout);

  child.on("close", (code) => {
    clearTimeout(timer);
    job.done = true;
    job.exitCode = code;
    job.child = undefined;
  });
  child.on("error", (err) => {
    clearTimeout(timer);
    job.done = true;
    job.error = err.message;
    job.child = undefined;
  });

  return {
    ok: true,
    jobId: id,
    content: [
      `Started background job ${id} (timeout ${timeout}ms).`,
      `Use await_background_command with job_id="${id}" to wait, or list_background_commands.`,
      formatJob(job),
    ].join("\n"),
  };
}

export async function awaitBackgroundCommand(
  jobId: string,
  waitMs = 120_000
): Promise<{ ok: boolean; content: string }> {
  const id = (jobId || "").trim();
  const job = jobs.get(id);
  if (!job) {
    return {
      ok: false,
      content: `Unknown job_id "${id}". Use list_background_commands.`,
    };
  }
  const deadline = Date.now() + Math.min(Math.max(1_000, waitMs), 300_000);
  while (!job.done && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!job.done) {
    return {
      ok: true,
      content: [
        `Still running after wait (use await_background_command again).`,
        formatJob(job),
      ].join("\n"),
    };
  }
  const ok = !job.timedOut && !job.error && job.exitCode === 0;
  return { ok, content: formatJob(job) };
}

export function listBackgroundCommands(): { ok: boolean; content: string } {
  if (!jobs.size) {
    return { ok: true, content: "No background commands." };
  }
  const lines = [...jobs.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((j) => {
      const age = Math.round((Date.now() - j.startedAt) / 1000);
      const st = j.done
        ? j.timedOut
          ? "timeout"
          : j.error
            ? "error"
            : `exit=${j.exitCode}`
        : `running ${age}s`;
      return `${j.id}\t${st}\t${j.command.slice(0, 120)}`;
    });
  return {
    ok: true,
    content: ["Background jobs:", ...lines].join("\n"),
  };
}
