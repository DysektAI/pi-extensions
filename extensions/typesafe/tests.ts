import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ask, buildRequest, config as resolveConfig, parseAuthKey, precheck, readConfig, resolveApiKey, validateResponse } from "./client.js";

const config = readConfig({ TYPESAFE_API_KEY: "test-only-not-a-real-key" });
const questions = [{ type: "noul" as const, instructions: "Is this useful?" }];
const request = buildRequest("hello", questions, config.model);
const payload = { model: "jev-test", answers: { q1: { type: "noul", noul: 0.8 } }, usage: { input_tokens: 1, output_tokens: 2 } };
const reply = (body: unknown, status = 200): typeof fetch => async () => new Response(JSON.stringify(body), { status });

test("safe defaults and validated configuration", () => {
  assert.equal(readConfig({}).apiKey, "");
  assert.equal(readConfig({}).auto, false);
  assert.equal(readConfig({ TYPESAFE_AUTO: "on" }).auto, true);
  for (const threshold of ["NaN", "Infinity", "-1", "1.1"]) assert.throws(() => readConfig({ TYPESAFE_AUTO_THRESHOLD: threshold }));
  for (const url of ["http://example.com", "https://user:pass@example.com", "https://example.com?a=b", "https://example.com#fragment"]) assert.throws(() => readConfig({ TYPESAFE_BASE_URL: url }));
  assert.equal(readConfig({ TYPESAFE_BASE_URL: "https://example.com/v1/" }).baseUrl, "https://example.com/v1");
});

test("state parsing preserves scalar text and accepts objects/arrays", () => {
  for (const state of ["null", "true", "123", "plain text"]) assert.equal(buildRequest(state, questions, "jev").state, state);
  assert.deepEqual(buildRequest('{"a":1}', questions, "jev").state, { a: 1 });
  assert.deepEqual(buildRequest("[1]", questions, "jev").state, [1]);
});

test("question IDs cannot overwrite each other or mutate prototypes", () => {
  assert.throws(() => buildRequest("x", [...questions, { ...questions[0], id: "q1" }], "jev"));
  const result = buildRequest("x", [{ ...questions[0], id: "__proto__" }], "jev");
  assert.equal(Object.getPrototypeOf(result.questions), null);
  assert.ok(Object.hasOwn(JSON.parse(JSON.stringify(result)).questions, "__proto__"));
  assert.throws(() => buildRequest("x", [{ ...questions[0], id: " " }], "jev"));
});

test("validates question types, criteria and request limits", () => {
  assert.throws(() => buildRequest("x", [], "jev"));
  assert.throws(() => buildRequest("x", Array(65).fill(questions[0]), "jev"));
  assert.throws(() => buildRequest("x".repeat(256 * 1024), questions, "jev"));
  assert.throws(() => buildRequest("x", questions, " "));
  assert.throws(() => buildRequest("x", [{ ...questions[0], instructions: " " }], "jev"));
  for (const criteria of [undefined, [], {}, { a: true }]) assert.throws(() => buildRequest("x", [{ type: "choice", instructions: "Choose", criteria }], "jev"));
  for (const criteria of [undefined, ["one"], Array(11).fill("level"), [null, "x"]]) assert.throws(() => buildRequest("x", [{ type: "score", instructions: "Rate", criteria }], "jev"));
  assert.throws(() => buildRequest("x", [{ ...questions[0], criteria: { invalid: "no" } }], "jev"));
  assert.doesNotThrow(() => buildRequest("x", [
    { type: "choice", instructions: "Choose", criteria: { yes: null, no: "No" } },
    { type: "score", instructions: "Rate", criteria: ["Low", "High"] },
  ], "jev"));
});

test("validates responses and expected answer IDs", () => {
  assert.deepEqual(validateResponse(payload, request), payload);
  for (const value of [null, {}, { ...payload, answers: {} }, { ...payload, usage: {} }, { ...payload, answers: { q1: { type: "noul", noul: 1.1 } } }]) assert.throws(() => validateResponse(value, request));
  const req = buildRequest("x", [{ type: "choice", instructions: "Choose", criteria: { a: null, b: null } }, { type: "score", instructions: "Rate", criteria: ["Low", "High"] }], "jev");
  const valid = { ...payload, answers: {
    q1: { type: "choice", choice: "a", confidence: 0.8, probabilities: { a: 0.9, b: 0.1 } },
    q2: { type: "score", score: 0.5, confidence: 0, probabilities: { "0": 0.5, "1": 0.5 }, legend: { "0": "Low", "1": "High" } },
  } };
  assert.doesNotThrow(() => validateResponse(valid, req));
  assert.throws(() => validateResponse({ ...valid, answers: { ...valid.answers, q1: { ...valid.answers.q1, choice: "unknown" } } }, req));
});

