"""
EverOS 决策规划器 — 在 LLM 思索链之前完成 recall/save 决策。

提供两个轻量级决策：
1. recall_decision: 判断用户消息是否需要检索记忆
2. save_decision:   判断对话内容是否值得保存到记忆

两个决策都在 OnLLMRequestEvent 中完成（思索链之前），
使用配置的专门 LLM 提供商（或回退到主提供商），
通过极简 system prompt 约束仅返回 JSON，超时 5 秒兜底。
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any

from astrbot.api import logger

RECALL_PLANNER_SYSTEM = """\
你是一个记忆检索决策助手。分析用户消息，判断是否需要从长期记忆中检索信息。
记忆库中可能存储了：用户个人信息、偏好、习惯、计划；之前对话的内容和决策；
AI 自身的身份设定、名字、角色；用户与 AI 的关系、约定、秘密等。

**需要检索 (recall) 的情况（宁可多检不可漏检）：**
- 用户询问任何「是什么/是谁/叫什么/什么时候/为什么/怎么样」的问题
- 用户提到人物、名字、地点、事件、偏好
- 用户说「之前/上次/还记得/我的/我们的/你之前说过」
- 用户询问 AI 关于自身的信息（名字、能力、角色、设定）
- 任何可能从过去对话中找到答案的问题
- 不确定是否需要 → 选择 recall（宁可多检）

**不需要检索 (skip) 的情况（极少）：**
- 纯粹的「你好/晚安/哈哈/嗯/哦」之类无信息量的消息
- 用户说「继续」但上文已经提供完整上下文

严格按以下 JSON 格式回复（不要包含其他内容）：
{"action": "recall", "query": "一句话概括需要检索的内容"}
或
{"action": "skip", "query": ""}"""

SAVE_PLANNER_SYSTEM = """\
你是一个记忆保存决策助手。分析用户消息，判断是否有值得保存到长期记忆的信息。

**需要保存 (save) 的情况：**
- 用户透露个人信息：姓名、偏好、习惯、计划、经历、关系、秘密
- 用户表达重要观点、决定、或要求未来记住/参考的事项
- 用户建立或修改了与 AI 的约定、规则、角色设定
- 对话中出现了对后续交流有价值的事实或上下文
- 不确定是否需要保存 → 选择 save（宁可多存）

**不需要保存 (skip) 的情况（极少）：**
- 纯粹的「你好/晚安/哈哈/嗯/哦」之类无信息量的消息
- 明显的一次性指令（如「帮我查一下天气」）

严格按以下 JSON 格式回复（不要包含其他内容）：
{"action": "save", "content": "一句话概括要保存的内容（中文第三人称，包含上下文）"}
或
{"action": "skip", "content": ""}"""

PLANNER_TIMEOUT = 5.0  # 决策超时秒数


def _parse_planner_json(text: str) -> dict[str, str]:
    """从 planner LLM 的回复中提取 JSON。容错处理。"""
    text = (text or "").strip()
    # 尝试直接解析
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # 尝试提取 JSON 块
    import re

    m = re.search(r'\{[^{}]*}', text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            pass
    return {"action": "skip", "query": ""}


class Planner:
    """轻量级决策规划器 — 在思索链之前运行。"""

    def __init__(self, plugin: Any) -> None:
        self._plugin = plugin

    # ── Recall 决策 ──────────────────────────────────────────────

    async def recall_decision(self, user_query: str) -> tuple[str, str]:
        """返回 (action, query)。action ∈ {"recall", "skip"}。

        使用配置的 recall planner provider 或回退到主 provider。
        """
        provider_id = self._plugin.config.get("recall_planner_provider", "")
        return await self._planner_call(
            provider_id, RECALL_PLANNER_SYSTEM, user_query, "recall"
        )

    # ── Save 决策 ────────────────────────────────────────────────

    async def save_decision(self, user_query: str) -> tuple[str, str]:
        """返回 (action, content)。action ∈ {"save", "skip"}。

        使用配置的 save planner provider 或回退到主 provider。
        """
        provider_id = self._plugin.config.get("save_planner_provider", "")
        return await self._planner_call(
            provider_id, SAVE_PLANNER_SYSTEM, user_query, "save"
        )

    # ── 内部 ─────────────────────────────────────────────────────

    async def _planner_call(
        self, provider_id: str, system: str, user_query: str, mode: str
    ) -> tuple[str, str]:
        """通用 planner 调用。返回 (action, content)。"""
        if not user_query.strip():
            return ("skip", "")

        try:
            result = await asyncio.wait_for(
                self._do_llm_call(provider_id, system, user_query),
                timeout=PLANNER_TIMEOUT,
            )
            parsed = _parse_planner_json(result)
            action = parsed.get("action", "skip")
            content = parsed.get("query", "") or parsed.get("content", "")
            logger.info(
                f"[EverOS] Planner({mode}): action={action}, "
                f"content={content[:60]!r}"
            )
            return (action, content)
        except asyncio.TimeoutError:
            logger.warning(f"[EverOS] Planner({mode}): 超时 ({PLANNER_TIMEOUT}s)，回退到 skip")
            return ("skip", "")
        except Exception as e:
            logger.warning(f"[EverOS] Planner({mode}): 调用失败: {e}")
            return ("skip", "")

    async def _do_llm_call(
        self, provider_id: str, system: str, user_query: str
    ) -> str:
        """执行一次轻量 LLM 调用。"""
        # 回退到主 provider
        actual_provider = provider_id or self._get_main_provider_id()

        response = await self._plugin.context.llm_generate(
            chat_provider_id=actual_provider,
            prompt=user_query,
            system_prompt=system,
        )
        return response.completion_text or ""

    def _get_main_provider_id(self) -> str:
        """获取当前会话的主 provider ID。"""
        try:
            # 尝试从插件上下文获取
            return self._plugin.context.get_using_provider().meta().id
        except (AttributeError, TypeError, ValueError):
            pass
        # 尝试从 provider_manager 获取第一个可用 provider
        try:
            providers = self._plugin.context.get_all_providers()
            if providers:
                return providers[0].meta().id
        except (AttributeError, IndexError, TypeError):
            pass
        return ""
