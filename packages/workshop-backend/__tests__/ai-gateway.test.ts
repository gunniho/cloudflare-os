import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AiGatewayLogRetryableError,
  getAiGatewayConfig,
  getAiGatewayLogCost,
  parseAiGatewayCatalog,
} from "../src/ai-gateway.js";
import { getModel } from "../src/ai-models.js";

function env(overrides: Partial<Cloudflare.Env> = {}): Cloudflare.Env {
  return {
    CF_AI_GATEWAY: "platform-gateway",
    CF_AI_GATEWAY_PROVIDERS: "anthropic,openai,google",
    WORKERS_AI: {} as Ai,
    ...overrides,
  } as Cloudflare.Env;
}

describe("getAiGatewayLogCost", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads cross-account log cost through the REST API", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      success: true,
      result: { cost: 1.25 },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getAiGatewayLogCost(env(), {
      accountId: "gateway-account-id",
      gateway: "platform-gateway",
      apiToken: "read-run-token",
    }, "log/id")).resolves.toBe(1.25);

    expect(fetchMock).toHaveBeenCalledWith(
        "https://api.cloudflare.com/client/v4/accounts/gateway-account-id/" +
        "ai-gateway/gateways/platform-gateway/logs/log%2Fid",
        {
          headers: { Authorization: "Bearer read-run-token" },
          signal: expect.any(AbortSignal),
        });
  });

  it("uses the binding for same-account log cost", async () => {
    const getLog = vi.fn(async () => ({ cost: 0.5 }));
    const gateway = vi.fn(() => ({ getLog }));

    await expect(getAiGatewayLogCost(env({
      WORKERS_AI: { gateway } as unknown as Ai,
    }), { gateway: "platform-gateway" }, "log-id")).resolves.toBe(0.5);

    expect(gateway).toHaveBeenCalledWith("platform-gateway");
    expect(getLog).toHaveBeenCalledWith("log-id");
  });

  it("classifies same-account binding failures as retryable", async () => {
    const getLog = vi.fn(async () => { throw new Error("log not found"); });
    const gateway = vi.fn(() => ({ getLog }));

    await expect(getAiGatewayLogCost(env({
      WORKERS_AI: { gateway } as unknown as Ai,
    }), { gateway: "platform-gateway" }, "log-id"))
        .rejects.toBeInstanceOf(AiGatewayLogRetryableError);
  });

  it("classifies cross-account network failures as retryable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network unavailable"); }));

    await expect(getAiGatewayLogCost(env(), {
      accountId: "gateway-account-id",
      gateway: "platform-gateway",
      apiToken: "read-run-token",
    }, "log-id")).rejects.toBeInstanceOf(AiGatewayLogRetryableError);
  });

  it("classifies cross-account response body failures as retryable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new Error("response body reset"); },
    } as Response)));

    await expect(getAiGatewayLogCost(env(), {
      accountId: "gateway-account-id",
      gateway: "platform-gateway",
      apiToken: "read-run-token",
    }, "log-id")).rejects.toBeInstanceOf(AiGatewayLogRetryableError);
  });

  it("rejects failed or malformed cross-account responses", async () => {
    const responses = [
      new Response(null, { status: 403 }),
      Response.json({ success: true, result: { cost: "unknown" } }),
      Response.json({ success: true, result: { cost: -1 } }),
      Response.json({ success: true, result: {} }),
      new Response(null, { status: 404 }),
      new Response(null, { status: 408 }),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => responses.shift()!));
    const route = {
      accountId: "gateway-account-id",
      gateway: "platform-gateway",
      apiToken: "read-run-token",
    };

    await expect(getAiGatewayLogCost(env(), route, "log-id"))
        .rejects.toThrow("AI Gateway log request failed with status 403.");
    await expect(getAiGatewayLogCost(env(), route, "log-id"))
        .rejects.toThrow("AI Gateway log response contained an invalid cost.");
    await expect(getAiGatewayLogCost(env(), route, "log-id"))
        .rejects.toThrow("AI Gateway log response contained an invalid cost.");
    await expect(getAiGatewayLogCost(env(), route, "log-id"))
        .rejects.toBeInstanceOf(AiGatewayLogRetryableError);
    await expect(getAiGatewayLogCost(env(), route, "log-id"))
        .rejects.toBeInstanceOf(AiGatewayLogRetryableError);
    await expect(getAiGatewayLogCost(env(), route, "log-id"))
        .rejects.toBeInstanceOf(AiGatewayLogRetryableError);
  });
});

const TIERS = JSON.stringify([
  { id: "high", name: "High", provider: "openai", model: "gpt-5.6-sol" },
  { id: "low", name: "Low", provider: "openai", model: "gpt-5.6-luna" },
]);

function gatewayEnv(overrides: Partial<Cloudflare.Env> = {}): Cloudflare.Env {
  return env({
    CF_AI_GATEWAY_ACCOUNT_ID: "gateway-account-id",
    CF_AI_GATEWAY_API_TOKEN: "gateway-token",
    CF_AI_GATEWAY_PROVIDERS: "openai,cloudflare",
    ...overrides,
  });
}

