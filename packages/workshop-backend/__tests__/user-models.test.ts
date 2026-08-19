import { describe, expect, it } from "vitest";
import type { AiChatAuthorInfo, AiModelConfig } from "@gadgets/workshop-shared/api";
import { UserDurableObject, type UserAiModelRecord } from "../src/user.js";

// Exercises the User DO's model-management methods against a Map-backed `aiModels` collection,
// under the three AI configurations that matter: no gateway, a gateway with the default built-in
// list, and a gateway with a deployment-defined catalog that forbids custom models.

// An OpenAI model id that is NOT in SUGGESTED_MODELS, so it is never a built-in.
const OWN_MODEL: UserAiModelRecord = {
  profile: { type: "agent", id: "gpt-5.6-nova", name: "My Nova" },
  config: { provider: "openai", model: "gpt-5.6-nova", apiToken: "" },
};

const TIERS = JSON.stringify([
  { id: "high", name: "High", provider: "openai", model: "gpt-5.6-sol" },
  { id: "low", name: "Low", provider: "openai", model: "gpt-5.6-luna" },
]);

function makeUser(env: Partial<Cloudflare.Env>, records: UserAiModelRecord[] = []) {
  const models = new Map(records.map(record => [record.profile.id, structuredClone(record)]));
  let preferred: string | null = null;
  let quick: string | null = null;
  const user = Object.create(UserDurableObject.prototype) as UserDurableObject;
  Object.assign(user, {
    env,
    storage: {
      aiModels: {
        get: (id: string) => models.get(id),
        put: (record: UserAiModelRecord) => { models.set(record.profile.id, record); },
        delete: (id: string) => { models.delete(id); },
        list: () => [...models.values()],
      },
      preferredModel: { get: () => preferred, put: (id: string | null) => { preferred = id; } },
      quickModel: { get: () => quick, put: (id: string | null) => { quick = id; } },
      profile: { get: () => ({ type: "user", id: "u@example.com", name: "u" }) },
    },
  });
  return { user, models };
}

const noGateway: Partial<Cloudflare.Env> = {};
const defaultGateway: Partial<Cloudflare.Env> = {
  CF_AI_GATEWAY: "platform-gateway",
  CF_AI_GATEWAY_ACCOUNT_ID: "gateway-account-id",
  CF_AI_GATEWAY_API_TOKEN: "gateway-token",
  CF_AI_GATEWAY_PROVIDERS: "openai",
};
const tierGateway: Partial<Cloudflare.Env> = {
  ...defaultGateway,
  CF_AI_GATEWAY_MODELS: TIERS,
  CF_AI_GATEWAY_CUSTOM_MODELS: "false",
};

const ids = (list: AiChatAuthorInfo[]) => list.map(model => model.id);

describe("UserDurableObject model management", () => {
  it("lists only the user's own models without a gateway", async () => {
    const { user } = makeUser(noGateway, [OWN_MODEL]);
    expect(ids(await user.listModels())).toEqual(["gpt-5.6-nova"]);
    expect((await user.getChatContext("gpt-5.6-nova")).aiModel).toEqual(OWN_MODEL);
  });

  it("lists built-ins first and the user's distinct models after them", async () => {
    const { user } = makeUser(defaultGateway, [OWN_MODEL, {
      profile: { type: "agent", id: "gpt-5.6-sol", name: "Renamed Sol" },
      config: { provider: "openai", model: "gpt-5.6-sol", apiToken: "" },
    }]);

    const list = await user.listModels();
    expect(ids(list)).toEqual(["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-nova"]);
    // A user record that shadows a built-in id is hidden; the built-in wins, under its own name.
    expect(list[0].name).toBe("GPT 5.6 Sol");
    expect((await user.getChatContext("gpt-5.6-sol")).aiModel!.profile.name).toBe("GPT 5.6 Sol");
  });

  it("lists exactly the catalog when custom models are disallowed", async () => {
    const { user } = makeUser(tierGateway, [OWN_MODEL]);

    expect(await user.listModels()).toEqual([
      { type: "agent", id: "high", name: "High" },
      { type: "agent", id: "low", name: "Low" },
    ]);
    expect((await user.getChatContext("low")).aiModel!.config).toEqual(
        { provider: "openai", model: "gpt-5.6-luna", apiToken: "" });
    // Previously added models are ignored everywhere, not just hidden from the list.
    await expect(user.getChatContext("gpt-5.6-nova")).rejects.toThrow("No such model");
    await expect(user.setPreferredModel("gpt-5.6-nova")).rejects.toThrow("No such model");
    await expect(user.setPreferredModel("high")).resolves.toBeUndefined();
  });

  it("refuses to add models when the deployment disallows them", async () => {
    const { user, models } = makeUser(tierGateway);
    const profile: AiChatAuthorInfo = { type: "agent", id: "gpt-5.6-nova", name: "Nova" };
    const config: AiModelConfig = { provider: "openai", model: "gpt-5.6-nova", apiToken: "" };

    await expect(user.addModel(profile, config))
        .rejects.toThrow("This deployment does not allow adding your own models.");
    expect(models.size).toBe(0);
  });

  it("still adds models for enabled providers when allowed", async () => {
    const { user, models } = makeUser(defaultGateway);

    await user.addModel({ type: "agent", id: "gpt-5.6-nova", name: "Nova" },
        { provider: "openai", model: "gpt-5.6-nova", apiToken: "" });
    expect(models.has("gpt-5.6-nova")).toBe(true);
    await expect(user.addModel({ type: "agent", id: "claude-opus-5", name: "Opus" },
        { provider: "anthropic", model: "claude-opus-5", apiToken: "" }))
        .rejects.toThrow('Provider "anthropic" is not available in AI Gateway mode.');
  });

  it("protects built-in models from deletion, by catalog id", async () => {
    const tiers = makeUser(tierGateway);
    await expect(tiers.user.deleteModel("high"))
        .rejects.toThrow('Cannot delete built-in model "High".');

    const defaults = makeUser(defaultGateway, [OWN_MODEL]);
    await expect(defaults.user.deleteModel("gpt-5.6-sol"))
        .rejects.toThrow('Cannot delete built-in model "GPT 5.6 Sol".');
    // Suggested models are built in without a catalog, even when the user also stored one.
    await expect(defaults.user.deleteModel("gpt-5.6-terra"))
        .rejects.toThrow('Cannot delete built-in model "GPT 5.6 Terra".');
    await defaults.user.deleteModel("gpt-5.6-nova");
    expect(defaults.models.size).toBe(0);
  });
});
