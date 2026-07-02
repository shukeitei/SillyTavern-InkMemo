// src/trigger-engine.js
// 触发引擎核心:对自有存储的条目按 matchText 评分、排序、按 token 预算裁剪
// Phase 9:trigger 加 core 字段,evaluate 加 core 软 OR 档(命中任一即给一次 weights.core)

import { listForCurrentContext, getTriggerFilterContext, getTimelineKey } from './storage.js';

const TAG = '[InkMemo]';
const DEFAULT_TOKEN_BUDGET = 1000;

// 中文 1 字 ≈ 1.5 token,保守估算
function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length * 1.5);
}

// substring 匹配,大小写不敏感
function hit(matchText, word) {
    if (!word) return false;
    return matchText.includes(word.toLowerCase());
}

/**
 * 单条目评分
 * 顺序:exclude 拦截 → must 全中拦截 → must 基础分 → core 软 OR(任一中给一次)→ any 累加 → boost 累加
 * @returns {{score:number, reason:string, hits:{must,core,any,boost,exclude}}}
 */
export function evaluate(entry, matchText) {
    const trigger = entry.trigger || {};
    const must = trigger.must || [];
    const core = trigger.core || [];
    const any = trigger.any || [];
    const boost = trigger.boost || [];
    const exclude = trigger.exclude || [];
    const weights = trigger.weights || { must: 10, core: 5, any: 3, boost: 1 };

    const hits = { must: [], core: [], any: [], boost: [], exclude: [] };

    // 1. exclude 命中任一 → 直接跳过
    for (const w of exclude) {
        if (hit(matchText, w)) {
            hits.exclude.push(w);
            return { score: 0, reason: `excluded by "${w}"`, hits };
        }
    }

    // 2. must 必须全命中
    if (must.length > 0) {
        for (const w of must) {
            if (!hit(matchText, w)) {
                return { score: 0, reason: `must miss "${w}"`, hits };
            }
            hits.must.push(w);
        }
    }

    let score = 0;

    // 3. must 全命中给基础分(must 为空不给)
    if (must.length > 0) {
        score += weights.must || 0;
    }

    // 4. core 软 OR:命中任一即给一次 weights.core,不累加
    //    所有命中词记录到 hits.core 用于 UI 展示,但 score 只加一次
    let coreHit = false;
    for (const w of core) {
        if (hit(matchText, w)) {
            hits.core.push(w);
            coreHit = true;
        }
    }
    if (coreHit) {
        score += weights.core || 0;
    }

    // 5. any 每命中一个加分(数组遍历级别 only-once,数组内重复词不去重)
    for (const w of any) {
        if (hit(matchText, w)) {
            hits.any.push(w);
            score += weights.any || 0;
        }
    }

    // 6. boost 同 any
    for (const w of boost) {
        if (hit(matchText, w)) {
            hits.boost.push(w);
            score += weights.boost || 0;
        }
    }

    return { score, reason: 'ok', hits };
}

/**
 * 主流程:遍历当前 scope + _global 的条目,评分、过滤、排序、token 裁剪
 */
export function runTriggers(matchText, options = {}) {
    const tokenBudget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    const maxEntries = options.maxEntries ?? Infinity;

    if (!matchText || typeof matchText !== 'string') {
        return { triggered: [], skipped: [], totalTokens: 0, entriesScanned: 0, belowThreshold: 0, timelineBlocked: 0, cutoffBlocked: 0 };
    }

    const normalized = matchText.toLowerCase();
    const entries = listForCurrentContext();
    const entriesScanned = entries.length;
    const filter = getTriggerFilterContext();
    let belowThreshold = 0;
    let timelineBlocked = 0;
    let cutoffBlocked = 0;

    const scored = [];
    for (const entry of entries) {
        if (entry.enabled === false) continue;

        // 时间线总开关:来源聊天被整组禁用 → 跳过
        const tlKey = getTimelineKey(entry);
        if (filter.timelines[tlKey]?.enabled === false) {
            timelineBlocked++;
            continue;
        }

        // 本聊天记忆截止层:只卡"别的时间线"的条目(本聊天自己结晶的永远豁免),
        // 来源起始层在截止层之后的视为"这条时间线的未来",不注入
        if (filter.cutoff !== null
            && entry.source?.chatId
            && entry.source.chatId !== filter.currentChatId
            && Number.isFinite(entry.source?.range?.from)
            && entry.source.range.from > filter.cutoff) {
            cutoffBlocked++;
            continue;
        }

        const { score, reason, hits } = evaluate(entry, normalized);
        const threshold = entry.trigger?.threshold ?? 6;
        if (score >= threshold) {
            scored.push({ entry, score, threshold, hits, reason });
        } else if (score > 0) {
            belowThreshold++;
        }
    }

    // 按 score 降序,同分按 updated 倒序(新条目优先)
    scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const ta = new Date(a.entry.updated || a.entry.created || 0).getTime();
        const tb = new Date(b.entry.updated || b.entry.created || 0).getTime();
        return tb - ta;
    });

    // token 预算 + maxEntries 裁剪
    const triggered = [];
    const skipped = [];
    let totalTokens = 0;

    for (const item of scored) {
        const tokens = estimateTokens(item.entry.content);
        if (triggered.length >= maxEntries) {
            skipped.push({ ...item, tokens, skipReason: 'maxEntries' });
            continue;
        }
        if (totalTokens + tokens > tokenBudget) {
            skipped.push({ ...item, tokens, skipReason: 'tokenBudget' });
            continue;
        }
        triggered.push({ ...item, tokens });
        totalTokens += tokens;
    }

    return { triggered, skipped, totalTokens, entriesScanned, belowThreshold, timelineBlocked, cutoffBlocked };
}

/** 从 chat 数组构造 matchText(最近 N 条消息合并) */
export function buildMatchText(chat, windowSize = 5) {
    if (!Array.isArray(chat) || chat.length === 0) return '';
    const slice = chat.slice(-windowSize);
    return slice.map(m => m?.mes || '').filter(Boolean).join('\n');
}

/** Debug 入口:console 打印评分明细 */
export function debugTriggers(matchText, options = {}) {
    const result = runTriggers(matchText, options);
    const preview = matchText.length > 80 ? matchText.slice(0, 80) + '…' : matchText;

    console.group(`${TAG} 触发引擎测试`);
    console.log('matchText:', preview);
    console.log(`扫描 ${result.entriesScanned} / 触发 ${result.triggered.length} / 阈值未达 ${result.belowThreshold} / 时间线屏蔽 ${result.timelineBlocked} / 截止层屏蔽 ${result.cutoffBlocked} / 跳过 ${result.skipped.length} / 总 token ≈ ${result.totalTokens}`);

    if (result.triggered.length > 0) {
        console.group('触发条目(按得分降序)');
        for (const t of result.triggered) {
            console.log(
                `[${t.score}/${t.threshold}] ${t.entry.title}`,
                { hits: t.hits, tokens: t.tokens, scope: t.entry.scope }
            );
        }
        console.groupEnd();
    }

    if (result.skipped.length > 0) {
        console.group('跳过条目');
        for (const s of result.skipped) {
            console.log(`[${s.score}/${s.threshold}] ${s.entry.title} (${s.skipReason})`);
        }
        console.groupEnd();
    }

    console.groupEnd();
    return result;
}
