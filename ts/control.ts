import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { debug } from "./log.ts";

export type ControlResponse = { ok: boolean; message?: string; data?: unknown };
export type ControlHandler = (args: string[]) => Promise<ControlResponse>;

const MAX_REQUEST_BYTES = 64 * 1024;

/** Where `serve` listens and `ctl` connects by default: one instance per user. */
export function defaultSocketPath(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (platform === "win32") {
    const user = (env.USERNAME || userInfo().username).replace(/[^\w.-]/g, "_");
    return `\\\\.\\pipe\\stdinman-${user}`;
  }

  if (env.XDG_RUNTIME_DIR) {
    return join(env.XDG_RUNTIME_DIR, "stdinman.sock");
  }

  return join(tmpdir(), `stdinman-${userInfo().uid}.sock`);
}

function connect(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

/** Removes a socket file left behind by a crashed instance; fails if an instance is still running. */
async function claimSocketPath(path: string): Promise<void> {
  if (process.platform === "win32" || !existsSync(path)) {
    return;
  }

  try {
    const socket = await connect(path);
    socket.destroy();
    throw new Error(`another stdinman instance is already running (control socket ${path})`);
  } catch (connectError) {
    const code = (connectError as NodeJS.ErrnoException).code;
    // A leftover socket from a crashed instance refuses connections (some runtimes report ENOENT).
    if (code === "ECONNREFUSED" || code === "ENOTSOCK" || code === "ENOENT") {
      debug(`removing stale control socket ${path}`);
      unlinkSync(path);
      return;
    }

    throw connectError;
  }
}

/** Serves line-delimited JSON requests `{ "args": [...] }` with one JSON response each. */
export async function startControlServer(path: string, handler: ControlHandler): Promise<{ close: () => void }> {
  await claimSocketPath(path);

  const server: Server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", (socketError) => debug(`[control] client error: ${socketError.message}`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_REQUEST_BYTES) {
        socket.end(`${JSON.stringify({ ok: false, message: "request too large" })}\n`);
        return;
      }

      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        void respond(socket, line);
      }
    });
  });

  const respond = async (socket: Socket, line: string): Promise<void> => {
    let response: ControlResponse;
    try {
      const request = JSON.parse(line) as { args?: unknown };
      if (!Array.isArray(request.args) || !request.args.every((arg) => typeof arg === "string")) {
        throw new Error("request must be {\"args\": [string, ...]}");
      }

      response = await handler(request.args as string[]);
    } catch (requestError) {
      response = { ok: false, message: requestError instanceof Error ? requestError.message : String(requestError) };
    }

    if (!socket.destroyed) {
      socket.write(`${JSON.stringify(response)}\n`);
    }
  };

  await new Promise<void>((resolve, reject) => {
    const onError = (listenError: Error): void => {
      reject(new Error(`cannot listen on the control socket ${path} (${listenError.message}); is another stdinman instance already running?`));
    };
    server.once("error", onError);
    server.listen(path, () => {
      server.off("error", onError);
      resolve();
    });
  });

  if (process.platform !== "win32") {
    // Only this user may control the instance.
    chmodSync(path, 0o600);
  }

  server.on("error", (serverError) => debug(`[control] server error: ${serverError.message}`));
  return {
    close: () => {
      server.close();
      if (process.platform !== "win32") {
        try {
          unlinkSync(path);
        } catch {
          // Already gone.
        }
      }
    },
  };
}

/** Sends one request to a running `serve` instance and returns its response. */
export async function sendControl(path: string, args: string[], timeoutMs = 30_000): Promise<ControlResponse> {
  let socket: Socket;
  try {
    socket = await connect(path);
  } catch (connectError) {
    const code = (connectError as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ECONNREFUSED") {
      throw new Error(`no running stdinman instance found (control socket ${path}); start one with "stdinman serve"`);
    }

    throw connectError;
  }

  return await new Promise<ControlResponse>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("timed out waiting for the stdinman instance to respond"));
    }, timeoutMs);

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        clearTimeout(timer);
        socket.end();
        try {
          resolve(JSON.parse(buffer.slice(0, newline)) as ControlResponse);
        } catch (parseError) {
          reject(parseError);
        }
      }
    });
    socket.on("error", (socketError) => {
      clearTimeout(timer);
      reject(socketError);
    });
    socket.write(`${JSON.stringify({ args })}\n`);
  });
}
