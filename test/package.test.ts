import { createOpqAdapter, type ReverseProtocolGateway } from "@lotus-yunzai/opq";
import { expect, test } from "bun:test";

test("exports an independent reverse adapter from the package root", () => {
  const adapter: ReverseProtocolGateway = createOpqAdapter({ instance: "local", accounts: ["50001"] });
  expect(adapter.start).toBeFunction();
  expect(adapter.accept).toBeFunction();
  expect(adapter.send).toBeFunction();
});

test("requires an explicit instance and valid allowlisted accounts", () => {
  expect(() => createOpqAdapter({ instance: "", accounts: ["50001"] })).toThrow();
  expect(() => createOpqAdapter({ instance: "local", accounts: [] })).toThrow();
  expect(() => createOpqAdapter({ instance: "local", accounts: ["9007199254740992"] })).toThrow();
});
