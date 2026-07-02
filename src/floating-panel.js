// src/floating-panel.js
// 浮动结晶面板:连续分段结晶时不用开扩展抽屉、不用回设置区查上次晶到哪
// 纯操作面板:状态行(上次结晶到哪/当前楼层)+ 楼层范围 + 预览/结晶按钮
// 入口:魔棒菜单(#extensionsMenu)+ 设置面板「浮动结晶面板」按钮;仅桌面端

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
    if (window.innerWidth <= 600) {
        if (typeof toastr !== 'undefined') toastr.info('浮动面板仅桌面端,手机请用扩展面板里的结晶区', '落墨');
        return;
    }
    const panel = ensurePanel();
    applySavedPos(panel);
    fillDefaults();
    panel.style.display = '';
}

export function closeFloatPanel() {
    const el = document.getElementById(PANEL_ID);
    if (el) el.style.display = 'none';
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
            <button class="mc-btn mc-btn-primary" id="mc-fp-concise">✦ 简洁式</button>
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
