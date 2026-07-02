// 落墨 InkMemo — 消息提取模块
// 按楼层号范围从 ST 聊天数据提取消息

import { getContext } from '../../../../extensions.js';

const LOG_PREFIX = '[InkMemo]';

/**
 * 按楼层范围提取消息
 * @param {number} from 起始楼层（含）
 * @param {number} to   结束楼层（含）
 * @returns {{ messages: Array, formatted: string, count: number }}
 */
export function extractMessages(from, to) {
    const context = getContext();
    const chat = context.chat;

    if (!chat || chat.length === 0) {
        throw new Error('当前没有聊天记录');
    }
    if (isNaN(from) || isNaN(to)) {
        throw new Error('请输入有效的楼层号');
    }
    if (from < 0 || to < 0) {
        throw new Error('楼层号不能为负数');
    }
    if (from > to) {
        throw new Error('起始楼层不能大于结束楼层');
    }
    if (to >= chat.length) {
        throw new Error(`最大楼层号为 #${chat.length - 1}`);
    }

    const slice = chat.slice(from, to + 1);
    const messages = slice.map((msg, i) => ({
        floor: from + i,
        name: msg.name || '未知',
        isUser: !!msg.is_user,
        content: cleanContent(msg.mes || ''),
    }));

    // 拼接为纯文本，供后续发给结晶 API
    const formatted = messages.map(m =>
        `[#${m.floor}] ${m.name}:\n${m.content}`
    ).join('\n\n---\n\n');

    console.log(`${LOG_PREFIX} 提取完成: #${from} ~ #${to}，共 ${messages.length} 条`);
    return { messages, formatted, count: messages.length };
}

/**
 * 将提取的消息渲染为预览 HTML
 * @param {Array} messages extractMessages 返回的 messages 数组
 * @returns {string} HTML 字符串
 */
export function renderPreviewHTML(messages) {
    if (!messages || messages.length === 0) {
        return '<div class="mc-preview-empty">没有提取到消息</div>';
    }
    return messages.map(m => {
        const roleAttr = m.isUser ? ' data-role="user"' : '';
        const escaped = escapeHtml(m.content);
        const display = escaped.length > 500
            ? escaped.substring(0, 500) + '……'
            : escaped;
        return `<div class="mc-msg-card">
            <span class="mc-tag-character"${roleAttr}>#${m.floor} ${escapeHtml(m.name)}</span>
            <div class="mc-msg-content">${display.replace(/\n/g, '<br>')}</div>
        </div>`;
    }).join('');
}

/**
 * 清洗消息内容：去除 <thinking> COT 区块等
 */
function cleanContent(text) {
    if (!text) return '';
    // 去除 <thinking>...</thinking> 及其内容（含换行）
    let cleaned = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
    // 清理残余空行（连续多个换行合并为两个）
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
    return cleaned;
}

/**
 * HTML 转义
 */
function escapeHtml(text) {
    const el = document.createElement('div');
    el.textContent = text;
    return el.innerHTML;
}
