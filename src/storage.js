// 落墨自有存储模块
// 基于 extension_settings.luomo.entries,按 scope 分桶

import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';

const MODULE_NAME = 'luomo';
const STORAGE_VERSION = 3;
const DEFAULT_WEIGHTS = { must: 10, core: 5, any: 3, boost: 1 };
// Phase 9.1:5→6,单 core(=5)不再过线,必须叠至少一个辅助词凑出层次
const DEFAULT_THRESHOLD = 6;
// Phase 0(知识库优化):知识条目专属阈值。概念词单独命中(core=5)即过线;
// 场景词单独(any=3)不过,需与主体名(any=3)共现 3+3=6≥5。回忆条目仍用 DEFAULT_THRESHOLD。
const KNOWLEDGE_THRESHOLD = 5;
// v1→v2 迁移判断"用户是否改过 threshold"时用,冻结 v2 时代默认值(当时是 5),
// 不随 DEFAULT_THRESHOLD 漂移;否则历史 v1 数据会把旧默认 5 误判成用户自定义而保留
const LEGACY_V1_DEFAULT_THRESHOLD = 5;

function getCtx() {
    if (typeof SillyTavern !== 'undefined' && typeof SillyTavern.getContext === 'function') {
        return SillyTavern.getContext();
    }
    return null;
}

/** 确保存储桶初始化,返回 entries 引用 */
export function initStorage() {
    extension_settings[MODULE_NAME] = extension_settings[MODULE_NAME] || {};
    const settings = extension_settings[MODULE_NAME];
    if (!settings.entries) settings.entries = {};

    // 版本管理
    // - storage_version 不存在:全新装机用户,直接标当前版本不跑迁移
    // - storage_version < STORAGE_VERSION:跑迁移
    if (settings.storage_version === undefined) {
        settings.storage_version = STORAGE_VERSION;
    } else if (settings.storage_version < STORAGE_VERSION) {
        runMigrations(settings);
    }

    return settings.entries;
}

/** 迁移调度。失败时不更新 storage_version,下次初始化会重试 */
function runMigrations(settings) {
    const fromVersion = settings.storage_version;
    try {
        if (fromVersion < 2) {
            migrateV1ToV2(settings);
        }
        if (fromVersion < 3) {
            migrateV2ToV3(settings);
        }
        settings.storage_version = STORAGE_VERSION;
        saveSettingsDebounced();
        console.log(`[InkMemo] Storage migration: v${fromVersion} → v${STORAGE_VERSION} 完成`);
    } catch (err) {
        console.error(`[InkMemo] Storage migration v${fromVersion}→v${STORAGE_VERSION} 失败:`, err);
    }
}

/** v1 → v2:trigger 加 core 字段,按新 deriveTrigger 重算所有非手编条目 */
function migrateV1ToV2(settings) {
    const entries = settings.entries || {};
    let migrated = 0;
    let failed = 0;
    for (const scope of Object.keys(entries)) {
        for (const entry of entries[scope]) {
            try {
                // _userEdited 保护:Phase 10 trigger 编辑器上线后用户手编过的不重算
                // 当前不会触发(还没 UI),但接口先留着
                if (entry.trigger?._userEdited === true) continue;
                const oldTrigger = entry.trigger || {};
                const newTrigger = deriveTrigger(entry.keywords, entry.type, getEntrySubject(entry));
                // 保留原有 exclude(理论上当前都为空)
                if (Array.isArray(oldTrigger.exclude) && oldTrigger.exclude.length > 0) {
                    newTrigger.exclude = oldTrigger.exclude;
                }
                // 偏离 v2 时代默认值(5)的才视为用户自定义需保留;等于旧默认的跟到新默认(v2→v3 会再统一抬)
                if (typeof oldTrigger.threshold === 'number' && oldTrigger.threshold !== LEGACY_V1_DEFAULT_THRESHOLD) {
                    newTrigger.threshold = oldTrigger.threshold;
                }
                entry.trigger = newTrigger;
                migrated++;
            } catch (err) {
                console.warn(`[InkMemo] migrateV1ToV2 跳过条目 ${entry.id}:`, err);
                failed++;
            }
        }
    }
    console.log(`[InkMemo] Migration v1→v2: 重算 ${migrated} 条 trigger,失败 ${failed} 条`);
}

/** v2 → v3:Phase 9.1 默认 threshold 5→6。把非手编、且仍是旧默认 5 的条目抬到新默认 6。
 *  _userEdited 的条目保留不动(用户可能就是想要 5);非 5 的非手编条目也不动(避免误伤)。 */
