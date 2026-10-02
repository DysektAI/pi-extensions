import assert from "node:assert/strict";
import { test } from "node:test";
import extension, { stripStoredItemIds } from "../agentrouter-item-id-replay.ts";

test("AgentRouter replay preserves call pairing and encrypted reasoning without mutating history", () => {
    const payload = { input: [{ id: "resource-id", call_id: "call-id", encrypted_content: "portable-reasoning", type: "reasoning" }] };
    assert.deepEqual(stripStoredItemIds(payload), { input: [{ call_id: "call-id", encrypted_content: "portable-reasoning", type: "reasoning" }] });
    assert.equal(payload.input[0].id, "resource-id");
});

test("unmodified payloads retain identity and malformed input is untouched", () => {
    for (const payload of [null, 3, { input: "bad" }, { input: [{ call_id: "call-id" }] }]) {
        assert.equal(stripStoredItemIds(payload), payload);
    }
});

test("replay hook affects only AgentRouter Responses requests", () => {
    let handler: any;
    extension({ on: (name: string, callback: unknown) => { assert.equal(name, "before_provider_request"); handler = callback; } } as any);
    const payload = { input: [{ id: "resource-id", call_id: "pair" }] };
    assert.equal(handler({ payload }, { model: { provider: "other", baseUrl: "https://example.com/v1" } }), undefined);
    assert.equal(handler({ payload: { messages: [] } }, { model: { provider: "agentrouter" } }).messages.length, 0);
    assert.deepEqual(handler({ payload }, { model: { provider: "agentrouter" } }), { input: [{ call_id: "pair" }] });
});
