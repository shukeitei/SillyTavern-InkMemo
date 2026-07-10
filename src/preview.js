// src/preview.js
// Phase 4: 结晶预览编辑弹窗

export { showCrystalPreview };

/**
 * 展示结晶预览编辑界面
 * @param {object} parsed - { memories: [...], knowledge: [...] }
 * @param {object} callbacks - {
 *     target?: { scope, scopeLabel, bound, memoryBook, knowledgeBook },  // 写入目标（来自 resolveWriteTarget）
 *     onConfirm(editedData, confirmedTarget), onCancel()
 * }
 */
function showCrystalPreview(parsed, callbacks = {}) {
    const isMobile = window.innerWidth <= 600;
    if (isMobile) {
        renderInline(parsed, callbacks);
    } else {
        renderModal(parsed, callbacks);
    }
}

// ── 桌面 Modal ──────────────────────────────────────

function renderModal(parsed, callbacks) {
    // 移除已有
    document.querySelector('#mc-crystal-preview-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'mc-crystal-preview-overlay';
    overlay.className = 'mc-modal-overlay';

    overlay.innerHTML = `
        <div class="mc-modal mc-crystal-preview">
            ${buildPreviewContent(parsed, callbacks.target)}
        </div>`;

    document.body.appendChild(overlay);
    bindEvents(overlay, parsed, callbacks, 'modal');
    console.log('[InkMemo] 结晶预览弹窗已打开');
}

// ── 手机内联 ────────────────────────────────────────

function renderInline(parsed, callbacks) {
    const container = document.getElementById('mc-crystal-inline');
    if (!container) {
        console.error('[InkMemo] 未找到 #mc-crystal-inline 容器');
        return;
    }
    // 手机端 sheet 拖拽指示条:点顶部横条收起(等价取消)
    container.innerHTML = '<div class="mc-sheet-handle" title="点击收起"><span></span></div>'
        + buildPreviewContent(parsed, callbacks.target);
    $(container).slideDown(200);
    setTimeout(() => {
        container.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 220);
    bindEvents(container, parsed, callbacks, 'inline');
    container.querySelector('.mc-sheet-handle')?.addEventListener('click', () => {
        closePreview(container, 'inline');
        callbacks.onCancel?.();
    });
    console.log('[InkMemo] 结晶预览内联区已展开');
}

// ── 构建 HTML ───────────────────────────────────────

function buildPreviewContent(parsed, target) {
    const memCount = parsed.memories?.length || 0;
    const kbCount = parsed.knowledge?.length || 0;

    let html = `
        <div class="mcp-header">
            <div class="mcp-title">✦ 结晶预览</div>
            <div class="mcp-subtitle">${subtitleText(memCount, kbCount)}</div>
        </div>
        ${buildTargetBlock(target)}`;

    // ── 回忆录区 ──
    if (memCount > 0) {
        html += `
        <div class="mc-section mcp-section">
            <div class="mc-section-header mcp-section-header" aria-expanded="true">
                <span class="mcp-sec-count" data-count-type="memory">回忆录 (${memCount})</span>
                <span class="mc-chevron mc-chevron-open">▾</span>
            </div>
            <div class="mc-section-body mc-open mcp-section-body">
                ${parsed.memories.map((m, i) => buildMemoryCard(m, i)).join('')}
            </div>
        </div>`;
    }

    // ── 知识库区 ──
    if (kbCount > 0) {
        html += `
        <div class="mc-section mcp-section">
            <div class="mc-section-header mcp-section-header" aria-expanded="true">
                <span class="mcp-sec-count" data-count-type="knowledge">角色知识库 (${kbCount})</span>
                <span class="mc-chevron mc-chevron-open">▾</span>
            </div>
            <div class="mc-section-body mc-open mcp-section-body">
                ${parsed.knowledge.map((k, i) => buildKnowledgeCard(k, i)).join('')}
            </div>
        </div>`;
    }

    // ── 底部按钮 ──
    html += `
        <div class="mcp-actions">
            <button class="mc-btn mc-btn-outline mcp-cancel">取消</button>
            <button class="mc-btn mc-btn-primary mcp-confirm">✦ 确认写入</button>
        </div>`;

    return html;
}

function buildMemoryCard(mem, index) {
    const meta = mem.metadata || {};
    const kw = mem.keywords || {};
    return `
    <div class="mcp-card" data-type="memory" data-index="${index}">
        ${DEL_BTN_HTML}
        ${leakFlagBlock(mem._exampleLeak)}
        <input class="mc-input mcp-field-title" value="${esc(mem.title || '')}" placeholder="标题">

        <div class="mcp-meta-row">
            <label class="mcp-meta-item">
                <span class="mcp-meta-label">时间</span>
                <input class="mc-input mcp-field-meta-time" value="${esc(meta.time || '')}" placeholder="如：2026.2.9 深夜">
            </label>
            <label class="mcp-meta-item">
                <span class="mcp-meta-label">地点</span>
                <input class="mc-input mcp-field-meta-location" value="${esc(meta.location || '')}" placeholder="核心地点">
            </label>
            <label class="mcp-meta-item mcp-meta-item-wide">
                <span class="mcp-meta-label">场景</span>
                <input class="mc-input mcp-field-meta-scene" value="${esc(meta.scene || '')}" placeholder="一句话总结">
            </label>
        </div>

        <div class="mcp-content-toggle" aria-expanded="false">
            <span>正文</span>
            <span class="mcp-content-hint">${contentPreview(mem.content)}</span>
            <span class="mc-chevron">▾</span>
        </div>
        <textarea class="mc-input mcp-field-content mcp-content-area" style="display:none">${esc(mem.content || '')}</textarea>

        <div class="mcp-keywords-group">
            <div class="mcp-kw-row">
                <span class="mcp-kw-label">核心词</span>
                <div class="mcp-tags" data-kw-tier="core">
                    ${buildTags(kw.core)}
                    <input class="mcp-tag-input" placeholder="回车添加">
                </div>
            </div>
            <div class="mcp-kw-row">
                <span class="mcp-kw-label">常用词</span>
                <div class="mcp-tags" data-kw-tier="common">
                    ${buildTags(kw.common)}
                    <input class="mcp-tag-input" placeholder="回车添加">
                </div>
            </div>
            <div class="mcp-kw-row">
                <span class="mcp-kw-label">辅助词</span>
                <div class="mcp-tags" data-kw-tier="assist">
                    ${buildTags(kw.assist)}
                    <input class="mcp-tag-input" placeholder="回车添加">
                </div>
            </div>
        </div>
    </div>`;
}

// Phase 1 知识 category 枚举 → 中文徽章文案
const KB_CATEGORY_LABELS = {
    preference: '喜好习惯',
    pet: '宠物习性',
    promise: '未完约定',
    date: '重要日期',
    boundary: '雷区',
};

function kbCatLabel(cat) {
    return KB_CATEGORY_LABELS[cat] || cat || '';
}

function buildKnowledgeCard(kb, index) {
    // Phase 1 新 schema:keywords 为 {concept, scene};兼容旧扁平数组
    const kw = kb.keywords || {};
    const concept = Array.isArray(kw.concept) ? kw.concept
        : (Array.isArray(kb.keywords) ? kb.keywords : []);
    const scene = Array.isArray(kw.scene) ? kw.scene : [];
    const cat = kb.category || '';
    // Phase 2:update = AI 指向的旧条目标题(写入后软失效旧条目);_dupOf = 重合度检查标出的疑似重复条目
    const updateOf = String(kb.update || '').trim();
    const updateOld = kb._updateOld;           // {title, content} 找到旧条目时才有
    const updateMissing = !!kb._updateMissing;  // AI 说更新但落墨里没这条
    const dupOf = String(kb._dupOf || '').trim();

    // update 块:默认勾选"失效旧条目",附旧条目 content 供对比裁决(AI 可能误把两条并列判成更新)
    let updateBlock = '';
    if (updateOf && updateOld) {
        updateBlock = `
        <div class="mcp-kb-update">
            <label class="mcp-update-toggle">
                <input type="checkbox" class="mcp-update-check" checked>
                <span class="mcp-update-label">↻ 写入后失效旧条目：<b>${esc(updateOf)}</b></span>
            </label>
            <div class="mcp-update-hint">AI 认为本条是对旧条目的更新。<b>取消勾选则两条都保留</b>。拿不准就点下面对比旧条目原文。</div>
            <details class="mcp-update-old">
                <summary>对比旧条目原文</summary>
                <div class="mcp-update-old-content">${esc(updateOld.content || '(旧条目无正文)')}</div>
            </details>
        </div>`;
    } else if (updateOf && updateMissing) {
        updateBlock = `
        <div class="mcp-kb-update mcp-kb-update-missing">
            <span class="mcp-update-label">↻ AI 标为更新「${esc(updateOf)}」,但落墨条目里没有这条 → 将作为新条目写入</span>
        </div>`;
    }
    const dupBlock = dupOf ? `
        <div class="mcp-kb-flags">
            <span class="mcp-flag mcp-flag-dup" title="与已收录知识关键词高度重合,请人工确认是否重复——不会自动丢弃">⚠ 疑似重复：${esc(dupOf)}</span>
        </div>` : '';
    return `
    <div class="mcp-card" data-type="knowledge" data-index="${index}" data-category="${esc(cat)}" data-update="${esc(updateOf)}">
        ${DEL_BTN_HTML}
        ${leakFlagBlock(kb._exampleLeak)}
        ${updateBlock}
        ${dupBlock}
        <div class="mcp-kb-head">
            ${cat ? `<span class="mcp-cat-badge mcp-cat-${esc(cat)}">${esc(kbCatLabel(cat))}</span>` : ''}
            <input class="mc-input mcp-field-subject" value="${esc(kb.subject || '')}" placeholder="主体(谁)">
        </div>

        <input class="mc-input mcp-field-title" value="${esc(kb.title || '')}" placeholder="标题">

        <textarea class="mc-input mcp-field-content mcp-kb-content">${esc(kb.content || '')}</textarea>

        <div class="mcp-keywords-group">
            <div class="mcp-kw-row">
                <span class="mcp-kw-label">概念词</span>
                <div class="mcp-tags" data-kw-tier="concept">
                    ${buildTags(concept)}
                    <input class="mcp-tag-input" placeholder="回车添加">
                </div>
            </div>
            <div class="mcp-kw-row">
                <span class="mcp-kw-label">场景词</span>
                <div class="mcp-tags" data-kw-tier="scene">
                    ${buildTags(scene)}
                    <input class="mcp-tag-input" placeholder="回车添加">
                </div>
            </div>
        </div>
    </div>`;
}

/**
 * 写入目标区：始终显示本次要写进哪两本书。
 * 已绑定 → 预填书名，可直接确认写入。
 * 未绑定 → 不预填（灰色 placeholder 只做建议），必须手填名字并点「确定」，
 *          否则「确认写入」保持禁用（见 bindEvents）——逼用户真的看一眼书名。
 */
function buildTargetBlock(target) {
    if (!target) return '';
    if (target.bound) {
        return `
    <div class="mcp-target">
        <div class="mcp-target-status">写入目标 · ${esc(target.scopeLabel)}（已绑定，可改）</div>
        <label class="mcp-target-row">
            <span class="mcp-target-label">回忆录</span>
            <input class="mc-input mcp-target-memory" value="${esc(target.memoryBook || '')}" placeholder="回忆录世界书名">
        </label>
        <label class="mcp-target-row">
            <span class="mcp-target-label">知识库</span>
            <input class="mc-input mcp-target-knowledge" value="${esc(target.knowledgeBook || '')}" placeholder="角色知识库世界书名">
        </label>
    </div>`;
    }
    return `
    <div class="mcp-target mcp-target-unbound">
        <div class="mcp-target-status">⚠ 「${esc(target.scopeLabel)}」还没有绑定世界书——请填写两本书名并点「确定」。灰色字只是建议，可以照抄也可以另起，注意别和已有世界书撞名</div>
        <label class="mcp-target-row">
            <span class="mcp-target-label">回忆录</span>
            <input class="mc-input mcp-target-memory" value="" placeholder="${esc(target.memoryBook || '回忆录世界书名')}">
        </label>
        <label class="mcp-target-row">
            <span class="mcp-target-label">知识库</span>
            <input class="mc-input mcp-target-knowledge" value="" placeholder="${esc(target.knowledgeBook || '角色知识库世界书名')}">
        </label>
        <div class="mcp-target-actions">
            <button class="mc-btn mc-btn-outline mcp-target-confirm">确定</button>
        </div>
    </div>`;
}

// 单条删除按钮:第一次点进入待确认(变红显"确删?"),3 秒内再点才真删,防误触
const DEL_BTN_HTML = '<button type="button" class="mcp-card-del" title="删掉这条，本次不写入">🗑</button>';

/** 示例泄漏旗:模型把提示词示范例文里的人物抄进了产出,提醒人工删除或改写,不自动丢弃 */
function leakFlagBlock(leakName) {
    if (!leakName) return '';
    return `<div class="mcp-kb-flags">
        <span class="mcp-flag mcp-flag-leak" title="这条内容出现了落墨提示词示范例文里的人物,大概率是 AI 把示例当正文抄了——建议删掉这条重新结晶,或手动改写">⚠ 疑似抄示例：出现「${esc(leakName)}」</span>
    </div>`;
}

function subtitleText(memCount, kbCount) {
    if (memCount === 0 && kbCount === 0) return '条目已全部删除';
    return `共 ${memCount} 条回忆录${kbCount > 0 ? ` · ${kbCount} 条知识库` : ''}`;
}

/** 删除条目后同步顶部小计与分区计数 */
function refreshCounts(root) {
    const memCount = root.querySelectorAll('.mcp-card[data-type="memory"]').length;
    const kbCount = root.querySelectorAll('.mcp-card[data-type="knowledge"]').length;
    const subtitle = root.querySelector('.mcp-subtitle');
    if (subtitle) subtitle.textContent = subtitleText(memCount, kbCount);
    root.querySelectorAll('.mcp-sec-count').forEach(span => {
        const type = span.getAttribute('data-count-type');
        span.textContent = type === 'memory' ? `回忆录 (${memCount})` : `角色知识库 (${kbCount})`;
    });
}

function buildTags(arr) {
    if (!arr || !arr.length) return '';
    return arr.map(t => `<span class="mcp-tag">${esc(t)}<span class="mcp-tag-x">×</span></span>`).join('');
}

// ── 事件绑定 ────────────────────────────────────────

function bindEvents(root, originalParsed, callbacks, mode) {
    // 折叠区切换 — 用事件委托绑到 root,以 body.style.display 为真理来源
    // (V2.1 max-height transition 会卡死,且 per-header 监听器在第二次 click 时表现异常)
    root.addEventListener('click', (e) => {
        const header = e.target.closest('.mcp-section-header');
        if (!header || !root.contains(header)) return;
        const body = header.nextElementSibling;
        if (!body || !body.classList.contains('mc-section-body')) return;
        const isHidden = body.style.display === 'none';
        const chevron = header.querySelector('.mc-chevron');
        if (isHidden) {
            body.style.display = '';
            chevron?.classList.add('mc-chevron-open');
            header.setAttribute('aria-expanded', 'true');
        } else {
            body.style.display = 'none';
            chevron?.classList.remove('mc-chevron-open');
            header.setAttribute('aria-expanded', 'false');
        }
    });

    // 正文展开/折叠
    root.querySelectorAll('.mcp-content-toggle').forEach(toggle => {
        toggle.addEventListener('click', () => {
            const expanded = toggle.getAttribute('aria-expanded') === 'true';
            toggle.setAttribute('aria-expanded', String(!expanded));
            toggle.querySelector('.mc-chevron')?.classList.toggle('mc-chevron-open', !expanded);
            const textarea = toggle.nextElementSibling;
            if (!expanded) {
                textarea.style.display = 'block';
                // 自适应高度
                textarea.style.height = 'auto';
                textarea.style.height = Math.min(textarea.scrollHeight, 300) + 'px';
            } else {
                textarea.style.display = 'none';
            }
        });
    });

    // 正文 textarea 自适应高度
    root.querySelectorAll('.mcp-field-content').forEach(ta => {
        ta.addEventListener('input', () => {
            ta.style.height = 'auto';
            ta.style.height = Math.min(ta.scrollHeight, 300) + 'px';
        });
    });

    // 标签删除
    root.addEventListener('click', (e) => {
        if (e.target.classList.contains('mcp-tag-x')) {
            e.target.parentElement.remove();
        }
    });

    // 单条删除:collectEdits 按 DOM 现存卡片收集,删掉卡片 = 本次不写入
    root.addEventListener('click', (e) => {
        const btn = e.target.closest('.mcp-card-del');
        if (!btn || !root.contains(btn)) return;
        if (!btn.classList.contains('mcp-del-arm')) {
            btn.classList.add('mcp-del-arm');
            btn.textContent = '确删?';
            setTimeout(() => {
                if (!btn.isConnected) return;
                btn.classList.remove('mcp-del-arm');
                btn.textContent = '🗑';
            }, 3000);
            return;
        }
        const card = btn.closest('.mcp-card');
        const section = card?.closest('.mcp-section');
        card?.remove();
        // 该区删空 → 整区（含分区头）一起撤掉
        if (section && !section.querySelector('.mcp-card')) section.remove();
        refreshCounts(root);
    });

    // 标签添加（回车 / 失焦兜底:手机输入法「前往」键可能不发标准 Enter）
    const addTagFromInput = (input) => {
        const val = input.value.trim();
        if (!val) return;
        const tag = document.createElement('span');
        tag.className = 'mcp-tag mc-pill-enter';
        tag.innerHTML = `${esc(val)}<span class="mcp-tag-x">×</span>`;
        input.parentElement.insertBefore(tag, input);
        input.value = '';
    };
    root.querySelectorAll('.mcp-tag-input').forEach(input => {
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.keyCode === 13) {
                e.preventDefault();
                addTagFromInput(input);
            }
        });
        input.addEventListener('blur', () => addTagFromInput(input));
    });

    // 取消按钮
    root.querySelector('.mcp-cancel')?.addEventListener('click', () => {
        closePreview(root, mode);
        callbacks.onCancel?.();
    });

    // ── 写入目标门禁：未绑定聊天必须先点目标区的「确定」 ──
    const targetState = { confirmed: !callbacks.target || !!callbacks.target.bound };
    const confirmBtn = root.querySelector('.mcp-confirm');
    const targetBlock = root.querySelector('.mcp-target');
    const targetStatus = targetBlock?.querySelector('.mcp-target-status');
    // 用 class 而不是 disabled 属性锁按钮：disabled 的按钮不触发 click，提示语会哑掉
    const refreshConfirmEnabled = () => {
        confirmBtn?.classList.toggle('mcp-locked', !targetState.confirmed);
    };
    refreshConfirmEnabled();

    root.querySelector('.mcp-target-confirm')?.addEventListener('click', () => {
        const mem = root.querySelector('.mcp-target-memory')?.value.trim() || '';
        const kn = root.querySelector('.mcp-target-knowledge')?.value.trim() || '';
        if (!mem || !kn) {
            if (typeof toastr !== 'undefined') toastr.warning('两本世界书的名字都要填（灰色字是建议，可照抄可另起）', '落墨');
            return;
        }
        targetState.confirmed = true;
        targetBlock?.classList.remove('mcp-target-unbound');
        targetBlock?.classList.add('mcp-target-confirmed');
        if (targetStatus) targetStatus.textContent = `✓ 将写入：回忆录「${mem}」 · 知识库「${kn}」（写入后记住为本聊天的绑定）`;
        refreshConfirmEnabled();
    });

    // 点过「确定」又改名字 → 退回未确认，重新禁用「确认写入」
    if (callbacks.target && !callbacks.target.bound) {
        ['.mcp-target-memory', '.mcp-target-knowledge'].forEach(sel => {
            root.querySelector(sel)?.addEventListener('input', () => {
                if (!targetState.confirmed) return;
                targetState.confirmed = false;
                targetBlock?.classList.remove('mcp-target-confirmed');
                targetBlock?.classList.add('mcp-target-unbound');
                if (targetStatus) targetStatus.textContent = '⚠ 写入目标改过了——请重新点「确定」';
                refreshConfirmEnabled();
            });
        });
    }

    // 确认写入按钮
    confirmBtn?.addEventListener('click', () => {
        if (!targetState.confirmed) {
            if (typeof toastr !== 'undefined') toastr.warning('请先在上方确定写入目标', '落墨');
            return;
        }
        if (!root.querySelector('.mcp-card')) {
            if (typeof toastr !== 'undefined') toastr.warning('条目已全部删除，没有可写入的内容——直接点「取消」即可', '落墨');
            return;
        }
        const target = collectTarget(root, callbacks.target);
        if (target && !target.memoryBook) {
            if (typeof toastr !== 'undefined') toastr.warning('写入目标（回忆录世界书名）不能为空', '落墨');
            return;
        }
        if (target && !target.knowledgeBook && root.querySelector('.mcp-card[data-type="knowledge"]')) {
            if (typeof toastr !== 'undefined') toastr.warning('本次有知识库条目，知识库世界书名不能为空', '落墨');
            return;
        }
        const editedData = collectEdits(root);
        console.log('[InkMemo] 用户确认写入，编辑后数据：', editedData, '目标：', target);
        closePreview(root, mode);
        callbacks.onConfirm?.(editedData, target);
    });
}

