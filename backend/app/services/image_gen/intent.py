"""自动检测用户消息中的图片生成/编辑意图。"""
from __future__ import annotations

import re

# 文生图关键词 —— 宽松匹配，覆盖常见口语说法
_TEXT_TO_IMAGE_PATTERNS: list[str] = [
    # "画" 系列：画一只猫、画个猫、帮我画、请画、画出
    r"画[一]?[只个张幅条匹头朵棵颗座栋台辆架把件套]",
    r"帮我画",
    r"请画",
    r"画[出个]",
    r"我想要.*画",
    # "生成" 系列：生成一只猫、生成一张图、生成图片
    r"生成[一]?[只个张幅条匹头朵棵颗座栋台辆架把件套]",
    r"生成.*图[片像]",
    r"生成图[片像]",
    # "做/创建/制作" 系列
    r"做[一]?[张幅个].*图",
    r"创建[一]?[张幅个]",
    r"制作[一]?[张幅个]",
    # 直接说 "文生图"
    r"文生图",
    # 英文
    r"create\s+(?:an?\s+)?image",
    r"generate\s+(?:an?\s+)?(?:image|picture|photo)",
    r"draw\s+(?:a|an|me|the)\b",
    r"paint\s+(?:a|an|me|the)\b",
    r"make\s+(?:a|an)\s+(?:image|picture|photo)",
]

# 图生图关键词（当附带图片时触发）
_IMAGE_TO_IMAGE_PATTERNS: list[str] = [
    r"图生图",
    r"编辑[这这张]*图",
    r"修改[这这张]*图",
    r"改[一]?下",
    r"把[它这].*[改变换]",
    r"将[它这].*[改变换]",
    r"风格转[换化]",
    r"改背景",
    r"换背景",
    r"换[一个]?[种个]?风格",
    r"添加",
    r"去掉",
    r"去除",
    r"替换",
    r"变[成为]",
    r"改[成为]",
    r"edit\s+(?:this\s+)?image",
    r"modify\s+(?:this\s+)?image",
    r"change\s+(?:the|this)",
]

_t2i_compiled = [re.compile(p, re.IGNORECASE) for p in _TEXT_TO_IMAGE_PATTERNS]
_i2i_compiled = [re.compile(p, re.IGNORECASE) for p in _IMAGE_TO_IMAGE_PATTERNS]


def detect_image_intent(content: str, has_image_attachment: bool) -> str | None:
    """检测消息的图片意图。

    Returns:
        ``"text_to_image"`` / ``"image_to_image"`` / ``None``
    """
    text = (content or "").strip()
    if not text:
        return None

    # 如果用户带了图片附件，优先检测图生图
    if has_image_attachment:
        for pat in _i2i_compiled:
            if pat.search(text):
                return "image_to_image"

    # 检测文生图
    for pat in _t2i_compiled:
        if pat.search(text):
            return "text_to_image"

    return None
