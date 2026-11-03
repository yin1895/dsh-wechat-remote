"""Crop the DSH settings screenshot down to the WeChat Remote panel and mask
anything that is not part of the plugin's own UI (workspace path, session title).

Input : the raw window capture grabbed through Computer Use.
Output: docs/panel.png, ready to embed in the README.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw

SRC = Path(sys.argv[1])
DST = Path(sys.argv[2])

# Window capture is 1296x828. Settings dialog content column starts at x=460 and
# the tab strip sits at y=181; the viewport is clipped at the dialog bottom.
CROP = (440, 172, 1040, 766)

# (left, top, right, bottom) boxes of values that expose the operator's own
# machine: the workspace path and the current session title.
MASKS = [
    (890, 570, 1012, 594),  # 工作区
    (818, 598, 1012, 622),  # 当前会话
]


def main() -> int:
    image = Image.open(SRC).convert("RGB")
    panel = image.crop(CROP)
    draw = ImageDraw.Draw(panel)
    for left, top, right, bottom in MASKS:
        box = (
            left - CROP[0],
            top - CROP[1],
            right - CROP[0],
            bottom - CROP[1],
        )
        draw.rectangle(box, fill=(28, 30, 34))

    DST.parent.mkdir(parents=True, exist_ok=True)
    panel.save(DST, format="PNG", optimize=True)
    print(f"saved {DST} {panel.size[0]}x{panel.size[1]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
