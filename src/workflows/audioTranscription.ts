import * as http from "node:http";
import * as https from "node:https";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as vscode from "vscode";
import { resolveConfiguredLanguageModel } from "../aiSettings";
import { getConfiguredLanguageModelProviderBaseUrl } from "../languageModelProvider";
import { getLanguageModelProviderApiKey } from "../secrets";
import { beginRunWrite, finishRunWrite, pruneSavedRuns } from "../runRetention";
import { resolveWorkflowRunsDirUri } from "../workflowConfig";
import { formatTranscriptionUsage, TranscriptionUsage } from "./transcriptionUsage";
import { ensureMediaTools, MediaTools } from "./mediaTools";

const TRANSCRIPTION_MODEL = "gpt-4o-transcribe-diarize";
const MEDIA_EXTENSIONS = new Set([
  ".3g2", ".3gp", ".aac", ".aiff", ".amr", ".avi", ".caf", ".flac", ".m2ts",
  ".m4a", ".m4v", ".mkv", ".mov", ".mp3", ".mp4", ".mpeg", ".mpg", ".mts",
  ".ogg", ".opus", ".ts", ".wav", ".webm", ".wma", ".wmv"
]);
const AUDIO_FILE_EXCLUDE = "**/{node_modules,.git,.cmsis-dev,out,dist,build}/**";
const SUMMARY_CHUNK_CHARACTERS = 12000;
const AUDIO_CHUNK_SECONDS = 180;
const AUDIO_CHUNK_OVERLAP_SECONDS = 10;
const MAX_KNOWN_SPEAKERS = 4;
const MAX_PARALLEL_TRANSCRIPTIONS = 3;

interface DiarizedTranscription {
  text?: string;
  recordingDuration?: number;
  chunkUsages?: Array<TranscriptionUsage | undefined>;
  usage?: TranscriptionUsage;
  segments?: Array<{
    start?: number;
    end?: number;
    text?: string;
    speaker?: string;
  }>;
}

interface SpeakerReference {
  name: string;
  dataUrl: string;
}

