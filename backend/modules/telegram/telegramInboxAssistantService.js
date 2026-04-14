'use strict';

const https = require('https');
const { getConfig } = require('../../config/config');
const { logError } = require('../../services/logService');
const {
    generateDelegationPlanFromText,
} = require('../tasks/taskDelegationService');

const MAX_SUBTASKS = 6;
const AMBIGUOUS_PATTERNS = [
    /\bthis\b/i,
    /\bthat\b/i,
    /\bit\b/i,
    /\bthey\b/i,
    /\bthem\b/i,
    /\bstuff\b/i,
    /\bthings\b/i,
    /\bsomething\b/i,
    /\basap\b/i,
    /\bsoon\b/i,
    /\blater\b/i,
];

function sanitizeText(value, fallback = '') {
    if (typeof value !== 'string') return fallback;
    return value.trim();
}

function estimateDifficulty(name, context = '') {
    const text = `${name} ${context}`.toLowerCase();
    if (
        /\b(strategy|architecture|design|migrate|integrate|automate|deploy|analyze|investigate|debug|refactor|coordinate)\b/.test(
            text
        )
    ) {
        return 'hard';
    }

    if (
        /\b(review|draft|outline|prepare|collect|compare|plan|document|research|summarize|clarify)\b/.test(
            text
        )
    ) {
        return 'medium';
    }

    return 'easy';
}

function estimateTime(name, difficulty) {
    const text = name.toLowerCase();
    if (/\b(call|send|share|confirm|book|schedule|reply|rename|create)\b/.test(text)) {
        return difficulty === 'easy' ? '10-15 min' : '15-25 min';
    }

    if (difficulty === 'hard') return '45-90 min';
    if (difficulty === 'medium') return '20-40 min';
    return '5-15 min';
}

function needsClarification(text) {
    const trimmed = sanitizeText(text);
    if (!trimmed) return true;
    if (trimmed.split(/\s+/).length < 4) return true;
    return AMBIGUOUS_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function buildClarificationQuestion(text) {
    const trimmed = sanitizeText(text);
    if (!trimmed || trimmed.split(/\s+/).length < 4) {
        return 'What outcome do you want, and what would “done” look like?';
    }

    return 'Before I break this down, what exactly is the deliverable, and are there any deadline or scope constraints I should respect?';
}

function enrichPlan(plan, originalText) {
    const subtasks = (Array.isArray(plan?.subtasks) ? plan.subtasks : [])
        .slice(0, MAX_SUBTASKS)
        .map((subtask) => {
            const name = sanitizeText(subtask?.name || subtask?.title);
            const context = sanitizeText(subtask?.context || subtask?.reason);
            const difficulty = estimateDifficulty(name, context);
            return {
                name,
                context,
                difficulty,
                time_estimate: estimateTime(name, difficulty),
            };
        })
        .filter((subtask) => subtask.name);

    return {
        status: 'ready_to_approve',
        summary:
            sanitizeText(plan?.summary) ||
            `Draft plan for: ${sanitizeText(originalText, 'your item')}`,
        approval_message:
            sanitizeText(plan?.delegation_brief) ||
            'I broke this into smaller actionable tasks. If this looks right, approve it and I will create the task with subtasks in tududi.',
        subtasks,
    };
}

function buildFallbackPlan(text) {
    const cleaned = sanitizeText(text);
    return enrichPlan(
        {
            summary: `Draft plan for: ${cleaned}`,
            delegation_brief:
                'I turned this into a lightweight execution plan. Approve it if you want me to create it as a task with subtasks in tududi.',
            subtasks: [
                {
                    name: `Clarify the exact outcome for ${cleaned}`,
                    context: 'Define what success looks like before starting.',
                },
                {
                    name: `Gather the inputs needed for ${cleaned}`,
                    context: 'Collect links, files, people, or decisions required to move forward.',
                },
                {
                    name: `Do the main work for ${cleaned}`,
                    context: 'Focus on the core deliverable first.',
                },
                {
                    name: `Review the result and capture follow-up actions for ${cleaned}`,
                    context: 'Check quality and note any remaining loose ends.',
                },
            ],
        },
        cleaned
    );
}

function extractMessageContent(message) {
    if (!message) return '';
    if (typeof message.content === 'string') return message.content;
    if (!Array.isArray(message.content)) return '';

    return message.content
        .map((part) => {
            if (typeof part === 'string') return part;
            if (part?.type === 'text') return part.text || '';
            return '';
        })
        .join('')
        .trim();
}

function postJson(url, headers, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload);
        const request = https.request(
            url,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                    ...headers,
                },
                timeout: timeoutMs,
            },
            (response) => {
                let data = '';
                response.on('data', (chunk) => {
                    data += chunk;
                });
                response.on('end', () => {
                    try {
                        resolve(JSON.parse(data || '{}'));
                    } catch (error) {
                        reject(error);
                    }
                });
            }
        );

        request.on('error', reject);
        request.on('timeout', () => {
            request.destroy(new Error('Telegram assistant LLM request timed out.'));
        });
        request.write(body);
        request.end();
    });
}

