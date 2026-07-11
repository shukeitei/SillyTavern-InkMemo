// src/floating-panel.js
// 浮动结晶面板:连续分段结晶时不用开扩展抽屉、不用回设置区查上次晶到哪
// 纯操作面板:状态行(上次结晶到哪/当前楼层)+ 楼层范围 + 预览/结晶按钮
// 入口:魔棒菜单(#extensionsMenu)+ 设置面板「浮动结晶面板」按钮 + 楼层点选(mes-button)
// 桌面=可拖动悬浮小窗;手机(≤600px)=固定底部小抽屉,并把抽屉里的两个内联预览容器借进来

import { extension_settings, getContext } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import { getLastCrystallizedTo } from './storage.js';

const MODULE_NAME = 'luomo';
const PANEL_ID = 'mc-float-panel';
const LOG_PREFIX = '[InkMemo]';

let deps = null; // { onPreview(from,to), onCrystallize(from,to,mode) } 由 index.js 注入,避免循环依赖

export function mountFloatingPanel(d) {
    deps = d;
    mountWandButton();
    // 写入完成后(不管从哪个入口触发的结晶)刷新状态行、楼层自动滚到下一段
    document.addEventListener('luomo:crystal-written', () => {
        if (isOpen()) fillDefaults();
    });
}

function isOpen() {
    const el = document.getElementById(PANEL_ID);
    return !!el && el.style.display !== 'none';
}

export function toggleFloatPanel() {
    if (isOpen()) closeFloatPanel();
    else openFloatPanel();
}

export function openFloatPanel() {
    const panel = ensurePanel();
    if (window.innerWidth <= 600) {
        // 手机端:底部小抽屉形态(定位交给 .mc-fp-mobile 的 CSS,清掉桌面拖动残留的行内定位)
        panel.classList.add('mc-fp-mobile');
        panel.style.left = '';
        panel.style.top = '';
        panel.style.right = '';
        adoptInlineContainers(panel);
    } else {
        panel.classList.remove('mc-fp-mobile');
        restoreInlineContainers();
        applySavedPos(panel);
    }
    fillDefaults();
    panel.style.display = '';
    if (window.innerWidth <= 600) pinToViewportBottom(panel);
    else panel.style.transform = '';
}

/** 手机端贴底修正:ST 给 <html> 挂了 transform(哪怕恒等),按规范 fixed 的包含块被劫持为
 *  html 盒——窄屏布局下该盒高度可为 0,bottom:0 会把面板整个钉到屏幕上方外(真机实测)。
 *  getBoundingClientRect 永远是真视口坐标,量出偏差用 translateY 拉回真视口底部。 */
function pinToViewportBottom(panel) {
    panel.style.transform = '';
    const gap = window.innerHeight - panel.getBoundingClientRect().bottom;
    if (Math.abs(gap) > 1) panel.style.transform = `translateY(${gap}px)`;
}

export function closeFloatPanel() {
    const el = document.getElementById(PANEL_ID);
    if (el) el.style.display = 'none';
    restoreInlineContainers();
    // 手机端点选到一半关面板要能取消挂起的起点,index.js 监听后处理
    document.dispatchEvent(new CustomEvent('luomo:fp-closed'));
}

/** 切聊天后刷新状态行与默认楼层(面板开着才动) */
export function refreshFloatPanel() {
    if (isOpen()) fillDefaults();
}

// ── 面板本体 ────────────────────────────────────────

function ensurePanel() {
    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;

    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.display = 'none';
    panel.innerHTML = `
        <div class="mc-fp-header" id="mc-fp-drag">
            <span class="mc-fp-title">✦ 快速结晶</span>
            <button class="mc-fp-close" id="mc-fp-close" title="关闭">×</button>
        </div>
        <div class="mc-fp-status" id="mc-fp-status">…</div>
        <div class="mc-fp-range">
            <span class="mc-range-hash">#</span>
            <input class="mc-input mc-fp-input" type="number" id="mc-fp-from" min="0" placeholder="起始">
            <span class="mc-range-sep">→</span>
            <span class="mc-range-hash">#</span>
            <input class="mc-input mc-fp-input" type="number" id="mc-fp-to" min="0" placeholder="结束">
            <button class="mc-btn-ghost" id="mc-fp-latest" title="结束楼层填到当前最新">最新</button>
        </div>
        <button class="mc-btn mc-btn-outline mc-btn-full mc-fp-btn" id="mc-fp-preview">预览提取内容</button>
        <div class="mc-fp-modes">
            <button class="mc-btn mc-btn-primary" id="mc-fp-immersive">✦ 沉浸式</button>
            <button class="mc-btn mc-btn-primary" id="mc-fp-concise" title="概括风格,保真度低;想让 AI 忠实记住细节,优先用沉浸式">✦ 简洁式</button>
        </div>
        <div id="mc-fp-shimmer"></div>`;
    document.body.appendChild(panel);

    panel.querySelector('#mc-fp-close').addEventListener('click', closeFloatPanel);
    panel.querySelector('#mc-fp-latest').addEventListener('click', () => {
        const max = getMaxFloor();
        if (max !== null) panel.querySelector('#mc-fp-to').value = max;
    });
    panel.querySelector('#mc-fp-preview').addEventListener('click', () => {
        const range = readRange();
        if (range) deps?.onPreview(range.from, range.to);
    });
    panel.querySelector('#mc-fp-immersive').addEventListener('click', () => {
        const range = readRange();
        if (range) deps?.onCrystallize(range.from, range.to, 'immersive');
    });
    panel.querySelector('#mc-fp-concise').addEventListener('click', () => {
        const range = readRange();
        if (range) deps?.onCrystallize(range.from, range.to, 'concise');
    });
    makeDraggable(panel, panel.querySelector('#mc-fp-drag'));
    console.log(`${LOG_PREFIX} 浮动结晶面板已创建`);
    return panel;
}

