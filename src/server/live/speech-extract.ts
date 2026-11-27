import { z } from "zod";
import {
	derivedNodeStatus,
	derivePlanStatusesLh,
	type PlanTree,
} from "../../core/contracts/plan.ts";
import type { LhMessage } from "../../core/native-messages.ts";
import {
	PRACTICE_PROBLEM_TOOL,
	SEND_TO_USER_TOOL,
	activeProblemOf,
	danglingQuestionOf,
	pendingPluginQuestionOf,
} from "../../core/native-messages.ts";
import { QUESTION_TOOLS, toolQuestionKind } from "../../core/pending.ts";
import {
	buildAnswer,
	normalizeQuizType,
	questionDisplayOptions,
	resolveCorrect,
	type QuestionAnswerData,
	type QuestionData,
	type QuizOption,
} from "../../core/question-core.ts";

type ToolCallBlock = { type: "toolCall"; id: string; name: string; arguments?: Record<string, unknown> };

const RawQuestionArgsSchema = z.object({
	question: z.string().optional(),
	details: z.string().optional(),
	type: z.string().optional(),
	multiSelect: z.boolean().optional(),
	options: z.union([
		z.string(),
		z.array(z.object({ label: z.string(), value: z.string().optional(), description: z.string().optional() })),
	]).optional(),
	correctAnswer: z.union([z.string(), z.array(z.string())]).optional(),
	explanation: z.string().optional(),
});

function extractMessageProse(message: LhMessage): string[] {
	if (message.role !== "assistant") return [];
	const sendToUserParts: string[] = [];
	const textParts: string[] = [];
	for (const block of message.content) {
		if (block.type === "toolCall" && block.name === SEND_TO_USER_TOOL) {
			const rawMsg = block.arguments?.message;
			const text = typeof rawMsg === "string" ? rawMsg.trim() : "";
			if (text) sendToUserParts.push(text);
		} else if (block.type === "text") {
			const text = block.text.trim();
			if (text) textParts.push(text);
		}
	}
	if (sendToUserParts.length > 0) {
		const joinedSent = sendToUserParts.join("\n\n");
		const extraTexts = textParts.filter((part) => part !== joinedSent && !sendToUserParts.includes(part));
		return [...sendToUserParts, ...extraTexts];
	}
	return textParts;
}

/** Format a posed question cleanly for speech — NEVER include correctAnswer or explanation. */
function formatPosedQuestionForSpeech(block: ToolCallBlock): string | null {
	const parsed = RawQuestionArgsSchema.safeParse(block.arguments);
	if (!parsed.success) return null;
	const args = parsed.data;
	const question = args.question?.trim() ?? "";
	if (!question) return null;
	const details = args.details?.trim() ?? "";
	const kind = toolQuestionKind(block.name);
	const multiSelect = args.multiSelect === true;

	const lines: string[] = [];
	if (kind === "quiz") {
		const role = normalizeQuizType(args.type);
		lines.push(role === "predict" ? `Prediction question: ${question}` : `Question: ${question}`);
	} else {
		lines.push(`Question: ${question}`);
	}
	if (details) lines.push(details);

	if (kind === "quiz" || kind === "ask") {
		let displayed: { options: QuizOption[]; optionOrder?: Record<string, number> };
		try {
			displayed = questionDisplayOptions(args.options, kind, multiSelect, block.id);
		} catch {
			displayed = { options: [] };
		}
		if (displayed.options.length > 0) {
			const letters = displayed.optionOrder ? Object.keys(displayed.optionOrder) : undefined;
			lines.push(multiSelect ? "Select all that apply:" : "Options:");
			displayed.options.forEach((opt, index) => {
				const prefix = letters?.[index] ? `${letters[index]}.` : `${index + 1}.`;
				lines.push(`${prefix} ${opt.label}`);
			});
		}
	}
	return lines.join("\n");
}

/** Extract intermediate spoken commentary from an assistant toolUse step. */
export function extractAssistantCommentary(message: LhMessage): string {
	return extractMessageProse(message).join("\n\n").trim();
}

