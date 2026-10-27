import { NextRequest, NextResponse } from "next/server";
import { recallMemories } from "../../lib/recall";

export const runtime = "nodejs";

type ChatRole = "user" | "assistant";
type ChatMessage = { role: ChatRole; content: string };

const SERVER_URL = (process.env.LLAMA_SERVER_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");
const MODEL_ALIAS = process.env.LLAMA_MODEL_ALIAS || "raphya-1";
const MAX_TOKENS = Math.min(Math.max(Number(process.env.LLAMA_MAX_TOKENS) || 3072, 256), 8192);
const SYSTEM_PROMPT = [
  "당신은 대학 연구실에서 민철희 교수님을 돕는 로컬 AI 연구 보조원 Raphya-1입니다.",
  "질문에 명료하고 정중하게 답하고, 불확실한 내용은 사실처럼 지어내지 마세요.",
  "[첨부 문서]가 제공되면 실제로 읽은 것이므로 그 내용만 근거로 요약·답변하고, 문서에 없는 내용은 지어내지 마세요. 그 외에는 파일 읽기, 계산 실행, 교수 피드백 학습을 했다고 주장하지 마세요.",
  "[저장된 기억]이 제공되면 관련 있을 때 참고하되, 질문과 무관하면 언급하지 마세요.",
  "[웹 검색 결과]가 제공되면 그 발췌문에 실제로 있는 내용만 근거로 답하고 [번호]로 출처를 표시하세요. 발췌문에 없는 장소·수치·날짜는 만들지 말고 '검색 결과에서 확인되지 않았습니다'라고 말하세요. 반드시 한국어로만 답하고 한자나 일본어를 섞지 마세요. 제공되지 않으면 인터넷 검색을 했다고 주장하지 마세요.",
].join(" ");

type SearchResult = { title: string; url: string; snippet: string };

function readSearchContext(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const lines = value.slice(0, 6).flatMap((item, index) => {
    const r = item as Partial<SearchResult>;
    if (typeof r?.title !== "string" || typeof r.url !== "string" || typeof r.snippet !== "string") return [];
    return [`[${index + 1}] ${r.title.slice(0, 200)} (${r.url.slice(0, 300)})\n${r.snippet.slice(0, 800)}`];
  });
  return lines.length ? `[웹 검색 결과]\n${lines.join("\n\n")}` : null;
}

function readDocumentContext(value: unknown): string | null {
  const d = value as { name?: unknown; text?: unknown } | null | undefined;
  if (typeof d?.name !== "string" || typeof d.text !== "string" || !d.text.trim()) return null;
  return `[첨부 문서: ${d.name.slice(0, 200)}]\n${d.text.slice(0, 6000)}`;
}

// The browser only calls /api/chat; the GGUF server is never called directly by the browser.
export async function GET() {
  try {
    const response = await fetch(`${SERVER_URL}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });
    return NextResponse.json({ ready: response.ok }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ ready: false }, { headers: { "Cache-Control": "no-store" } });
  }
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청 형식입니다." }, { status: 400 });
  }

  const rawMessages = typeof body === "object" && body !== null && "messages" in body
    ? (body as { messages?: unknown }).messages
    : undefined;

  if (!Array.isArray(rawMessages) || rawMessages.length === 0 || rawMessages.length > 100) {
    return NextResponse.json({ error: "메시지 배열이 올바르지 않습니다." }, { status: 400 });
  }

  const valid = rawMessages.every((item): item is ChatMessage =>
    typeof item === "object" && item !== null &&
    (item.role === "user" || item.role === "assistant") &&
    typeof item.content === "string" && item.content.trim().length > 0 && item.content.length <= 4000
  );

  if (!valid || rawMessages[rawMessages.length - 1].role !== "user") {
    return NextResponse.json({ error: "전송할 메시지가 올바르지 않습니다." }, { status: 400 });
  }

  // Keep the MVP context small. No messages are stored on the server.
  const messages = (rawMessages as ChatMessage[]).slice(-16);
  const searchContext = readSearchContext((body as { searchResults?: unknown }).searchResults);
  const documentContext = readDocumentContext((body as { document?: unknown }).document);
  let memoryContext: string | null = null;
  let memoriesUsed = 0;
  try {
    const recalled = await recallMemories(messages[messages.length - 1].content);
    memoriesUsed = recalled.length;
    if (recalled.length) memoryContext = `[저장된 기억]\n${recalled.map((m) => `- ${m.content}`).join("\n")}`;
  } catch {
    memoryContext = null;
  }
  const system = [SYSTEM_PROMPT, memoryContext, searchContext].filter(Boolean).join("\n\n");
  if (documentContext) {
    const last = messages[messages.length - 1];
    last.content = `아래 문서는 사용자가 직접 첨부한 파일의 실제 텍스트입니다. 이 내용을 읽고 질문에 답하세요.\n\n${documentContext}\n\n[질문]\n${last.content}`;
  }

  try {
    const response = await fetch(`${SERVER_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL_ALIAS,
        stream: false,
        temperature: 0.6,
        max_tokens: MAX_TOKENS,
        messages: [{ role: "system", content: system }, ...messages],
      }),
      cache: "no-store",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(900000)]),
    });

    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const details = readErrorMessage(data);
      return NextResponse.json({ error: details || `로컬 모델 서버 오류 (${response.status})` }, { status: 502 });
    }

    const reply = readReply(data);
    if (!reply) {
      return NextResponse.json({ error: "모델이 빈 답변을 반환했습니다." }, { status: 502 });
    }
    return NextResponse.json({ reply, memoriesUsed }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
      ? "모델 응답 시간이 초과되었습니다. 모델 로딩 또는 추론 상태를 확인하세요."
      : "로컬 GGUF 서버에 연결하지 못했습니다. llama-server 실행 상태를 확인하세요.";
    return NextResponse.json({ error: message }, { status: 503 });
  }
}

function readReply(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("choices" in value)) return null;
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0] as { message?: { content?: unknown } };
  if (typeof first?.message?.content !== "string") return null;
  // Reasoning models (DeepSeek-R1) emit <think>…</think>; hide it, and drop an unterminated one cut off by max_tokens.
  const text = first.message.content
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<think>[\s\S]*$/, "")
    .replace(/^[\s\S]*?<\/think>/, "")
    .trim();
  return text || null;
}

function readErrorMessage(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("error" in value)) return null;
  const error = (value as { error?: unknown }).error;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" ? message : null;
  }
  return null;
}

//& "C:\Users\user\Downloads\llama-b10883-bin-win-cuda-13.3-x64\llama-server.exe" -m "c:\Users\user\Desktop\sophia\DeepSeek-R1-Distill-Llama-8B-Q4_K_M.gguf" --alias raphya-1 --host 127.0.0.1 --port 8080 -c 8192 -ngl 99