export interface TranscriptionUsage {
  type: "tokens" | "duration";
  seconds?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_token_details?: {
    audio_tokens?: number;
    text_tokens?: number;
  };
}

export function formatTranscriptionUsage(chunkUsages: Array<TranscriptionUsage | undefined>): string[] {
  const reported = (values: Array<number | undefined>, label: string): string | undefined => {
    const numbers = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
    if (numbers.length === 0) {
      return undefined;
    }
    const total = numbers.reduce((sum, value) => sum + value, 0);
    const coverage = numbers.length === chunkUsages.length ? "" : ` (reported for ${numbers.length}/${chunkUsages.length} chunks)`;
    return `- ${label}: ${total} tokens${coverage}`;
  };
  const tokens = chunkUsages.map((usage) => usage?.type === "tokens" ? usage : undefined);
  const inputTokens = reported(tokens.map((usage) => usage?.input_tokens), "Input tokens");
  const outputTokens = reported(tokens.map((usage) => usage?.output_tokens), "Output tokens");
  return [
    ...(!inputTokens && !outputTokens ? ["- Transcription tokens: Not reported by provider."] : []),
    ...(inputTokens ? [inputTokens] : []),
    ...(outputTokens ? [outputTokens] : [])
  ];
}