// ── 收集编辑结果 ────────────────────────────────────

function collectEdits(root) {
    const result = { memories: [], knowledge: [] };

    root.querySelectorAll('.mcp-card[data-type="memory"]').forEach(card => {
        result.memories.push({
            title: card.querySelector('.mcp-field-title')?.value.trim() || '',
            metadata: {
                time: card.querySelector('.mcp-field-meta-time')?.value.trim() || '',
                location: card.querySelector('.mcp-field-meta-location')?.value.trim() || '',
                scene: card.querySelector('.mcp-field-meta-scene')?.value.trim() || '',
            },
            content: card.querySelector('.mcp-field-content')?.value || '',
            keywords: {
                core: collectTags(card, 'core'),
                common: collectTags(card, 'common'),
                assist: collectTags(card, 'assist'),
            },
        });
    });

    root.querySelectorAll('.mcp-card[data-type="knowledge"]').forEach(card => {
        // Phase 2:update 默认带回(写入时软失效旧条目);若用户取消了"失效旧条目"勾选 → 清空,两条都保留
        let update = card.getAttribute('data-update') || '';
        const updCheck = card.querySelector('.mcp-update-check');
        if (updCheck && !updCheck.checked) update = '';
        result.knowledge.push({
            category: card.getAttribute('data-category') || '',
            update,
            subject: card.querySelector('.mcp-field-subject')?.value.trim() || '',
            title: card.querySelector('.mcp-field-title')?.value.trim() || '',
            content: card.querySelector('.mcp-field-content')?.value || '',
            keywords: {
                concept: collectTags(card, 'concept'),
                scene: collectTags(card, 'scene'),
            },
        });
    });

    return result;
}

