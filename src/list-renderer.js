// 条目管理面板列表渲染 + Phase 10.1 trigger 编辑器

import {
    listAllByScope, deleteEntry, toggleEntry, getStats, getCurrentScope,
    findEntryById, updateEntry, resetEntryTrigger,
    getCurrentChatId, getTimelineKey, getTimelineLabel, getTimelineConfig,
    setTimelineEnabled, setTimelineName,
} from './storage.js';

const LIST_SEL = '#mc-entries-list';
const STATS_SEL = '#mc-entries-stats';

// 同时只允许一条 entry 展开 trigger 编辑器
let expandedEntryId = null;

export function renderEntryList() {
    const $container = $(LIST_SEL);
    if ($container.length === 0) return;

    const groups = listAllByScope();
    const stats = getStats();
    $(STATS_SEL).text(`共 ${stats.total} 条 · 启用 ${stats.enabled} · 回忆 ${stats.memory} · 知识 ${stats.knowledge}`);

    if (stats.total === 0) {
        $container.html('<div class="mc-empty">暂无条目。完成一次结晶后会出现在这里。</div>');
        expandedEntryId = null;
        return;
    }

    // 校验展开 id 是否还存在
    if (expandedEntryId) {
        const stillExists = groups.some(g => g.entries.some(e => e.id === expandedEntryId));
        if (!stillExists) expandedEntryId = null;
    }

    const currentScope = getCurrentScope();
    let html = '';
    for (const group of groups) {
        const isCurrent = group.scope === currentScope;
        // 非当前 scope 默认折叠,收视线(展开态有条目被展开编辑时除外)
        const hasExpanded = expandedEntryId && group.entries.some(e => e.id === expandedEntryId);
        const collapsed = !isCurrent && group.scope !== '_global' && !hasExpanded;
        html += `<div class="mc-scope-group" data-scope="${escapeAttr(group.scope)}">
  <div class="mc-scope-header${collapsed ? ' mc-scope-collapsed' : ''}">
    <span class="mc-scope-label">${escapeHtml(group.label)}${isCurrent ? '<span class="mc-scope-current">当前</span>' : ''}</span>
    <span class="mc-scope-count">${group.entries.length}</span>
  </div>
  <div class="mc-scope-body"${collapsed ? ' style="display:none"' : ''}>${renderTimelineGroups(group.entries)}</div>
</div>`;
    }
    $container.html(html);

    // 展开态:rAF 后加 mc-open 触发 max-height 过渡
    if (expandedEntryId) {
        requestAnimationFrame(() => {
            $container.find(`.mc-entry-row[data-id="${cssEscape(expandedEntryId)}"] .mc-trigger-editor`).addClass('mc-open');
        });
    }
}

/** scope 内按来源聊天(时间线)分桶渲染。本聊天的时间线置顶展开,其余默认折叠 */
function renderTimelineGroups(entries) {
    const currentChatId = getCurrentChatId();
    const buckets = new Map();
    for (const e of entries) {
        const key = getTimelineKey(e);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(e);
    }

    // 只有一个时间线、且就是本聊天(或没记录来源)时不画分桶头,保持旧观感;
    // 唯一的桶来自别的聊天(典型:刚开分支还没结晶)仍要画头,否则没入口关它
    if (buckets.size <= 1) {
        const onlyKey = [...buckets.keys()][0];
        if (!onlyKey || onlyKey === '_none' || onlyKey === currentChatId) {
            return entries.map(renderEntryRow).join('');
        }
    }

    // 本聊天优先,其余按桶内最新条目倒序(entries 已按 updated 倒序)
    const keys = [...buckets.keys()].sort((a, b) => {
        if (a === currentChatId) return -1;
        if (b === currentChatId) return 1;
        const la = buckets.get(a)[0]?.updated || '';
        const lb = buckets.get(b)[0]?.updated || '';
        return lb.localeCompare(la);
    });

    return keys.map(key => {
        const list = buckets.get(key);
        const cfg = getTimelineConfig(key);
        const enabled = cfg.enabled !== false;
        const isCurrent = key === currentChatId;
        const hasExpanded = expandedEntryId && list.some(e => e.id === expandedEntryId);
        const collapsed = !isCurrent && !hasExpanded;
        const enabledCount = list.filter(e => e.enabled !== false).length;
        return `<div class="mc-timeline-group${enabled ? '' : ' mc-timeline-disabled'}" data-timeline="${escapeAttr(key)}">
  <div class="mc-timeline-header${collapsed ? ' mc-timeline-collapsed' : ''}">
    <span class="mc-timeline-label" title="${escapeAttr(key)}">⌁ ${escapeHtml(getTimelineLabel(key))}${isCurrent ? '<span class="mc-scope-current">当前</span>' : ''}</span>
    <span class="mc-timeline-count">${enabled ? `${enabledCount}/${list.length}` : '已禁用'}</span>
    <div class="mc-timeline-actions">
      <button class="mc-icon-btn mc-timeline-rename" title="给这条时间线起备注名" type="button">✎</button>
      <label class="mc-toggle" title="${enabled ? '时间线已启用,点击整组禁用' : '时间线已禁用,点击整组启用'}">
        <input type="checkbox" class="mc-timeline-toggle" ${enabled ? 'checked' : ''}>
        <span class="mc-toggle-slider"></span>
      </label>
    </div>
  </div>
  <div class="mc-timeline-body"${collapsed ? ' style="display:none"' : ''}>${list.map(renderEntryRow).join('')}</div>
</div>`;
    }).join('');
}

