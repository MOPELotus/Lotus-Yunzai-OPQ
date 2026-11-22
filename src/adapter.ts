import {
  protocolConversationKey,
  type ProtocolConversation,
  type ProtocolIncomingMessage,
  type ProtocolMessagePart,
  type ProtocolReplyPart,
  type ProtocolScope,
  type ProtocolPeer,
  type ProtocolPeerSession,
  type ReverseProtocolGateway,
} from "./host-contract.ts";
import { decodeOpqFrame, opqMediaBytes, type OpqInboundMessage, type OpqOutboundPart, type OpqQuote, type OpqTarget } from "./protocol.ts";
import { createOpqRequestSession, sendOpqMessage, type OpqRequestSession } from "./session.ts";

const maxConnections = 16;
const maxQuoteReferences = 1024;
const quoteLifetimeMs = 10 * 60_000;

export interface OpqConfig {
  readonly instance: string;
  readonly accounts: readonly string[];
}

interface AttachedConnection {
  readonly requests: OpqRequestSession;
  readonly accounts: Set<string>;
  readonly quotes: Map<string, { readonly quote: OpqQuote; readonly expires: number }>;
  readonly signal: AbortSignal;
  readonly stop: () => void;
}

function qqNumber(value: string): number | undefined {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,15}$/.test(value)) return;
  const id = Number(value);
  if (Number.isSafeInteger(id)) return id;
}

function opqTarget(conversation: ProtocolConversation): OpqTarget | undefined {
  if (conversation.transportKind !== undefined) return;
  const id = qqNumber(conversation.id);
  if (!id) return;
  if (conversation.kind === "temporary") {
    const groupId = qqNumber(conversation.parentId ?? "");
    if (groupId) return { kind: "temporary", userId: id, groupId };
    return;
  }
  if (conversation.parentId !== undefined) return;
  if (conversation.kind === "private") return { kind: "friend", userId: id };
  if (conversation.kind === "group") return { kind: "group", groupId: id };
}

function protocolConversation(target: OpqTarget): ProtocolConversation {
  switch (target.kind) {
    case "friend":
      return { kind: "private", id: String(target.userId) };
    case "group":
      return { kind: "group", id: String(target.groupId) };
    case "temporary":
      return { kind: "temporary", id: String(target.userId), parentId: String(target.groupId) };
  }
}

function incomingOpqMessage(scope: ProtocolScope, message: OpqInboundMessage): ProtocolIncomingMessage | undefined {
  if (!message.messageId) return;
  const parts: ProtocolMessagePart[] = [];
  for (const part of message.parts) {
    switch (part.type) {
      case "text":
        parts.push(part);
        break;
      case "at":
        parts.push({ type: "mention", id: String(part.qq) });
        break;
      case "image":
        parts.push({ type: "image", id: part.url });
        break;
    }
  }

  return { scope, conversation: protocolConversation(message.target), actor: String(message.userId), messageId: message.messageId, parts };
}

function replyParts(parts: readonly ProtocolReplyPart[]): OpqOutboundPart[] | undefined {
  const result: OpqOutboundPart[] = [];
  for (const part of parts) {
    switch (part.type) {
      case "text":
        result.push(part);
        break;
      case "mention": {
        const qq = qqNumber(part.id);
        if (!qq) return;
        result.push({ type: "at", qq });
        break;
      }
      case "image":
      case "audio": {
        const bytes = opqMediaBytes(part.bytes);
        if (!bytes) return;
        result.push({ type: part.type === "image" ? "image" : "record", bytes });
        break;
      }
      case "file":
      case "video":
        return;
    }
  }
  return result;
}

function quoteKey(message: Pick<ProtocolIncomingMessage, "scope" | "conversation">, messageId: string): string {
  return JSON.stringify([protocolConversationKey(message), messageId]);
}

