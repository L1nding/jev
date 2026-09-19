import { createHash } from "node:crypto";

export type ChoiceRequest = {
  model: string;
  state: Record<string, unknown>;
  questions: Record<string, { type: "choice"; instructions: string; criteria: Record<string, string> }>;
};

export type ChoiceResponse = {
  id?: string;
  model?: string;
  provider?: string;
  usage?: Record<string, unknown>;
  answers?: Record<string, { choice?: string; confidence?: number; probabilities?: Record<string, number> }>;
  error?: unknown;
};

export type DecisionRecord = {
  answer_request_hashes?: Record<string, string>;
  request_hash: string;
  request: ChoiceRequest;
  status: "ok" | "model_error" | "invalid_response" | "replay_mismatch";
  http_status?: number;
  response: ChoiceResponse | null;
  raw_response?: string;
  error?: string;
};

export type DecisionAdapter = (request: ChoiceRequest) => Promise<DecisionRecord>;

export function evidenceHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// The transport is the only network seam. Neither credentials nor headers enter the journal.
export function liveDecisionAdapter(options: {
  endpoint: string;
  apiKey: string;
  timeoutMs?: number;
  fetcher?: (...args: Parameters<typeof fetch>) => Promise<Response>;
}): DecisionAdapter {
  return async (request) => {
    const record: DecisionRecord = { request_hash: evidenceHash(request), request, status: "model_error", response: null };
    try {
      const response = await (options.fetcher ?? fetch)(options.endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
      });
      record.http_status = response.status;
      record.raw_response = await response.text();
      let parsed: unknown;
      try { parsed = JSON.parse(record.raw_response); } catch {
        return { ...record, status: response.ok ? "invalid_response" : "model_error", error: "non_json_response" };
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ...record, status: "invalid_response", error: "invalid_response_shape" };
      }
      record.response = parsed as ChoiceResponse;
      if (!response.ok || record.response.error) return { ...record, error: "model_request_failed" };
      for (const [key, question] of Object.entries(request.questions)) {
        const choice = record.response.answers?.[key]?.choice;
        if (typeof choice !== "string" || !Object.hasOwn(question.criteria, choice)) {
          return { ...record, status: "invalid_response", error: "missing_or_unknown_choice" };
        }
      }
      return { ...record, status: "ok" };
    } catch {
      return { ...record, error: "transport_failure_or_timeout" };
    }
  };
}

export function replayDecisionAdapter(records: DecisionRecord[]): DecisionAdapter {
  let cursor = 0;
  return async (request) => {
    const record = records[cursor];
    const hash = evidenceHash(request);
    if (!record || record.request_hash !== hash || evidenceHash(record.request) !== hash) {
      return { request_hash: hash, request, status: "replay_mismatch", response: null, error: `request_mismatch_at_${cursor}` };
    }
    cursor += 1;
    return structuredClone(record);
  };
}

/** Reuse only an identical, successful request; changed evidence always goes to Jev. */
export function cachedDecisionAdapter(records: DecisionRecord[], fallback: DecisionAdapter): DecisionAdapter {
  const cache = new Map(records.filter((r) => r.status === "ok" && evidenceHash(r.request) === r.request_hash).map((r) => [r.request_hash, r]));
  return async (request) => {
    const record = cache.get(evidenceHash(request));
    return record ? structuredClone(record) : fallback(request);
  };
}
