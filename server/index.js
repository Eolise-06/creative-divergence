import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

// Health check for Docker
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

app.post('/api/expand', async (req, res) => {
  const { word } = req.body;
  if (!word || typeof word !== 'string') {
    return res.status(400).json({ error: 'word is required' });
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey || apiKey === 'sk-your-api-key-here') {
    return res.status(500).json({ error: 'DEEPSEEK_API_KEY not configured' });
  }

  try {
    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          {
            role: 'system',
            content:
              '你是一个创意联想助手，擅长从一个词出发，沿着具体的方向（工具、场景、人物、风格、趋势等）找到生动且强相关的联想词。你的联想让人感觉"妙啊，确实是这样"，而不是"这有什么关系？"。你只返回JSON数组，不返回其他内容。',
          },
          {
            role: 'user',
            content: `用户输入了"${word}"，请围绕它联想8个词。

核心原则：每个词必须和"${word}"强相关。联想可以巧妙、有趣，但不能牵强——如果别人看到这个词，应该能立刻明白"为什么从${word}想到了它"。

联想方向建议（每个方向挑一两个即可，不用全部覆盖）：
- 工具/设备：${word}常用什么工具
- 场景/空间：${word}在什么环境下工作或出现
- 上下游：${word}的上游输入或下游产出是什么
- 风格/流派：${word}领域内有什么分支或风格
- 代表人物/品牌：行业内公认的名字
- 痛点/需求：${word}面临什么困扰或用户需要什么
- 搭配/组合：${word}常和什么一起出现
- 趋势/新事物：${word}领域最近有什么新变化

要求：
1. 每个联想词必须是和"${word}"直接相关的具体事物，不能是抽象概念
2. 优先选生动、有画面感的词，让人能"看到"它
3. 网感可以有，但不能为了网感牺牲相关性
4. 每个词包含 zh 和 en，严格按JSON数组返回，不要其他文字`,
          },
        ],
        temperature: 0.7,
        max_tokens: 800,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('DeepSeek API HTTP error:', response.status, errText);
      return res.status(502).json({ error: `DeepSeek API error: ${response.status}` });
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';

    // Extract JSON array — handle markdown wrapping
    const jsonStart = content.indexOf('[');
    const jsonEnd = content.lastIndexOf(']');
    if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
      console.error('No JSON array in response:', content);
      return res.status(502).json({ error: 'Invalid response format from API' });
    }

    const jsonStr = content.slice(jsonStart, jsonEnd + 1);
    let pairs;
    try {
      pairs = JSON.parse(jsonStr);
    } catch (parseErr) {
      console.error('JSON parse error:', parseErr.message, jsonStr);
      return res.status(502).json({ error: 'Failed to parse API response' });
    }

    if (!Array.isArray(pairs) || pairs.length === 0) {
      return res.status(502).json({ error: 'Empty result from API' });
    }

    const validPairs = pairs
      .filter((p) => p.zh && p.en)
      .slice(0, 8)
      .map((p) => ({ zh: p.zh, en: p.en }));

    res.json({ pairs: validPairs });
  } catch (err) {
    console.error('Unexpected error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Serve built frontend in production
const distPath = path.resolve(__dirname, '..', 'dist');
app.use(express.static(distPath));
app.get('*', (_req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
