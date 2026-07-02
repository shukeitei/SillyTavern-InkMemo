// sync-check.js — Phase 10.2 建议同步启发式
// 对比自有存储 vs ST 世界书内容差异,差异时在条目管理区给红点提示。
// 只做"建议",不自动同步——同步动作仍由用户点「从世界书同步」触发。
//
// 比较策略(为压低误报,故意做得宽松):
// 1. 按 title ↔ comment 匹配本地条目与世界书条目
// 2. content:剥掉写入时加的 metadata 头([时间：… | 地点：…]\n\n)后 trim 比较
// 3. 关键词:比"扁平并集"(wb 的 key+keysecondary vs 本地 keywords 三层拍平)。
//    不逐层对——写入路径有 core 空时 shift 一个词进 key 的兜底、knowledge 新旧双形状,
//    逐层对会满屏误报。并集相等即视为一致。
// 4. 世界书里没有本地副本的条目单独计数(wbOnly),只做信息展示不算 diff

import { loadWorldInfo } from '../../../../world-info.js';
import { listAllByScope } from './storage.js';

const LOG = '[InkMemo]';

function normalizeContent(wbContent) {
    let content = String(wbContent || '');
    const metaMatch = content.match(/^\[[^\]\n]*\]\n\n/);
    if (metaMatch) content = content.slice(metaMatch[0].length);
    return content.trim();
}

function flattenLocalKeywords(entry) {
    const kw = entry.keywords || {};
    return [
        ...(Array.isArray(kw.core) ? kw.core : []),
        ...(Array.isArray(kw.common) ? kw.common : []),
        ...(Array.isArray(kw.assist) ? kw.assist : []),
    ];
}

function sameSet(a, b) {
    const sa = new Set(a.map(w => String(w).trim()).filter(Boolean));
    const sb = new Set(b.map(w => String(w).trim()).filter(Boolean));
    if (sa.size !== sb.size) return false;
    for (const w of sa) if (!sb.has(w)) return false;
    return true;
}

/**
 * 检查当前聊天绑定的两本世界书与自有存储的差异。
 * @param {{memoryBook?: string, knowledgeBook?: string}} target 来自 resolveWriteTarget()
 * @returns {Promise<{diff: number, wbOnly: number, checkedBooks: string[], diffTitles: string[]}>}
 */
export async function checkSyncDiff(target) {
    const result = { diff: 0, wbOnly: 0, checkedBooks: [], diffTitles: [] };
    const allLocal = listAllByScope().flatMap(g => g.entries);
    if (allLocal.length === 0) return result;

    const books = [...new Set([target?.memoryBook, target?.knowledgeBook].filter(Boolean))];
    for (const bookName of books) {
        let data = null;
        try {
            data = await loadWorldInfo(bookName);
        } catch (e) {
            // 书不存在/读失败都静默跳过——这是后台启发式,不打扰用户
            continue;
        }
        if (!data?.entries) continue;
        result.checkedBooks.push(bookName);

        for (const wbe of Object.values(data.entries)) {
            const local = allLocal.find(le => le.title === wbe.comment);
            if (!local) { result.wbOnly++; continue; }

            const contentDiff = normalizeContent(wbe.content) !== String(local.content || '').trim();
            const wbKeywords = [
                ...(Array.isArray(wbe.key) ? wbe.key : []),
                ...(Array.isArray(wbe.keysecondary) ? wbe.keysecondary : []),
            ];
            const kwDiff = !sameSet(wbKeywords, flattenLocalKeywords(local));

            if (contentDiff || kwDiff) {
                result.diff++;
                result.diffTitles.push(local.title);
            }
        }
    }
    return result;
}

/**
 * 把检查结果渲染到条目管理区:
 * - diff > 0:「从世界书同步」按钮加红点,统计行下方出现提示行
 * - diff = 0:红点和提示行都撤掉
 */
export function renderSyncHint(result) {
    const $btn = $('#mc-sync-from-wb');
    const $hint = $('#mc-sync-hint');
    if ($btn.length === 0) return;

    const hasDiff = result && result.diff > 0;
    $btn.toggleClass('mc-has-diff', hasDiff);

    if ($hint.length === 0) return;
    if (hasDiff) {
        const parts = [`世界书里有 ${result.diff} 条和本地不同(可能在 ST 世界书界面里改过)`];
        if (result.wbOnly > 0) parts.push(`另有 ${result.wbOnly} 条无本地副本`);
        $hint.removeClass('mc-sync-hint-neutral').text(`⚠ ${parts.join('，')}——点「从世界书同步」拉平`).show();
    } else if (result && result.wbOnly > 0 && result.checkedBooks.length > 0) {
        $hint.addClass('mc-sync-hint-neutral').text(`世界书里有 ${result.wbOnly} 条无本地副本(手动新建的,同步会跳过)`).show();
    } else {
        $hint.hide().text('');
    }
    console.log(`${LOG} 同步检查: diff=${result?.diff ?? 0}, wbOnly=${result?.wbOnly ?? 0}, books=[${(result?.checkedBooks || []).join(', ')}]`);
}
