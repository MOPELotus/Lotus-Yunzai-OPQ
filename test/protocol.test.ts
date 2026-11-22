import { describe, expect, test } from "bun:test";
import {
  acceptedImageUpload,
  acceptedMessageId,
  acceptedMessageSequence,
  acceptedVoiceUpload,
  decodeOpqFrame,
  encodeOpqRequest,
  opqMediaBytes,
  opqMessageRequest,
  opqUploadRequest,
  type OpqAcknowledgement,
} from "../src/protocol.ts";

const group = { kind: "group", groupId: 57001 } as const;
const friend = { kind: "friend", userId: 58001 } as const;
const temporary = { kind: "temporary", groupId: 57001, userId: 58001 } as const;
const text = { type: "text", text: "测试" } as const;
const quoteUid = "72057594201400861";
const png = new Uint8Array([137, 80, 78, 71]);

function messageFrame(eventName: string, head: Record<string, unknown>, body: Record<string, unknown>, currentQq = 50001) {
  return JSON.stringify({
    CurrentQQ: currentQq,
    CurrentPacket: { EventName: eventName, EventData: { MsgHead: { SenderUin: 58001, ...head }, MsgBody: body } },
  });
}

describe("OPQ receive mapping", () => {
  test("group sender, mention, text, image and exact 64-bit quote ID", () => {
    const input = messageFrame("ON_EVENT_GROUP_NEW_MSG", {
      FromType: 2,
      SenderNick: "昵称",
      GroupInfo: { GroupCode: 57001, GroupName: "群名", GroupCard: "群名片" },
      MsgUid: 1,
      MsgTime: 1731000000,
      MsgSeq: 2306,
    }, {
      SubMsgType: 0,
      Content: "#状态",
      AtUinLists: [{ Uin: 50001 }, { Uin: 0 }, { Uin: null }],
      Images: [{ Url: "http://gchat.qpic.cn/picture?tag=yes" }, { Url: "https://multimedia.nt.qq.com/n" },
        { Url: "https://another.example/n" }, { Url: "http://127.0.0.1/n" },
        { Url: "https://user:passwd@image.qpic.cn/n" }, { Url: "https://image.qpic.cn.attacker.example/n" }],
    }).replace('"MsgUid":1', '"MsgUid":' + quoteUid);
    expect(decodeOpqFrame(new TextEncoder().encode(input))).toEqual({
      kind: "message",
      selfId: 50001,
      userId: 58001,
      messageId: quoteUid,
      nickname: "昵称",
      card: "群名片",
      groupName: "群名",
      target: group,
      quote: { uid: quoteUid, seq: 2306, time: 1731000000 },
      parts: [{ type: "at", qq: 50001 }, { type: "at", qq: "all" }, { type: "text", text: "#状态" },
        { type: "image", url: "http://gchat.qpic.cn/picture?tag=yes" }, { type: "image", url: "https://multimedia.nt.qq.com/n" }],
    });
  });

  test("private addresses distinguish ordinary friend and temporary group chat", () => {
    const event = "ON_EVENT_FRIEND_NEW_MSG";
    expect(decodeOpqFrame(messageFrame(event, { FromType: 1 }, { Content: "#帮助" }))).toMatchObject({ kind: "message", target: friend });
    expect(decodeOpqFrame(messageFrame(event, { FromType: 3, C2CTempMessageHead: { GroupCode: 57001 } }, { Content: "#帮助" })))
      .toMatchObject({ kind: "message", target: temporary });
    expect(decodeOpqFrame(messageFrame(event, { FromType: 3 }, { Content: "#帮助" }))).toBeUndefined();
  });

  test("ignores self messages, invalid identities, alternate events, invalid group and non-plain structured message", () => {
    expect(decodeOpqFrame(messageFrame("ON_EVENT_FRIEND_NEW_MSG", { SenderUin: 50001 }, { Content: "#帮助" }))).toBeUndefined();
    expect(decodeOpqFrame(messageFrame("ON_EVENT_FRIEND_NEW_MSG", { SenderUin: "9007199254740993" }, { Content: "#帮助" }))).toBeUndefined();
    expect(decodeOpqFrame(messageFrame("ON_EVENT_FRIEND_NEW_MSG", {}, { Content: "#帮助" }, 0))).toBeUndefined();
    expect(decodeOpqFrame(messageFrame("ON_EVENT_FRIEND_NEW_MSG", { FromType: 2 }, { Content: "#帮助" }))).toBeUndefined();
    expect(decodeOpqFrame(messageFrame("ON_EVENT_GROUP_NEW_MSG", {}, { Content: "#帮助" }))).toBeUndefined();
    expect(decodeOpqFrame(messageFrame("ON_EVENT_GROUP_JOIN", {}, { Content: "#帮助" }))).toBeUndefined();
    expect(decodeOpqFrame(messageFrame("ON_EVENT_FRIEND_NEW_MSG", {}, { SubMsgType: 51, Content: "#帮助" }))).toBeUndefined();
    expect(decodeOpqFrame("[]")).toBeUndefined();
    expect(decodeOpqFrame(new Uint8Array([0xff]))).toBeUndefined();
    expect(decodeOpqFrame(".".repeat(1024 * 1024 + 1))).toBeUndefined();
  });

  test("uses a quote only with complete valid reference fields", () => {
    const event = "ON_EVENT_GROUP_NEW_MSG";
    const base = { GroupInfo: { GroupCode: 57001 }, MsgSeq: 1, MsgTime: 2 };
    expect(decodeOpqFrame(messageFrame(event, { ...base, MsgUid: "18446744073709551615" }, { Content: "abc" })))
      .toMatchObject({ quote: { uid: "18446744073709551615", seq: 1, time: 2 } });
    expect(decodeOpqFrame(messageFrame(event, { ...base, MsgUid: "18446744073709551616" }, { Content: "abc" })))
      .toMatchObject({ quote: undefined });
    expect(decodeOpqFrame(messageFrame(event, { ...base, MsgTime: 0, MsgUid: "1" }, { Content: "abc" })))
      .toMatchObject({ quote: undefined });
  });
});

