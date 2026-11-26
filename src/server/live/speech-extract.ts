import { z } from "zod";
import type { LhMessage } from "../../core/native-messages.ts";
import { SEND_TO_USER_TOOL, danglingQuestionOf } from "../../core/native-messages.ts";
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
			if (block.type === "toolCall" && (QUESTION_TOOLS as readonly string[]).includes(block.name) && !erroredToolCallIds.has(block.id)) {
				const formatted = formatPosedQuestionForSpeech(block as ToolCallBlock);
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
