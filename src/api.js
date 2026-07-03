// src/api.js — 独立 API 调用模块
// 兼容 OpenAI Chat Completions 格式（DeepSeek / Claude / OpenAI 通用）

const DEFAULT_TIMEOUT = 120000; // 2分钟，结晶任务较重
const LOG = '[InkMemo]';

/**
 * 调用 Chat Completions API
 * @param {Object} config - { endpoint, apiKey, model }
 * @param {Array} messages - [{ role, content }]
 * @param {Object} [options] - { temperature, maxTokens, timeout }
 * @returns {Promise<string>} AI 返回的文本内容
 */
export async function callChatAPI(config, messages, options = {}) {
    const { endpoint, apiKey, model } = config;

    if (!endpoint || !apiKey || !model) {
        throw new APIError('请先在 API 设置中填写 Endpoint、Key 和模型名称', 'CONFIG_MISSING');
    }

    const url = normalizeEndpoint(endpoint);
    const timeout = options.timeout || DEFAULT_TIMEOUT;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        console.log(`${LOG} API 请求 → ${url} (model: ${model})`);

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model,
                messages,
                temperature: options.temperature ?? 0.7,
                max_tokens: options.maxTokens ?? 8192,
            }),
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

        const data = await response.json();
        const content = data?.choices?.[0]?.message?.content;

        if (!content) {
            throw new APIError(
                'API 返回格式异常：未找到 choices[0].message.content',
                'PARSE_ERROR'
            );
        }

        console.log(`${LOG} API 返回成功，长度: ${content.length}`);
        return content;

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
 * 解析 AI 返回的 JSON（处理 markdown 代码块包裹）
 * @param {string} raw - AI 返回的原始文本
 * @returns {Object} { memories: [...], knowledge: [...] }
 */
export function parseResultJSON(raw) {
    let cleaned = raw.trim();

    // 去掉 ```json ... ``` 或 ``` ... ```
    const fenceMatch = cleaned.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
    if (fenceMatch) {
        cleaned = fenceMatch[1].trim();
    }

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
    let cleaned = raw.trim();

    const fenceMatch = cleaned.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
    if (fenceMatch) {
        cleaned = fenceMatch[1].trim();
    }

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