test("accepts login only from matching event and envelope account IDs", () => {
  const frame = { CurrentQQ: 50001, CurrentPacket: { EventName: "ON_EVENT_LOGIN_SUCCESS", EventData: { Uin: 50001 } } };
  expect(decodeOpqFrame(JSON.stringify(frame))).toEqual({ kind: "login", selfId: 50001 });
  expect(decodeOpqFrame(JSON.stringify({ ...frame, CurrentQQ: 50002 }))).toBeUndefined();
  expect(decodeOpqFrame(messageFrame("ON_EVENT_FRIEND_NEW_MSG", { ToUin: 50002 }, { Content: "#帮助" }))).toBeUndefined();
});

describe("OPQ send mapping", () => {
  test("maps all three destinations and preserves the original quote integer on the wire", () => {
    const quote = { uid: quoteUid, seq: 2306, time: 1731000000 };
    const groupRequest = opqMessageRequest(group, [text, { type: "at", qq: 58001 }], quote)!;
    const encoded = encodeOpqRequest(50001, 100, groupRequest);
    expect(encoded).toContain('"MsgUid":' + quoteUid);
    expect(JSON.parse(encoded!)).toMatchObject({
      BotUin: "50001", ReqId: 100, CgiCmd: "MessageSvc.PbSendMsg",
      CgiRequest: { ToUin: 57001, ToType: 2, ReplyTo: { MsgSeq: 2306, MsgTime: 1731000000 }, Content: "测试", AtUinLists: [{ Uin: 58001 }] },
    });
    expect(encodeOpqRequest(0, 100, groupRequest)).toBeUndefined();
    expect(encodeOpqRequest(50001, 0, groupRequest)).toBeUndefined();
    expect(opqMessageRequest(friend, [text])).toMatchObject({ fields: { ToUin: 58001, ToType: 1 } });
    expect(opqMessageRequest(temporary, [text])).toMatchObject({ fields: { ToUin: 58001, GroupCode: 57001, ToType: 3 } });
    expect(opqMessageRequest(friend, [text], quote)).toBeUndefined();
    expect(opqMessageRequest(temporary, [text, { type: "at", qq: 58001 }])).toBeUndefined();
    expect(opqMessageRequest(group, [{ type: "text", text: "" }])).toBeUndefined();
    expect(opqMessageRequest(group, [text], { ...quote, uid: "15e2" })).toBeUndefined();
  });

  test("maps verified upload command IDs and bounds media data", () => {
    expect(opqUploadRequest(group, { type: "image", bytes: png })).toEqual({ command: "PicUp.DataUp", fields: { CommandId: 2, Base64Buf: "iVBORw==" } });
    expect(opqUploadRequest(friend, { type: "image", bytes: png })).toMatchObject({ fields: { CommandId: 1 } });
    expect(opqUploadRequest(temporary, { type: "image", bytes: png })).toMatchObject({ fields: { CommandId: 1 } });
    expect(opqUploadRequest(group, { type: "record", bytes: png })).toMatchObject({ fields: { CommandId: 29 } });
    expect(opqUploadRequest(friend, { type: "record", bytes: png })).toMatchObject({ fields: { CommandId: 26 } });
    expect(opqUploadRequest(group, { type: "image", bytes: new Uint8Array() })).toBeUndefined();
    expect(opqUploadRequest(group, { type: "image", bytes: new Uint8Array(10 * 1024 * 1024 + 1) })).toBeUndefined();
    expect(opqMediaBytes(png)).toBe(png);
    expect(Array.from(opqMediaBytes("base64://iVBORw==")!)).toEqual(Array.from(png));
    expect(opqMediaBytes("base64://iV-ORw==")).toBeUndefined();
    expect(opqMediaBytes("base64://iVBORw")).toBeUndefined();
    expect(opqMediaBytes("file:///var/tmp/example.png")).toBeUndefined();
    expect(opqMediaBytes("http://gchat.qpic.cn/foo")).toBeUndefined();
  });

  test("reports explicit protocol success and rejection and keeps ambiguous or malformed frames unknown", () => {
    const data = { MsgTime: 1731000000, MsgSeq: 2306 };
    expect(decodeOpqFrame(JSON.stringify({ ReqId: 80, CgiBaseResponse: { Ret: 0 }, ResponseData: data })))
      .toEqual({ kind: "receipt", requestId: 80, acknowledgement: { status: "accepted", data } });
    expect(decodeOpqFrame(JSON.stringify({ ReqId: 80, CgiBaseResponse: { Ret: 110, ErrMsg: "private upstream text" } })))
      .toEqual({ kind: "receipt", requestId: 80, acknowledgement: { status: "rejected", code: 110 } });
    for (const bad of [null, {}, { Ret: "0" }, { Ret: false }, { Ret: 0.1 }]) {
      expect(decodeOpqFrame(JSON.stringify({ ReqId: 80, CgiBaseResponse: bad })))
        .toEqual({ kind: "receipt", requestId: 80, acknowledgement: { status: "unknown" } });
    }
    expect(decodeOpqFrame(JSON.stringify({ ReqId: 80, CurrentPacket: {}, CgiBaseResponse: { Ret: 0 } }))).toBeUndefined();
    expect(decodeOpqFrame(JSON.stringify({ ReqId: 0, CgiBaseResponse: { Ret: 0 } }))).toBeUndefined();
    expect(decodeOpqFrame(JSON.stringify({ ReqId: 80, BotUin: "50001", CgiBaseResponse: { Ret: 0 } })))
      .toMatchObject({ requestId: 80, selfId: 50001 });
    expect(decodeOpqFrame(JSON.stringify({ ReqId: 80, CurrentQQ: 50002, BotUin: "50001", CgiBaseResponse: { Ret: 0 } })))
      .toBeUndefined();
    expect(decodeOpqFrame(JSON.stringify({ ReqId: 80, CurrentQQ: null, BotUin: "50001", CgiBaseResponse: { Ret: 0 } })))
      .toBeUndefined();
    expect(acceptedMessageSequence({ status: "accepted", data })).toBe(2306);
    expect(acceptedMessageId({ status: "accepted", data })).toBeUndefined();
    expect(acceptedMessageId({ status: "accepted", data: { MsgUid: quoteUid } })).toBe(quoteUid);
    expect(acceptedMessageSequence({ status: "accepted", data: { MsgTime: 1731000000 } })).toBeUndefined();
    expect(acceptedMessageSequence({ status: "rejected", code: 80 })).toBeUndefined();
  });

  test("validates success uploads according to file type and emits file fields only", () => {
    const data = { FileId: 28, FileMd5: "bWQ1", FileSize: 4, Width: 12, Height: 8, FileToken: "tok", VoiceTime: 4, unknown: 1 };
    const accepted: OpqAcknowledgement = { status: "accepted", data };
    const image = acceptedImageUpload(accepted);
    const voice = acceptedVoiceUpload(accepted);
    expect(image).toEqual({ type: "image", file: { FileId: 28, FileMd5: "bWQ1", FileSize: 4, Width: 12, Height: 8 } });
    expect(voice).toEqual({ type: "record", file: { FileMd5: "bWQ1", FileSize: 4, FileToken: "tok", VoiceTime: 4 } });
    expect(acceptedImageUpload({ status: "accepted", data: { FileToken: "tok" } })).toBeUndefined();
    expect(acceptedVoiceUpload({ status: "accepted", data: { FileSize: 3, FileMd5: "abc" } })).toBeUndefined();
    expect(acceptedImageUpload({ status: "unknown" })).toBeUndefined();
    expect(opqMessageRequest(group, [image!, voice!, voice!])).toBeUndefined();
    expect(opqMessageRequest(group, [image!, voice!])?.fields).toMatchObject({ Images: [image!.file], Voice: voice!.file });
  });
});