function renderEntryRow(entry) {
    const typeLabel = entry.type === 'memory' ? '回忆' : '知识';
    const typeClass = entry.type === 'memory' ? 'mc-tag-memory' : 'mc-tag-knowledge';
    const enabledClass = entry.enabled ? 'mc-entry-enabled' : 'mc-entry-disabled';
    const expandedClass = entry.id === expandedEntryId ? 'mc-entry-expanded' : '';
    const time = entry.metadata?.time ? `<span class="mc-entry-meta">${escapeHtml(entry.metadata.time)}</span>` : '';
    const range = entry.source?.range;
    const rangeBadge = (range && Number.isFinite(range.from) && Number.isFinite(range.to))
        ? `<span class="mc-entry-range" title="结晶来源楼层">#${range.from}–${range.to}</span>`
        : '';
    const editorBody = entry.id === expandedEntryId ? renderTriggerEditor(entry) : '';
    return `<div class="mc-entry-row ${enabledClass} ${expandedClass}" data-id="${escapeAttr(entry.id)}">
  <div class="mc-entry-head">
    <span class="mc-entry-tag ${typeClass}">${typeLabel}</span>
    <span class="mc-entry-title" title="${escapeAttr(entry.title)}">${escapeHtml(entry.title)}</span>
  </div>
  <div class="mc-entry-foot">
    <span class="mc-entry-foot-meta">${rangeBadge}${time}</span>
    <div class="mc-entry-actions">
      <button class="mc-icon-btn mc-entry-edit" title="编辑触发条件">⚙</button>
      <label class="mc-toggle" title="${entry.enabled ? '已启用,点击禁用' : '已禁用,点击启用'}">
        <input type="checkbox" class="mc-entry-toggle" ${entry.enabled ? 'checked' : ''}>
        <span class="mc-toggle-slider"></span>
      </label>
      <button class="mc-icon-btn mc-entry-delete" title="删除">×</button>
    </div>
  </div>
  <div class="mc-trigger-editor">${editorBody}</div>
</div>`;
}

function renderTriggerEditor(entry) {
    const t = entry.trigger || {};
    const userEdited = t._userEdited === true;
    const isKnowledge = entry.type === 'knowledge';
    const threshold = typeof t.threshold === 'number' ? t.threshold : (isKnowledge ? 5 : 6);

    const statusBadge = userEdited
        ? `<span class="mc-tag-status">✦ 已编辑(不再随 keywords 变动)</span>`
        : `<span class="mc-tag-status-auto">⟳ 自动推导自 keywords</span>`;
    // 「重置为默认触发配置」对所有条目可见:即便没手编,推导规则升级后(如知识条目改用阈值 5)
    // 存量条目存的仍是旧 trigger,点此按新 deriveTrigger 重算。手编条目二次确认(会丢手改)。
    const resetLabel = userEdited ? '恢复推导' : '重置为默认触发配置';
    const resetBtn = `<button class="mc-btn-ghost" data-mc-action="reset-trigger" type="button">${resetLabel}</button>`;

    return `<div class="mc-trigger-editor-inner" data-id="${escapeAttr(entry.id)}">
  <div class="mc-trigger-editor-head">
    ${statusBadge}
    ${resetBtn}
  </div>
  ${renderPillRow('must', '必须词', '全命中才触发', t.must)}
  ${renderPillRow('core', '核心词', '任一命中 +5', t.core)}
  ${renderPillRow('any', '一般词', '每词 +3', t.any)}
  ${renderPillRow('boost', '加分词', '每词 +1', t.boost)}
  ${renderPillRow('exclude', '排除词', '出现即跳过', t.exclude)}
  <div class="mc-trigger-threshold-row">
    <label class="mc-trigger-threshold-label">触发阈值</label>
    <input class="mc-input-threshold" type="number" min="1" max="99" step="1" value="${threshold}" />
    <span class="mc-trigger-threshold-hint">梯度: 任一 core=5 / 一个 any=3 / 一个 boost=1${isKnowledge ? ' · 知识条目默认阈值 5(概念词单独命中即触发)' : ' · 回忆条目默认阈值 6'}</span>
  </div>
  <div class="mc-trigger-editor-actions">
    <button class="mc-btn mc-btn-sm mc-btn-secondary" data-mc-action="cancel-trigger" type="button">取消</button>
    <button class="mc-btn mc-btn-sm mc-btn-primary" data-mc-action="save-trigger" type="button">保存</button>
  </div>
</div>`;
}

