// src/api.js — 独立 API 调用模块
// 兼容 OpenAI Chat Completions 格式（DeepSeek / Claude / OpenAI 通用）

// 思考模型（deepseek-v4-pro 等）推理链耗时可达 3 分钟，120s 会把成功的请求也掐掉
const DEFAULT_TIMEOUT = 300000;
const LOG = '[InkMemo]';

/**
 * 调用 Chat Completions API
 * @param {Object} config - { endpoint, apiKey, model }
 * @param {Array} messages - [{ role, content }]
 * @param {Object} [options] - { temperature, maxTokens, timeout, thinking }
 *        thinking: 'disabled' | 'enabled' | 'auto'(不发该参数，由服务端默认决定)
 * @returns {Promise<{content: string, reasoning: string, finishReason: string, usage: Object}>}
 */
export async function callChatAPI(config, messages, options = {}) {
    const { endpoint, apiKey, model } = config;

    if (!endpoint || !apiKey || !model) {
        throw new APIError('请先在 API 设置中填写 Endpoint、Key 和模型名称', 'CONFIG_MISSING');
    }

    const url = normalizeEndpoint(endpoint);
    const timeout = options.timeout || DEFAULT_TIMEOUT;
    const thinking = options.thinking || 'auto';

    // thinking 是 DeepSeek 系扩展字段，别的服务商可能 400。
    // 先按用户选择发，遇到点名 thinking 的 400 自动脱掉重试一次（见下），保证换服务商不炸。
    const body = {
        model,
        messages,
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens ?? 8192,
    };
    if (thinking === 'disabled' || thinking === 'enabled') {
        body.thinking = { type: thinking };
    }

    let data;
    try {
        data = await postJSON(url, apiKey, body, timeout);
    } catch (err) {
        const rejectsThinking = err instanceof APIError
            && err.code === 'HTTP_ERROR'
            && err.status === 400
            && body.thinking
            && /thinking/i.test(err.message);
        if (!rejectsThinking) throw err;
        console.warn(`${LOG} 服务端不认 thinking 参数，脱掉重试一次`);
        delete body.thinking;
        data = await postJSON(url, apiKey, body, timeout);
    }

    const choice = data?.choices?.[0];
    if (!choice) {
        throw new APIError('API 返回格式异常：没有 choices', 'PARSE_ERROR');
    }
    const content = typeof choice.message?.content === 'string' ? choice.message.content : '';
    const reasoning = typeof choice.message?.reasoning_content === 'string' ? choice.message.reasoning_content : '';
    const finishReason = choice.finish_reason || '';

    console.log(`${LOG} API 返回 finish=${finishReason} 正文 ${content.length} 字` +
        (reasoning ? `，推理链 ${reasoning.length} 字` : ''));
    // 正文空/被截断都不在这里抛：交给 parseFromResult 先试着从推理链里捞，捞不到再报准话
    return { content, reasoning, finishReason, usage: data?.usage || null };
}

/**
 * 发一次请求并返回解析好的 JSON body（失败一律转成 APIError）
 */
async function postJSON(url, apiKey, body, timeout) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        console.log(`${LOG} API 请求 → ${url} (model: ${body.model}` +
            `${body.thinking ? `, thinking: ${body.thinking.type}` : ''})`);

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });

        clearTimeout(timer);

        if (!response.ok) {
            const errBody = await response.text().catch(() => '');
            throw new APIError(
                `API 返回 ${response.status}: ${errBody.slice(0, 200)}`,
                'HTTP_ERROR',
                response.status
            );
        }

        return await response.json();

    } catch (err) {
        clearTimeout(timer);
        if (err instanceof APIError) throw err;
        if (err.name === 'AbortError') {
            throw new APIError(`请求超时（${timeout / 1000}秒）`, 'TIMEOUT');
        }
        throw new APIError(`网络错误: ${err.message}`, 'NETWORK_ERROR');
    }
}

/**
 * 把 callChatAPI 的返回喂给解析器，带两层兜底：
 *  ① 正文解析失败 → 去 reasoning_content 里捞（思考模型经常把成品 JSON 先写在推理链里）
 *  ② 都捞不到且 finish_reason === 'length' → 报「被截断」而不是笼统的「格式异常」
 * @param {{content: string, reasoning: string, finishReason: string}} result
 * @param {(raw: string) => Object} parser - parseResultJSON / parseKnowledgeJSON
 */
export function parseFromResult(result, parser) {
    const { content = '', reasoning = '', finishReason = '' } = result || {};
    let firstErr = null;

    if (content.trim()) {
        try {
            return parser(content);
        } catch (err) {
            firstErr = err;
        }
    }

    if (reasoning.trim()) {
        try {
            const salvaged = parser(reasoning);
            console.warn(`${LOG} 正文${content.trim() ? '解析失败' : '为空'}，已从推理链里捞回可用 JSON`);
            return salvaged;
        } catch {
            // 推理链里也没有完整 JSON，走下面的统一报错
        }
    }

    if (finishReason === 'length') {
        throw new APIError(
            `输出被截断（finish_reason=length）：模型把 max_tokens 用完了。` +
            `思考模型的推理链也算在 max_tokens 里，把「思考模式」设为「关」或调大 Max Tokens 即可。`,
            'TRUNCATED'
        );
    }
    if (firstErr) throw firstErr;
    throw new APIError('API 返回内容为空（正文和推理链都没有东西）', 'PARSE_ERROR');
}

/**
 * 解析 AI 返回的 JSON（处理 markdown 代码块包裹）
 * @param {string} raw - AI 返回的原始文本
 * @returns {Object} { memories: [...], knowledge: [...] }
 */