/** 收集写入目标（用户可能在弹窗里改过书名） */
function collectTarget(root, target) {
    if (!target) return null;
    return {
        ...target,
        memoryBook: root.querySelector('.mcp-target-memory')?.value.trim() || '',
        knowledgeBook: root.querySelector('.mcp-target-knowledge')?.value.trim() || '',
    };
}

function collectTags(card, tier) {
    const container = card.querySelector(`.mcp-tags[data-kw-tier="${tier}"]`);
    if (!container) return [];
    return Array.from(container.querySelectorAll('.mcp-tag'))
        .map(tag => {
            // 取文本内容，去掉尾部的 × 按钮文字
            const clone = tag.cloneNode(true);
            clone.querySelector('.mcp-tag-x')?.remove();
            return clone.textContent.trim();
        })
        .filter(Boolean);
}

// ── 关闭 ────────────────────────────────────────────

function closePreview(root, mode) {
    if (mode === 'modal') {
        root.classList.add('mcp-closing');
        setTimeout(() => root.remove(), 200);
    } else {
        $(root).slideUp(200, () => {
            root.innerHTML = '';
        });
    }
}

// ── 工具函数 ────────────────────────────────────────

function esc(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function contentPreview(content) {
    if (!content) return '（空）';
    const plain = content.replace(/\n/g, ' ').trim();
    return plain.length > 30 ? plain.slice(0, 30) + '…' : plain;
}
