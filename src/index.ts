const OPENROUTER_URL = "https://openrouter.ai/api/alpha/decisions";
// The OpenRouter page alias (~typesafe/jev-latest) is not accepted by the
// Decisions API; use the concrete Jev model ID and allow an explicit override.
const MODEL = Bun.env.OPENROUTER_MODEL ?? "typesafe/jev-1.13";

export {};

type ChoiceAnswer = {
  type: "choice";
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
};

type DecisionsResponse = {
  answers?: Record<string, ChoiceAnswer>;
  model?: string;
  [key: string]: unknown;
};

const apiKey = Bun.env.OPENROUTER_API_KEY;

if (!apiKey) {
  console.error("缺少 OPENROUTER_API_KEY。请复制 .env.example 为 .env 并填入 API key。");
  process.exit(1);
}

async function classify(text: string): Promise<DecisionsResponse> {
  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(Bun.env.OPENROUTER_SITE_URL
        ? { "HTTP-Referer": Bun.env.OPENROUTER_SITE_URL }
        : {}),
      ...(Bun.env.OPENROUTER_APP_NAME
        ? { "X-OpenRouter-Title": Bun.env.OPENROUTER_APP_NAME }
        : {}),
    },
    body: JSON.stringify({
      model: MODEL,
      state: { text },
      questions: {
        sentiment: {
          type: "choice",
          instructions: "判断 text 表达的整体情绪。",
          criteria: {
            positive: "整体是积极、满意、开心或赞扬。",
            neutral: "整体没有明显的积极或消极倾向，或只是陈述事实。",
            negative: "整体是消极、不满、悲伤、愤怒或批评。",
          },
        },
      },
    }),
  });

  const body = (await response.json()) as DecisionsResponse & {
    error?: { message?: string };
  };

  if (!response.ok) {
    throw new Error(
      `OpenRouter 请求失败 (${response.status}): ${body.error?.message ?? JSON.stringify(body)}`,
    );
  }

  return body;
}

async function readInput(): Promise<string> {
  const fromArgs = Bun.argv.slice(2).join(" ").trim();
  if (fromArgs) return fromArgs;

  if (process.stdin.isTTY) {
    return "这个产品真的很棒，我非常满意。";
  }

  return (await Bun.stdin.text()).trim();
}

try {
  const text = await readInput();
  if (!text) throw new Error("请输入待分类文本，例如：bun run start \"这个产品很棒\"");

  const result = await classify(text);
  const answer = result.answers?.sentiment;

  console.log(
    JSON.stringify(
      {
        model: result.model ?? MODEL,
        text,
        choice: answer?.choice ?? null,
        confidence: answer?.confidence ?? null,
        probabilities: answer?.probabilities ?? {},
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