export async function runAudioTranscription(storagePath: string): Promise<vscode.Uri | undefined> {
  const apiKey = await getLanguageModelProviderApiKey();
  if (!apiKey) {
    vscode.window.showWarningMessage("Configure the CMSIS-Dev language model provider API key before transcribing audio.");
    await vscode.commands.executeCommand("cmsisDev.configureIntegrations");
    return;
  }

  const audioFile = await selectAudioFile();
  if (!audioFile) {
    return;
  }

  const model = await resolveConfiguredLanguageModel();
  if (!model) {
    vscode.window.showWarningMessage("No CMSIS-Dev chat model is available for generating the executive summary.");
    return;
  }

  try {
    const mediaTools = await ensureMediaTools(storagePath);
    if (!mediaTools) {
      return;
    }
    const outputFile = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Transcribing ${path.basename(audioFile.fsPath)}`,
        cancellable: true
      },
      async (progress, cancellationToken) => {
        const transcriptionStartedAt = performance.now();
        const transcription = await transcribeMedia(
          audioFile,
          apiKey,
          mediaTools,
          cancellationToken,
          (message, increment) => progress.report({ message, increment })
        );
        const transcriptionProcessingSeconds = (performance.now() - transcriptionStartedAt) / 1000;
        if (cancellationToken.isCancellationRequested) {
          return undefined;
        }

        const transcript = formatDiarizedTranscript(transcription);
        progress.report({ message: "Generating executive summary..." });
        const summary = await summarizeTranscript(model, transcript, cancellationToken, (message) => {
          progress.report({ message });
        });
        if (cancellationToken.isCancellationRequested) {
          return undefined;
        }

        progress.report({ message: "Saving run..." });
      return saveTranscriptionRun(audioFile, model.name, summary, transcript, transcription, transcriptionProcessingSeconds);
      }
    );

    if (!outputFile) {
      vscode.window.showInformationMessage("Audio transcription canceled.");
      return;
    }

    await vscode.commands.executeCommand("cmsisDev.refreshRuns");
    const document = await vscode.workspace.openTextDocument(outputFile);
    await vscode.window.showTextDocument(document, { preview: false });
    vscode.window.showInformationMessage(`Audio transcription saved to ${path.basename(outputFile.fsPath)}.`);
    return outputFile;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error ? error.cause : undefined;
    const causeMessage = cause instanceof Error ? cause.message : undefined;
    const errorCode = isRecord(error) && typeof error.code === "string" ? `${error.code}: ` : "";
    const causeCode = isRecord(cause) && typeof cause.code === "string" ? `${cause.code}: ` : "";
    const details = causeMessage
      ? `${message} (${causeCode}${causeMessage})`
      : `${errorCode}${message}`;
    vscode.window.showErrorMessage(`Audio transcription failed: ${details}`);
  }
}

async function selectAudioFile(): Promise<vscode.Uri | undefined> {
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  if (workspaceFolders.length === 0) {
    vscode.window.showWarningMessage("Open a workspace containing audio files before running transcription.");
    return undefined;
  }

  const matches = await vscode.workspace.findFiles("**/*", AUDIO_FILE_EXCLUDE);
  const files = matches
    .filter((uri) => uri.scheme === "file" && MEDIA_EXTENSIONS.has(path.extname(uri.fsPath).toLowerCase()))
    .map((uri) => {
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      return {
        label: path.basename(uri.fsPath),
        description: folder ? path.relative(folder.uri.fsPath, uri.fsPath) : uri.fsPath,
        detail: folder?.name,
        uri
      };
    })
    .sort((left, right) => left.description.localeCompare(right.description));

  if (files.length === 0) {
    vscode.window.showInformationMessage("No supported audio or video files were found in the workspace.");
    return undefined;
  }

  const selected = await vscode.window.showQuickPick(files, {
    title: "Transcribe Audio",
    placeHolder: "Select one audio or video recording from the workspace",
    matchOnDescription: true,
    matchOnDetail: true
  });
  return selected?.uri;
}

async function transcribeMedia(
  audioFile: vscode.Uri,
  apiKey: string,
  mediaTools: MediaTools,
  cancellationToken: vscode.CancellationToken,
  reportProgress: (message: string, increment?: number) => void
): Promise<DiarizedTranscription> {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cmsis-dev-transcription-"));
  try {
    const duration = await probeMediaDuration(audioFile.fsPath, mediaTools, cancellationToken);
    if (cancellationToken.isCancellationRequested) {
      return {};
    }
    const chunkCount = Math.max(1, Math.ceil(
      (duration - AUDIO_CHUNK_OVERLAP_SECONDS) / (AUDIO_CHUNK_SECONDS - AUDIO_CHUNK_OVERLAP_SECONDS)
    ));
    const chunkDuration = Math.min(
      AUDIO_CHUNK_SECONDS,
      (duration + AUDIO_CHUNK_OVERLAP_SECONDS * (chunkCount - 1)) / chunkCount
    );
    const chunkStride = chunkDuration - AUDIO_CHUNK_OVERLAP_SECONDS;
    if (!Number.isFinite(duration) || duration <= 0 || chunkCount < 1) {
      throw new Error("Could not determine a valid duration for the selected media file.");
    }

    const transcriptSegments: NonNullable<DiarizedTranscription["segments"]> = [];
    const chunkUsages: Array<TranscriptionUsage | undefined> = [];
    const speakerReferences = new Map<string, SpeakerReference>();
    let nextSpeakerNumber = 1;
    let completedChunks = 0;

    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      if (cancellationToken.isCancellationRequested) {
        return {};
      }
      const chunkStart = chunkIndex * chunkStride;
      const currentChunkDuration = Math.min(chunkDuration, duration - chunkStart);
      const chunkFile = path.join(temporaryDirectory, `chunk-${String(chunkIndex + 1).padStart(4, "0")}.mp3`);
      await extractAudioChunk(audioFile.fsPath, chunkFile, chunkStart, currentChunkDuration, mediaTools, cancellationToken);
      if (cancellationToken.isCancellationRequested) {
        return {};
      }
      const transcription = await transcribeAudioChunk(chunkFile, apiKey, [...speakerReferences.values()], cancellationToken);
      if (cancellationToken.isCancellationRequested) {
        return {};
      }
      chunkUsages.push(transcription.usage);

      const chunkSegments = transcription.segments?.filter((segment) => segment.text?.trim()) ?? [];
      if (chunkSegments.length === 0 && transcription.text?.trim()) {
        transcriptSegments.push({
          start: chunkStart,
          end: chunkStart,
          text: transcription.text.trim()
        });
      }
      const localSpeakerMap = new Map<string, string>();
      for (const segment of chunkSegments) {
        if (segment.speaker && speakerReferences.has(segment.speaker)) {
          localSpeakerMap.set(segment.speaker, segment.speaker);
        }
      }
      if (chunkIndex > 0) {
        for (const segment of chunkSegments) {
          if (!segment.speaker || localSpeakerMap.has(segment.speaker) || (segment.end ?? 0) > AUDIO_CHUNK_OVERLAP_SECONDS) {
            continue;
          }
          const text = segment.text?.trim().replace(/\s+/g, " ").toLowerCase();
          if (!text || text.length < 12) {
            continue;
          }
          const start = chunkStart + (segment.start ?? 0);
          const matches = transcriptSegments.filter((previous) =>
            previous.speaker
            && previous.text?.trim().replace(/\s+/g, " ").toLowerCase() === text
            && Math.abs((previous.start ?? 0) - start) < 2
          );
          if (matches.length === 1 && ![...localSpeakerMap.values()].includes(matches[0].speaker!)) {
            localSpeakerMap.set(segment.speaker, matches[0].speaker!);
          }
        }
      }
      for (const segment of chunkSegments) {
        const localSpeaker = segment.speaker;
        if (!localSpeaker) {
          continue;
        }
        let globalSpeaker = localSpeakerMap.get(localSpeaker);
        if (!globalSpeaker) {
          globalSpeaker = `Speaker ${nextSpeakerNumber++}`;
          localSpeakerMap.set(localSpeaker, globalSpeaker);
        }
        if (!speakerReferences.has(globalSpeaker) && speakerReferences.size < MAX_KNOWN_SPEAKERS) {
          const start = segment.start ?? 0;
          const end = segment.end ?? start;
          const referenceDuration = Math.min(5, end - start);
          if (referenceDuration >= 2) {
            try {
              const data = await extractSpeakerReference(chunkFile, start, referenceDuration, mediaTools, cancellationToken);
              speakerReferences.set(globalSpeaker, {
                name: globalSpeaker,
                dataUrl: `data:audio/wav;base64,${data.toString("base64")}`
              });
            } catch {
              // A reference is an optional aid; keep the transcript if extraction fails.
            }
          }
        }
      }

      const overlapSeconds = chunkIndex === 0 ? 0 : AUDIO_CHUNK_OVERLAP_SECONDS;
      for (const segment of chunkSegments) {
        const localStart = segment.start ?? 0;
        const localEnd = segment.end ?? localStart;
        if (chunkIndex > 0 && localEnd <= overlapSeconds) {
          continue;
        }
        const globalSegment = {
          ...segment,
          start: localStart + chunkStart,
          end: localEnd + chunkStart,
          speaker: segment.speaker ? localSpeakerMap.get(segment.speaker) : undefined
        };
        if (chunkIndex > 0 && localStart < overlapSeconds) {
          for (let index = transcriptSegments.length - 1; index >= 0; index -= 1) {
            const previous = transcriptSegments[index];
            if ((previous.end ?? 0) > globalSegment.start! && (previous.start ?? 0) < globalSegment.end!) {
              transcriptSegments.splice(index, 1);
            }
          }
        }
        transcriptSegments.push(globalSegment);
      }
      completedChunks += 1;
      reportProgress(
        `Transcribed ${completedChunks}/${chunkCount} chunks (${Math.floor(completedChunks * 100 / chunkCount)}%)`,
        Math.floor(completedChunks * 100 / chunkCount) - Math.floor((completedChunks - 1) * 100 / chunkCount)
      );
    }

    return {
      recordingDuration: duration,
      chunkUsages,
      segments: transcriptSegments,
      text: transcriptSegments.map((segment) => segment.text?.trim()).filter(Boolean).join(" ")
    };
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function probeMediaDuration(filePath: string, mediaTools: MediaTools, cancellationToken: vscode.CancellationToken): Promise<number> {
  const output = await runMediaTool(mediaTools.ffprobe, [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath
  ], cancellationToken, true);
  if (cancellationToken.isCancellationRequested) {
    return 0;
  }
  const duration = Number.parseFloat(output.toString("utf8").trim());
  if (!Number.isFinite(duration)) {
    throw new Error("FFprobe could not read the selected media duration.");
  }
  return duration;
}

async function extractAudioChunk(
  inputFile: string,
  outputFile: string,
  start: number,
  duration: number,
  mediaTools: MediaTools,
  cancellationToken: vscode.CancellationToken
): Promise<void> {
  await runMediaTool(mediaTools.ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y", "-ss", String(start), "-i", inputFile,
    "-t", String(duration), "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", "-f", "mp3", outputFile
  ], cancellationToken);
}

async function extractSpeakerReference(
  chunkFile: string,
  start: number,
  duration: number,
  mediaTools: MediaTools,
  cancellationToken: vscode.CancellationToken
): Promise<Buffer> {
  return runMediaTool(mediaTools.ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-ss", String(start), "-i", chunkFile,
    "-t", String(duration), "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", "pipe:1"
  ], cancellationToken, true);
}

function runMediaTool(
  command: string,
  args: string[],
  cancellationToken: vscode.CancellationToken,
  captureStdout = false
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const cancellation = cancellationToken.onCancellationRequested(() => child.kill());
    child.stdout.on("data", (chunk: Buffer) => {
      if (captureStdout) {
        stdout.push(chunk);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error: NodeJS.ErrnoException) => {
      cancellation.dispose();
      if (error.code === "ENOENT") {
        reject(new Error(`Media tool ${path.basename(command)} is no longer available. Retry the transcription to reinstall it.`));
      } else {
        reject(error);
      }
    });
    child.once("close", (code) => {
      cancellation.dispose();
      if (cancellationToken.isCancellationRequested) {
        resolve(Buffer.alloc(0));
      } else if (code === null) {
        reject(new Error(`${command} was terminated before it completed.`));
      } else if (code !== 0) {
        reject(new Error(`${command} failed: ${Buffer.concat(stderr).toString("utf8").trim() || `exit code ${code}`}`));
      } else {
        resolve(Buffer.concat(stdout));
      }
    });
  });
}

async function transcribeAudioChunk(
  audioFile: string,
  apiKey: string,
  speakerReferences: SpeakerReference[],
  cancellationToken: vscode.CancellationToken
): Promise<DiarizedTranscription> {
  const fileSize = (await fs.stat(audioFile)).size;
  const boundary = `----cmsisdev-${randomBytes(16).toString("hex")}`;
  const filename = path.basename(audioFile).replace(/["\r\n]/g, "_");
  const fileHeader = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: audio/mpeg\r\n\r\n`
  );
  const fields = [
    ["model", TRANSCRIPTION_MODEL],
    ["response_format", "diarized_json"],
    ["chunking_strategy", "auto"],
    ...speakerReferences.flatMap((reference) => [
      ["known_speaker_names[]", reference.name],
      ["known_speaker_references[]", reference.dataUrl]
    ])
  ].map(([name, value]) => Buffer.from(
    `\r\n--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}`
  ));
  const ending = Buffer.from(`\r\n--${boundary}--\r\n`);
  const contentLength = fileHeader.length + fileSize + fields.reduce((total, field) => total + field.length, 0) + ending.length;
  const endpoint = new URL(`${getConfiguredLanguageModelProviderBaseUrl()}/audio/transcriptions`);
  const transport = endpoint.protocol === "https:" ? https : endpoint.protocol === "http:" ? http : undefined;
  if (!transport) {
    throw new Error(`Unsupported transcription URL protocol: ${endpoint.protocol}`);
  }

  const body = Readable.from((async function* () {
    yield fileHeader;
    for await (const chunk of createReadStream(audioFile)) {
      yield chunk;
    }
    for (const field of fields) {
      yield field;
    }
    yield ending;
  })());
  const request = transport.request(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": contentLength
    }
  });
  const responsePromise = new Promise<http.IncomingMessage>((resolve, reject) => {
    request.once("response", resolve);
    request.once("error", reject);
  });
  const uploadPromise = pipeline(body, request);
  const cancellation = cancellationToken.onCancellationRequested(() => {
    body.destroy(new Error("Audio transcription canceled."));
    request.destroy(new Error("Audio transcription canceled."));
  });

  try {
    const [, response] = await Promise.all([uploadPromise, responsePromise]);
    const responseChunks: Buffer[] = [];
    for await (const chunk of response) {
      responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const responseText = Buffer.concat(responseChunks).toString("utf8");
    const payload: unknown = JSON.parse(responseText) as unknown;
    if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
      const apiMessage = isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string"
        ? payload.error.message
        : undefined;
      throw new Error(apiMessage || response.statusMessage || `HTTP ${response.statusCode}`);
    }
    if (!isRecord(payload)) {
      throw new Error("The transcription provider returned an empty or invalid response.");
    }
    return payload as DiarizedTranscription;
  } catch (error) {
    if (cancellationToken.isCancellationRequested) {
      return {};
    }
    throw error;
  } finally {
    cancellation.dispose();
  }
}

