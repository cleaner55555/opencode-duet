import { describe, expect, it } from "vitest";
import {
  hashPassword,
  parseClientMessage,
} from "../src/duet/protocol.js";

describe("protocol", () => {
  it("hashes passwords deterministically", () => {
    expect(hashPassword("abc")).toBe(hashPassword("abc"));
    expect(hashPassword("abc")).not.toBe(hashPassword("abd"));
    expect(hashPassword("abc")).toHaveLength(64);
  });

  it("parses a join message", () => {
    const message = parseClientMessage(
      JSON.stringify({
        type: "join",
        user: "Alice",
        passwordHash: "x",
        timestamp: 1,
      }),
    );
    expect(message).toMatchObject({
      type: "join",
      user: "Alice",
      passwordHash: "x",
      timestamp: 1,
    });
  });

  it("parses chat and prompt messages", () => {
    expect(
      parseClientMessage(JSON.stringify({ type: "chat", text: "hi" })),
    ).toMatchObject({ type: "chat", text: "hi" });

    expect(
      parseClientMessage(
        JSON.stringify({ type: "prompt", id: "p1", text: "fix it" }),
      ),
    ).toMatchObject({ type: "prompt", id: "p1", text: "fix it" });
  });

  it("rejects malformed messages", () => {
    expect(parseClientMessage("not json")).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "nope" }))).toBeNull();
    expect(
      parseClientMessage(JSON.stringify({ type: "join", user: "x" })),
    ).toBeNull();
    expect(
      parseClientMessage(JSON.stringify({ type: "approval_response", promptId: "x" })),
    ).toBeNull();
  });

  it("truncates oversized chat text", () => {
    const message = parseClientMessage(
      JSON.stringify({ type: "chat", text: "x".repeat(30_000) }),
    );
    expect(message?.type).toBe("chat");
    if (message?.type === "chat") expect(message.text.length).toBe(20_000);
  });
});
