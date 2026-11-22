const mediaSizeLimit = 10 * 1024 * 1024;
const maxFrameBytes = 1024 * 1024;
const unsignedDecimal = /^(?:0|[1-9][0-9]{0,19})$/;
const uint64Limit = 18446744073709551615n;

// Bun supports the ES JSON source and raw JSON operations ahead of our TypeScript library declarations.
const losslessJson = JSON as unknown as {
  parse(text: string, reviver: (key: string, value: unknown, context: { source?: string }) => unknown): unknown;
  rawJSON(text: string): object;
};

export interface OpqQuote {
  readonly uid: string;
  readonly seq: number;
  readonly time: number;
}

export type OpqTarget =
  | { readonly kind: "friend"; readonly userId: number }
  | { readonly kind: "group"; readonly groupId: number }
  | { readonly kind: "temporary"; readonly userId: number; readonly groupId: number };

export type OpqInboundPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "at"; readonly qq: number | "all" }
  | { readonly type: "image"; readonly url: string };

export interface OpqInboundMessage {
  readonly kind: "message";
  readonly selfId: number;
  readonly userId: number;
  readonly messageId?: string;
  readonly target: OpqTarget;
  readonly nickname?: string;
  readonly card?: string;
  readonly groupName?: string;
  readonly quote?: OpqQuote;
  readonly parts: readonly OpqInboundPart[];
}

export type OpqAcknowledgement =
  | { readonly status: "accepted"; readonly data: Readonly<Record<string, unknown>> | undefined }
  | { readonly status: "rejected"; readonly code: number }
  | { readonly status: "unknown" };

export interface OpqLogin {
  readonly kind: "login";
  readonly selfId: number;
}

export interface OpqReceipt {
  readonly kind: "receipt";
  readonly requestId: number;
  readonly selfId?: number;
  readonly acknowledgement: OpqAcknowledgement;
}

export type OpqOutboundPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "at"; readonly qq: number }
  | { readonly type: "image"; readonly bytes: Uint8Array }
  | { readonly type: "record"; readonly bytes: Uint8Array };

interface OpqImage {
  readonly FileId: number;
  readonly FileMd5: string;
  readonly FileSize: number;
  readonly Height?: number;
  readonly Width?: number;
}

interface OpqVoice {
  readonly FileMd5: string;
  readonly FileSize: number;
  readonly FileToken: string;
  readonly VoiceTime?: number;
}

export type OpqImageUpload = { readonly type: "image"; readonly file: OpqImage };
export type OpqVoiceUpload = { readonly type: "record"; readonly file: OpqVoice };
export type OpqPreparedPart = Exclude<OpqOutboundPart, { type: "image" | "record" }> | OpqImageUpload | OpqVoiceUpload;

export type OpqRequest = { readonly command: "MessageSvc.PbSendMsg" | "PicUp.DataUp"; readonly fields: Readonly<Record<string, unknown>> };

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Readonly<Record<string, unknown>>;
}

function positiveSafeInteger(value: unknown): number | undefined {
  if (typeof value === "string" && unsignedDecimal.test(value)) value = Number(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
}

function unsignedId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) value = String(value);
  if (typeof value === "string" && unsignedDecimal.test(value) && value !== "0" && BigInt(value) <= uint64Limit) return value;
}

function string(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
}

function pictureLink(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 8192) return;
  try {
    const url = new URL(value);
    const host = url.hostname;
    if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password && !url.port &&
      (host.endsWith(".qpic.cn") || host === "multimedia.nt.qq.com")) return url.href;
  } catch {
    return;
  }
}

function receivedParts(body: Readonly<Record<string, unknown>>): OpqInboundPart[] {
  const parts: OpqInboundPart[] = [];
  if (Array.isArray(body.AtUinLists)) {
    for (const item of body.AtUinLists) {
      const value = record(item)?.Uin;
      const qq = value === 0 || value === "0" ? "all" : positiveSafeInteger(value);
      if (qq) parts.push({ type: "at", qq });
    }
  }

  if (typeof body.Content === "string" && body.Content) parts.push({ type: "text", text: body.Content });

  if (Array.isArray(body.Images)) {
    for (const item of body.Images) {
      const url = pictureLink(record(item)?.Url);
      if (url) parts.push({ type: "image", url });
    }
  }
  return parts;
}

