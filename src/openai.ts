/**
 * OpenAI/Azure/Codex model and payload helpers.
 *
 * Keeps provider-specific detection, request patching, endpoint classification,
 * and model-key logic out of the higher-level extension wiring.
 */
import type { ExtensionConfig, JsonRecord } from "./config.ts";
import type { ResponsesReasoningConfig, ResponsesTextConfig } from "./remote-compaction.ts";
import { isRecord, toPositiveInteger } from "./config.ts";

export type ModelLike = {
  api?: unknown;
  provider?: unknown;
  id?: unknown;
  baseUrl?: unknown;
  compat?: unknown;
  contextWindow?: unknown;
  reasoning?: unknown;
  input?: readonly unknown[];
};

type AssistantMessageLike = {
  role?: unknown;
  provider?: unknown;
  model?: unknown;
  responseId?: unknown;
  stopReason?: unknown;
};

export function hostnameFromBaseUrl(baseUrl: unknown): string | undefined {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) return undefined;
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function supportsStore(model: unknown): boolean {
  if (!isRecord(model)) return true;
  const compat = model.compat;
  if (!isRecord(compat)) return true;
  return compat.supportsStore !== false;
}

export function isOpenAIResponsesModel(model: unknown): model is ModelLike {
  return (
    isRecord(model) &&
    (
      model.api === "openai-responses" ||
      model.api === "azure-openai-responses" ||
      model.api === "openai-codex-responses"
    )
  );
}

export function isDirectOpenAIResponsesModel(model: ModelLike): boolean {
  if (model.api !== "openai-responses") return false;
  if (model.provider !== "openai") return false;
  const host = hostnameFromBaseUrl(model.baseUrl);
  return host === undefined || host === "api.openai.com";
}

export function isAzureOpenAIResponsesModel(model: ModelLike): boolean {
  if (model.api !== "azure-openai-responses" && model.api !== "openai-responses") return false;
  const provider = typeof model.provider === "string" ? model.provider : "";
  if (provider === "azure-openai" || provider === "azure-openai-responses") return true;
  const host = hostnameFromBaseUrl(model.baseUrl);
  return typeof host === "string" && host.endsWith(".openai.azure.com");
}

export function isOpenAICodexResponsesModel(model: ModelLike): boolean {
  if (model.api !== "openai-codex-responses") return false;
  const provider = typeof model.provider === "string" ? model.provider : "";
  if (provider === "openai-codex") return true;
  const host = hostnameFromBaseUrl(model.baseUrl);
  return host === "chatgpt.com";
}

export function supportsPreviousResponseId(
  model: unknown,
  cfg: Required<ExtensionConfig>,
): model is ModelLike {
  if (!isOpenAIResponsesModel(model)) return false;
  if (isDirectOpenAIResponsesModel(model)) return true;
  return cfg.includeAzure && isAzureOpenAIResponsesModel(model);
}

export function supportsRemoteCompactionModel(model: unknown): model is ModelLike {
  if (!isOpenAIResponsesModel(model)) return false;
  return isDirectOpenAIResponsesModel(model) || isOpenAICodexResponsesModel(model);
}

export function resolveCompactThreshold(
  model: ModelLike,
  cfg: Required<ExtensionConfig>,
): number {
  if (cfg.compactThreshold > 0) return Math.floor(cfg.compactThreshold);
  const contextWindow = toPositiveInteger(model.contextWindow);
  if (contextWindow) return Math.max(1000, Math.floor(contextWindow * cfg.thresholdRatio));
  return 80000;
}

export function looksLikeResponsesPayload(payload: JsonRecord): boolean {
  return "input" in payload || "model" in payload || "messages" in payload;
}

export function modelKey(model: ModelLike): string {
  return `${String(model.provider)}:${String(model.api)}:${String(model.id)}`;
}

