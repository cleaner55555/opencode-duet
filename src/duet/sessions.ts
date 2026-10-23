import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeChannelSessionId, slugifyChannel } from "./channels.js";

const execFileAsync = promisify(execFile);

export interface SessionCreator {
  /** Make sure the base session exists before child sessions are linked to it. */
  ensureBase(sessionId: string, cwd: string, title?: string): Promise<void>;
  /** Create an OpenCode child session under `parentId` and return its id. */
  createChild(parentId: string, title: string, cwd?: string): Promise<string>;
  /** Remove a session created for a channel that could not be stored. */
  remove(sessionId: string): Promise<void>;
}

interface ApiSession {
  data?: {
    id?: unknown;
    parentID?: unknown;
  };
}

interface ExecError extends Error {
  stdout?: string;
  stderr?: string;
}

/**
 * Offline fallback used by tests and by hosts where OpenCode is not running.
 * Channels still get isolated sessions, but they are top-level rather than
 * children of the base session.
 */
export class LocalSessionCreator implements SessionCreator {
  async ensureBase(): Promise<void> {}

  async createChild(_parentId: string, title: string): Promise<string> {
    return makeChannelSessionId(slugifyChannel(title.replace(/^#/, "")));
  }

  async remove(): Promise<void> {}
}

/**
 * Creates channels as native OpenCode child sessions. OpenCode hides child
 * sessions from the top-level `opencode session list` and groups them under
 * the parent session, which keeps a Duet workspace reviewable in one place.
 */
export class OpenCodeSessionCreator implements SessionCreator {
  private readonly command: string;
  private readonly timeoutMs: number;

  constructor(command = "opencode", timeoutMs = 20_000) {
    this.command = command;
    this.timeoutMs = timeoutMs;
  }

  async ensureBase(
    sessionId: string,
    cwd: string,
    title = "Duet workspace",
  ): Promise<void> {
    if (await this.exists(sessionId)) return;

    try {
      await this.api("POST", "/api/session", {
        id: sessionId,
        title,
        location: { directory: cwd },
      });
    } catch (error) {
      // Another process may have created it between the GET and the POST.
      if (await this.exists(sessionId)) return;
      throw error;
    }
  }

  async createChild(
    parentId: string,
    title: string,
    _cwd?: string,
  ): Promise<string> {
    const response = await this.api<ApiSession>("POST", "/api/session", {
      parentID: parentId,
      title,
    });
    const id = response?.data?.id;
    if (typeof id !== "string" || !id.startsWith("ses")) {
      throw new Error("OpenCode did not return a child session id");
    }
    return id;
  }

  async remove(sessionId: string): Promise<void> {
    try {
      await this.api("DELETE", `/api/session/${encodeURIComponent(sessionId)}`);
    } catch {
      // Cleanup is best-effort; the channel may already be gone.
    }
  }

  private async exists(sessionId: string): Promise<boolean> {
    try {
      await this.api(
        "GET",
        `/api/session/${encodeURIComponent(sessionId)}`,
      );
      return true;
    } catch {
      return false;
    }
  }

  private async api<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const args = ["api", method, path];
    if (body !== undefined) args.push("-d", JSON.stringify(body));

    try {
      const { stdout } = await execFileAsync(this.command, args, {
        timeout: this.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      });
      const text = stdout.trim();
      return (text ? JSON.parse(text) : undefined) as T;
    } catch (error) {
      const failure = error as ExecError;
      const detail = [failure.stderr, failure.stdout]
        .filter((part): part is string => Boolean(part?.trim()))
        .join("\n")
        .trim();
      throw new Error(
        `opencode api ${method} ${path}: ${
          detail || failure.message || "unknown error"
        }`,
      );
    }
  }
}
