// 落墨 InkMemo — 主入口
// ST 扩展注册、面板加载、UI 交互

import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types } from '../../../../script.js';
import { loadWorldInfo, world_names } from '../../../world-info.js';
import { extractMessages, renderPreviewHTML } from './src/extractor.js';
import { callChatAPI, parseResultJSON, parseKnowledgeJSON, fetchModels, APIError } from './src/api.js';
import { buildMessages, buildKnowledgeMessages } from './src/prompt-template.js';
import { showCrystalPreview } from './src/preview.js';
import { writeConfirmedEntries, DEFAULT_MEMORY_BOOK, DEFAULT_KNOWLEDGE_BOOK } from './src/worldbook.js';
import {
    initStorage, buildEntry, saveEntry, updateEntry, toggleEntry,
    listAllByScope, getCurrentScope, getScopeLabel,
    getKnowledgeTitlesForContext, findKnowledgeByTitleInContext, findDuplicateKnowledge,
} from './src/storage.js';
import { renderEntryList, bindEntryListEvents } from './src/list-renderer.js';
import { runTriggers, evaluate, debugTriggers } from './src/trigger-engine.js';
import { mountInjector } from './src/injector.js';
import { bindTriggerSettings, renderTriggerLog } from './src/trigger-ui.js';
import { mountFloatingPanel, openFloatPanel, refreshFloatPanel } from './src/floating-panel.js';
import { checkSyncDiff, renderSyncHint } from './src/sync-check.js';
import { startTour, maybeStartTour } from './src/tour.js';

const EXT_NAME = 'luomo';
const LOG_PREFIX = '[InkMemo]';
// 知识提取用比回忆录更低的固定温度:抽取判断类任务,低温更确定、多次产出更一致、更贴 kb 门槛;
// 回忆录仍走用户配置的 temperature(创作需要发挥空间)。实验性稳定性调整,待观察是否回退。
const KNOWLEDGE_TEMPERATURE = 0.5;

// 默认设置
const DEFAULT_SETTINGS = {
    api_endpoint: '',
    api_key: '',
    api_model: 'deepseek-chat',
    api_temperature: 0.7,
    api_max_tokens: 8192,
    wb_memory_book: '',
    wb_knowledge_book: '',
    clean_tags: 'thinking',
    filter_protagonist: true,      // 触发词主角名过滤总开关，默认开
    protagonist_names: '',         // 手填主角名单，一行一个，选填（群聊补男女主名）
};

// 暂存提取结果，供后续 Phase 3 使用
let lastExtraction = null;
let lastCrystallization = null; // 暂存结晶结果，供 Phase 4 使用

// ==================== 设置 ====================

function loadSettings() {
    extension_settings[EXT_NAME] = extension_settings[EXT_NAME] || {};
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (extension_settings[EXT_NAME][key] === undefined) {
            extension_settings[EXT_NAME][key] = value;
        }
    }
    // per-chat 世界书绑定表: { [scope]: { memoryBook, knowledgeBook } }
    if (!extension_settings[EXT_NAME].wb_bindings) {
        extension_settings[EXT_NAME].wb_bindings = {};
    }
}

/**
 * 解析当前聊天的写入目标。
 * 已绑定 → 用绑定的书名；未绑定 → 用全局默认值预填，bound=false，
 * 由预览弹窗负责让用户确认并落绑定，绝不静默写入。
 */
function resolveWriteTarget() {
    const s = extension_settings[EXT_NAME] || {};
    const scope = getCurrentScope();
    const bound = (s.wb_bindings || {})[scope] || null;
    return {
        scope,
        scopeLabel: getScopeLabel(scope),
        bound: !!bound,
        memoryBook: bound?.memoryBook || s.wb_memory_book || DEFAULT_MEMORY_BOOK,
        knowledgeBook: bound?.knowledgeBook || s.wb_knowledge_book || DEFAULT_KNOWLEDGE_BOOK,
    };
}

function populateUI() {
    const s = extension_settings[EXT_NAME];
    $('#mc-api-endpoint').val(s.api_endpoint);
    $('#mc-api-key').val(s.api_key);
    $('#mc-api-model').val(s.api_model);
    $('#mc-api-temperature').val(s.api_temperature);
    $('#mc-api-max-tokens').val(s.api_max_tokens);
    $('#mc-wb-memory-book').val(s.wb_memory_book || '');
    $('#mc-wb-knowledge-book').val(s.wb_knowledge_book || '');
    $('#mc-clean-tags').val(s.clean_tags);
    $('#mc-filter-protagonist').prop('checked', s.filter_protagonist !== false);
    $('#mc-protagonist-names').val(s.protagonist_names || '');
}