export function createOpqAdapter(config: OpqConfig): ReverseProtocolGateway {
  const instance = config.instance;
  const allowedAccounts = new Set(config.accounts);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(instance) || !allowedAccounts.size ||
    allowedAccounts.size > 32 || [...allowedAccounts].some(account => !qqNumber(account))) throw new Error("OPQ 适配器实例或账号配置无效。");

  const attached = new Set<AttachedConnection>();
  const byAccount = new Map<string, AttachedConnection>();
  let runtime: { readonly receive: (message: ProtocolIncomingMessage) => Promise<void>; readonly signal: AbortSignal } | undefined;

  return {
    async start(receive, signal) {
      if (signal.aborted) return;
      if (runtime) throw new Error("OPQ 适配器已经启动。");
      runtime = { receive, signal };
      signal.addEventListener("abort", () => {
        runtime = undefined;
        for (const connection of attached) connection.stop();
      }, { once: true });
    },

    accept(transport: ProtocolPeer): ProtocolPeerSession | undefined {
      const active = runtime;
      if (!active || active.signal.aborted || attached.size >= maxConnections) return;

      const lifecycle = new AbortController();
      const connection: AttachedConnection = {
        requests: createOpqRequestSession(frame => transport.send(frame)),
        accounts: new Set(),
        quotes: new Map(),
        signal: lifecycle.signal,
        stop() {
          close();
          try {
            transport.close();
          } catch {
            // Local cleanup already completed.
          }
        },
      };

      function close() {
        if (lifecycle.signal.aborted) return;
        lifecycle.abort();
        connection.requests.close();
        for (const account of connection.accounts) {
          if (byAccount.get(account) === connection) byAccount.delete(account);
        }
        connection.accounts.clear();
        connection.quotes.clear();
        attached.delete(connection);
      }

      attached.add(connection);
      return {
        close,
        async receive(frame) {
          if (connection.signal.aborted || active.signal.aborted) return;
          const packet = decodeOpqFrame(frame);
          if (!packet) return;
          if (packet.kind === "receipt") {
            connection.requests.receive(packet);
            return;
          }

          const account = String(packet.selfId);
          if (!allowedAccounts.has(account)) return;
          const previous = byAccount.get(account);
          if (previous && previous !== connection) return;
          connection.accounts.add(account);
          byAccount.set(account, connection);
          if (packet.kind === "login") return;

          const incoming = incomingOpqMessage({ adapter: "opq", instance, platform: "qq", account }, packet);
          if (!incoming) return;
          if (packet.quote && incoming.conversation.kind === "group") {
            const key = quoteKey(incoming, incoming.messageId);
            connection.quotes.delete(key);
            connection.quotes.set(key, { quote: packet.quote, expires: Date.now() + quoteLifetimeMs });
            if (connection.quotes.size > maxQuoteReferences) {
              const oldest = connection.quotes.keys().next().value;
              if (oldest !== undefined) connection.quotes.delete(oldest);
            }
          }
          await active.receive(incoming);
        },
      };
    },

    async send(address, parts, signal) {
      const { scope, conversation, replyTo } = address;
      if (scope.adapter !== "opq" || scope.platform !== "qq" || scope.instance !== instance || !allowedAccounts.has(scope.account)) {
        return { status: "unsupported" };
      }
      const account = qqNumber(scope.account);
      const target = opqTarget(conversation);
      const output = replyParts(parts);
      if (!account || !target || !output?.length) return { status: "unsupported" };

      const connection = byAccount.get(scope.account);
      if (!connection || signal.aborted || connection.signal.aborted) return { status: "unknown" };
      let quote: OpqQuote | undefined;
      if (replyTo !== undefined) {
        const reference = connection.quotes.get(quoteKey(address, replyTo));
        if (!reference || reference.expires <= Date.now()) return { status: "unsupported" };
        quote = reference.quote;
      }
      const receipt = await sendOpqMessage(connection.requests, account, target, output, AbortSignal.any([signal, connection.signal]), quote);
      return receipt.status === "accepted" ? { status: "accepted", messageId: receipt.messageId } : { status: receipt.status };
    },
  };
}