async function tryStructuredLlmAnalysis(text) {
    const config = getConfig();
    const llmConfig = config.llm || {};

    if (!llmConfig.enabled || !llmConfig.apiKey) {
        return null;
    }

    const payload = {
        model: llmConfig.model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        max_tokens: 900,
        messages: [
            {
                role: 'system',
                content:
                    'You are a productivity assistant for Telegram inbox capture. Return strict JSON only. Decide whether the user item needs clarification before breakdown. If clarification is needed, return status="clarification_needed" and one concise clarification_question. If it is clear enough, return status="ready_to_approve", a short summary, a concise approval_message, and subtasks as an array of objects with name, context, difficulty (easy|medium|hard), and time_estimate. Keep subtasks actionable and brief.',
            },
            {
                role: 'user',
                content: JSON.stringify({
                    instruction:
                        'Analyze this inbox item and either ask for clarification or produce an approval-ready subtask plan.',
                    text,
                }),
            },
        ],
    };

    const baseUrl = String(llmConfig.baseUrl || 'https://api.openai.com/v1').replace(
        /\/$/,
        ''
    );

    const response = await postJson(
        `${baseUrl}/chat/completions`,
        {
            Authorization: `Bearer ${llmConfig.apiKey}`,
        },
        payload,
        llmConfig.timeoutMs || 20000
    );

    const rawContent = extractMessageContent(response?.choices?.[0]?.message);
    if (!rawContent) return null;

    const parsed = JSON.parse(rawContent);
    return parsed;
}

async function analyzeTelegramInboxItem(text) {
    const trimmed = sanitizeText(text);

    if (needsClarification(trimmed)) {
        return {
            status: 'clarification_needed',
            clarification_question: buildClarificationQuestion(trimmed),
        };
    }

    try {
        const llmResult = await tryStructuredLlmAnalysis(trimmed);
        if (llmResult?.status === 'clarification_needed') {
            return {
                status: 'clarification_needed',
                clarification_question:
                    sanitizeText(llmResult.clarification_question) ||
                    buildClarificationQuestion(trimmed),
            };
        }

        if (llmResult?.status === 'ready_to_approve') {
            return enrichPlan(llmResult, trimmed);
        }
    } catch (error) {
        logError('Telegram assistant LLM analysis failed, falling back:', error);
    }

    try {
        const delegationPlan = await generateDelegationPlanFromText(trimmed);
        return enrichPlan(delegationPlan, trimmed);
    } catch (error) {
        logError('Telegram assistant delegation fallback failed, using heuristic plan:', error);
        return buildFallbackPlan(trimmed);
    }
}

module.exports = {
    analyzeTelegramInboxItem,
    _needsClarification: needsClarification,
    _estimateDifficulty: estimateDifficulty,
    _estimateTime: estimateTime,
    _enrichPlan: enrichPlan,
};
