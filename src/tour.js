// 落墨 InkMemo — 新手引导(onboarding tour)
// 首次打开面板时逐区讲解:解说气泡紧贴当前讲的区(不固定在面板底部),
// 每步只讲一件事,自动展开对应折叠区并滚动到位。完成/跳过后不再自动弹出。

import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';

const EXT_NAME = 'luomo';

// section: 对应 settings.html 里 data-mc-section 的 key;null = 锚定面板标题区
const STEPS = [
    {
        section: null,
        title: '欢迎使用落墨',
        text: '落墨把你选中的高光剧情结晶成沉浸式记忆,聊到相关话题时自动递回给 AI——让角色记得的不只是"发生过什么",还有当时的氛围。花 30 秒认识一下面板。',
    },
    {
        section: 'api',
        title: '第一步:接上你的模型',
        text: '结晶用你自己的 LLM。填一个 OpenAI 兼容接口(推荐 DeepSeek),Max Tokens 保持 ≥ 8192——结晶产出很长,填小了会被截断。',
    },
    {
        section: 'worldbook',
        title: '世界书设置:可以先不动',
        text: '这里只是全局默认书名。每个聊天真正写进哪本书,第一次结晶时会让你确认,之后按聊天记住绑定,不会写错地方。',
    },
    {
        section: 'crystallize',
        title: '记忆结晶:主工作区',
        text: '剧情告一段落,填楼层范围 → 预览 → 结晶。一个事件晶一条(常见 5~10 楼),别攒一整章——颗粒度小,日后触发才准。隐藏/折叠的楼层也照样能晶。风格推荐沉浸式——细节是情绪的载体。',
    },
    {
        section: 'entries',
        title: '条目管理:晶出的记忆都在这',
        text: '每条记忆可以开关、编辑触发关键词、删除;开过分支会按时间线分组,旧时间线可以整组关掉。',
    },
    {
        section: 'trigger',
        title: '触发引擎:记得开总开关',
        text: '勾上「启用自动触发注入」,聊天命中关键词时记忆才会自动注入。其余参数用默认值就好。',
    },
    {
        section: 'trigger-log',
        title: '触发日志:出问题第一站',
        text: '每次注入了哪条、命中了什么词、谁被拦下,全记在这。怀疑"怎么没注入",先来这里看。',
    },
    {
        section: null,
        title: '就这些!',
        text: '更详细的教程(预览怎么审、关键词怎么手调)看标题下的「📖 使用指引」。现在去接上 API,晶你的第一段记忆吧。',
    },
];

let currentStep = -1;

function getSettings() {
    extension_settings[EXT_NAME] = extension_settings[EXT_NAME] || {};
    return extension_settings[EXT_NAME];
}

function sectionBody(key) {
    return $(`#mc-section-${key}`);
}

function sectionHeader(key) {
    return $(`.mc-section-header[data-mc-section="${key}"]`);
}

function setSectionOpen(key, open) {
    const $body = sectionBody(key);
    const $header = sectionHeader(key);
    if (!$body.length) return;
    $body.toggleClass('mc-open', open);
    $header.attr('aria-expanded', String(open));
    $header.find('.mc-chevron').toggleClass('mc-chevron-open', open);
}

function removeBubble() {
    $('.mc-tour-bubble').remove();
    $('.mc-tour-active').removeClass('mc-tour-active');
}

// 引导结束后恢复面板默认开合状态(与 settings.html 初始一致)
function restoreDefaultSections() {
    for (const key of ['api', 'worldbook', 'trigger', 'trigger-log']) setSectionOpen(key, false);
    for (const key of ['crystallize', 'entries']) setSectionOpen(key, true);
}

function endTour(markDone) {
    removeBubble();
    restoreDefaultSections();
    currentStep = -1;
    if (markDone) {
        getSettings().tour_done = true;
        saveSettingsDebounced();
    }
}

function renderStep(index) {
    removeBubble();
    currentStep = index;
    const step = STEPS[index];
    const isLast = index === STEPS.length - 1;

    // 只展开当前讲的区,其他全收起,视线不分散
    for (const key of ['api', 'worldbook', 'crystallize', 'entries', 'trigger', 'trigger-log']) {
        setSectionOpen(key, key === step.section);
    }

    const bubble = $(`
        <div class="mc-tour-bubble">
            <div class="mc-tour-progress">${index + 1} / ${STEPS.length}</div>
            <div class="mc-tour-title">${step.title}</div>
            <div class="mc-tour-text">${step.text}</div>
            <div class="mc-tour-actions">
                <button type="button" class="mc-btn mc-btn-text mc-tour-skip">跳过引导</button>
                <span class="mc-tour-actions-right">
                    ${index > 0 ? '<button type="button" class="mc-btn mc-btn-outline mc-tour-prev">上一步</button>' : ''}
                    <button type="button" class="mc-btn mc-btn-primary mc-tour-next">${isLast ? '开始使用' : '下一步 →'}</button>
                </span>
            </div>
        </div>
    `);

    let $anchor;
    if (step.section) {
        const $section = sectionHeader(step.section).closest('.mc-section');
        $section.addClass('mc-tour-active');
        // 气泡插在该区 header 之后、内容之前——解说紧贴被讲解的区域
        sectionHeader(step.section).after(bubble);
        $anchor = $section;
    } else {
        $('#mc-panel .mc-header').addClass('mc-tour-active').after(bubble);
        $anchor = $('#mc-panel .mc-header');
    }

    bubble.find('.mc-tour-next').on('click', () => {
        if (isLast) endTour(true);
        else renderStep(index + 1);
    });
    bubble.find('.mc-tour-prev').on('click', () => renderStep(index - 1));
    bubble.find('.mc-tour-skip').on('click', () => endTour(true));

    $anchor[0]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** 从第一步开始引导(也用于「重看引导」) */
export function startTour() {
    if (currentStep >= 0) return; // 已在引导中
    renderStep(0);
}

/**
 * 首次使用自动开始引导。
 * 扩展抽屉可能还没打开(面板不可见时开讲用户根本看不到),
 * 所以用 IntersectionObserver 等面板第一次真正出现在屏幕上再开始。
 */
export function maybeStartTour() {
    if (getSettings().tour_done) return;
    const panel = document.getElementById('mc-panel');
    if (!panel) return;

    if (typeof IntersectionObserver === 'undefined') {
        startTour();
        return;
    }
    const observer = new IntersectionObserver((entries) => {
        if (entries.some(e => e.isIntersecting)) {
            observer.disconnect();
            if (!getSettings().tour_done) startTour();
        }
    }, { threshold: 0.1 });
    observer.observe(panel);
}