describe("AI Gateway model catalog", () => {
  it("offers every suggested model of an enabled provider by default", () => {
    const config = getAiGatewayConfig(gatewayEnv())!;

    expect(config.catalog).toBeUndefined();
    expect(config.allowCustomModels).toBe(true);
    const ids = config.getModelList().map(model => model.id);
    expect(ids).toContain("gpt-5.6-sol");
    expect(ids).toContain("@cf/zai-org/glm-5.2");
    expect(ids).not.toContain("claude-opus-5");
    expect(config.resolveModel("gpt-5.6-sol")).toEqual({
      profile: { type: "agent", id: "gpt-5.6-sol", name: "GPT 5.6 Sol" },
      config: { provider: "openai", model: "gpt-5.6-sol", apiToken: "" },
    });
    expect(config.resolveModel("claude-opus-5")).toBeUndefined();
    expect(config.isBuiltIn("gpt-5.6-sol")).toBe(true);
    expect(config.isBuiltIn("my-own-model")).toBe(false);
  });

  it("replaces the built-in list with the deployment-defined catalog, in order", () => {
    const config = getAiGatewayConfig(gatewayEnv({ CF_AI_GATEWAY_MODELS: TIERS }))!;

    expect(config.getModelList()).toEqual([
      { type: "agent", id: "high", name: "High" },
      { type: "agent", id: "low", name: "Low" },
    ]);
    expect(config.resolveModel("low")).toEqual({
      profile: { type: "agent", id: "low", name: "Low" },
      config: { provider: "openai", model: "gpt-5.6-luna", apiToken: "" },
    });
    // Suggested models that are not in the catalog are no longer built in.
    expect(config.resolveModel("gpt-5.6-sol")).toBeUndefined();
    expect(config.isBuiltIn("high")).toBe(true);
    expect(config.isBuiltIn("gpt-5.6-terra")).toBe(false);
  });

  it("routes a catalog entry to its provider model through the gateway", () => {
    const testEnv = gatewayEnv({ CF_AI_GATEWAY_MODELS: TIERS });
    const record = getAiGatewayConfig(testEnv)!.resolveModel("high")!;

    const handle = getModel(testEnv, record.config, { type: "user", id: "u", name: "U" });

    expect(handle.model.id).toBe("gpt-5.6-sol");
    expect(handle.model.api).toBe("openai-responses");
    expect(handle.model.baseUrl).toBe(
        "https://gateway.ai.cloudflare.com/v1/gateway-account-id/platform-gateway/openai");
    // Token limits come from the real model, not the tier id.
    expect(handle.model.contextWindow).toBe(1050000);
  });

  it("reads the custom-models switch leniently", () => {
    expect(getAiGatewayConfig(gatewayEnv({ CF_AI_GATEWAY_CUSTOM_MODELS: "false" }))!
        .allowCustomModels).toBe(false);
    expect(getAiGatewayConfig(gatewayEnv({ CF_AI_GATEWAY_CUSTOM_MODELS: " False " }))!
        .allowCustomModels).toBe(false);
    expect(getAiGatewayConfig(gatewayEnv({ CF_AI_GATEWAY_CUSTOM_MODELS: "true" }))!
        .allowCustomModels).toBe(true);
    expect(getAiGatewayConfig(gatewayEnv({ CF_AI_GATEWAY_CUSTOM_MODELS: "" }))!
        .allowCustomModels).toBe(true);
  });

  it("treats a blank catalog variable as unset", () => {
    expect(parseAiGatewayCatalog(undefined, new Set(["openai"]))).toBeUndefined();
    expect(parseAiGatewayCatalog("  ", new Set(["openai"]))).toBeUndefined();
  });

  it("rejects malformed catalogs with a precise message", () => {
    const providers = new Set(["openai"]);
    const parse = (value: unknown) => () =>
        parseAiGatewayCatalog(typeof value === "string" ? value : JSON.stringify(value), providers);

    expect(parse("not json")).toThrow("CF_AI_GATEWAY_MODELS must be a JSON array");
    expect(parse({ id: "high" })).toThrow("must be a non-empty JSON array");
    expect(parse([])).toThrow("must be a non-empty JSON array");
    expect(parse(["high"])).toThrow("CF_AI_GATEWAY_MODELS[0] must be an object");
    expect(parse([{ id: "high", name: "High", provider: "openai" }]))
        .toThrow("CF_AI_GATEWAY_MODELS[0].model must be a non-empty string");
    expect(parse([{ id: " high", name: "High", provider: "openai", model: "gpt-5.6-sol" }]))
        .toThrow("CF_AI_GATEWAY_MODELS[0].id must be a non-empty string");
    expect(parse([{ id: "high", name: "High", provider: "ollama", model: "gemma4:31b" }]))
        .toThrow("CF_AI_GATEWAY_MODELS[0].provider must be one of");
    expect(parse([{ id: "high", name: "High", provider: "anthropic", model: "claude-opus-5" }]))
        .toThrow('CF_AI_GATEWAY_MODELS[0].provider "anthropic" is not in CF_AI_GATEWAY_PROVIDERS');
    expect(parse([
      { id: "high", name: "High", provider: "openai", model: "gpt-5.6-sol" },
      { id: "high", name: "Also high", provider: "openai", model: "gpt-5.6-luna" },
    ])).toThrow('CF_AI_GATEWAY_MODELS[1].id "high" is used more than once');
  });

  it("fails gateway configuration loudly for a malformed catalog", () => {
    expect(() => getAiGatewayConfig(gatewayEnv({ CF_AI_GATEWAY_MODELS: "[]" })))
        .toThrow("CF_AI_GATEWAY_MODELS must be a non-empty JSON array.");
  });
});
