import { randomInt } from "node:crypto";
import {
  acceptedImageUpload,
  acceptedMessageId,
  acceptedMessageSequence,
  acceptedVoiceUpload,
  encodeOpqRequest,
  opqMessageRequest,
  opqUploadRequest,
  type OpqAcknowledgement,
  type OpqOutboundPart,
  type OpqPreparedPart,
  type OpqQuote,
  type OpqReceipt,
  type OpqRequest,
  type OpqTarget,
} from "./protocol.ts";

const unknownAcknowledgement = { status: "unknown" } as const;
const requestTimeoutMs = 30_000;
const maxPendingRequests = 128;

export interface OpqRequestSession {
  readonly request: (selfId: number, request: OpqRequest, signal: AbortSignal) => Promise<OpqAcknowledgement>;
  readonly receive: (receipt: OpqReceipt) => void;
  readonly close: () => void;
}

/** One callback and pending map per connection. A replacement connection cannot resolve the old requests. */
export function createOpqRequestSession(write: (data: string) => boolean): OpqRequestSession {
  const pending = new Map<number, { readonly selfId: number; readonly finish: (reply: OpqAcknowledgement) => void }>();
  let closed = false;
  let requestId = randomInt(1, 2 ** 47);

  return {
    request(selfId, request, signal) {
      if (closed || signal.aborted || pending.size >= maxPendingRequests) return Promise.resolve(unknownAcknowledgement);

      const id = ++requestId;
      const frame = encodeOpqRequest(selfId, id, request);
      if (!frame) return Promise.resolve(unknownAcknowledgement);

      return new Promise(resolve => {
        const finish = (reply: OpqAcknowledgement) => {
          clearTimeout(timeout);
          pending.delete(id);
          signal.removeEventListener("abort", abort);
          resolve(reply);
        };
        const abort = () => finish(unknownAcknowledgement);
        const timeout = setTimeout(abort, requestTimeoutMs);
        pending.set(id, { selfId, finish });
        signal.addEventListener("abort", abort, { once: true });

        try {
          if (!write(frame)) abort();
        } catch {
          abort();
        }
      });
    },
    receive(receipt) {
      const entry = pending.get(receipt.requestId);
      if (entry && (receipt.selfId === undefined || receipt.selfId === entry.selfId)) entry.finish(receipt.acknowledgement);
    },
    close() {
      if (closed) return;
      closed = true;
      for (const { finish } of pending.values()) finish(unknownAcknowledgement);
    },
  };
}

export type OpqDelivery =
  | { readonly status: "accepted"; readonly messageId?: string; readonly messageSequence?: number }
  | { readonly status: "rejected"; readonly code: number }
  | { readonly status: "unsupported" | "unknown" };

/** The caller must normalize and validate every part before starting an upload. */
export async function sendOpqMessage(
  session: Pick<OpqRequestSession, "request">,
  selfId: number,
  target: OpqTarget,
  parts: readonly OpqOutboundPart[],
  signal: AbortSignal,
  quote?: OpqQuote,
): Promise<OpqDelivery> {
  if (signal.aborted) return { status: "unknown" };
  if (!parts.length || (quote && target.kind !== "group") ||
    parts.some(part => part.type === "at" && target.kind !== "group") ||
    parts.filter(part => part.type === "record").length > 1) return { status: "unsupported" };

  const prepared: OpqPreparedPart[] = [];
  for (const part of parts) {
    if (part.type === "image" || part.type === "record") {
      const upload = opqUploadRequest(target, part);
      if (!upload) return { status: "unsupported" };
      const reply = await session.request(selfId, upload, signal);
      if (reply.status !== "accepted") return reply;
      const file = part.type === "image" ? acceptedImageUpload(reply) : acceptedVoiceUpload(reply);
      if (!file) return { status: "unknown" };
      prepared.push(file);
    } else {
      prepared.push(part);
    }
  }
  const request = opqMessageRequest(target, prepared, quote);
  if (!request) return { status: "unsupported" };
  if (signal.aborted) return { status: "unknown" };
  const reply = await session.request(selfId, request, signal);
  if (reply.status !== "accepted") return reply;
  return { status: "accepted", messageId: acceptedMessageId(reply), messageSequence: acceptedMessageSequence(reply) };
}