export function applyPayloadPatch(params: {
  payload: JsonRecord;
  model: ModelLike;
  cfg: Required<ExtensionConfig>;
  previousResponseId?: string;
}): JsonRecord {
  const nextPayload: JsonRecord = { ...params.payload };

  if (supportsStore(params.model)) {
    nextPayload.store = true;
  }

  if (nextPayload.context_management === undefined) {
    nextPayload.context_management = [
      {
        type: "compaction",
        compact_threshold: resolveCompactThreshold(params.model, params.cfg),
      },
    ];
  }

  if (
    params.cfg.usePreviousResponseId &&
    params.previousResponseId &&
    nextPayload.previous_response_id === undefined
  ) {
    nextPayload.previous_response_id = params.previousResponseId;
  }

  return nextPayload;
}

export function thinkingLevelToResponsesReasoning(
  thinkingLevel: unknown,
): ResponsesReasoningConfig | undefined {
  if (thinkingLevel === "minimal") return { effort: "minimal", summary: "auto" };
  if (thinkingLevel === "low") return { effort: "low", summary: "auto" };
  if (thinkingLevel === "medium") return { effort: "medium", summary: "auto" };
  if (thinkingLevel === "high") return { effort: "high", summary: "auto" };
  if (thinkingLevel === "xhigh") return { effort: "xhigh", summary: "auto" };
  return undefined;
}

function isAdditionalToolsItem(item: unknown): item is { type: "additional_tools"; tools: unknown[] } {
  return isRecord(item) && item.type === "additional_tools" && Array.isArray(item.tools);
}

function inputHasAdditionalTools(input: unknown[]): boolean {
  return input.some(isAdditionalToolsItem);
}

/**
 * Codex declares callable tools as `additional_tools` input items and leaves the
 * top-level `tools` array empty. Remote replay replaces `input`, so those items
 * must be copied onto the replacement history or the host has no callable tools.
 */
export function prependMissingAdditionalTools(history: unknown[], sourceInput: unknown): unknown[] {
  if (!Array.isArray(sourceInput)) return history;
  const declarations = sourceInput.filter(isAdditionalToolsItem);
  if (declarations.length === 0) return history;
  const present = new Set(
    history.filter(isAdditionalToolsItem).map((item) => JSON.stringify(item.tools)),
  );
  const missing = declarations.filter((item) => !present.has(JSON.stringify(item.tools)));
  return missing.length === 0 ? history : [...missing, ...history];
}

export function applyRemoteHistoryPayloadPatch(params: {
  payload: JsonRecord;
  explicitHistory: unknown[];
  callableTools?: Record<string, unknown>[];
}): JsonRecord {
  let input = prependMissingAdditionalTools(params.explicitHistory, params.payload.input);
  const hasTopLevelTools = Array.isArray(params.payload.tools) && params.payload.tools.length > 0;
  if (
    !hasTopLevelTools &&
    !inputHasAdditionalTools(input) &&
    params.callableTools !== undefined &&
    params.callableTools.length > 0
  ) {
    input = [{ type: "additional_tools", role: "developer", tools: params.callableTools }, ...input];
  }
  const nextPayload: JsonRecord = {
    ...params.payload,
    input,
  };
  delete nextPayload.messages;
  delete nextPayload.previous_response_id;
  return nextPayload;
}

export function extractResponsesReasoningConfig(payload: unknown): ResponsesReasoningConfig | undefined {
  if (!isRecord(payload) || !isRecord(payload.reasoning)) return undefined;
  const effort = payload.reasoning.effort;
  const summary = payload.reasoning.summary;
  const normalized: ResponsesReasoningConfig = {
    ...(typeof effort === "string" ? { effort: effort as ResponsesReasoningConfig["effort"] } : {}),
    ...(
      summary === null || typeof summary === "string"
        ? { summary: summary as ResponsesReasoningConfig["summary"] }
        : {}
    ),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function extractResponsesTextConfig(payload: unknown): ResponsesTextConfig | undefined {
  return isRecord(payload) && isRecord(payload.text) ? payload.text : undefined;
}

export function extractAssistantResponseId(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  const msg = message as AssistantMessageLike;
  if (msg.role !== "assistant") return undefined;
  if (msg.stopReason === "error" || msg.stopReason === "aborted") return undefined;
  return typeof msg.responseId === "string" && msg.responseId.trim()
    ? msg.responseId
    : undefined;
}

export function messageMatchesModel(message: unknown, model: ModelLike): boolean {
  if (!isRecord(message)) return false;
  return message.provider === model.provider && message.model === model.id;
}
