import { AiChatAuthorInfo, AiModelConfig, SUGGESTED_MODELS } from "@gadgets/workshop-shared/api";
import { UserAiModelRecord } from "./user.js";

// The model used for quick tasks like title generation when AI Gateway mode is active.
//
// This 70B model is quite fast and cheap and produces pretty good titles. The cost is insignificant
// compared to the actual coding model so there's not much reason to use a smaller model.
const QUICK_MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// Providers that can be reached through AI Gateway (see gatewayNativeModel in ai-models.ts).
const GATEWAY_PROVIDERS = new Set<string>(["anthropic", "openai", "google", "cloudflare"]);

/**
 * One entry of a deployment-defined model catalog (CF_AI_GATEWAY_MODELS). `id` and `name` are
 * what users see and select; `provider`/`model` is the provider model the entry resolves to.
 * Ids are stable identities: chat history, preferred-model settings, and remembered selections
 * refer to them, so a deployment can retune the provider model behind "medium" without touching
 * any of that.
 */
export type AiGatewayCatalogEntry = {
  id: string;
  name: string;
  provider: AiModelConfig["provider"];
  model: string;
};

/**
 * Parse and validate CF_AI_GATEWAY_MODELS. Returns undefined when the variable is unset or blank
 * (the built-in SUGGESTED_MODELS catalog applies). Throws a descriptive error for anything else
 * that is not a non-empty array of well-formed entries whose providers are enabled, so a
 * misconfigured deployment fails loudly rather than advertising a broken catalog.
 */