/** Extract the complete learner-facing prose and posed question from a finished turn's new messages. */
export function extractTurnSpokenSummary(messages: readonly LhMessage[]): string {
	const sections: string[] = [];
	const erroredToolCallIds = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult" && message.isError) {
			erroredToolCallIds.add(message.toolCallId);
		}
	}

	let lastError: string | undefined;
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		if (message.stopReason === "error") {
			lastError = message.errorMessage?.trim() || "The tutor could not complete that turn.";
			continue;
		}
		lastError = undefined;
		sections.push(...extractMessageProse(message));
		for (const block of message.content) {
			if (block.type !== "toolCall" || erroredToolCallIds.has(block.id)) continue;
			if ((QUESTION_TOOLS as readonly string[]).includes(block.name)) {
				const formatted = formatPosedQuestionForSpeech(block as ToolCallBlock);
				if (formatted) sections.push(formatted);
			} else if (block.name === PRACTICE_PROBLEM_TOOL) {
				const formatted = formatPosedProblemForSpeech(block as ToolCallBlock);
				if (formatted) sections.push(formatted);
			}
		}
	}

	const combined = sections.map((part) => part.trim()).filter(Boolean).join("\n\n").trim();
	if (combined) return combined;
	return lastError ?? "";
}

export type SpokenInputResolution =
	| { kind: "text" }
	| { kind: "answer"; toolCallId: string; answer: QuestionAnswerData }
	| { kind: "quiz-unmatched"; promptHint: string };

const DONT_KNOW_PATTERN = /^(?:i\s+don'?t\s+know|don'?t\s+know|no\s+idea|not\s+sure|idk|skip\s+it|pass|わからない|分からない|わかりません|分かりません)[.!?。！？\s]*$/i;

