// worldbook.js — 世界书写入模块
// 将确认的回忆录和知识库条目写入 ST 世界书

import {
    loadWorldInfo,
    createWorldInfoEntry,
    saveWorldInfo,
    createNewWorldInfo,
    updateWorldInfoList,
    world_names,
    world_info_logic,
} from '../../../../world-info.js';

export const DEFAULT_MEMORY_BOOK = '落墨·回忆录';
export const DEFAULT_KNOWLEDGE_BOOK = '落墨·角色知识库';

const LOG = '[InkMemo]';

async function ensureBook(bookName) {
    // 不能信 world_names 缓存判断存在性：worlds/ 目录里外部新建的书不在列表里,
    // 误判不存在会走 createNewWorldInfo 把同名书覆盖成空书(2026-06-11 真踩过)。
    // 改成先实地 load,load 得到就直接用;load 不到才创建。
    let data = await loadWorldInfo(bookName);
    if (!data) {
        console.log(`${LOG} 世界书 "${bookName}" 不存在，正在创建...`);
        await createNewWorldInfo(bookName, { interactive: false });
        data = await loadWorldInfo(bookName);
        console.log(`${LOG} 世界书 "${bookName}" 创建成功`);
    }
    if (!data) throw new Error(`无法加载世界书 "${bookName}"`);
    if (!world_names.includes(bookName)) {
        // 列表过期时顺手刷新,让 ST 世界书下拉里能看到这本书
        try { await updateWorldInfoList(); } catch (e) { console.warn(`${LOG} 世界书列表刷新失败:`, e); }
    }
    return data;
}

function formatMetadataHeader(metadata) {
    if (!metadata) return '';
    const parts = [];
    if (metadata.time) parts.push(`时间：${metadata.time}`);
    if (metadata.location) parts.push(`地点：${metadata.location}`);
    if (metadata.scene) parts.push(`场景：${metadata.scene}`);
    if (parts.length === 0) return '';
    return `[${parts.join(' | ')}]\n\n`;
}

function writeEntry(bookName, data, { title, content, keys, keysecondary = [], selective = true }) {
    const entry = createWorldInfoEntry(bookName, data);
    entry.comment = title;
    entry.content = content;
    entry.key = keys;
    entry.keysecondary = keysecondary;
    entry.selective = selective && keysecondary.length > 0;
    entry.selectiveLogic = world_info_logic.AND_ANY;
    entry.disable = false;
    entry.constant = false;
    console.log(`${LOG} 条目已创建: "${title}" (uid: ${entry.uid})`);
    return entry.uid;
}

/**
 * 写入所有确认的条目
 * @param {{memories?: Array, knowledge?: Array}} parsed
 * @param {{memoryBook?: string, knowledgeBook?: string}} [bookNames]
 */
export async function writeConfirmedEntries(parsed, bookNames = {}) {
    const memoryBookName = bookNames.memoryBook || DEFAULT_MEMORY_BOOK;
    const knowledgeBookName = bookNames.knowledgeBook || DEFAULT_KNOWLEDGE_BOOK;

    const result = { memoriesWritten: 0, knowledgeWritten: 0, errors: [] };

    if (parsed.memories && parsed.memories.length > 0) {
        try {
            const data = await ensureBook(memoryBookName);
            for (const mem of parsed.memories) {
                try {
                    const fullContent = formatMetadataHeader(mem.metadata) + (mem.content || '');
                    const keys = [...(mem.keywords?.core || [])];
                    const keysecondary = [
                        ...(mem.keywords?.common || []),
                        ...(mem.keywords?.assist || []),
                    ];
                    if (keys.length === 0 && keysecondary.length > 0) {
                        keys.push(keysecondary.shift());
                    }
                    writeEntry(memoryBookName, data, {
                        title: mem.title,
                        content: fullContent,
                        keys,
                        keysecondary,
                        selective: true,
                    });
                    result.memoriesWritten++;
                } catch (e) {
                    console.error(`${LOG} 写入回忆录失败: "${mem.title}"`, e);
                    result.errors.push(`回忆录 "${mem.title}": ${e.message}`);
                }
            }
            await saveWorldInfo(memoryBookName, data, true);
            console.log(`${LOG} 回忆录世界书已保存，共 ${result.memoriesWritten} 条`);
        } catch (e) {
            console.error(`${LOG} 回忆录世界书操作失败:`, e);
            result.errors.push(`回忆录世界书: ${e.message}`);
        }
    }

    if (parsed.knowledge && parsed.knowledge.length > 0) {
        try {
            const data = await ensureBook(knowledgeBookName);
            for (const kn of parsed.knowledge) {
                try {
                    // Phase 1:知识 keywords 新形状为 {concept, scene};世界书 keys 摊平 concept+scene(+主体名)。
                    // 兼容旧扁平数组。
                    const kKeys = Array.isArray(kn.keywords)
                        ? kn.keywords
                        : [
                            ...(kn.keywords?.concept || []),
                            ...(kn.keywords?.scene || []),
                            ...(kn.subject ? [kn.subject] : []),
                        ];
                    writeEntry(knowledgeBookName, data, {
                        title: kn.title,
                        content: kn.content || '',
                        keys: kKeys,
                        keysecondary: [],
                        selective: false,
                    });
                    result.knowledgeWritten++;
                } catch (e) {
                    console.error(`${LOG} 写入知识库失败: "${kn.title}"`, e);
                    result.errors.push(`知识库 "${kn.title}": ${e.message}`);
                }
            }
            await saveWorldInfo(knowledgeBookName, data, true);
            console.log(`${LOG} 知识库世界书已保存，共 ${result.knowledgeWritten} 条`);
        } catch (e) {
            console.error(`${LOG} 知识库世界书操作失败:`, e);
            result.errors.push(`知识库世界书: ${e.message}`);
        }
    }

    // — 刷新 ST 世界书编辑器 UI —
    if (result.memoriesWritten > 0 || result.knowledgeWritten > 0) {
        try {
            await updateWorldInfoList();
            const $select = $('#world_editor_select');
            const currentName = $select.find(':selected').text();
            if (currentName === memoryBookName || currentName === knowledgeBookName) {
                $select.trigger('change');
            }
            console.log(`${LOG} ST 世界书编辑器已刷新`);
        } catch (e) {
            console.warn(`${LOG} 编辑器刷新失败（条目已写入磁盘，手动切换世界书即可）:`, e);
        }
    }

    return result;
}