function migrateV2ToV3(settings) {
    const entries = settings.entries || {};
    let bumped = 0;
    for (const scope of Object.keys(entries)) {
        for (const entry of entries[scope]) {
            const t = entry.trigger;
            if (!t || t._userEdited === true) continue;
            if (t.threshold === LEGACY_V1_DEFAULT_THRESHOLD) {
                t.threshold = DEFAULT_THRESHOLD;
                bumped++;
            }
        }
    }
    console.log(`[InkMemo] Migration v2→v3: threshold ${LEGACY_V1_DEFAULT_THRESHOLD}→${DEFAULT_THRESHOLD} 抬升 ${bumped} 条`);
}

/** 当前 ST 上下文对应的默认 scope */
export function getCurrentScope() {
    const ctx = getCtx();
    if (!ctx) return '_global';
    if (ctx.groupId) return `group:${ctx.groupId}`;
    if (ctx.characterId !== undefined && ctx.characters && ctx.characters[ctx.characterId]) {
        const avatar = ctx.characters[ctx.characterId].avatar;
        if (avatar) return `character:${avatar}`;
    }
    return '_global';
}

/** scope 的人类可读名 */
export function getScopeLabel(scope) {
    if (scope === '_global') return '全局';
    const ctx = getCtx() || {};
    if (scope.startsWith('group:')) {
        const gid = scope.slice(6);
        const group = (ctx.groups || []).find(g => String(g.id) === gid);
        return group ? `群聊 · ${group.name}` : `群聊 · ${gid.slice(0, 8)}`;
    }
    if (scope.startsWith('character:')) {
        const avatar = scope.slice(10);
        const ch = (ctx.characters || []).find(c => c.avatar === avatar);
        return ch ? `角色 · ${ch.name}` : `角色 · ${avatar}`;
    }
    return scope;
}

function genId(type) {
    const prefix = type === 'knowledge' ? 'kn' : 'mem';
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 7);
    return `${prefix}_${ts}_${rand}`;
}

/** 从 keywords 三层 + 条目类型推导默认 trigger 配置
 *
 *  回忆条目(memory / type 缺省):must=[], core=keywords.core, any=keywords.common,
 *  boost=keywords.assist, threshold=DEFAULT_THRESHOLD(6)。维持现状。
 *
 *  知识条目(knowledge):触发几何整个不同(Phase 0 修复"就算词提得完美也触发不了"的 bug)。
 *  - 阈值降到 KNOWLEDGE_THRESHOLD(5),让单个概念词命中即可过线。
 *  - Phase 1 精确映射:concept 词(core 容器)→ core 档(任一命中 +5,软 OR);
 *    scene 词(common 容器)→ any 档(+3);subject 主体名 → any 档(+3)。
 *    语义:概念词单独命中即触发;场景词单独不过(3<5),需与主体名共现(3+3=6≥5)。
 *  - 兼容存量/旧形状:知识关键词曾以扁平数组存过(有的落 core 容器、Phase 0 前落 common 容器)。
 *    若只有一个容器有词(另一个空),把有词的那批一律当 concept 放 core 档——保证"单词命中即触发",
 *    避免旧对象形状(词全在 common)被 reset 后掉进 any 档、单词 3<5 触发不了的回退。
 *    只有两容器都非空时才是新 schema(concept+scene),走精确的 core/any 分档。
 */
function deriveTrigger(keywords, type, subject) {
    const core = Array.isArray(keywords?.core) ? keywords.core : [];
    const common = Array.isArray(keywords?.common) ? keywords.common : [];
    const assist = Array.isArray(keywords?.assist) ? keywords.assist : [];

    if (type === 'knowledge') {
        let coreTier;   // → core 档(+5,concept)
        let anyTier;    // → any 档(+3,scene)
        if (core.length && !common.length) {
            coreTier = [...core]; anyTier = [];              // 新 schema 无 scene / Phase 0 存量(扁平在 core)
        } else if (!core.length && common.length) {
            coreTier = [...common]; anyTier = [];            // 旧对象形状(扁平在 common)→ 当 concept,防回退
        } else {
            coreTier = [...core]; anyTier = [...common];     // 新 schema:concept→core, scene→any
        }
        const subj = String(subject || '').trim();
        if (subj) anyTier.push(subj);            // 主体名入 any 档(+3),与场景词共现凑线
        return {
            must: [],
            core: coreTier,
            any: anyTier,
            boost: [...assist],
            exclude: [],
            weights: { ...DEFAULT_WEIGHTS },
            threshold: KNOWLEDGE_THRESHOLD,
        };
    }

    return {
        must: [],
        core: [...core],
        any: [...common],
        boost: [...assist],
        exclude: [],
        weights: { ...DEFAULT_WEIGHTS },
        threshold: DEFAULT_THRESHOLD,
    };
}

/** 从 entry 取主体名(Phase 1 起存于 metadata.subject),Phase 0 存量条目无此字段返回 '' */
function getEntrySubject(entry) {
    const s = entry?.metadata?.subject;
    return typeof s === 'string' ? s : '';
}