export function parseResultJSON(raw) {
    const cleaned = extractJSONBlock(raw);

    try {
        const parsed = JSON.parse(cleaned);

        // 结构校验
        if (!parsed.memories || !Array.isArray(parsed.memories)) {
            throw new Error('缺少 memories 数组');
        }
        for (let i = 0; i < parsed.memories.length; i++) {
            const m = parsed.memories[i];
            if (!m.title || !m.content) {
                throw new Error(`memories[${i}] 缺少 title 或 content`);
            }
        }
        if (!parsed.knowledge) {
            parsed.knowledge = [];
        } else if (!Array.isArray(parsed.knowledge)) {
            throw new Error('knowledge 必须是数组');
        }

        console.log(`${LOG} JSON 解析成功: ${parsed.memories.length} 条回忆, ${parsed.knowledge.length} 条知识`);
        return parsed;

    } catch (err) {
        throw new APIError(
            `JSON 解析失败: ${err.message}\n原始内容前300字:\n${raw.slice(0, 300)}`,
            'JSON_PARSE_ERROR'
        );
    }
}

/**
 * 解析知识提取独立调用的 JSON（Phase 1）
 * 与 parseResultJSON 的区别：宽松分支——只要求 knowledge 是数组，不要求 memories。
 * @param {string} raw - AI 返回的原始文本
 * @returns {{ knowledge: Array }}
 */
export function parseKnowledgeJSON(raw) {
    const cleaned = extractJSONBlock(raw);

    let parsed;
    try {
        parsed = JSON.parse(cleaned);
    } catch (err) {
        throw new APIError(
            `知识 JSON 解析失败: ${err.message}\n原始内容前300字:\n${raw.slice(0, 300)}`,
            'JSON_PARSE_ERROR'
        );
    }

    if (!parsed || !Array.isArray(parsed.knowledge)) {
        throw new APIError('知识返回缺少 knowledge 数组', 'JSON_PARSE_ERROR');
    }

    console.log(`${LOG} 知识 JSON 解析成功: ${parsed.knowledge.length} 条`);
    return { knowledge: parsed.knowledge };
}

/**
 * 拉取可用模型列表（OpenAI 兼容的 GET /v1/models）
 * 复用 endpoint（把 /chat/completions 换成 /models）+ Bearer key，与结晶请求同源，CORS 一致。
 * @param {Object} config - { endpoint, apiKey }
 * @returns {Promise<string[]>} 模型 id 数组（已排序去空）
 */
export async function fetchModels(config) {
    const { endpoint, apiKey } = config;
    if (!endpoint || !apiKey) {
        throw new APIError('请先填写 API Endpoint 和 Key 再拉取模型', 'CONFIG_MISSING');
    }

    const url = normalizeEndpoint(endpoint).replace(/\/chat\/completions$/, '/models');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);

    try {
        console.log(`${LOG} 拉取模型 → ${url}`);
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${apiKey}` },
            signal: controller.signal,
        });
        clearTimeout(timer);

        if (!response.ok) {
            const errBody = await response.text().catch(() => '');
            throw new APIError(
                `拉取模型返回 ${response.status}: ${errBody.slice(0, 200)}`,
                'HTTP_ERROR',
                response.status
            );
        }

        const data = await response.json();
        // 兼容 { data: [{id}] } / 直接数组 / 元素为字符串
        const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
        const ids = list
            .map(m => (typeof m === 'string' ? m : m?.id))
            .filter(Boolean);

        if (!ids.length) {
            throw new APIError('接口未返回模型列表（data 为空或格式不符）', 'PARSE_ERROR');
        }

        ids.sort((a, b) => a.localeCompare(b));
        console.log(`${LOG} 拉取模型成功: ${ids.length} 个`);
        return ids;

    } catch (err) {
        clearTimeout(timer);
        if (err instanceof APIError) throw err;
        if (err.name === 'AbortError') {
            throw new APIError('拉取模型超时（30秒）', 'TIMEOUT');
        }
        throw new APIError(`网络错误: ${err.message}`, 'NETWORK_ERROR');
    }
}

/**
 * 从模型输出里抠出 JSON 块。
 * 旧写法是整串锚定的围栏正则（^```…```$），模型在 JSON 前后多说半句话就整条炸；
 * 思考模型尤其爱加前言。改成单遍扫描取顶层 {…} 块（识别字符串与转义，不被正文里的花括号骗）：
 *  · 有多个完整块 → 取最长的那个（推理链里常有小示例对象，成品答案总是最长的）
 *  · 一个完整的都没有 → 返回最后一个未闭合块，让 JSON.parse 报出「在哪断的」
 * @param {string} raw
 * @returns {string}
 */
function extractJSONBlock(raw) {
    const text = String(raw ?? '').trim();
    const complete = [];
    let truncated = '';
    let depth = 0, start = -1, inString = false, escaped = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === '{') {
            if (depth === 0) start = i;
            depth++;
        } else if (ch === '}' && depth > 0) {
            depth--;
            if (depth === 0 && start >= 0) {
                complete.push(text.slice(start, i + 1));
                start = -1;
            }
        }
    }
    if (depth > 0 && start >= 0) truncated = text.slice(start);

    if (complete.length) {
        return complete.reduce((a, b) => (b.length > a.length ? b : a));
    }
    return truncated || text;
}

/**
 * 规范化 endpoint：确保以 /chat/completions 结尾
 */
function normalizeEndpoint(endpoint) {
    let url = endpoint.trim().replace(/\/+$/, '');
    if (!url.endsWith('/chat/completions')) {
        url += '/chat/completions';
    }
    return url;
}

/**
 * 自定义错误类型
 */
export class APIError extends Error {
    constructor(message, code, status) {
        super(message);
        this.name = 'APIError';
        this.code = code;
        this.status = status;
    }
}