export function parseAiGatewayCatalog(raw: string | undefined, providers: Set<string>)
    : AiGatewayCatalogEntry[] | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error("CF_AI_GATEWAY_MODELS must be a JSON array of {id, name, provider, model}.",
        { cause: err });
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("CF_AI_GATEWAY_MODELS must be a non-empty JSON array.");
  }

  const catalog: AiGatewayCatalogEntry[] = [];
  const ids = new Set<string>();
  parsed.forEach((entry, index) => {
    const where = `CF_AI_GATEWAY_MODELS[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`${where} must be an object with id, name, provider, and model.`);
    }
    const { id, name, provider, model } = entry as Record<string, unknown>;
    for (const [key, value] of Object.entries({ id, name, provider, model })) {
      if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
        throw new Error(`${where}.${key} must be a non-empty string without surrounding whitespace.`);
      }
    }
    if (!GATEWAY_PROVIDERS.has(provider as string)) {
      throw new Error(`${where}.provider must be one of ` +
          `${[...GATEWAY_PROVIDERS].join(", ")}; got "${provider}".`);
    }
    if (!providers.has(provider as string)) {
      throw new Error(`${where}.provider "${provider}" is not in CF_AI_GATEWAY_PROVIDERS.`);
    }
    if (ids.has(id as string)) {
      throw new Error(`${where}.id "${id}" is used more than once.`);
    }
    ids.add(id as string);
    catalog.push({
      id: id as string,
      name: name as string,
      provider: provider as AiModelConfig["provider"],
      model: model as string,
    });
  });
  return catalog;
}

export class AiGatewayConfig {
  readonly gateway: string;
  readonly workersAiGateway?: string;
  readonly accountId: string;
  readonly apiToken: string;
  readonly providers: Set<string>;
  /**
   * The deployment-defined catalog (CF_AI_GATEWAY_MODELS), or undefined when the built-in
   * SUGGESTED_MODELS catalog applies.
   */
  readonly catalog?: AiGatewayCatalogEntry[];
  /**
   * Whether users may add their own models on top of the catalog (CF_AI_GATEWAY_CUSTOM_MODELS;
   * default true). Custom models are routed through the platform gateway like the built-in ones,
   * so a deployment that funds inference may want to turn this off.
   */
  readonly allowCustomModels: boolean;

  constructor(env: Cloudflare.Env) {
    this.gateway = env.CF_AI_GATEWAY!;
    // Inference now goes over HTTPS with tokens (pi has no Workers-binding transport), so the
    // account/token pair is required whenever gateway mode is enabled. The token-less
    // same-account mode existed only because of the Workers binding.
    if (!env.CF_AI_GATEWAY_ACCOUNT_ID || !env.CF_AI_GATEWAY_API_TOKEN) {
      throw new Error(
          "CF_AI_GATEWAY_ACCOUNT_ID and CF_AI_GATEWAY_API_TOKEN (a Run + Read token) are " +
          "required when CF_AI_GATEWAY is set.");
    }
    this.accountId = env.CF_AI_GATEWAY_ACCOUNT_ID;
    this.apiToken = env.CF_AI_GATEWAY_API_TOKEN;
    if (env.CF_AI_GATEWAY_WAI_DIRECT === "true" && env.CF_AI_GATEWAY_WAI) {
      throw new Error(
          "CF_AI_GATEWAY_WAI and CF_AI_GATEWAY_WAI_DIRECT cannot be configured together.");
    }
    this.workersAiGateway = env.CF_AI_GATEWAY_WAI_DIRECT === "true"
      ? undefined
      : env.CF_AI_GATEWAY_WAI || this.gateway;
    this.providers = new Set(
      (env.CF_AI_GATEWAY_PROVIDERS || "").split(",").map(s => s.trim()).filter(s => s !== "")
    );
    this.catalog = parseAiGatewayCatalog(env.CF_AI_GATEWAY_MODELS, this.providers);
    this.allowCustomModels =
        (env.CF_AI_GATEWAY_CUSTOM_MODELS ?? "").trim().toLowerCase() !== "false";
  }

  /**
   * Get the list of models available through AI Gateway, as AiChatAuthorInfo entries: the
   * deployment-defined catalog in its configured order, or every SUGGESTED_MODELS entry of an
   * enabled provider. The first entry is the default for users who have not chosen a model.
   */
  getModelList(): AiChatAuthorInfo[] {
    if (this.catalog) {
      return this.catalog.map(({ id, name }) => ({ type: "agent", id, name }));
    }
    let result: AiChatAuthorInfo[] = [];
    for (let [provider, models] of Object.entries(SUGGESTED_MODELS)) {
      if (this.providers.has(provider)) {
        for (let [id, model] of Object.entries(models)) {
          result.push({ type: "agent", id, name: model.name });
        }
      }
    }
    return result;
  }

  /**
   * Look up an AI Gateway model by ID. Returns a UserAiModelRecord if the ID names a
   * deployment-defined catalog entry (or, without a catalog, a SUGGESTED_MODEL of an enabled
   * gateway provider), or undefined otherwise.
   */
  resolveModel(modelId: string): UserAiModelRecord | undefined {
    if (this.catalog) {
      let entry = this.catalog.find(candidate => candidate.id === modelId);
      if (!entry) return undefined;
      return {
        profile: { type: "agent", id: entry.id, name: entry.name },
        // apiToken and apiUrl are ignored when AI Gateway mode is active -- getModel() reads the
        // real values from env. The empty string satisfies the type.
        config: { provider: entry.provider, model: entry.model, apiToken: "" },
      };
    }
    for (let [provider, models] of Object.entries(SUGGESTED_MODELS)) {
      if (this.providers.has(provider) && modelId in models) {
        return {
          profile: { type: "agent", id: modelId, name: models[modelId].name },
          config: {
            provider: provider as AiModelConfig["provider"],
            model: modelId,
            // apiToken and apiUrl are ignored when AI Gateway mode is active -- getModel()
            // reads the real values from env. We set them to empty strings here to satisfy
            // the type.
            apiToken: "",
          },
        };
      }
    }
    return undefined;
  }

  /**
   * Whether `modelId` is one of the deployment's built-in gateway models (as opposed to a model
   * the user added themselves). Built-in models cannot be deleted by users.
   */
  isBuiltIn(modelId: string): boolean {
    return this.resolveModel(modelId) !== undefined;
  }

  /**
   * Get the AiModelConfig for the quick model (used for title generation).
   */
  getQuickModelConfig(): AiModelConfig | undefined {
    // Always use Workers AI here.
    return {
      provider: "cloudflare",
      model: QUICK_MODEL_ID,
      apiToken: "",
    };
  }
}

/**
 * Parse AI Gateway configuration from environment variables. Returns null if AI Gateway
 * mode is not enabled (i.e. CF_AI_GATEWAY is not set).
 */
export function getAiGatewayConfig(env: Cloudflare.Env): AiGatewayConfig | null {
  if (!env.CF_AI_GATEWAY) return null;
  return new AiGatewayConfig(env);
}

/** Identifies the Gateway and credentials needed to retrieve an inference log. */
export type AiGatewayLogRoute =
  | { gateway: string }
  | { gateway: string; accountId: string; apiToken: string };

/** Indicates a transient AI Gateway log lookup failure that should be retried. */
export class AiGatewayLogRetryableError extends Error {}

function validateLogCost(cost: unknown): number {
  if (cost === undefined || cost === null) {
    throw new AiGatewayLogRetryableError("AI Gateway log cost is not available yet.");
  }
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
    throw new Error("AI Gateway log response contained an invalid cost.");
  }
  return cost;
}

/** Retrieve the cost recorded for an AI Gateway log. */
export async function getAiGatewayLogCost(
    env: Cloudflare.Env, route: AiGatewayLogRoute, logId: string): Promise<number> {
  if (!("accountId" in route)) {
    let log: AiGatewayLog;
    try {
      log = await env.WORKERS_AI.gateway(route.gateway).getLog(logId);
    } catch (error) {
      throw new AiGatewayLogRetryableError("AI Gateway binding log request failed.", {
        cause: error,
      });
    }
    return validateLogCost(log.cost);
  }

  let url = "https://api.cloudflare.com/client/v4/accounts/" +
      `${encodeURIComponent(route.accountId)}/ai-gateway/gateways/` +
      `${encodeURIComponent(route.gateway)}/logs/${encodeURIComponent(logId)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${route.apiToken}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new AiGatewayLogRetryableError("AI Gateway log request failed.", { cause: error });
  }
  if (!response.ok) {
    if (response.status === 404 || response.status === 408 || response.status === 429 ||
        response.status >= 500) {
      throw new AiGatewayLogRetryableError(
          `AI Gateway log request failed with status ${response.status}.`);
    }
    throw new Error(`AI Gateway log request failed with status ${response.status}.`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new AiGatewayLogRetryableError("AI Gateway log response could not be read.", {
      cause: error,
    });
  }
  if (typeof body !== "object" || body === null || !("success" in body) ||
      body.success !== true || !("result" in body) ||
      typeof body.result !== "object" || body.result === null) {
    throw new Error("AI Gateway log response was malformed.");
  }

  let cost = "cost" in body.result ? body.result.cost : undefined;
  return validateLogCost(cost);
}