function normalizeMatchText(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/^[("'「『]+|[)"'」』.!?。！？]+$/g, "")
		.replace(/\s+/g, " ");
}

function buildQuestionDataFromPending(pending: { toolCallId: string; tool: string; input: unknown }): QuestionData | null {
	const parsed = RawQuestionArgsSchema.safeParse(pending.input);
	if (!parsed.success) return null;
	const args = parsed.data;
	const question = args.question?.trim() ?? "";
	if (!question) return null;
	const kind = toolQuestionKind(pending.tool);
	const multi = args.multiSelect === true;

	let displayed: { options: QuizOption[]; optionOrder?: Record<string, number> };
	try {
		displayed = questionDisplayOptions(args.options, kind, multi, pending.toolCallId);
	} catch {
		return null;
	}

	const mode = kind === "explain" || displayed.options.length === 0 ? "text" : multi ? "multi-select" : "single-select";
	const qd: QuestionData = {
		id: pending.toolCallId,
		kind,
		questionType: kind === "quiz" || kind === "explain" ? normalizeQuizType(args.type) : undefined,
		question,
		context: args.details?.trim() || undefined,
		mode,
		options: displayed.options,
		optionOrder: displayed.optionOrder,
		createdAt: new Date().toISOString(),
	};
	if (kind === "quiz") {
		const resolved = resolveCorrect(args.correctAnswer, displayed.options);
		if (resolved.error) return null;
		qd.correctIndices = resolved.indices;
		qd.explanation = args.explanation?.trim() || undefined;
	}
	if (kind === "explain") {
		qd.committedAnswer = typeof args.correctAnswer === "string" ? args.correctAnswer.trim() || undefined : undefined;
	}
	return qd;
}

function matchSingleOption(spoken: string, options: QuizOption[], optionOrder?: Record<string, number>): QuizOption | null {
	const norm = normalizeMatchText(spoken);
	if (!norm) return null;

	const letters = optionOrder ? Object.keys(optionOrder) : undefined;
	if (letters && letters.length === options.length) {
		const letterMatch = /^(?:(?:option|choice|answer|letter)\s+)?([a-z])(?:\s*番)?$/i.exec(norm);
		if (letterMatch) {
			const idx = letters.findIndex((letter) => letter.toLowerCase() === letterMatch[1]!.toLowerCase());
			if (idx >= 0) return options[idx]!;
		}
	}
	const numMatch = /^(?:(?:option|choice|number|answer|#)\s+)?(\d+)(?:\s*番)?$/i.exec(norm);
	if (numMatch) {
		const idx = Number(numMatch[1]) - 1;
		if (idx >= 0 && idx < options.length) return options[idx]!;
	}

	const exact = options.filter((opt) => normalizeMatchText(opt.label) === norm || normalizeMatchText(opt.value) === norm);
	if (exact.length === 1) return exact[0]!;
	return null;
}

/**
 * Route a voice-delegated learner utterance cleanly against any dangling builtin question
 * so free-recall (`explain`/`recall`), `ask_user_question`, and clearly chosen `quiz` answers
 * submit as real tool results instead of breaking tool-call adjacency.
 */
export function resolveSpokenInput(messages: readonly LhMessage[], spokenText: string): SpokenInputResolution {
	const pending = danglingQuestionOf(messages);
	if (!pending) return { kind: "text" };

	const trimmed = spokenText.trim();
	const qd = buildQuestionDataFromPending(pending);
	if (!qd) return { kind: "text" };

	if (qd.kind === "explain") {
		const dontKnow = DONT_KNOW_PATTERN.test(trimmed);
		return {
			kind: "answer",
			toolCallId: pending.toolCallId,
			answer: buildAnswer(qd, dontKnow ? { dontKnow: true } : { text: trimmed }, pending.tool),
		};
	}

	if (qd.kind === "ask") {
		if (DONT_KNOW_PATTERN.test(trimmed)) {
			return { kind: "answer", toolCallId: pending.toolCallId, answer: buildAnswer(qd, { dontKnow: true }, pending.tool) };
		}
		if (qd.mode === "text") {
			return { kind: "answer", toolCallId: pending.toolCallId, answer: buildAnswer(qd, { text: trimmed }, pending.tool) };
		}
		const matched = qd.mode === "single-select" ? matchSingleOption(trimmed, qd.options, qd.optionOrder) : null;
		return {
			kind: "answer",
			toolCallId: pending.toolCallId,
			answer: buildAnswer(qd, matched ? { values: [matched.value] } : { other: trimmed }, pending.tool),
		};
	}

	if (DONT_KNOW_PATTERN.test(trimmed)) {
		return { kind: "answer", toolCallId: pending.toolCallId, answer: buildAnswer(qd, { dontKnow: true }, pending.tool) };
	}
	if (qd.mode === "single-select") {
		const matched = matchSingleOption(trimmed, qd.options, qd.optionOrder);
		if (matched) {
			return {
				kind: "answer",
				toolCallId: pending.toolCallId,
				answer: buildAnswer(qd, { values: [matched.value] }, pending.tool),
			};
		}
	} else if (qd.mode === "multi-select") {
		const matched = matchMultipleOptions(trimmed, qd.options, qd.optionOrder);
		if (matched && matched.length > 0) {
			return {
				kind: "answer",
				toolCallId: pending.toolCallId,
				answer: buildAnswer(qd, { values: matched.map((opt) => opt.value) }, pending.tool),
			};
		}
	}
	const letters = qd.optionOrder ? Object.keys(qd.optionOrder) : undefined;
	const optionSummary = qd.options
		.map((opt, i) => `${letters?.[i] ? `${letters[i]}.` : `${i + 1}.`} ${opt.label}`)
		.join(" | ");
	return {
		kind: "quiz-unmatched",
		promptHint:
			`There is a multiple-choice quiz currently waiting on screen ("${qd.question}"; options: ${optionSummary}). ` +
			`The learner said: "${trimmed}". Do not reveal the correct answer; briefly help or ask them to pick one of the displayed options (by letter, option text, "I don't know", or by clicking in the quiz card).`,
	};
}

const MAX_PLAN_NODES = 24;
const MAX_PLAN_SUMMARY_CHARS = 3_200;
const MAX_PLAN_NODE_SUMMARY_CHARS = 120;
const MAX_RECENT_TURNS = 12;
const MAX_TURN_CHARS = 500;
const MAX_RECENT_TOTAL_CHARS = 4_500;
const MAX_OPENING_TURN_CHARS = 240;
const MAX_ACTIVE_PROMPT_CHARS = 900;

const PlanBlockMarkerSchema = z.object({
	block: z.object({
		nodes: z.array(z.object({
			id: z.string(),
			title: z.string(),
			status: z.enum(["current", "visited", "upcoming"]).optional(),
		})),
		edges: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
	}),
});
const AnsweredDetailsSchema = z.object({
	dismissed: z.boolean().optional(),
	dontKnow: z.boolean().optional(),
	answers: z.array(z.object({ label: z.string() })).optional(),
	text: z.string().optional(),
	other: z.string().optional(),
	thinking: z.string().optional(),
	note: z.string().optional(),
	correct: z.boolean().optional(),
});

const PracticeProblemInputSchema = z.object({
	statement: z.string().optional(),
	title: z.string().optional(),
});

/** Format a posed practice problem cleanly for speech — NEVER include modelSolution. */
function formatPosedProblemForSpeech(block: ToolCallBlock): string | null {
	const parsed = PracticeProblemInputSchema.safeParse(block.arguments);
	if (!parsed.success) return null;
	const statement = parsed.data.statement?.trim() || parsed.data.title?.trim() || "";
	return statement ? `Practice problem: ${statement}` : null;
}

function matchMultipleOptions(spoken: string, options: QuizOption[], optionOrder?: Record<string, number>): QuizOption[] | null {
	const single = matchSingleOption(spoken, options, optionOrder);
	if (single) return [single];
	const parts = spoken
		.split(/\s*(?:,|、|&|\band\b|と)\s*/i)
		.map((part) => part.trim())
		.filter(Boolean);
	if (parts.length < 2) return null;
	const seen = new Set<string>();
	const matched: QuizOption[] = [];
	for (const part of parts) {
		const hit = matchSingleOption(part, options, optionOrder);
		if (!hit) return null;
		if (!seen.has(hit.value)) {
			seen.add(hit.value);
			matched.push(hit);
		}
	}
	return matched.length > 0 ? matched : null;
}
function collapseInline(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function truncateCodepoints(value: string, maxChars: number): string {
	const trimmed = value.trim();
	if (trimmed.length <= maxChars) return trimmed;
	const chars = Array.from(trimmed);
	if (chars.length <= maxChars) return trimmed;
	return `${chars.slice(0, Math.max(1, maxChars - 1)).join("").trimEnd()}…`;
}

function formatPlanLines(
	items: readonly { id: string; title: string; status: "current" | "visited" | "upcoming"; summary?: string }[],
	edges: readonly { from: string; to: string }[] = [],
): string | undefined {
	if (items.length === 0) return undefined;
	const lines: string[] = [];
	const titleById = new Map<string, string>();
	let totalChars = 0;
	for (let i = 0; i < items.length; i++) {
		if (i >= MAX_PLAN_NODES) {
			lines.push(`… (+${items.length - i} more topics)`);
			break;
		}
		const item = items[i]!;
		const title = collapseInline(item.title);
		if (!title) continue;
		titleById.set(item.id, title);
		const summary = item.summary ? truncateCodepoints(collapseInline(item.summary), MAX_PLAN_NODE_SUMMARY_CHARS) : "";
		const line = summary ? `- [${item.status}] ${title} — ${summary}` : `- [${item.status}] ${title}`;
		if (lines.length > 0 && totalChars + line.length + 1 > MAX_PLAN_SUMMARY_CHARS) {
			lines.push(`… (+${items.length - i} more topics)`);
			break;
		}
		lines.push(line);
		totalChars += line.length + 1;
	}
	if (edges.length > 0 && totalChars + 12 < MAX_PLAN_SUMMARY_CHARS) {
		const edgeLines: string[] = [];
		for (const edge of edges) {
			const from = titleById.get(edge.from);
			const to = titleById.get(edge.to);
			if (!from || !to) continue;
			const line = `  ${from} -> ${to}`;
			if (totalChars + line.length + 8 > MAX_PLAN_SUMMARY_CHARS) break;
			edgeLines.push(line);
			totalChars += line.length + 1;
		}
		if (edgeLines.length > 0) {
			lines.push("Path:", ...edgeLines);
		}
	}
	return lines.length > 0 ? lines.join("\n") : undefined;
}

function extractPlanSummary(tree: PlanTree | undefined, messages: readonly LhMessage[]): string | undefined {
	if (tree && tree.nodes.length > 0) {
		const statuses = derivePlanStatusesLh(tree, messages);
		return formatPlanLines(
			tree.nodes.map((node) => ({
				id: node.id,
				title: node.title,
				status: derivedNodeStatus(statuses, node.id),
				summary: node.summary,
			})),
			tree.edges,
		);
	}
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role !== "custom" || message.customType !== "plan-block") continue;
		const parsed = PlanBlockMarkerSchema.safeParse(message.details);
		if (!parsed.success || parsed.data.block.nodes.length === 0) continue;
		return formatPlanLines(
			parsed.data.block.nodes.map((node) => ({
				id: node.id,
				title: node.title,
				status: node.status ?? "upcoming",
			})),
			parsed.data.block.edges ?? [],
		);
	}
	return undefined;
}

function extractUserMessageText(message: Extract<LhMessage, { role: "user" }>): string {
	if (typeof message.content === "string") return message.content.trim();
	const parts: string[] = [];
	let hasImage = false;
	for (const block of message.content) {
		if (block.type === "text") {
			const text = block.text.trim();
			if (text) parts.push(text);
		} else if (block.type === "image") {
			hasImage = true;
		}
	}
	if (parts.length > 0) return parts.join("\n");
	return hasImage ? "[sent an image]" : "";
}

function formatAnsweredQuestionSummary(details: unknown): string {
	const parsed = AnsweredDetailsSchema.safeParse(details);
	if (!parsed.success) return "";
	const data = parsed.data;
	if (data.dismissed) return "[dismissed question]";
	const pieces: string[] = [];
	if (data.dontKnow) {
		pieces.push("I don't know");
	} else {
		const labels = (data.answers ?? []).map((item) => collapseInline(item.label)).filter(Boolean);
		if (labels.length > 0) pieces.push(labels.join(", "));
		const freeText = data.text?.trim() || data.other?.trim();
		if (freeText) pieces.push(freeText);
	}
	const reasoning = data.thinking?.trim() || data.note?.trim();
	if (reasoning && pieces.length === 0) pieces.push(reasoning);
	if (pieces.length === 0) return "";
	const verdict = data.correct === true ? " (correct)" : data.correct === false ? " (incorrect)" : "";
	return `[answered question] ${pieces.join(" — ")}${verdict}`;
}

function extractRecentTurns(messages: readonly LhMessage[]): string | undefined {
	const erroredToolCallIds = new Set<string>();
	for (const message of messages) {
		if (message.role === "toolResult" && message.isError) {
			erroredToolCallIds.add(message.toolCallId);
		}
	}

	const entries: { speaker: "Learner" | "Tutor"; text: string }[] = [];
	const pushEntry = (speaker: "Learner" | "Tutor", rawText: string) => {
		const text = rawText.trim();
		if (!text) return;
		const prev = entries.at(-1);
		if (prev && prev.speaker === speaker && speaker === "Tutor") {
			prev.text = `${prev.text}\n\n${text}`;
			return;
		}
		entries.push({ speaker, text });
	};

	for (const message of messages) {
		if (message.role === "user") {
			pushEntry("Learner", extractUserMessageText(message));
			continue;
		}
		if (message.role === "assistant") {
			if (message.stopReason === "error") continue;
			const sections: string[] = [...extractMessageProse(message)];
			for (const block of message.content) {
				if (block.type !== "toolCall" || erroredToolCallIds.has(block.id)) continue;
				if ((QUESTION_TOOLS as readonly string[]).includes(block.name)) {
					const formatted = formatPosedQuestionForSpeech(block as ToolCallBlock);
					if (formatted) sections.push(formatted);
				} else if (block.name === PRACTICE_PROBLEM_TOOL) {
					const formatted = formatPosedProblemForSpeech(block as ToolCallBlock);
					if (formatted) sections.push(formatted);
				}
			}
			pushEntry("Tutor", sections.join("\n\n"));
			continue;
		}
		if (message.role === "toolResult") {
			if (message.isError || !(QUESTION_TOOLS as readonly string[]).includes(message.toolName)) continue;
			pushEntry("Learner", formatAnsweredQuestionSummary(message.details));
			continue;
		}
		if (message.role === "custom" && message.customType === "practice-thinking") {
			const rawDetails = message.details;
			const text = typeof rawDetails === "object" && rawDetails !== null && "text" in rawDetails && typeof rawDetails.text === "string"
				? rawDetails.text.trim()
				: message.content.trim();
			if (text) pushEntry("Learner", `[thinking] ${text}`);
		}
	}

	if (entries.length === 0) return undefined;
	const recent = entries.slice(-MAX_RECENT_TURNS).map((entry) => ({
		speaker: entry.speaker,
		text: truncateCodepoints(entry.text, MAX_TURN_CHARS),
	}));

	const kept: string[] = [];
	let totalChars = 0;
	for (let i = recent.length - 1; i >= 0; i--) {
		const formatted = `${recent[i]!.speaker}: ${recent[i]!.text}`;
		if (kept.length > 0 && totalChars + formatted.length + 2 > MAX_RECENT_TOTAL_CHARS) break;
		kept.unshift(formatted);
		totalChars += formatted.length + 2;
	}
	const omitted = entries.length - kept.length;
	if (omitted > 0) {
		const firstLearner = entries.slice(0, omitted).find((entry) => entry.speaker === "Learner");
		const anchor = firstLearner
			? `Session start (${omitted} earlier ${omitted === 1 ? "turn" : "turns"} before recent window) — Learner: ${truncateCodepoints(firstLearner.text, MAX_OPENING_TURN_CHARS)}`
			: `(${omitted} earlier ${omitted === 1 ? "turn" : "turns"} before recent window)`;
		kept.unshift(anchor);
	}
	return kept.length > 0 ? kept.join("\n\n") : undefined;
}

function extractActivePrompt(messages: readonly LhMessage[]): { activePrompt?: string; hasPendingQuestion: boolean } {
	const sections: string[] = [];
	const pending = danglingQuestionOf(messages);
	const pluginPending = pendingPluginQuestionOf(messages);
	const hasPendingQuestion = Boolean(pending || pluginPending);

	if (pending) {
		const args = typeof pending.input === "object" && pending.input !== null && !Array.isArray(pending.input)
			? (pending.input as Record<string, unknown>)
			: undefined;
		const formatted = formatPosedQuestionForSpeech({
			type: "toolCall",
			id: pending.toolCallId,
			name: pending.tool,
			arguments: args,
		});
		if (formatted) sections.push(truncateCodepoints(formatted, MAX_ACTIVE_PROMPT_CHARS));
	} else if (pluginPending) {
		const prompt = pluginPending.input.question.trim();
		const label = collapseInline(pluginPending.label || "interactive");
		sections.push(
			prompt
				? `Interactive ${label} question on screen: ${truncateCodepoints(prompt, MAX_ACTIVE_PROMPT_CHARS)}`
				: `An interactive ${label} question card is waiting on screen.`,
		);
	}

	const problem = activeProblemOf(messages);
	if (problem) {
		const parsed = PracticeProblemInputSchema.safeParse(problem.input);
		const statement = parsed.success ? (parsed.data.statement?.trim() || parsed.data.title?.trim()) : undefined;
		if (statement) {
			sections.push(`Active practice problem: ${truncateCodepoints(statement, MAX_ACTIVE_PROMPT_CHARS)}`);
		}
	}

	return {
		activePrompt: sections.length > 0 ? sections.join("\n\n") : undefined,
		hasPendingQuestion,
	};
}

export interface LiveSessionContextSnapshot {
	planSummary?: string;
	recentTurns?: string;
	activePrompt?: string;
	hasPendingQuestion: boolean;
}

/** Build a compact, spoiler-free snapshot of the session plan, recent turns, and active prompt for Live connect. */
export function extractLiveSessionContext(record: {
	messages: readonly LhMessage[];
	tree?: PlanTree;
}): LiveSessionContextSnapshot {
	const planSummary = extractPlanSummary(record.tree, record.messages);
	const recentTurns = extractRecentTurns(record.messages);
	const { activePrompt, hasPendingQuestion } = extractActivePrompt(record.messages);
	return {
		...(planSummary ? { planSummary } : {}),
		...(recentTurns ? { recentTurns } : {}),
		...(activePrompt ? { activePrompt } : {}),
		hasPendingQuestion,
	};
}