function readRange() {
    const from = parseInt(document.getElementById('mc-fp-from')?.value, 10);
    const to = parseInt(document.getElementById('mc-fp-to')?.value, 10);
    if (isNaN(from) || isNaN(to)) {
        if (typeof toastr !== 'undefined') toastr.warning('请填好起始和结束楼层', '落墨');
        return null;
    }
    return { from, to };
}

function getMaxFloor() {
    const chat = getContext()?.chat;
    return (chat && chat.length > 0) ? chat.length - 1 : null;
}

/** 状态行 + 默认楼层:起始 = 上次结晶楼层+1,结束 = 当前最新楼层 */
function fillDefaults() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const statusEl = panel.querySelector('#mc-fp-status');
    const fromEl = panel.querySelector('#mc-fp-from');
    const toEl = panel.querySelector('#mc-fp-to');

    const max = getMaxFloor();
    if (max === null) {
        statusEl.textContent = '当前没有聊天记录';
        fromEl.value = '';
        toEl.value = '';
        return;
    }
    const lastTo = getLastCrystallizedTo();
    const from = lastTo === null ? 0 : lastTo + 1;
    fromEl.value = from;
    // 结束楼层故意留空:逼用户每次手填,防止懒得检查直接结晶。需要填到最新点「最新」按钮
    toEl.value = '';

    if (lastTo === null) {
        statusEl.textContent = `本聊天还没结晶过 · 当前 #${max}`;
    } else if (from > max) {
        statusEl.textContent = `已结晶到 #${lastTo} · 当前 #${max} · 已是最新 ✓`;
    } else {
        statusEl.textContent = `上次结晶到 #${lastTo} · 当前 #${max} · 还差 ${max - from + 1} 楼`;
    }
}

// ── 手机端:借用抽屉里的内联预览容器 ─────────────────
// 提取预览(#mc-inline-preview)/结晶预览(#mc-crystal-inline)手机端渲染在扩展抽屉里,
// 抽屉不开就看不见。浮动面板打开时把两个容器挪进面板(下游 preview 链路按 id 找容器,零改动),
// 关面板挪回原位,抽屉里的老流程不受影响。
const INLINE_IDS = ['mc-inline-preview', 'mc-crystal-inline'];
let inlineHome = null; // [{ el, parent, next }]

function adoptInlineContainers(panel) {
    if (inlineHome) return;
    inlineHome = [];
    for (const id of INLINE_IDS) {
        const el = document.getElementById(id);
        if (!el) continue;
        inlineHome.push({ el, parent: el.parentNode, next: el.nextSibling });
        panel.appendChild(el);
    }
}

function restoreInlineContainers() {
    if (!inlineHome) return;
    for (const { el, parent, next } of inlineHome) {
        el.style.display = 'none'; // 收起旧内容再还回抽屉
        parent.insertBefore(el, next);
    }
    inlineHome = null;
}

// ── 拖动 + 位置记忆 ─────────────────────────────────

function getPosBucket() {
    extension_settings[MODULE_NAME] = extension_settings[MODULE_NAME] || {};
    return extension_settings[MODULE_NAME];
}

function applySavedPos(panel) {
    const pos = getPosBucket().fp_pos;
    if (!pos) return;
    // 夹回视口内,防止上次存的位置在小窗口下飞出屏幕外
    const left = Math.min(Math.max(0, pos.left), Math.max(0, window.innerWidth - 100));
    const top = Math.min(Math.max(0, pos.top), Math.max(0, window.innerHeight - 60));
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    panel.style.right = 'auto';
}

function makeDraggable(panel, handle) {
    let dragging = false, startX = 0, startY = 0, origX = 0, origY = 0;
    handle.addEventListener('pointerdown', (e) => {
        if (window.innerWidth <= 600) return; // 手机端底部抽屉形态不拖动
        if (e.target.closest('.mc-fp-close')) return;
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const rect = panel.getBoundingClientRect();
        origX = rect.left;
        origY = rect.top;
        handle.setPointerCapture(e.pointerId);
        e.preventDefault();
    });
    handle.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const x = Math.min(Math.max(0, origX + e.clientX - startX), window.innerWidth - panel.offsetWidth);
        const y = Math.min(Math.max(0, origY + e.clientY - startY), window.innerHeight - 48);
        panel.style.left = x + 'px';
        panel.style.top = y + 'px';
        panel.style.right = 'auto';
    });
    const stop = () => {
        if (!dragging) return;
        dragging = false;
        const rect = panel.getBoundingClientRect();
        getPosBucket().fp_pos = { left: Math.round(rect.left), top: Math.round(rect.top) };
        saveSettingsDebounced();
    };
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
}

// ── 魔棒菜单入口 ────────────────────────────────────

function mountWandButton() {
    if (document.getElementById('mc-fp-wand')) return;
    const menu = document.getElementById('extensionsMenu');
    if (!menu) {
        console.warn(`${LOG_PREFIX} 未找到 #extensionsMenu,浮动面板入口只剩设置面板按钮`);
        return;
    }
    const item = document.createElement('div');
    item.id = 'mc-fp-wand';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = `<div class="fa-solid fa-droplet extensionsMenuExtensionButton"></div><span>落墨 · 快速结晶</span>`;
    item.addEventListener('click', toggleFloatPanel);
    menu.appendChild(item);
}
