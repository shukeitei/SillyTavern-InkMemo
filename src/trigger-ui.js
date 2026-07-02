// Phase 8: 触发引擎设置面板 + 触发日志
import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types } from '../../../../../script.js';
import { manualTrigger, getLastTrigger } from './injector.js';
import { getChatCutoff, setChatCutoff, getCurrentChatId } from './storage.js';

function getSettings() {
    if (!extension_settings.luomo) extension_settings.luomo = {};
    return extension_settings.luomo;
}

export function bindTriggerSettings() {
    const s = getSettings();
    const $enabled = $('#mc-trigger-enabled');
    const $window = $('#mc-trigger-window');
    const $budget = $('#mc-trigger-budget');
    const $position = $('#mc-trigger-position');
    const $depth = $('#mc-trigger-depth');
    const $test = $('#mc-trigger-test');

    $enabled.prop('checked', s.trigger_enabled !== false);
    $window.val(s.trigger_window ?? 5);
    $budget.val(s.trigger_token_budget ?? 1000);
    $position.val(s.trigger_position || 'in_chat');
    $depth.val(s.trigger_depth ?? 4);

    $enabled.on('change', () => { s.trigger_enabled = $enabled.prop('checked'); saveSettingsDebounced(); });
    $window.on('change', () => { s.trigger_window = Number($window.val()) || 5; saveSettingsDebounced(); });
    $budget.on('change', () => { s.trigger_token_budget = Number($budget.val()) || 1000; saveSettingsDebounced(); });
    $position.on('change', () => { s.trigger_position = $position.val(); saveSettingsDebounced(); });
    $depth.on('change', () => { s.trigger_depth = Number($depth.val()) || 0; saveSettingsDebounced(); });

    $test.on('click', async () => {
        await manualTrigger();
        if (window.toastr) toastr.info('已执行一次触发评估');
    });

    // 本聊天记忆截止层(按 chatId 各自记忆,切聊天时刷新输入框)
    refreshCutoffInput();
    eventSource.on(event_types.CHAT_CHANGED, refreshCutoffInput);
    $('#mc-chat-cutoff').on('change', function () {
        const raw = String($(this).val() || '').trim();
        if (raw !== '' && (!Number.isFinite(Number(raw)) || Number(raw) < 0)) {
            if (window.toastr) toastr.error('截止层必须是 ≥0 的数字,或留空清除');
            refreshCutoffInput();
            return;
        }
        const ok = setChatCutoff(raw === '' ? null : Number(raw));
        if (!ok) {
            if (window.toastr) toastr.warning('当前没有打开聊天,无法设置截止层');
            return;
        }
        if (window.toastr) {
            toastr.success(raw === '' ? '已清除本聊天的记忆截止层' : `本聊天只触发起始层 ≤ #${Number(raw)} 的其他时间线结晶`);
        }
    });
}

/** 把截止层输入框刷新成当前聊天的值;没开聊天时禁用 */
export function refreshCutoffInput() {
    const $cutoff = $('#mc-chat-cutoff');
    if (!$cutoff.length) return;
    const chatId = getCurrentChatId();
    $cutoff.prop('disabled', !chatId);
    const v = getChatCutoff();
    $cutoff.val(v === null ? '' : v);
}

export function renderTriggerLog() {
    const $log = $('#mc-trigger-log-content');
    if (!$log.length) return;

    const last = getLastTrigger();
    if (!last) {
        $log.html('<div class="mc-empty-hint">尚无触发记录</div>');
        return;
    }

    const time = new Date(last.timestamp).toLocaleString();
    const matchPreview = last.matchTextLength > 0
        ? escapeHtml(last.matchTextPreview)
        : '<em>(空)</em>';
    let html = `<div class="mc-trigger-summary">
        <div>最近触发:${time}</div>
        <div>扫描 ${last.entriesScanned} 条 · 命中 ${last.triggered.length} 条 · 阈值未达 ${last.belowThreshold} 条 · 预算跳过 ${last.skippedCount} 条</div>
        <div>时间线屏蔽 ${last.timelineBlocked ?? 0} 条 · 截止层屏蔽 ${last.cutoffBlocked ?? 0} 条</div>
        <div>共 ${last.totalTokens} token · ${last.position}@depth${last.depth}</div>
        <div class="mc-trigger-match">聊天 ${last.chatLength} 条 · matchText ${last.matchTextLength} 字</div>
        <div class="mc-trigger-match-preview">${matchPreview}</div>
    </div>`;

    if (last.triggered.length === 0) {
        let hint = '本次未命中任何条目';
        if (last.entriesScanned === 0) hint = '当前 scope 下没有可扫描的条目';
        else if (last.matchTextLength === 0) hint = 'matchText 为空(可能未切到角色聊天,或 chat 还没消息)';
        else if (last.belowThreshold > 0) hint = `${last.belowThreshold} 条命中关键词但分数未达阈值,可降 threshold 或加 any/boost 词`;
        html += `<div class="mc-empty-hint">${hint}</div>`;
    } else {
        html += '<ul class="mc-trigger-hits">';
        for (const h of last.triggered) {
            const wordsLine = h.hitWords.length
                ? `<div class="mc-trigger-hit-words">${escapeHtml(h.hitWords.join(' / '))}</div>`
                : '';
            html += `<li>
                <div class="mc-trigger-hit-title">${escapeHtml(h.title)}</div>
                <div class="mc-trigger-hit-meta">[${h.score}/${h.threshold}] · ${h.tokens} token · ${h.hitWords.length} 词命中</div>
                ${wordsLine}
            </li>`;
        }
        html += '</ul>';
    }
    $log.html(html);
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
