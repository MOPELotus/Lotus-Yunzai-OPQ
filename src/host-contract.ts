export interface ProtocolScope {
  /** The registered adapter and local endpoint label, independent of any remote IDs. */
  readonly adapter: string;
  readonly instance: string;
  readonly platform?: string;
  readonly account: string;
}

export interface ProtocolConversation {
  readonly kind: "private" | "group" | "channel" | "temporary";
  readonly id: string;
  readonly parentId?: string;
  readonly transportKind?: string;
}

export type ProtocolMessagePart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "mention"; readonly id: string }
  | { readonly type: "image" | "audio" | "video" | "file"; readonly id: string; readonly name?: string };

export interface ProtocolIncomingMessage {
  readonly scope: ProtocolScope;
  readonly conversation: ProtocolConversation;
  readonly actor: string;
  readonly messageId: string;
  readonly parts: readonly ProtocolMessagePart[];
  readonly replyTo?: string;
}

export type ProtocolReplyPart =
  | Extract<ProtocolMessagePart, { type: "text" | "mention" }>
  | { readonly type: "image" | "audio" | "video" | "file"; readonly bytes: Uint8Array; readonly name: string };

export type ProtocolReceipt =
  | { readonly status: "accepted"; readonly messageId?: string }
  | { readonly status: "rejected" | "unknown" | "unsupported" };

export interface ProtocolGateway {
  send(message: Pick<ProtocolIncomingMessage, "scope" | "conversation" | "replyTo">,
    parts: readonly ProtocolReplyPart[], signal: AbortSignal): Promise<ProtocolReceipt>;
  start(receive: (message: ProtocolIncomingMessage) => Promise<void>, signal: AbortSignal): Promise<void>;
}

export interface ProtocolPeer {
  send(frame: string): boolean;
  close(): void;
}

export interface ProtocolPeerSession {
  receive(frame: string): Promise<void>;
  close(): void;
}

/** The host authenticates a reverse connection before passing its peer to the adapter. */
export interface ReverseProtocolGateway extends ProtocolGateway {
  accept(peer: ProtocolPeer): ProtocolPeerSession | undefined;
}

/** Preserve the provider's string IDs and separate platform/account identities from QQ IDs. */
export function protocolConversationKey({ scope, conversation }: Pick<ProtocolIncomingMessage, "scope" | "conversation">): string {
  return JSON.stringify([scope.adapter, scope.instance, scope.platform ?? null, scope.account,
    conversation.kind, conversation.transportKind ?? null, conversation.parentId ?? null, conversation.id]);
}