function renderPillRow(field, label, hint, words) {
    const safeWords = Array.isArray(words) ? words : [];
    return `<div class="mc-pill-row" data-field="${field}">
  <div class="mc-pill-row-head">
    <span class="mc-pill-row-label">${label}</span>
    <span class="mc-pill-row-hint">${hint}</span>
  </div>
  <div class="mc-pill-list">
    ${safeWords.map(w => renderPill(field, w)).join('')}
    <input class="mc-pill-input" type="text" placeholder="+ 添加" data-field="${field}" />
  </div>
</div>`;
}

function renderPill(field, word) {
    return `<span class="mc-pill mc-pill-${field}" data-word="${escapeAttr(word)}"><span class="mc-pill-text">${escapeHtml(word)}</span><span class="mc-pill-x" data-mc-action="remove-pill">×</span></span>`;
}

export function bindEntryListEvents() {
    const $container = $(LIST_SEL);
    if ($container.length === 0) return;

    // ===== 现有事件 =====
    $container.on('change', '.mc-entry-toggle', function () {
        const id = String($(this).closest('.mc-entry-row').data('id'));
        const enabled = this.checked;
        toggleEntry(id, enabled);
        $(this).closest('.mc-entry-row')
            .toggleClass('mc-entry-enabled', enabled)
            .toggleClass('mc-entry-disabled', !enabled);
    });

    $container.on('click', '.mc-entry-delete', function () {
        const $row = $(this).closest('.mc-entry-row');
        const id = String($row.data('id'));
        const title = $row.find('.mc-entry-title').text();
        if (!confirm(`确定删除「${title}」?\n注意:只删除落墨自有存储中的副本,世界书中的同名条目不会动。`)) return;
        if (id === expandedEntryId) expandedEntryId = null;
        deleteEntry(id);
        renderEntryList();
        if (typeof toastr !== 'undefined') toastr.success('已删除');
    });

    $container.on('click', '.mc-scope-header', function () {
        const $body = $(this).next('.mc-scope-body');
        $body.slideToggle(150);
        $(this).toggleClass('mc-scope-collapsed');
    });

    // ===== 时间线分桶 =====

    // 折叠/展开(点开关、重命名按钮时不触发)
    $container.on('click', '.mc-timeline-header', function (e) {
        if ($(e.target).closest('.mc-timeline-actions').length) return;
        const $body = $(this).next('.mc-timeline-body');
        $body.slideToggle(150);
        $(this).toggleClass('mc-timeline-collapsed');
    });

    // 时间线总开关
    $container.on('change', '.mc-timeline-toggle', function () {
        const $group = $(this).closest('.mc-timeline-group');
        const key = String($group.attr('data-timeline'));
        const enabled = this.checked;
        setTimelineEnabled(key, enabled);
        $group.toggleClass('mc-timeline-disabled', !enabled);
        $group.find('.mc-timeline-count').text(enabled
            ? `${$group.find('.mc-entry-row.mc-entry-enabled').length}/${$group.find('.mc-entry-row').length}`
            : '已禁用');
        if (typeof toastr !== 'undefined') {
            toastr.info(enabled ? '时间线已启用,组内条目恢复参与触发' : '时间线已禁用,组内条目不再参与触发');
        }
    });

    // 时间线重命名
    $container.on('click', '.mc-timeline-rename', function (e) {
        e.stopPropagation();
        const key = String($(this).closest('.mc-timeline-group').attr('data-timeline'));
        const old = getTimelineConfig(key).name || '';
        const name = prompt('给这条时间线起个备注名(比如「A线·原线」,留空恢复默认):', old);
        if (name === null) return;
        setTimelineName(key, name);
        renderEntryList();
    });

    // ===== Phase 10.1: trigger 编辑器 =====

    // 展开/收起编辑器
    $container.on('click', '.mc-entry-edit', function (e) {
        e.stopPropagation();
        const id = String($(this).closest('.mc-entry-row').data('id'));
        if (expandedEntryId === id) {
            expandedEntryId = null;
        } else {
            expandedEntryId = id;
        }
        renderEntryList();
    });

    // 移除药丸(× 按钮)
    $container.on('click', '.mc-pill-x', function (e) {
        e.stopPropagation();
        const $pill = $(this).closest('.mc-pill');
        $pill.addClass('mc-pill-removing');
        setTimeout(() => $pill.remove(), 200);
    });

    // 输入框回车 → 加新药丸
    $container.on('keydown', '.mc-pill-input', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            const field = $(this).data('field');
            addPillToDOM($(this), $(this).val(), field);
        }
    });

    // 输入框失焦 → 加新药丸(如果 value 非空)
    $container.on('blur', '.mc-pill-input', function () {
        const field = $(this).data('field');
        const val = String($(this).val() || '').trim();
        if (val) addPillToDOM($(this), val, field);
    });

    // 取消编辑(整列表重渲染丢弃 DOM 改动)
    $container.on('click', '[data-mc-action="cancel-trigger"]', function () {
        expandedEntryId = null;
        renderEntryList();
    });

    // 重置为默认触发配置 / 恢复推导(局部更新编辑器 inner,不闪烁)
    // 手编过的条目会丢手改,需二次确认;未手编的直接按最新 deriveTrigger 规则重算,无需确认。
    $container.on('click', '[data-mc-action="reset-trigger"]', function () {
        const $editorInner = $(this).closest('.mc-trigger-editor-inner');
        const id = String($editorInner.data('id'));
        const entry = findEntryById(id);
        const wasEdited = entry?.trigger?._userEdited === true;
        if (wasEdited && !confirm('恢复推导后,你对这条 trigger 的所有手编修改将丢失,改回从 keywords 自动生成。确定继续?')) return;
        const updated = resetEntryTrigger(id);
        if (updated) {
            $editorInner.replaceWith(renderTriggerEditor(updated));
            if (typeof toastr !== 'undefined') toastr.success(wasEdited ? '已恢复推导' : '已重置为默认触发配置');
        }
    });

    // 保存编辑
    $container.on('click', '[data-mc-action="save-trigger"]', function () {
        const $editor = $(this).closest('.mc-trigger-editor-inner');
        const id = String($editor.data('id'));
        const entry = findEntryById(id);
        if (!entry) {
            if (typeof toastr !== 'undefined') toastr.error('条目不存在');
            return;
        }

        const collected = collectTriggerFromDOM($editor);

        const threshold = collected.threshold;
        if (!Number.isFinite(threshold) || threshold < 1 || threshold > 99) {
            if (typeof toastr !== 'undefined') toastr.error('阈值必须为 1-99 之间的整数');
            return;
        }

        const oldTrigger = entry.trigger || {};
        const newTrigger = {
            must: collected.must,
            core: collected.core,
            any: collected.any,
            boost: collected.boost,
            exclude: collected.exclude,
            weights: oldTrigger.weights ? { ...oldTrigger.weights } : { must: 10, core: 5, any: 3, boost: 1 },
            threshold,
            _userEdited: true,
        };

        updateEntry(id, { trigger: newTrigger });
        expandedEntryId = null;
        renderEntryList();
        if (typeof toastr !== 'undefined') toastr.success('已保存');
    });
}

function collectTriggerFromDOM($editor) {
    const fields = ['must', 'core', 'any', 'boost', 'exclude'];
    const out = {};
    for (const f of fields) {
        const $row = $editor.find(`.mc-pill-row[data-field="${f}"]`);
        const words = [];
        $row.find('.mc-pill').each(function () {
            // 用 data-word,避开 × 字符串污染
            const w = $(this).attr('data-word');
            if (w) words.push(w);
        });
        out[f] = words;
    }
    out.threshold = parseInt($editor.find('.mc-input-threshold').val(), 10);
    return out;
}

function addPillToDOM($input, raw, field) {
    const w = String(raw || '').trim();
    if (!w) return;
    const $list = $input.closest('.mc-pill-list');
    let existed = false;
    $list.find('.mc-pill').each(function () {
        if ($(this).attr('data-word') === w) existed = true;
    });
    if (existed) {
        $input.val('');
        return;
    }
    $input.before($(renderPill(field, w)).addClass('mc-pill-enter'));
    $input.val('');
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

function cssEscape(s) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
    return String(s).replace(/[^\w-]/g, '\\$&');
}
