import type { ChildProcess } from "node:child_process";
import spawn from "cross-spawn";
import { Readable, Writable } from "node:stream";

import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionId,
} from "@agentclientprotocol/sdk";

import type { AcpAgentOptions } from "./types.js";
import { ResponseCollector } from "./response-collector.js";

function log(msg: string) {
  console.log(`[acp] ${msg}`);
}

function selectAllowOption(options: PermissionOption[]): PermissionOption | undefined {
  return (
    options.find((option) => option.kind === "allow_once") ??
    options.find((option) => option.kind === "allow_always")
  );
}

function selectRejectOption(options: PermissionOption[]): PermissionOption | undefined {
  return (
    options.find((option) => option.kind === "reject_once") ??
    options.find((option) => option.kind === "reject_always")
  );
}

/**
 * Manages the ACP agent subprocess and ClientSideConnection lifecycle.
 */
export class AcpConnection {
  private process: ChildProcess | null = null;
  private connection: ClientSideConnection | null = null;
  private ready = false;
  private collectors = new Map<SessionId, ResponseCollector>();

  constructor(private options: AcpAgentOptions) {}

  registerCollector(sessionId: SessionId, collector: ResponseCollector): void {
    this.collectors.set(sessionId, collector);
  }

  unregisterCollector(sessionId: SessionId): void {
    this.collectors.delete(sessionId);
  }

  private handlePermissionRequest(params: RequestPermissionRequest): RequestPermissionResponse {
    const allowOption = selectAllowOption(params.options);
    if (allowOption) {
      log(
        `permission: auto-approved "${params.toolCall.title ?? params.toolCall.toolCallId}" -> "${allowOption.optionId}"`,
      );
      return {
        outcome: {
          outcome: "selected",
          optionId: allowOption.optionId,
        },
      };
    }

    const rejectOption = selectRejectOption(params.options);
    log(`permission: no allow option for "${params.toolCall.title ?? params.toolCall.toolCallId}"`);
    if (!rejectOption) {
      return { outcome: { outcome: "cancelled" } };
    }

    return {
      outcome: {
        outcome: "selected",
        optionId: rejectOption.optionId,
      },
    };
  }

  /**
   * Ensure the subprocess is running and the connection is initialized.
   */
  async ensureReady(): Promise<ClientSideConnection> {
    if (this.ready && this.connection) {
      return this.connection;
    }

    const args = this.options.args ?? [];
    log(`spawning: ${this.options.command} ${args.join(" ")}`);

    const proc = spawn(this.options.command, args, {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, ...this.options.env },
      cwd: this.options.cwd,
    });
    this.process = proc;

    proc.on("exit", (code) => {
      log(`subprocess exited (code=${code})`);
      this.ready = false;
      this.connection = null;
      this.process = null;
    });

    const writable = Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>;
    const readable = Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(writable, readable);

    const conn = new ClientSideConnection((_agent) => ({
      sessionUpdate: async (params) => {
        const update = params.update;
        switch (update.sessionUpdate) {
          case "tool_call":
            log(`tool_call: ${update.title} (${update.status ?? "started"})`);
            break;
          case "tool_call_update":
            if (update.status) {
              log(`tool_call_update: ${update.title ?? update.toolCallId} → ${update.status}`);
            }
            break;
          case "agent_thought_chunk":
            if (update.content.type === "text") {
              log(`thinking: ${update.content.text.slice(0, 100)}`);
            }
            break;
        }
        const collector = this.collectors.get(params.sessionId);
        if (collector) {
          collector.handleUpdate(params);
        }
      },
      requestPermission: async (params) => {
        return this.handlePermissionRequest(params);
      },
    }), stream);

    log("initializing connection...");
    await conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "weixin-agent-sdk", version: "0.1.0" },
      clientCapabilities: {},
    });
    log("connection initialized");

    this.connection = conn;
    this.ready = true;
    return conn;
  }

  /**
   * Kill the subprocess and clean up.
   */
  dispose(): void {
    this.ready = false;
    this.collectors.clear();
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.connection = null;
  }
}