function formatDiarizedTranscript(transcription: DiarizedTranscription): string {
  const segments = transcription.segments?.filter((segment) => segment.text?.trim());
  if (segments && segments.length > 0) {
    return segments.map((segment) => {
      const timestamp = formatTimestamp(segment.start);
      const speaker = segment.speaker ? formatSpeaker(segment.speaker) : "Speaker";
      return `**[${timestamp}] ${speaker}:** ${segment.text?.trim()}`;
    }).join("\n\n");
  }

  if (transcription.text?.trim()) {
    return `> The provider returned no speaker segments for this recording.\n\n${transcription.text.trim()}`;
  }
  throw new Error("The transcription provider returned no transcript text.");
}

async function summarizeTranscript(
  model: vscode.LanguageModelChat,
  transcript: string,
  cancellationToken: vscode.CancellationToken,
  reportProgress: (message: string) => void
): Promise<string> {
  const chunks = splitTranscript(transcript, SUMMARY_CHUNK_CHARACTERS);
  const chunkSummaries: string[] = [];
  for (let batchStart = 0; batchStart < chunks.length; batchStart += MAX_PARALLEL_TRANSCRIPTIONS) {
    if (cancellationToken.isCancellationRequested) {
      return "";
    }
    const batch = chunks.slice(batchStart, batchStart + MAX_PARALLEL_TRANSCRIPTIONS);
    const results = await Promise.allSettled(batch.map((chunk, offset) => {
      reportProgress(chunks.length > 1
        ? `Summarizing transcript ${batchStart + offset + 1}/${chunks.length}...`
        : "Generating executive summary...");
      return requestSummary(model, chunk, cancellationToken);
    }));
    if (cancellationToken.isCancellationRequested) {
      return "";
    }
    for (const result of results) {
      if (result.status === "rejected") {
        throw result.reason;
      }
      chunkSummaries.push(result.value);
    }
  }

  if (chunkSummaries.length === 1) {
    return chunkSummaries[0];
  }
  if (cancellationToken.isCancellationRequested) {
    return "";
  }

  reportProgress("Combining summary points...");
  try {
    return await requestSummary(
      model,
      `Combine these chronological section summaries into one concise executive summary. Cover the purpose, key points, decisions, and action items. Do not invent details.\n\n${chunkSummaries.map((item, index) => `Section ${index + 1}:\n${item}`).join("\n\n")}`,
      cancellationToken
    );
  } catch (error) {
    if (cancellationToken.isCancellationRequested) {
      return "";
    }
    throw error;
  }
}