function receivedMessage(packet: Readonly<Record<string, unknown>>, selfId: number): OpqInboundMessage | undefined {
  const eventName = packet.EventName;
  if (eventName !== "ON_EVENT_FRIEND_NEW_MSG" && eventName !== "ON_EVENT_GROUP_NEW_MSG") return;

  const event = record(packet.EventData);
  const head = record(event?.MsgHead);
  const body = record(event?.MsgBody);
  if (!head || !body || (body.SubMsgType !== undefined && body.SubMsgType !== 0)) return;

  const userId = positiveSafeInteger(head.SenderUin);
  if (!userId || userId === selfId || (head.ToUin !== undefined && positiveSafeInteger(head.ToUin) !== selfId)) return;

  const group = record(head.GroupInfo);
  let target: OpqTarget;
  if (eventName === "ON_EVENT_GROUP_NEW_MSG") {
    const groupId = positiveSafeInteger(group?.GroupCode);
    if (!groupId || (head.FromType !== undefined && head.FromType !== 2)) return;
    target = { kind: "group", groupId };
  } else if (head.FromType === 3) {
    const groupId = positiveSafeInteger(record(head.C2CTempMessageHead)?.GroupCode ?? group?.GroupCode);
    if (!groupId) return;
    target = { kind: "temporary", userId, groupId };
  } else {
    if (head.FromType !== undefined && head.FromType !== 1) return;
    target = { kind: "friend", userId };
  }

  const parts = receivedParts(body);
  if (!parts.length) return;

  const uid = unsignedId(head.MsgUid);
  const seq = positiveSafeInteger(head.MsgSeq);
  const time = positiveSafeInteger(head.MsgTime);
  return { kind: "message", selfId, userId, messageId: uid, target, nickname: string(head.SenderNick), card: string(group?.GroupCard),
    groupName: string(group?.GroupName), quote: uid && seq && time ? { uid, seq, time } : undefined, parts };
}

export function decodeOpqFrame(frame: string | Uint8Array): OpqInboundMessage | OpqReceipt | OpqLogin | undefined {
  if (frame.length > maxFrameBytes) return;
  let data: Readonly<Record<string, unknown>> | undefined;
  try {
    const text = typeof frame === "string" ? frame : new TextDecoder("utf-8", { fatal: true }).decode(frame);
    if (Buffer.byteLength(text) > maxFrameBytes) return;
    data = record(losslessJson.parse(text, (key, value, context) => {
      // OPQ's original message identity can exceed a JavaScript number's safe range.
      if (key === "MsgUid" && typeof value === "number") return context.source;
      return value;
    }));
  } catch {
    return;
  }
  if (!data) return;

  if (Object.hasOwn(data, "CurrentPacket")) {
    const packet = record(data.CurrentPacket);
    const selfId = positiveSafeInteger(data.CurrentQQ);
    if (!selfId || !packet || Object.hasOwn(data, "ReqId")) return;
    if (packet.EventName === "ON_EVENT_LOGIN_SUCCESS") {
      if (positiveSafeInteger(record(packet.EventData)?.Uin) === selfId) return { kind: "login", selfId };
      return;
    }
    return receivedMessage(packet, selfId);
  }

  const requestId = positiveSafeInteger(data.ReqId);
  const currentQq = positiveSafeInteger(data.CurrentQQ);
  const botUin = positiveSafeInteger(data.BotUin);
  if (!requestId || (data.CurrentQQ !== undefined && !currentQq) || (data.BotUin !== undefined && !botUin)) return;
  if (currentQq && botUin && currentQq !== botUin) return;
  const selfId = currentQq ?? botUin;
  const code = record(data.CgiBaseResponse)?.Ret;
  const acknowledgement: OpqAcknowledgement = code === 0 ? { status: "accepted", data: record(data.ResponseData) }
    : typeof code === "number" && Number.isSafeInteger(code) ? { status: "rejected", code } : { status: "unknown" };
  return { kind: "receipt", requestId, ...(selfId !== undefined && { selfId }), acknowledgement };
}

export function encodeOpqRequest(selfId: number, requestId: number, request: OpqRequest): string | undefined {
  if (!positiveSafeInteger(selfId) || !positiveSafeInteger(requestId)) return;
  return JSON.stringify({ BotUin: String(selfId), CgiCmd: request.command, CgiRequest: request.fields, ReqId: requestId });
}

export function acceptedMessageId(reply: OpqAcknowledgement): string | undefined {
  if (reply.status === "accepted") return unsignedId(reply.data?.MsgUid);
}

