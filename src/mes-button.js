// src/mes-button.js
// 楼层点选结晶范围:每条消息的操作区(extraMesButtons,小铅笔那排)加一枚墨滴
// 点起点楼层 → 再点终点楼层 = 跨层范围;同一层点两下 = 只晶这一层
// 选完范围不直接开晶,回填结晶入口等用户按「预览/结晶」(保留手动确认防呆)

import { eventSource, event_types } from '../../../../../script.js';

const LOG_PREFIX = '[InkMemo]';
const BTN_CLASS = 'mc-mes-pick';
const ACTIVE_CLASS = 'mc-mes-pick-active';
const BTN_HTML = `<div title="落墨 · 点选结晶范围" class="mes_button ${BTN_CLASS} fa-solid fa-droplet" tabindex="0"></div>`;

let deps = null; // { onPickStart(from), onRangePicked(from, to) } 由 index.js 注入,避免循环依赖
let pendingFrom = null;
let pendingToast = null;

export function mountMesButton(d) {
    deps = d;

    // 注进消息模板:之后新渲染的每条消息自动带按钮
    const tpl = document.querySelector('#message_template .extraMesButtons');
    if (tpl) tpl.insertAdjacentHTML('afterbegin', BTN_HTML);
    else console.warn(`${LOG_PREFIX} 未找到 #message_template .extraMesButtons,楼层点选按钮不可用`);

    // 已渲染的存量消息补一遍;切聊天后 ST 从模板重渲染,但保险起见也补
    addToExistingMessages();
    eventSource.on(event_types.CHAT_CHANGED, () => {
        cancelPick(true);
        addToExistingMessages();
    });

    // 事件委托:消息节点会增删,不逐条绑
    $(document).on('click', `.${BTN_CLASS}`, function () {
        const mesid = parseInt($(this).closest('.mes').attr('mesid'), 10);
        if (isNaN(mesid)) return;
        handlePick(mesid);
    });
}

function addToExistingMessages() {
    document.querySelectorAll('#chat .mes .extraMesButtons').forEach((box) => {
        if (!box.querySelector(`.${BTN_CLASS}`)) box.insertAdjacentHTML('afterbegin', BTN_HTML);
    });
}

function handlePick(mesid) {
    if (pendingFrom === null) {
        pendingFrom = mesid;
        setActive(mesid, true);
        if (window.innerWidth <= 600) {
            // 手机端不弹 toast(会挡住消息工具栏且"点提示=取消"有歧义):
            // 直接弹底部浮动面板当状态提示,取消=关面板
            deps?.onPickStart?.(mesid);
            return;
        }
        if (typeof toastr !== 'undefined') {
            pendingToast = toastr.info(
                '同层再点一下=只晶这一层<br>点别的楼层=跨层结晶<br><u>点这条提示取消</u>',
                `✦ 起点 #${mesid}`,
                {
                    timeOut: 0,
                    extendedTimeOut: 0,
                    escapeHtml: false,
                    tapToDismiss: true,
                    onclick: () => cancelPick(false),
                },
            );
        }
        return;
    }
    // 第二点:起点大于终点自动交换;同层两下自然落成 from=to 单层范围
    const from = Math.min(pendingFrom, mesid);
    const to = Math.max(pendingFrom, mesid);
    cancelPick(true);
    console.log(`${LOG_PREFIX} 楼层点选范围 #${from} → #${to}`);
    deps?.onRangePicked(from, to);
}

/** silent=true 时只清状态不提示(选完范围/切聊天/手机端关面板);供 index.js 在面板关闭时调用 */
export function cancelPick(silent) {
    if (pendingFrom !== null) setActive(pendingFrom, false);
    pendingFrom = null;
    if (pendingToast && typeof toastr !== 'undefined') toastr.clear(pendingToast);
    pendingToast = null;
    if (!silent && typeof toastr !== 'undefined') toastr.info('已取消点选', '落墨');
}

function setActive(mesid, on) {
    const btn = document.querySelector(`#chat .mes[mesid="${mesid}"] .${BTN_CLASS}`);
    if (btn) btn.classList.toggle(ACTIVE_CLASS, on);
}
