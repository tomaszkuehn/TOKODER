export type OllamaModel = { name: string; size?: number };

export async function listOllamaModels(kind: "local" | "cloud", timeoutMs = 8000): Promise<OllamaModel[]> {
  const url = kind === "local" ? "http://localhost:11434/api/tags" : "https://ollama.com/api/tags";
  const headers: Record<string, string> = {};
  if (kind === "cloud" && process.env.OLLAMA_API_KEY) headers.Authorization = `Bearer ${process.env.OLLAMA_API_KEY}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} → ${url}`);
  const j: any = await res.json();
  const models = (j.models ?? []).map((m: any) => ({ name: m.name ?? m.model, size: m.size }));
  if (!models.length) throw new Error(`No models at ${url}`);
  return models;
}

export function ollamaIdSuggestion(modelName: string): string {
  return modelName
    .toLowerCase()
    .replace(/:.*$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24) || "ollama-model";
}