/** 把结晶产出的一条(memory 或 knowledge)标准化成内部 entry */
export function buildEntry({ type, raw, scope, sourceRange }) {
    const now = new Date().toISOString();
    const ctx = getCtx() || {};
    const isMemory = type === 'memory';

    // 知识条目:Phase 1 新 schema keywords 为 {concept, scene}——
    //   concept → core 容器,scene → common 容器,assist 恒空;deriveTrigger 据此 core→+5 档 / scene→+3 档。
    //   兼容旧扁平数组(raw.keywords 是 Array)→ 落 core 容器(与 Phase 0 存量对齐)。
    const keywords = isMemory
        ? {
            core: Array.isArray(raw.keywords?.core) ? raw.keywords.core : [],
            common: Array.isArray(raw.keywords?.common) ? raw.keywords.common : [],
            assist: Array.isArray(raw.keywords?.assist) ? raw.keywords.assist : [],
        }
        : {
            core: Array.isArray(raw.keywords?.concept) ? raw.keywords.concept
                : (Array.isArray(raw.keywords) ? raw.keywords : []),
            common: Array.isArray(raw.keywords?.scene) ? raw.keywords.scene : [],
            assist: [],
        };

    // 知识条目 metadata 从 null 启用:存 subject/category(索引键)+ update(Phase 2 消费的旧条目指向)
    const knowledgeMeta = isMemory ? null : (() => {
        const m = {};
        if (raw.subject) m.subject = raw.subject;
        if (raw.category) m.category = raw.category;
        if (raw.update) m.update = raw.update;
        return m;
    })();

    return {
        id: genId(type),
        type,
        title: raw.title || '(无标题)',
        metadata: isMemory ? (raw.metadata || {}) : knowledgeMeta,
        content: raw.content || '',
        keywords,
        trigger: deriveTrigger(keywords, type, isMemory ? undefined : raw.subject),
        enabled: true,
        scope: scope || getCurrentScope(),
        source: {
            range: sourceRange || null,
            chatId: ctx.chatId || null,
            characterId: ctx.characterId !== undefined ? ctx.characterId : null,
            groupId: ctx.groupId || null,
        },
        created: now,
        updated: now,
    };
}

/** 新增或覆盖保存(按 id 匹配) */
export function saveEntry(entry) {
    const entries = initStorage();
    const scope = entry.scope;
    if (!entries[scope]) entries[scope] = [];
    const idx = entries[scope].findIndex(e => e.id === entry.id);
    if (idx >= 0) {
        entry.updated = new Date().toISOString();
        entries[scope][idx] = entry;
    } else {
        entries[scope].push(entry);
    }
    saveSettingsDebounced();
    return entry;
}

/** 部分字段更新 */
export function updateEntry(id, patch) {
    const entries = initStorage();
    for (const scope of Object.keys(entries)) {
        const idx = entries[scope].findIndex(e => e.id === id);
        if (idx >= 0) {
            entries[scope][idx] = { ...entries[scope][idx], ...patch, updated: new Date().toISOString() };
            saveSettingsDebounced();
            return entries[scope][idx];
        }
    }
    return null;
}

export function deleteEntry(id) {
    const entries = initStorage();
    for (const scope of Object.keys(entries)) {
        const before = entries[scope].length;
        entries[scope] = entries[scope].filter(e => e.id !== id);
        if (entries[scope].length !== before) {
            saveSettingsDebounced();
            return true;
        }
    }
    return false;
}

export function toggleEntry(id, enabled) {
    return updateEntry(id, { enabled: !!enabled });
}

export function findEntryById(id) {
    const entries = initStorage();
    for (const scope of Object.keys(entries)) {
        const found = entries[scope].find(e => e.id === id);
        if (found) return found;
    }
    return null;
}

/** 恢复某条 entry 的 trigger 到自动推导态(清 _userEdited 标记)
 *  Phase 10.1 trigger 编辑器"恢复推导"按钮调用 */
export function resetEntryTrigger(id) {
    const entry = findEntryById(id);
    if (!entry) return null;
    const newTrigger = deriveTrigger(entry.keywords, entry.type, getEntrySubject(entry));
    return updateEntry(id, { trigger: newTrigger });
}

/** 当前上下文可见的条目(当前 scope + _global),给触发引擎用 */
export function listForCurrentContext() {
    const entries = initStorage();
    const scope = getCurrentScope();
    const out = [];
    if (entries[scope]) out.push(...entries[scope]);
    if (scope !== '_global' && entries['_global']) out.push(...entries['_global']);
    return out;
}

