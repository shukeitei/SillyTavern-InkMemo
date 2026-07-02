// Phase 8: 触发引擎结果注入
import { eventSource, event_types, setExtensionPrompt, extension_prompt_types } from '../../../../../script.js';
import { extension_settings, getContext } from '../../../../extensions.js';
import { runTriggers, buildMatchText } from './trigger-engine.js';

const PROMPT_KEY = 'luomo_triggered';

let lastTrigger = null;

export function getLastTrigger() {
    return lastTrigger;
}

function getInjectorSettings() {
    const s = extension_settings.luomo || {};
    return {
        enabled: s.trigger_enabled !== false,
        windowSize: Number(s.trigger_window) || 5,
        tokenBudget: Number(s.trigger_token_budget) || 1000,
        position: s.trigger_position || 'in_chat',
        depth: Number.isFinite(Number(s.trigger_depth)) ? Number(s.trigger_depth) : 4,
    };
}

function resolvePosition(name) {
    const map = {
        in_chat: extension_prompt_types.IN_CHAT,
        after_system: extension_prompt_types.IN_PROMPT,
        before_prompt: extension_prompt_types.BEFORE_PROMPT,
    };
    return map[name] ?? extension_prompt_types.IN_CHAT;
}

function formatInjection(triggered) {
    if (!triggered || triggered.length === 0) return '';
    const blocks = triggered.map(h => {
        const meta = h.entry.metadata || {};
        const head = [meta.time, meta.location, meta.scene].filter(Boolean).join(' | ');
        const title = `### ${h.entry.title}`;
        const metaLine = head ? `[${head}]` : '';
        return [title, metaLine, h.entry.content].filter(Boolean).join('\n');
    });
    return ['## 落墨触发记忆', ...blocks].join('\n\n');
}

async function onGenerationStarted() {
    const cfg = getInjectorSettings();
    const positionCode = resolvePosition(cfg.position);

    if (!cfg.enabled) {
        setExtensionPrompt(PROMPT_KEY, '', positionCode, cfg.depth, false, 0);
        return;
    }

    try {
        const ctx = getContext();
        const chat = ctx.chat || [];
        const matchText = buildMatchText(chat, cfg.windowSize);

        const result = runTriggers(matchText, { tokenBudget: cfg.tokenBudget });

        const injection = formatInjection(result.triggered);
        setExtensionPrompt(PROMPT_KEY, injection, positionCode, cfg.depth, false, 0);

        lastTrigger = {
            timestamp: Date.now(),
            chatLength: chat.length,
            matchTextLength: matchText.length,
            matchTextPreview: matchText.slice(-200),
            entriesScanned: result.entriesScanned ?? 0,
            belowThreshold: result.belowThreshold ?? 0,
            timelineBlocked: result.timelineBlocked ?? 0,
            cutoffBlocked: result.cutoffBlocked ?? 0,
            triggered: result.triggered.map(h => ({
                title: h.entry.title,
                score: h.score,
                threshold: h.threshold,
                tokens: h.tokens,
                hitWords: [
                    ...(h.hits?.must || []),
                    ...(h.hits?.core || []),
                    ...(h.hits?.any || []),
                    ...(h.hits?.boost || []),
                ],
            })),
            skippedCount: result.skipped?.length ?? 0,
            totalTokens: result.totalTokens ?? 0,
            position: cfg.position,
            depth: cfg.depth,
        };

        console.log(`[InkMemo] 触发 ${result.triggered.length}/${result.entriesScanned ?? 0} · ${result.totalTokens ?? 0} token · 阈值未达 ${result.belowThreshold ?? 0} · 时间线屏蔽 ${result.timelineBlocked ?? 0} · 截止层屏蔽 ${result.cutoffBlocked ?? 0} · 预算跳过 ${result.skipped?.length ?? 0} · ${cfg.position}@depth${cfg.depth}`);
        document.dispatchEvent(new CustomEvent('luomo:trigger-updated'));
    } catch (e) {
        console.error('[InkMemo] 触发注入失败:', e);
    }
}

let mounted = false;

export function mountInjector() {
    if (mounted) return;
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    mounted = true;
    console.log('[InkMemo] 注入挂载到 GENERATION_STARTED');
}

export async function manualTrigger() {
    await onGenerationStarted();
}