test("credentials come from auth.json first, then the environment", async () => {
  assert.equal(parseAuthKey({ typesafe: "key-a" }, "typesafe"), "key-a");
  assert.equal(parseAuthKey({ typesafe: { key: " key-b " } }, "typesafe"), "key-b");
  assert.equal(parseAuthKey({ typesafe: { type: "api_key", key: "key-c" } }, "typesafe"), "key-c");
  for (const auth of [null, [], {}, { typesafe: "" }, { typesafe: { key: 3 } }, { other: "key" }]) assert.equal(parseAuthKey(auth, "typesafe"), undefined);
  assert.equal(parseAuthKey({ typesafe: "key-a" }, "other"), undefined);

  const dir = await mkdtemp(join(tmpdir(), "typesafe-auth-"));
  const env = { PI_CODING_AGENT_DIR: dir, TYPESAFE_API_KEY: "env-key" };
  assert.equal(await resolveApiKey(env), "env-key");
  await writeFile(join(dir, "auth.json"), JSON.stringify({ typesafe: { type: "api_key", key: "file-key" } }));
  assert.equal(await resolveApiKey(env), "file-key");
  assert.equal((await resolveConfig(env)).apiKey, "file-key");
  await writeFile(join(dir, "auth.json"), "not json");
  assert.equal(await resolveApiKey(env), "env-key");
  assert.equal(await resolveApiKey({ PI_CODING_AGENT_DIR: join(dir, "missing") }), undefined);
  assert.equal((await resolveConfig({ PI_CODING_AGENT_DIR: dir })).apiKey, "");
});

test("HTTP client sends contract and honors overrides", async () => {
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(init?.redirect, "error");
    assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${config.apiKey}`);
    assert.equal(JSON.parse(init?.body as string).model, "custom-model");
    return new Response(JSON.stringify(payload));
  };
  assert.deepEqual(await ask(config, { ...request, model: "custom-model" }, undefined, 100, fetcher), payload);
});

test("missing key does not send; errors never echo upstream secrets", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return new Response("secret-body", { status: 401 }); };
  await assert.rejects(ask({ ...config, apiKey: "" }, request, undefined, 100, fetcher), /TYPESAFE_API_KEY/);
  assert.equal(calls, 0);
  await assert.rejects(ask(config, request, undefined, 100, fetcher), (e: unknown) => e instanceof Error && e.message.includes("401") && !e.message.includes("secret-body"));
  await assert.rejects(ask(config, request, undefined, 100, async () => { throw new Error("secret-network-details"); }), /network request failed/);
  await assert.rejects(ask(config, request, undefined, 100, async () => new Response("not json")), /invalid JSON/);
  await assert.rejects(ask(config, request, undefined, 100, async () => new Response("x".repeat(512 * 1024 + 1))), /512 KiB/);
});

test("timeout and cancellation stop pending fetches", async () => {
  const pending: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  await assert.rejects(ask(config, request, undefined, 10, pending), /timed out/);
  const controller = new AbortController();
  const result = ask(config, request, controller.signal, 1000, pending);
  controller.abort();
  await assert.rejects(result, /cancelled/);
  await assert.rejects(ask(config, request, controller.signal, 100, pending), /cancelled/);
});

test("precheck requires explicit opt-in, bounds prompt size, fails open", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return new Response(JSON.stringify({ ...payload, answers: { needs_jev: { type: "noul", noul: 0.8 } } })); };
  const auto = { ...config, auto: true };
  const prompt = "Compare these design options";
  assert.equal(await precheck(config, prompt, undefined, fetcher), undefined);
  assert.equal(await precheck({ ...auto, apiKey: "" }, prompt, undefined, fetcher), undefined);
  assert.equal(await precheck(auto, "short", undefined, fetcher), undefined);
  assert.equal(await precheck(auto, "x".repeat(16_001), undefined, fetcher), undefined);
  assert.equal(calls, 0);
  assert.equal(await precheck(auto, prompt, undefined, fetcher), 0.8);
  assert.equal(await precheck({ ...auto, threshold: 0.9 }, prompt, undefined, fetcher), undefined);
  assert.equal(await precheck(auto, prompt, undefined, reply({}, 429)), undefined);
  assert.equal(await precheck(auto, prompt, undefined, reply({})), undefined);
});