async function requestSummary(
  model: vscode.LanguageModelChat,
  text: string,
  cancellationToken: vscode.CancellationToken
): Promise<string> {
  const response = await model.sendRequest(
    [vscode.LanguageModelChatMessage.User(
      `Summarize this diarized audio transcript section, preserving important points, decisions, and action items. Do not invent details. Return only concise Markdown body text without an Executive Summary heading.\n\n${text}`
    )],
    { justification: "CMSIS-Dev is summarizing a user-selected audio transcription." },
    cancellationToken
  );

  let summary = "";
  for await (const part of response.stream) {
    if (cancellationToken.isCancellationRequested) {
      return "";
    }
    if (part instanceof vscode.LanguageModelTextPart) {
      summary += part.value;
    }
  }
  const normalized = summary.trim();
  if (!normalized) {
    throw new Error("The selected chat model returned an empty executive summary.");
  }
  return normalized;
}

function splitTranscript(transcript: string, maxCharacters: number): string[] {
  if (transcript.length <= maxCharacters) {
    return [transcript];
  }

  const paragraphs = transcript.split(/\n\n+/);
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    const pieces = paragraph.length > maxCharacters
      ? paragraph.match(new RegExp(`[\\s\\S]{1,${maxCharacters}}`, "g")) ?? [paragraph]
      : [paragraph];
    for (const piece of pieces) {
      const candidate = current ? `${current}\n\n${piece}` : piece;
      if (candidate.length > maxCharacters && current) {
        chunks.push(current);
        current = piece;
      } else {
        current = candidate;
      }
    }
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

async function saveTranscriptionRun(
  audioFile: vscode.Uri,
  summaryModel: string,
  summary: string,
  transcript: string,
  transcription: DiarizedTranscription,
  transcriptionProcessingSeconds: number
): Promise<vscode.Uri> {
  const runsDir = await resolveWorkflowRunsDirUri(true);
  if (!runsDir || runsDir.scheme !== "file") {
    throw new Error("Could not resolve the workspace runs directory.");
  }
  await fs.mkdir(runsDir.fsPath, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const outputFile = path.join(runsDir.fsPath, `audio-transcription-${timestamp}.md`);
  const content = [
    `# Audio Transcription: ${path.basename(audioFile.fsPath)}`,
    "",
    "## Recording and Transcription Usage",
    "",
    `- Recording duration: ${transcription.recordingDuration === undefined ? "Unknown" : `${formatTimestamp(transcription.recordingDuration)} (${transcription.recordingDuration.toFixed(2)} seconds)`}`,
    `- Transcription processing time: ${formatTimestamp(transcriptionProcessingSeconds)} (${transcriptionProcessingSeconds.toFixed(2)} seconds)`,
    ...formatTranscriptionUsage(transcription.chunkUsages ?? []),
    "",
    "## Executive Summary",
    "",
    summary.trim().replace(/^##[ \t]+Executive Summary[ \t]*#*[ \t]*(?:\r?\n|$)/i, "").trim(),
    "",
    "## Diarized Transcript",
    "",
    transcript,
    ""
  ].join("\n");

  beginRunWrite(outputFile);
  try {
    await fs.writeFile(outputFile, content, "utf8");
    await fs.writeFile(`${outputFile}.meta.json`, `${JSON.stringify({
      workflowId: "audio-transcription",
      workflowTitle: "Transcribe Audio",
      audioFile: path.basename(audioFile.fsPath),
      transcriptionModel: TRANSCRIPTION_MODEL,
      recordingDurationSeconds: transcription.recordingDuration,
      transcriptionProcessingSeconds,
      transcriptionChunkUsages: transcription.chunkUsages,
      summaryModel
    }, null, 2)}\n`, "utf8");
  } finally {
    finishRunWrite(outputFile);
  }

  await pruneSavedRuns();
  return vscode.Uri.file(outputFile);
}

function formatTimestamp(seconds: number | undefined): string {
  const totalSeconds = Math.max(0, Math.floor(seconds ?? 0));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSeconds = totalSeconds % 60;
  return [hours, minutes, remainingSeconds].map((part) => String(part).padStart(2, "0")).join(":");
}

function formatSpeaker(speakerId: string): string {
  if (/^speaker\s+\d+$/i.test(speakerId)) {
    return speakerId;
  }
  const match = speakerId.match(/^(?:speaker[_ -]?)?(\d+)$/i);
  return match ? `Speaker ${Number(match[1]) + 1}` : speakerId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}