function bindSettingsEvents() {
    $('#mc-api-endpoint').on('input', function () {
        extension_settings[EXT_NAME].api_endpoint = $(this).val().trim();
        saveSettingsDebounced();
    });
    $('#mc-api-key').on('input', function () {
        extension_settings[EXT_NAME].api_key = $(this).val().trim();
        saveSettingsDebounced();
    });
    $('#mc-api-model').on('input', function () {
        extension_settings[EXT_NAME].api_model = $(this).val().trim();
        saveSettingsDebounced();
    });
    $('#mc-api-temperature').on('change', function () {
        extension_settings[EXT_NAME].api_temperature = parseFloat($(this).val()) || 0.7;
        saveSettingsDebounced();
    });
    $('#mc-api-max-tokens').on('change', function () {
        extension_settings[EXT_NAME].api_max_tokens = parseInt($(this).val(), 10) || 8192;
        saveSettingsDebounced();
    });
    $('#mc-wb-memory-book').on('change', function () {
        extension_settings[EXT_NAME].wb_memory_book = $(this).val().trim();
        saveSettingsDebounced();
    });
    $('#mc-wb-knowledge-book').on('change', function () {
        extension_settings[EXT_NAME].wb_knowledge_book = $(this).val().trim();
        saveSettingsDebounced();
    });
    $('#mc-clean-tags').on('change', function () {
        extension_settings[EXT_NAME].clean_tags = $(this).val();
        saveSettingsDebounced();
    });
    $('#mc-filter-protagonist').on('change', function () {
        extension_settings[EXT_NAME].filter_protagonist = $(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#mc-protagonist-names').on('change', function () {
        extension_settings[EXT_NAME].protagonist_names = $(this).val();
        saveSettingsDebounced();
    });
    $('#mc-fetch-models').on('click', async function () {
        const $btn = $(this);
        const s = extension_settings[EXT_NAME];
        const original = $btn.text();
        $btn.prop('disabled', true).text('拉取中…');
        try {
            const ids = await fetchModels({ endpoint: s.api_endpoint, apiKey: s.api_key });
            const $list = $('#mc-model-list').empty();
            for (const id of ids) {
                $list.append($('<option>').attr('value', id));
            }
            toastr.success(`拉取到 ${ids.length} 个模型，点 Model 输入框下拉选择`, '落墨');
        } catch (err) {
            toastr.warning(err.message, '落墨');
        } finally {
            $btn.prop('disabled', false).text(original);
        }
    });
}

// ==================== 手风琴 ====================

function bindAccordion() {
    $(document).on('click', '.mc-section-header:not(.mc-disabled)', function () {
        const $header = $(this);
        const sectionId = $header.data('mc-section');
        const $body = $(`#mc-section-${sectionId}`);
        const isOpen = $body.hasClass('mc-open');

        if (isOpen) {
            $body.removeClass('mc-open');
            $header.attr('aria-expanded', 'false');
            $header.find('.mc-chevron').removeClass('mc-chevron-open');
        } else {
            $body.addClass('mc-open');
            $header.attr('aria-expanded', 'true');
            $header.find('.mc-chevron').addClass('mc-chevron-open');
        }
    });
}

// ==================== 涟漪 ====================

function addRipple(element, event) {
    const ripple = document.createElement('span');
    ripple.classList.add('mc-ripple');
    const rect = element.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 2;
    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = (event.clientX - rect.left - size / 2) + 'px';
    ripple.style.top = (event.clientY - rect.top - size / 2) + 'px';
    element.appendChild(ripple);
    ripple.addEventListener('animationend', () => ripple.remove());
}

function bindRipple() {
    // Phase 10.3: 涟漪全量上线——所有可点击的头部/切换行都给墨滴反馈
    $(document).on('click', '.mc-btn, .mc-section-header:not(.mc-disabled), .mc-scope-header, .mc-timeline-header, .mcp-content-toggle', function (e) {
        addRipple(this, e);
    });
}

// ==================== 结晶主流程 ====================

/**
 * 收集主角名单：自动(persona name1 + 角色卡 name2)并集手填名单。
 * 只留长度 ≥2 的名字——单字名做包含匹配误杀率太高，直接不启用。
 */
function getProtagonistNames() {
    const s = extension_settings[EXT_NAME];
    const ctx = getContext();
    const manual = String(s.protagonist_names || '').split('\n').map(t => t.trim());
    const auto = [ctx?.name1, ctx?.name2];
    return [...new Set([...auto, ...manual])].filter(n => n && n.length >= 2);
}

/**
 * 提示词示范例文里的人物名(prompt-template.js 大示例)。弱模型会无视"示例严禁出现在产出里"
 * 把示例人物当正文抄进来(实测有用户结晶出"苏眠眠"条目)。关键词档含名即删(与主角名同待遇);
 * 标题/正文/主体沾名 → 整条标 _exampleLeak,预览亮旗交人裁决,不自动扔。
 * 只收足够特异的全名;示例里的"煤球/汤圆"等常用词不进名单,避免误杀真实剧情。
 */
const EXAMPLE_NAMES = ['苏眠眠', '陆屿', '温若彤', '郑晓东', '郑念念', '赵一鸣'];

/** 从关键词数组里剔除包含任一主角名的词（包含即删）。返回 [过滤后数组, 被剔词数组]。 */
function stripNames(arr, names) {
    if (!Array.isArray(arr)) return [arr, []];
    const removed = [];
    const kept = arr.filter(kw => {
        const hit = names.some(n => String(kw).includes(n));
        if (hit) removed.push(kw);
        return !hit;
    });
    return [kept, removed];
}

/**
 * 结晶产出的触发关键词做主角名后置过滤（prompt 管九成，代码兜一成）。
 * 回忆录洗 core/common/assist；知识库洗 concept/scene（兼容旧扁平数组），绝不碰 subject。
 * 原地改 parsed，并 console 汇总剔了哪些词。
 */
function filterProtagonistNames(parsed) {
    // 关键词过滤名单 = 真实主角名 + 提示词示例人物名(后者是模型抄示例漏出来的,永远不该成为触发词)
    const names = [...getProtagonistNames(), ...EXAMPLE_NAMES];
    if (!names.length) return;
    const removedAll = [];
    for (const m of (parsed.memories || [])) {
        const kw = m.keywords;
        if (!kw || Array.isArray(kw)) continue; // 回忆录 keywords 恒为 {core,common,assist} 对象
        for (const layer of ['core', 'common', 'assist']) {
            const [kept, removed] = stripNames(kw[layer], names);
            if (removed.length) { kw[layer] = kept; removedAll.push(...removed); }
        }
    }
    for (const k of (parsed.knowledge || [])) {
        const kw = k.keywords;
        if (Array.isArray(kw)) { // 旧扁平数组形状：整个数组过滤
            const [kept, removed] = stripNames(kw, names);
            if (removed.length) { k.keywords = kept; removedAll.push(...removed); }
        } else if (kw) {
            for (const layer of ['concept', 'scene']) { // 不动 subject
                const [kept, removed] = stripNames(kw[layer], names);
                if (removed.length) { kw[layer] = kept; removedAll.push(...removed); }
            }
        }
    }
    if (removedAll.length) {
        console.log(`${LOG_PREFIX} 主角名过滤: 剔除 ${removedAll.length} 个关键词 [${removedAll.join(', ')}] (名单: ${names.join(', ')})`);
    }

    // 正文层示例泄漏检测:标题/正文/场景/主体出现示例人物名 → 整条打标,预览亮旗(不自动删,交人裁决)
    const leakOf = (...fields) => {
        const text = fields.map(f => String(f || '')).join('\n');
        return EXAMPLE_NAMES.find(n => text.includes(n)) || '';
    };
    for (const m of (parsed.memories || [])) {
        const hit = leakOf(m.title, m.content, m.metadata?.scene);
        if (hit) { m._exampleLeak = hit; console.warn(`${LOG_PREFIX} 疑似抄提示词示例:回忆「${m.title}」含「${hit}」`); }
    }
    for (const k of (parsed.knowledge || [])) {
        const hit = leakOf(k.title, k.content, k.subject);
        if (hit) { k._exampleLeak = hit; console.warn(`${LOG_PREFIX} 疑似抄提示词示例:知识「${k.title}」含「${hit}」`); }
    }
}

async function startCrystallization(mode = 'immersive') {
    if (!lastExtraction || !lastExtraction.formatted) {
        toastr.warning('请先预览提取内容', '落墨');
        return;
    }

    const s = extension_settings[EXT_NAME];
    const config = {
        endpoint: s.api_endpoint,
        apiKey: s.api_key,
        model: s.api_model,
    };
    const temperature = parseFloat(s.api_temperature) || 0.7;
    const maxTokens = parseInt(s.api_max_tokens, 10) || 8192;

    // Phase 1:回忆结晶与知识提取拆成两次独立请求,并行发出(总等待≈单次)。
    // 输入同为 lastExtraction.formatted(原始楼层);知识调用不依赖回忆产出。
    const memoirMessages = buildMessages(lastExtraction.formatted, mode);
    const knowledgeMessages = buildKnowledgeMessages(lastExtraction.formatted, getKnowledgeTitlesForContext()); // Phase 2:灌当前上下文已收录知识标题(空则填"(暂无)")
    console.log(`${LOG_PREFIX} 结晶模式: ${mode}(回忆+知识并行)`);

    setCrystallizeLoading(true, mode);

    try {
        // 回忆:失败即整轮失败(走外层 catch)。知识:独立 try/catch,失败降级为 knowledge:[] + 警告,不连累回忆。
        const memoirPromise = callChatAPI(config, memoirMessages, { temperature, maxTokens });
        const knowledgePromise = callChatAPI(config, knowledgeMessages, { temperature: KNOWLEDGE_TEMPERATURE, maxTokens })
            .then(raw => ({ knowledge: parseKnowledgeJSON(raw).knowledge, raw }))
            .catch(err => {
                console.error(`${LOG_PREFIX} 知识提取失败(不影响回忆结晶):`, err);
                if (typeof toastr !== 'undefined') {
                    toastr.warning(`知识提取失败,本轮只出回忆录(${err.message || err})`, 'InkMemo');
                }
                return { knowledge: [], raw: '' };
            });

        const [memoirRaw, knowledgeOutcome] = await Promise.all([memoirPromise, knowledgePromise]);
        const memoirParsed = parseResultJSON(memoirRaw);
        const parsed = {
            memories: memoirParsed.memories || [],
            knowledge: knowledgeOutcome.knowledge || [],
        };

        lastCrystallization = {
            raw: memoirRaw,
            knowledgeRaw: knowledgeOutcome.raw,
            parsed,
            sourceRange: {
                from: parseInt($('#mc-floor-from').val()),
                to: parseInt($('#mc-floor-to').val()),
            },
            timestamp: new Date().toISOString(),
        };

        const memCount = lastCrystallization.parsed.memories?.length || 0;
        const kbCount = lastCrystallization.parsed.knowledge?.length || 0;
        toastr.success(`结晶完成！回忆录 ${memCount} 条${kbCount > 0 ? `，知识库 ${kbCount} 条` : ''}，请预览确认`, 'InkMemo', { timeOut: 3000 });
        console.log(`${LOG_PREFIX} 结晶结果:`, parsed);

        // 主角名后置过滤（预览前，用户看到的即最终关键词）；关掉总开关则跳过，行为回到现状。
        if (s.filter_protagonist !== false) {
            filterProtagonistNames(parsed);
        }

        // Phase 2:预览前的两项标注——
        //  (a) update:AI 判本条更新了旧条目 → 把旧条目 content 附上供预览对比裁决
        //      (旧条目只在落墨自有存储里,预览层看不到内容;AI 可能误判两条并列为更新,故要人能对比后否决)。
        //  (b) 疑似重复:与当前上下文已有知识关键词 ≥0.5 重合 → 标出人裁决,不自动扔。
        //      带 update 且指向同一旧条目的,"更新"块已表达此关系,不再叠"疑似重复"。
        for (const k of parsed.knowledge) {
            const upd = String(k.update || '').trim();
            if (upd) {
                const old = findKnowledgeByTitleInContext(upd);
                if (old) {
                    k._updateOld = { title: old.title, content: old.content || '' };
                } else {
                    k._updateMissing = true;  // AI 指向的旧条目落墨里没有 → 写入时会当普通新条目
                }
            }
            const dup = findDuplicateKnowledge(k);
            if (dup && dup.title !== upd) {
                k._dupOf = dup.title;
                console.log(`${LOG_PREFIX} 知识疑似重复:「${k.title}」与已有「${dup.title}」重合 ${(dup.ratio * 100).toFixed(0)}%`);
            }
        }

        showCrystalPreview(lastCrystallization.parsed, {
            target: resolveWriteTarget(),
            onConfirm: async (editedData, confirmedTarget) => {
                lastCrystallization.parsed = editedData;
                lastCrystallization.confirmed = true;
                console.log(`${LOG_PREFIX} 预览确认，开始写入世界书`);

                // === Phase 6: 先写自有存储 ===
                try {
                    const scope = getCurrentScope();
                    const sourceRange = lastCrystallization?.sourceRange || null;
                    for (const m of (editedData?.memories || [])) {
                        saveEntry(buildEntry({ type: 'memory', raw: m, scope, sourceRange }));
                    }
                    for (const k of (editedData?.knowledge || [])) {
                        // Phase 2:带 update 的条目 → 旧条目软失效(enabled=false,不删);找不到旧条目就当普通新条目
                        if (k.update) {
                            const old = findKnowledgeByTitleInContext(k.update);
                            if (old) {
                                toggleEntry(old.id, false);
                                console.log(`${LOG_PREFIX} 知识更新:旧条目「${old.title}」已软失效(被「${k.title}」取代)`);
                            } else {
                                console.log(`${LOG_PREFIX} 知识 update 指向「${k.update}」未找到,按普通新条目处理`);
                            }
                        }
                        saveEntry(buildEntry({ type: 'knowledge', raw: k, scope, sourceRange }));
                    }
                    console.log(`${LOG_PREFIX} 已写入自有存储`);
                } catch (err) {
                    console.error(`${LOG_PREFIX} 写入自有存储失败:`, err);
                    if (typeof toastr !== 'undefined') toastr.warning('自有存储写入失败,详见控制台。世界书写入会继续。');
                }

                // 写入目标以预览弹窗确认的为准；同时记住为本聊天的绑定
                const target = confirmedTarget || resolveWriteTarget();
                try {
                    const s2 = extension_settings[EXT_NAME];
                    s2.wb_bindings = s2.wb_bindings || {};
                    s2.wb_bindings[target.scope] = {
                        memoryBook: target.memoryBook,
                        knowledgeBook: target.knowledgeBook,
                    };
                    saveSettingsDebounced();
                    console.log(`${LOG_PREFIX} 已绑定 ${target.scope} → 回忆录「${target.memoryBook}」/ 知识库「${target.knowledgeBook}」`);
                } catch (err) {
                    console.error(`${LOG_PREFIX} 保存聊天绑定失败:`, err);
                }

                try {
                    const result = await writeConfirmedEntries(editedData, {
                        memoryBook: target.memoryBook,
                        knowledgeBook: target.knowledgeBook,
                    });
                    if (result.errors.length > 0) {
                        toastr.warning(`写入完成，但有 ${result.errors.length} 个错误，详见控制台`, '落墨');
                    } else {
                        const parts = [];
                        if (result.memoriesWritten > 0) parts.push(`${result.memoriesWritten} 条回忆录 →「${target.memoryBook}」`);
                        if (result.knowledgeWritten > 0) parts.push(`${result.knowledgeWritten} 条知识库 →「${target.knowledgeBook}」`);
                        if (parts.length > 0) {
                            toastr.success(`已写入 ${parts.join('，')}`, '落墨 ✦');
                        } else {
                            toastr.info('没有可写入的条目', '落墨');
                        }
                    }
                } catch (e) {
                    console.error(`${LOG_PREFIX} 世界书写入异常:`, e);
                    toastr.error(`写入失败: ${e.message}`, '落墨');
                }

                renderEntryList();

                // 通知浮动面板等监听方:本轮结晶已落库,可以把楼层滚到下一段
                document.dispatchEvent(new CustomEvent('luomo:crystal-written', {
                    detail: { sourceRange: lastCrystallization?.sourceRange || null },
                }));
            },
            onCancel: () => {
                console.log(`${LOG_PREFIX} 用户取消预览`);
                toastr.info('已取消', 'InkMemo', { timeOut: 2000 });
            },
        });

    } catch (err) {
        console.error(`${LOG_PREFIX} 结晶失败:`, err);
        handleCrystallError(err);
    } finally {
        setCrystallizeLoading(false);
    }
}

function setCrystallizeLoading(loading, mode) {
    const allBtns = [
        $('#mc-btn-preview-confirm-immersive'),
        $('#mc-btn-preview-confirm-concise'),
        $('#mc-btn-inline-confirm-immersive'),
        $('#mc-btn-inline-confirm-concise'),
        $('#mc-fp-immersive'),
        $('#mc-fp-concise'),
    ];
    const shimmer = $('#mc-shimmer-bar, #mc-fp-shimmer');

    if (loading) {
        allBtns.forEach(b => b.prop('disabled', true));
        // 只改正在跑的那个模式的两个按钮文案
        if (mode === 'concise') {
            $('#mc-btn-preview-confirm-concise').text('✦ 结晶中…');
            $('#mc-btn-inline-confirm-concise').text('✦ 结晶中…');
            $('#mc-fp-concise').text('✦ 结晶中…');
        } else {
            $('#mc-btn-preview-confirm-immersive').text('✦ 结晶中…');
            $('#mc-btn-inline-confirm-immersive').text('✦ 结晶中…');
            $('#mc-fp-immersive').text('✦ 结晶中…');
        }
        shimmer.addClass('mc-shimmer').show();
    } else {
        allBtns.forEach(b => b.prop('disabled', false));
        $('#mc-btn-preview-confirm-immersive').text('✦ 沉浸式结晶');
        $('#mc-btn-preview-confirm-concise').text('✦ 简洁式结晶');
        $('#mc-btn-inline-confirm-immersive').text('✦ 沉浸式结晶');
        $('#mc-btn-inline-confirm-concise').text('✦ 简洁式结晶');
        $('#mc-fp-immersive').text('✦ 沉浸式');
        $('#mc-fp-concise').text('✦ 简洁式');
        shimmer.removeClass('mc-shimmer').hide();
    }
}

function handleCrystallError(err) {
    if (!(err instanceof APIError)) {
        toastr.error(`未知错误: ${err.message}`, '落墨');
        return;
    }
    switch (err.code) {
        case 'CONFIG_MISSING':
            toastr.error(err.message, '落墨');
            const apiHeader = $('[data-mc-section="api"].mc-section-header, .mc-section-header[data-mc-section="api"]');
            const apiBody = $('#mc-section-api');
            if (!apiBody.hasClass('mc-open')) {
                apiBody.addClass('mc-open');
                apiHeader.attr('aria-expanded', 'true');
                apiHeader.find('.mc-chevron').addClass('mc-chevron-open');
            }
            break;
        case 'TIMEOUT':
            toastr.error('请求超时，请检查网络或换个模型', '落墨');
            break;
        case 'HTTP_ERROR':
            if (err.status === 401) toastr.error('API Key 无效', '落墨');
            else if (err.status === 429) toastr.error('请求过于频繁，稍后再试', '落墨');
            else toastr.error(`API 错误 ${err.status}`, '落墨');
            break;
        case 'JSON_PARSE_ERROR':
            toastr.error('AI 返回格式异常，请重试', '落墨');
            break;
        default:
            toastr.error(err.message, '落墨');
    }
}

// ==================== 预览（桌面 Modal + 手机内联） ====================

/**
 * 判断是否为移动端
 */
function isMobile() {
    return window.innerWidth <= 600;
}

/**
 * 桌面端：创建 Modal 弹窗，追加到 body
 */
function ensureDesktopModal() {
    if (document.getElementById('mc-preview-overlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'mc-preview-overlay';
    overlay.className = 'mc-modal-overlay';
    overlay.style.display = 'none';
    overlay.innerHTML = `
        <div class="mc-modal">
            <div class="mc-modal-header">
                <span class="mc-modal-title">提取预览</span>
                <span class="mc-modal-count" id="mc-preview-count"></span>
            </div>
            <div class="mc-preview-list" id="mc-preview-list"></div>
            <div class="mc-modal-footer">
                <button class="mc-btn mc-btn-outline" id="mc-btn-preview-close">关闭</button>
                <button class="mc-btn mc-btn-primary" id="mc-btn-preview-confirm-immersive">
                    ✦ 沉浸式结晶
                </button>
                <button class="mc-btn mc-btn-primary" id="mc-btn-preview-confirm-concise"
                        title="概括风格,保真度低;想让 AI 忠实记住细节,优先用沉浸式">
                    ✦ 简洁式结晶
                </button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
}

/**
 * 绑定所有预览相关事件
 */
function bindPreview() {
    ensureDesktopModal();

    // 面板"预览提取内容"按钮
    $(document).on('click', '#mc-btn-preview', function () {
        showPreview();
    });

    // 桌面 Modal：关闭
    $(document).on('click', '#mc-btn-preview-close', function () {
        $('#mc-preview-overlay').fadeOut(200);
    });
    $(document).on('click', '#mc-preview-overlay', function (e) {
        if (e.target === this) $('#mc-preview-overlay').fadeOut(200);
    });

    // 桌面 Modal：沉浸式 / 简洁式
    $(document).on('click', '#mc-btn-preview-confirm-immersive', function () {
        startCrystallization('immersive');
    });
    $(document).on('click', '#mc-btn-preview-confirm-concise', function () {
        startCrystallization('concise');
    });

    // 手机内联：收起
    $(document).on('click', '#mc-btn-inline-close', function () {
        $('#mc-inline-preview').slideUp(200);
    });

    // 手机内联：沉浸式 / 简洁式
    $(document).on('click', '#mc-btn-inline-confirm-immersive', function () {
        startCrystallization('immersive');
    });
    $(document).on('click', '#mc-btn-inline-confirm-concise', function () {
        startCrystallization('concise');
    });
}

/**
 * 展示预览
 */
function showPreview() {
    const from = parseInt($('#mc-floor-from').val());
    const to = parseInt($('#mc-floor-to').val());

    try {
        const result = extractMessages(from, to, extension_settings[EXT_NAME].clean_tags);
        lastExtraction = result;

        if (isMobile()) {
            // 手机端：内联预览
            $('#mc-inline-preview-list').html(renderPreviewHTML(result.messages));
            $('#mc-inline-preview-count').text(`共 ${result.count} 条消息`);
            $('#mc-inline-preview').slideDown(200);
            setTimeout(() => {
                const el = document.getElementById('mc-inline-preview');
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 250);
        } else {
            // 桌面端：Modal 弹窗
            $('#mc-preview-list').html(renderPreviewHTML(result.messages));
            $('#mc-preview-count').text(`共 ${result.count} 条消息`);
            $('#mc-preview-overlay').fadeIn(200);
        }

        console.log(`${LOG_PREFIX} 预览: #${from} ~ #${to}，${result.count} 条`);
    } catch (err) {
        toastr.warning(err.message, '落墨');
    }
}

// ==================== 主按钮 ====================

function bindCrystallize() {
    $(document).on('click', '#mc-btn-crystallize', function () {
        showPreview();
    });
}

// ==================== Phase 6: 自有存储与世界书同步 ====================

// Phase 10.2: 建议同步启发式——对比自有存储 vs 世界书,差异时给红点
async function refreshSyncHint() {
    try {
        const result = await checkSyncDiff(resolveWriteTarget());
        renderSyncHint(result);
    } catch (err) {
        console.warn(`${LOG_PREFIX} 同步检查失败(不影响使用):`, err);
    }
}

async function syncFromWorldbook() {
    // 同步源跟随当前聊天的绑定（未绑定时回退全局默认）
    const target = resolveWriteTarget();
    const memBookName = target.memoryBook;
    const knBookName = target.knowledgeBook;

    const $syncBtn = $('#mc-sync-from-wb');
    $syncBtn.prop('disabled', true).text('同步中…');

    let updated = 0;
    let unmatched = 0;
    const allLocal = listAllByScope().flatMap(g => g.entries);

    for (const bookName of [memBookName, knBookName]) {
        if (!world_names.includes(bookName)) {
            console.log(`${LOG_PREFIX} 同步跳过: 世界书「${bookName}」不存在`);
            continue;
        }
        let data;
        try {
            data = await loadWorldInfo(bookName);
        } catch (e) {
            console.warn(`${LOG_PREFIX} 读取世界书「${bookName}」失败`, e);
            continue;
        }
        if (!data?.entries) continue;

        for (const wbe of Object.values(data.entries)) {
            const local = allLocal.find(le => le.title === wbe.comment);
            if (!local) { unmatched++; continue; }

            // 剥掉 Phase 5 写入时加在 content 头部的 metadata 行
            let content = wbe.content || '';
            const metaMatch = content.match(/^\[[^\]\n]*\]\n\n/);
            if (metaMatch) content = content.slice(metaMatch[0].length);

            // 写回要按类型分流,镜像 worldbook.js 的写入映射(2026-07-02 走查抓出的翻转 bug):
            // - knowledge 写入时 key=扁平关键词、keysecondary=[],回推要进 common 层
            //   (进 core 会让「恢复推导」推出软 OR 单命中 5 分<阈值 6 的死触发)
            // - memory 写入时 keysecondary=common+assist 合并,回推 common 要减掉 assist 词防重复
            const wbKey = Array.isArray(wbe.key) ? wbe.key : [];
            const wbSecondary = Array.isArray(wbe.keysecondary) ? wbe.keysecondary : [];
            const localAssist = Array.isArray(local.keywords?.assist) ? local.keywords.assist : [];
            const newKeywords = local.type === 'knowledge'
                ? { ...local.keywords, core: [], common: [...wbKey, ...wbSecondary], assist: [] }
                : {
                    ...local.keywords,
                    core: wbKey,
                    common: wbSecondary.filter(w => !localAssist.includes(w)),
                    // assist 保留原值,世界书里没法回推
                };
            updateEntry(local.id, { content, keywords: newKeywords });
            updated++;
        }
    }

    renderEntryList();
    $syncBtn.prop('disabled', false).text('从世界书同步');
    const msg = unmatched > 0
        ? `同步完成: 更新 ${updated} 条,${unmatched} 条世界书条目无本地副本(可能是手动新建的,跳过)`
        : `同步完成: 更新 ${updated} 条`;
    if (typeof toastr !== 'undefined') toastr.info(msg);
    console.log(`${LOG_PREFIX} ${msg}`);
    // 同步完重查一遍,红点应当消失
    refreshSyncHint();
}

// ==================== 入口 ====================

jQuery(async () => {
    // 1. 加载面板 HTML（路径从模块自身 URL 推导，兼容任意安装目录名）
    const panelHtml = await $.get(new URL('settings.html', import.meta.url).pathname);
    $('#extensions_settings2').append(panelHtml);
    console.log(`${LOG_PREFIX} 面板已加载`);

    // 2. 加载设置
    loadSettings();
    populateUI();

    // 3. 绑定事件
    bindSettingsEvents();
    bindAccordion();
    bindRipple();
    bindPreview();
    bindCrystallize();

    // 4. Phase 6: 自有存储 + 条目管理面板
    initStorage();
    bindEntryListEvents();
    renderEntryList();

    // 切聊天后重渲染:scope 排序、「本聊天」时间线标记都跟着当前聊天走
    eventSource.on(event_types.CHAT_CHANGED, () => {
        renderEntryList();
        refreshFloatPanel();
        refreshSyncHint();
    });

    // Phase 10.2: 建议同步——启动时查一次;每次结晶写入后也重查
    refreshSyncHint();
    document.addEventListener('luomo:crystal-written', refreshSyncHint);

    // 浮动结晶面板:楼层值同步回设置区输入框,下游 showPreview/startCrystallization 不用改
    mountFloatingPanel({
        onPreview: (from, to) => {
            $('#mc-floor-from').val(from);
            $('#mc-floor-to').val(to);
            showPreview();
        },
        onCrystallize: async (from, to, mode) => {
            $('#mc-floor-from').val(from);
            $('#mc-floor-to').val(to);
            try {
                lastExtraction = extractMessages(from, to, extension_settings[EXT_NAME].clean_tags);
            } catch (err) {
                toastr.warning(err.message, '落墨');
                return;
            }
            await startCrystallization(mode);
        },
    });
    $(document).on('click', '#mc-btn-open-float', openFloatPanel);

    $(document).on('click', '#mc-sync-from-wb', syncFromWorldbook);
    $(document).on('click', '#mc-refresh-list', () => {
        renderEntryList();
        refreshSyncHint();
        if (typeof toastr !== 'undefined') toastr.info('已刷新');
    });

    // Phase 10.3: 手机端 sheet 拖拽指示条——点提取预览顶部的横条收起
    $(document).on('click', '#mc-inline-preview .mc-sheet-handle', function () {
        $('#mc-inline-preview').slideUp(200);
    });

    // Phase 7: 触发引擎 console 测试入口(Phase 8 接入消息流后可移除)
    window.LuomoDebug = window.LuomoDebug || {};
    window.LuomoDebug.testTriggers = debugTriggers;
    window.LuomoDebug.runTriggers = runTriggers;
    window.LuomoDebug.evaluate = evaluate;

    // Phase 8: 触发注入挂载 + 设置面板 + 触发日志
    mountInjector();
    bindTriggerSettings();
    renderTriggerLog();
    document.addEventListener('luomo:trigger-updated', renderTriggerLog);

    // 新手引导:首次打开面板时自动开始;标题区「重看引导」可随时重放
    $(document).on('click', '#mc-tour-restart', (e) => {
        e.preventDefault();
        startTour();
    });
    maybeStartTour();

    console.log(`${LOG_PREFIX} 扩展初始化完成 v1.0.0`);
});