export function acceptedMessageSequence(reply: OpqAcknowledgement): number | undefined {
  if (reply.status === "accepted") return positiveSafeInteger(reply.data?.MsgSeq);
}

function targetFields(target: OpqTarget): Readonly<Record<string, unknown>> | undefined {
  if (target.kind === "group" && positiveSafeInteger(target.groupId)) return { ToUin: target.groupId, ToType: 2 };
  if (target.kind === "friend" && positiveSafeInteger(target.userId)) return { ToUin: target.userId, ToType: 1 };
  if (target.kind === "temporary" && positiveSafeInteger(target.userId) && positiveSafeInteger(target.groupId)) {
    return { ToUin: target.userId, ToType: 3, GroupCode: target.groupId };
  }
}

export function opqUploadRequest(target: OpqTarget, part: Extract<OpqOutboundPart, { type: "image" | "record" }>): OpqRequest | undefined {
  if (!targetFields(target) || !part.bytes.byteLength || part.bytes.byteLength > mediaSizeLimit) return;
  const commandId = part.type === "image" ? (target.kind === "group" ? 2 : 1) : (target.kind === "group" ? 29 : 26);
  return { command: "PicUp.DataUp", fields: { CommandId: commandId, Base64Buf: Buffer.from(part.bytes).toString("base64") } };
}

export function opqMediaBytes(input: string | Uint8Array): Uint8Array | undefined {
  if (input instanceof Uint8Array) {
    if (input.byteLength > 0 && input.byteLength <= mediaSizeLimit) return input;
    return;
  }

  if (typeof input !== "string" || !input.startsWith("base64://")) return;
  const encodedLength = input.length - "base64://".length;
  if (!encodedLength || encodedLength > Math.ceil(mediaSizeLimit / 3) * 4) return;
  const encoded = input.slice("base64://".length);
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength > 0 && bytes.byteLength <= mediaSizeLimit && bytes.toString("base64") === encoded) return bytes;
}

export function acceptedImageUpload(reply: OpqAcknowledgement): OpqImageUpload | undefined {
  if (reply.status !== "accepted") return;
  const file = reply.data;
  const FileId = positiveSafeInteger(file?.FileId);
  const FileSize = positiveSafeInteger(file?.FileSize);
  const FileMd5 = string(file?.FileMd5);
  if (!FileId || !FileSize || !FileMd5) return;
  return { type: "image", file: { FileId, FileSize, FileMd5, Height: positiveSafeInteger(file?.Height), Width: positiveSafeInteger(file?.Width) } };
}

export function acceptedVoiceUpload(reply: OpqAcknowledgement): OpqVoiceUpload | undefined {
  if (reply.status !== "accepted") return;
  const file = reply.data;
  const FileSize = positiveSafeInteger(file?.FileSize);
  const FileMd5 = string(file?.FileMd5);
  const FileToken = string(file?.FileToken);
  if (!FileSize || !FileMd5 || !FileToken) return;
  return { type: "record", file: { FileSize, FileMd5, FileToken, VoiceTime: positiveSafeInteger(file?.VoiceTime) } };
}

export function opqMessageRequest(target: OpqTarget, parts: readonly OpqPreparedPart[], quote?: OpqQuote): OpqRequest | undefined {
  const address = targetFields(target);
  if (!address || (quote && target.kind !== "group")) return;

  let ReplyTo: Readonly<Record<string, unknown>> | undefined;
  if (quote) {
    const uid = unsignedId(quote.uid);
    if (!uid || !positiveSafeInteger(quote.seq) || !positiveSafeInteger(quote.time)) return;
    ReplyTo = { MsgSeq: quote.seq, MsgTime: quote.time, MsgUid: losslessJson.rawJSON(uid) };
  }

  let Content = "";
  const Images: OpqImage[] = [];
  const AtUinLists: { Uin: number }[] = [];
  let Voice: OpqVoice | undefined;
  for (const part of parts) {
    switch (part.type) {
      case "text":
        Content += part.text;
        break;
      case "at":
        if (target.kind !== "group" || !positiveSafeInteger(part.qq)) return;
        AtUinLists.push({ Uin: part.qq });
        break;
      case "image":
        Images.push(part.file);
        break;
      case "record":
        if (Voice) return;
        Voice = part.file;
        break;
    }
  }
  if (!Content && !Images.length && !AtUinLists.length && !Voice) return;

  return { command: "MessageSvc.PbSendMsg", fields: { ...address, ReplyTo, Content, Images, AtUinLists, Voice } };
}
