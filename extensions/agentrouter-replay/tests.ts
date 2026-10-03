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
    for (const baseUrl of ["https://example.com/v1", "https://agentrouter.org.evil.example/v1", "https://evil.example/agentrouter.org", "https://agentrouter.org@evil.example", "invalid"]) {
        assert.equal(handler({ payload }, { model: { provider: "other", baseUrl } }), undefined);
    }
    for (const baseUrl of ["https://agentrouter.org/v1", "https://api.agentrouter.org/v1"]) {
        assert.deepEqual(handler({ payload }, { model: { provider: "other", baseUrl } }), { input: [{ call_id: "pair" }] });
    }
    assert.equal(handler({ payload: { messages: [] } }, { model: { provider: "agentrouter" } }).messages.length, 0);
    assert.deepEqual(handler({ payload }, { model: { provider: "agentrouter" } }), { input: [{ call_id: "pair" }] });
});


test("explicit item references retain their required ID alongside replayed output", () => {
    const reference = { type: "item_reference", id: "required-reference" };
    const payload = { input: [reference, { type: "reasoning", id: "stored-id", encrypted_content: "reasoning" }] };
    assert.deepEqual(stripStoredItemIds(payload), { input: [reference, { type: "reasoning", encrypted_content: "reasoning" }] });
    const onlyReference = { input: [reference] };
    assert.equal(stripStoredItemIds(onlyReference), onlyReference);
});