/** 全部条目按 scope 分组,管理面板用 */
export function listAllByScope() {
    const entries = initStorage();
    const currentScope = getCurrentScope();
    const order = [
        currentScope,
        '_global',
        ...Object.keys(entries).filter(s => s !== currentScope && s !== '_global'),
    ];
    const seen = new Set();
    const groups = [];
    for (const scope of order) {
        if (seen.has(scope) || !entries[scope]) continue;
        seen.add(scope);
        if (entries[scope].length === 0) continue;
        groups.push({
            scope,
            label: getScopeLabel(scope),
            entries: [...entries[scope]].sort((a, b) => (b.updated || '').localeCompare(a.updated || '')),
        });
    }
    return groups;
}

// ===== 时间线(按来源聊天分桶)+ 本聊天记忆截止层 =====
// 时间线 key = entry.source.chatId(无记录的归 '_none')。
// 配置存 extension_settings.luomo.timelines: { [key]: { name?, enabled? } },
// 截止层存 extension_settings.luomo.chat_cutoffs: { [chatId]: number }。
// 两者都是懒初始化,不走 storage_version 迁移。

const NO_CHAT_KEY = '_none';

function getSettingsBucket() {
    extension_settings[MODULE_NAME] = extension_settings[MODULE_NAME] || {};
    return extension_settings[MODULE_NAME];
}

export function getCurrentChatId() {
    const ctx = getCtx();
    return ctx?.chatId || null;
}

export function getTimelineKey(entry) {
    return entry?.source?.chatId || NO_CHAT_KEY;
}

export function getTimelines() {
    const s = getSettingsBucket();
    if (!s.timelines) s.timelines = {};
    return s.timelines;
}

export function getTimelineConfig(key) {
    return getTimelines()[key] || {};
}

export function setTimelineName(key, name) {
    const timelines = getTimelines();
    const next = { ...(timelines[key] || {}) };
    const trimmed = String(name || '').trim();
    if (trimmed) next.name = trimmed;
    else delete next.name;
    timelines[key] = next;
    saveSettingsDebounced();
}

export function setTimelineEnabled(key, enabled) {
    const timelines = getTimelines();
    timelines[key] = { ...(timelines[key] || {}), enabled: !!enabled };
    saveSettingsDebounced();
}

/** 时间线显示名:自定义备注 > 本聊天 > chatId 截断 */
export function getTimelineLabel(key) {
    const cfg = getTimelineConfig(key);
    if (cfg.name) return cfg.name;
    if (key === NO_CHAT_KEY) return '未记录来源聊天';
    if (key === getCurrentChatId()) return '本聊天';
    return key.length > 24 ? key.slice(0, 24) + '…' : key;
}

function getChatCutoffs() {
    const s = getSettingsBucket();
    if (!s.chat_cutoffs) s.chat_cutoffs = {};
    return s.chat_cutoffs;
}

/** 当前聊天的记忆截止层,没设返回 null */
export function getChatCutoff() {
    const chatId = getCurrentChatId();
    if (!chatId) return null;
    const v = getChatCutoffs()[chatId];
    return Number.isFinite(v) ? v : null;
}

/** 设置/清除当前聊天的截止层。value 传 null/'' 即清除。无聊天上下文返回 false */
export function setChatCutoff(value) {
    const chatId = getCurrentChatId();
    if (!chatId) return false;
    const cutoffs = getChatCutoffs();
    const n = Number(value);
    if (value === null || value === undefined || value === '' || !Number.isFinite(n)) {
        delete cutoffs[chatId];
    } else {
        cutoffs[chatId] = n;
    }
    saveSettingsDebounced();
    return true;
}

/** 当前聊天最近一次结晶覆盖到的楼层(所有条目 source.range.to 的最大值),没结晶过返回 null。
 *  浮动结晶面板的状态行 + 默认起始楼层用 */
export function getLastCrystallizedTo() {
    const chatId = getCurrentChatId();
    if (!chatId) return null;
    const entries = initStorage();
    let max = null;
    for (const scope of Object.keys(entries)) {
        for (const e of entries[scope]) {
            if (e.source?.chatId !== chatId) continue;
            const to = e.source?.range?.to;
            if (Number.isFinite(to) && (max === null || to > max)) max = to;
        }
    }
    return max;
}

/** 触发引擎一次评分所需的过滤上下文 */
export function getTriggerFilterContext() {
    return {
        currentChatId: getCurrentChatId(),
        cutoff: getChatCutoff(),
        timelines: getTimelines(),
    };
}

export function getStats() {
    const entries = initStorage();
    let total = 0, enabled = 0, memory = 0, knowledge = 0;
    for (const scope of Object.keys(entries)) {
        for (const e of entries[scope]) {
            total++;
            if (e.enabled) enabled++;
            if (e.type === 'memory') memory++;
            else if (e.type === 'knowledge') knowledge++;
        }
    }
    return { total, enabled, memory, knowledge };
}
