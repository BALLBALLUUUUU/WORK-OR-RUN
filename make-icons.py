#!/usr/bin/env python3
"""生成「下班倒计时」的应用图标与菜单栏模板图标（全部为原创绘制）。

产出（默认写入 mac-app/assets/）：
  icon-1024.png                 1024x1024 应用图标
  OffWorkCountdown.icns         macOS 图标包（含 16~1024 各尺寸 @1x/@2x）
  SunClockTemplate.png          菜单栏模板图标 16x16（黑色 + alpha）
  SunClockTemplate@2x.png       菜单栏模板图标 32x32
  OvertimeTemplate.png          加班菜单栏模板图标 16x16（月牙 + 星点）
  OvertimeTemplate@2x.png       加班菜单栏模板图标 32x32

  以下为非模板彩色变体（透明背景，16x16 + 32x32@2x），用于按状态着色：
  SunClockWork.png/@2x          #F5A65B 正常工作
  SunClockLunch.png/@2x         #8FD19E 午休
  SunClockOvertime.png/@2x      #E5533D 加班计时中
  SunClockRest.png/@2x          #9AA4B2 休息日
  OvertimeCounting.png/@2x      #E5533D 加班托盘计时中
  OvertimeIdle.png/@2x          #9AA4B2 加班托盘空闲

用法：
  python3 make-icons.py [输出目录]
  python3 make-icons.py --verify [输出目录]   # 仅校验已有变体的像素颜色
"""

from __future__ import annotations

import math
import os
import random
import shutil
import subprocess
import sys
import tempfile
from collections import Counter

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

# 菜单栏彩色变体（非模板图，保留真实颜色；透明背景）。
# 状态与颜色的映射必须和 countdown.js 的 trayAccentState / 主进程保持一致。
TRAY_VARIANT_COLORS = {
    "Work": (0xF5, 0xA6, 0x5B),      # 正常工作 #F5A65B
    "Lunch": (0x8F, 0xD1, 0x9E),     # 午休 #8FD19E
    "Overtime": (0xE5, 0x53, 0x3D),  # 加班中 #E5533D
    "Rest": (0x9A, 0xA4, 0xB2),      # 休息日 #9AA4B2
}
OVERTIME_VARIANT_COLORS = {
    "Counting": (0xE5, 0x53, 0x3D),  # 加班托盘计时中 #E5533D
    "Idle": (0x9A, 0xA4, 0xB2),      # 加班托盘空闲 #9AA4B2
}
# 允许的像素颜色误差（每通道）。PNG 无损，正常应为 0；留一点余量给抗锯齿。
COLOR_TOLERANCE = 6
# 判定“笔画像素”的 alpha 阈值；抗锯齿边缘的半透明像素不参与统计。
STROKE_ALPHA_MIN = 200
# 至少要有这么多完全不透明的笔画像素，避免把空图/错误图当成通过。
MIN_STROKE_PIXELS = 8

# 画布按 2048 超采样后再缩到 1024，边缘更平滑。
SIZE = 2048
MARGIN_RATIO = 0.095
RADIUS_RATIO = 0.225

SKY_STOPS = [
    (0.00, (18, 12, 44)),
    (0.22, (34, 19, 62)),
    (0.42, (71, 30, 88)),
    (0.58, (122, 42, 92)),
    (0.70, (176, 58, 88)),
    (0.80, (232, 96, 74)),
    (0.88, (255, 146, 78)),
    (1.00, (255, 205, 130)),
]

SEA_STOPS = [
    (0.00, (92, 44, 84)),
    (0.12, (56, 30, 66)),
    (0.45, (30, 18, 48)),
    (1.00, (12, 9, 26)),
]


def vertical_gradient(width: int, height: int, stops) -> Image.Image:
    """按相对位置插值生成竖向渐变（RGB）。"""
    positions = np.array([p for p, _ in stops], dtype=np.float64)
    colors = np.array([c for _, c in stops], dtype=np.float64)
    ys = np.linspace(0.0, 1.0, height)
    rows = np.stack(
        [np.interp(ys, positions, colors[:, channel]) for channel in range(3)], axis=1
    )
    array = np.repeat(rows[:, None, :], width, axis=1).astype(np.uint8)
    return Image.fromarray(array, "RGB")


def radial_alpha(size: int, center, radius: float, max_alpha: float) -> Image.Image:
    """生成径向淡出的 alpha 遮罩。"""
    yy, xx = np.mgrid[0:size, 0:size]
    distance = np.sqrt((xx - center[0]) ** 2 + (yy - center[1]) ** 2) / radius
    alpha = np.clip(1.0 - distance, 0.0, 1.0) ** 2.2 * max_alpha
    return Image.fromarray(alpha.astype(np.uint8), "L")


def make_app_icon() -> Image.Image:
    """黄昏渐变天空 + 落日 + 海平线 + 倒影，圆角方形（macOS 风格留边）。"""
    margin = int(SIZE * MARGIN_RATIO)
    box = SIZE - margin * 2
    radius = int(box * RADIUS_RATIO)
    horizon = int(box * 0.735)
    sun_center = (box * 0.5, horizon)
    sun_radius = box * 0.132

    content = Image.new("RGBA", (box, box), (0, 0, 0, 0))

    # 1) 天空
    sky = vertical_gradient(box, horizon, SKY_STOPS).convert("RGBA")
    content.paste(sky, (0, 0))

    # 2) 太阳周围的暖色氛围光
    glow = Image.new("RGBA", (box, box), (255, 138, 66, 255))
    glow.putalpha(radial_alpha(box, sun_center, box * 0.46, 120))
    content = Image.alpha_composite(content, glow)

    # 3) 云带（横向拉长的柔和椭球）
    clouds = Image.new("RGBA", (box, box), (0, 0, 0, 0))
    draw = ImageDraw.Draw(clouds)
    cloud_specs = [
        (0.16, 0.40, 0.34, 0.030, 70),
        (0.62, 0.51, 0.42, 0.026, 58),
        (0.38, 0.60, 0.26, 0.022, 46),
    ]
    for cx, cy, half_w, half_h, alpha in cloud_specs:
        x = box * cx
        y = box * cy
        w = box * half_w
        h = box * half_h
        draw.rounded_rectangle(
            (x - w, y - h, x + w, y + h),
            radius=h,
            fill=(255, 186, 150, alpha),
        )
    clouds = clouds.filter(ImageFilter.GaussianBlur(box * 0.012))
    content = Image.alpha_composite(content, clouds)

    # 4) 太阳：实心圆 + 上暖下橙的渐变，跨在海平线上
    sun_box = (
        sun_center[0] - sun_radius,
        sun_center[1] - sun_radius,
        sun_center[0] + sun_radius,
        sun_center[1] + sun_radius,
    )
    sun_mask = Image.new("L", (box, box), 0)
    ImageDraw.Draw(sun_mask).ellipse(sun_box, fill=255)
    sun_gradient = vertical_gradient(
        box,
        box,
        [(0.0, (255, 252, 226)), (0.55, (255, 205, 124)), (1.0, (255, 132, 60))],
    ).convert("RGBA")
    content = Image.alpha_composite(
        content, Image.composite(sun_gradient, Image.new("RGBA", (box, box), (0, 0, 0, 0)), sun_mask)
    )

    # 5) 海面
    sea_height = box - horizon
    sea = vertical_gradient(box, sea_height, SEA_STOPS).convert("RGBA")
    content.paste(sea, (0, horizon))

    # 6) 海面上的落日倒影：柔和光柱 + 横向碎光
    yy, xx = np.mgrid[0:sea_height, 0:box]
    dy = yy / max(1, sea_height - 1)
    dx = (xx - sun_center[0]) / (box * 0.072)
    falloff = np.exp(-(dx**2)) * np.clip(1.0 - dy, 0.0, 1.0) ** 2.4
    glow_alpha = np.clip(falloff * 120, 0, 255).astype(np.uint8)
    reflect_glow = Image.new("RGBA", (box, sea_height), (255, 178, 112, 255))
    reflect_glow.putalpha(Image.fromarray(glow_alpha, "L"))
    content.alpha_composite(reflect_glow, (0, horizon))

    bands = Image.new("RGBA", (box, sea_height), (0, 0, 0, 0))
    rdraw = ImageDraw.Draw(bands)
    rng = random.Random(20261109)  # 固定种子，保证每次构建的图标一致
    for index in range(30):
        t = index / 29
        y = (t**1.15) * sea_height * 0.92
        band_height = sea_height * rng.uniform(0.006, 0.013)
        alpha = int((45 + 95 * (1.0 - t)) * rng.uniform(0.55, 1.0))
        base_width = (0.21 - 0.135 * t) * box
        offset = math.sin(index * 2.3) * box * 0.012
        segments = rng.randint(2, 4)
        cursor = sun_center[0] + offset - base_width / 2
        for _ in range(segments):
            seg_width = base_width * rng.uniform(0.14, 0.42)
            gap = base_width * rng.uniform(0.02, 0.12)
            rdraw.rounded_rectangle(
                (cursor, y, cursor + seg_width, y + band_height),
                radius=band_height / 2,
                fill=(255, 176, 104, alpha),
            )
            cursor += seg_width + gap

    bands = bands.filter(ImageFilter.GaussianBlur(box * 0.0018))
    content.alpha_composite(bands, (0, horizon))

    # 7) 海平线
    line = Image.new("RGBA", (box, box), (0, 0, 0, 0))
    ldraw = ImageDraw.Draw(line)
    thickness = max(2, int(box * 0.0035))
    ldraw.rectangle(
        (0, horizon - thickness // 2, box, horizon + thickness // 2),
        fill=(255, 214, 158, 165),
    )
    content = Image.alpha_composite(content, line)

    # 8) 圆角遮罩（透明留边）
    mask = Image.new("L", (box, box), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, box - 1, box - 1), radius=radius, fill=255)

    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    canvas.paste(content, (margin, margin), mask)
    return canvas.resize((SIZE // 2, SIZE // 2), Image.LANCZOS)


def rounded_line(draw: ImageDraw.ImageDraw, p1, p2, width: float, fill) -> None:
    """画带圆头的粗线（16px 坐标系）。"""
    draw.line([p1, p2], fill=fill, width=int(round(width)))
    radius = width / 2
    for x, y in (p1, p2):
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=fill)


def make_tray_icon(
    size: int = 16, scale: int = 64, color=(0, 0, 0)
) -> Image.Image:
    """菜单栏图标：地平线上的半轮落日（默认黑色 + alpha，模板图由系统反色）。

    传入 `color` 可生成非模板彩色变体；透明背景、形状完全一致。
    设计坐标固定为 16 个逻辑单位，按目标像素尺寸等比放大后缩采样。

    v1.4.0（P1）：重新调整几何位置。原实现的地平线偏下（alpha bbox 中心在
    y≈10.5/16），视觉上下沉、偏小；现在把「太阳 + 地平线」整体上移并放大，
    使 alpha bbox 中心落在画布中心（16px 时 (7.5, 7.5)）附近，同时让笔画质量
    与旁边的「月牙」图标相当，避免午休绿图标显得又小又低。
    """
    big = size * scale
    unit = big / 16.0
    fill = (int(color[0]), int(color[1]), int(color[2]), 255)

    image = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    # 正在落下的太阳：画整圆后裁掉地平线以下部分，保留大半轮。
    # 圆心上移 + 半径加大，使可见半轮更高、更醒目，整体 bbox 居中。
    horizon_y = 9.4 * unit
    cx, cy, r = 8.0 * unit, horizon_y, 5.0 * unit
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=fill)
    draw.rectangle((0, horizon_y, big, big), fill=(0, 0, 0, 0))

    # 地平线：与太阳底部留有细缝，整体 bbox 中心仍在画布中心。
    line_width = 1.5 * unit
    rounded_line(
        draw,
        (1.9 * unit, 10.9 * unit),
        (14.1 * unit, 10.9 * unit),
        line_width,
        fill,
    )

    # 缩采样用面积平均（BOX），避免 LANCZOS 在 16px 上产生振铃偏色。
    return image.resize((size, size), Image.Resampling.BOX)


def make_overtime_icon(
    size: int = 16, scale: int = 64, color=(0, 0, 0)
) -> Image.Image:
    """加班菜单栏图标：一弯月牙 + 星点（默认黑色 + alpha，系统自动反色）。

    与倒计时的「半轮落日」明显不同，让两个菜单栏项目一眼可分。
    传入 `color` 可生成非模板彩色变体；透明背景、形状完全一致。
    设计坐标固定为 16 个逻辑单位，先超采样再缩到目标尺寸。
    """
    big = size * scale
    unit = big / 16.0
    fill = (int(color[0]), int(color[1]), int(color[2]), 255)

    mask = Image.new("L", (big, big), 0)
    draw = ImageDraw.Draw(mask)

    # 外圆减去偏右上的内圆 -> 朝右上方开口的月牙
    cx, cy, radius = 8.9 * unit, 8.0 * unit, 5.85 * unit
    draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=255)
    cut_x, cut_y, cut_r = 11.9 * unit, 6.35 * unit, 4.95 * unit
    draw.ellipse(
        (cut_x - cut_r, cut_y - cut_r, cut_x + cut_r, cut_y + cut_r), fill=0
    )

    # 月牙开口处的小星点
    star_x, star_y, star_r = 13.45 * unit, 4.35 * unit, 0.62 * unit
    draw.ellipse(
        (star_x - star_r, star_y - star_r, star_x + star_r, star_y + star_r),
        fill=255,
    )

    image = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    image.paste(fill, (0, 0), mask)
    # 缩采样用面积平均（BOX），避免 LANCZOS 在 16px 上产生振铃偏色。
    return image.resize((size, size), Image.Resampling.BOX)


def write_iconset(master: Image.Image, iconset_dir: str) -> None:
    specs = [
        ("icon_16x16.png", 16),
        ("icon_16x16@2x.png", 32),
        ("icon_32x32.png", 32),
        ("icon_32x32@2x.png", 64),
        ("icon_128x128.png", 128),
        ("icon_128x128@2x.png", 256),
        ("icon_256x256.png", 256),
        ("icon_256x256@2x.png", 512),
        ("icon_512x512.png", 512),
        ("icon_512x512@2x.png", 1024),
    ]
    os.makedirs(iconset_dir, exist_ok=True)
    for name, px in specs:
        master.resize((px, px), Image.LANCZOS).save(os.path.join(iconset_dir, name), "PNG")


def _hex(rgb) -> str:
    return "#{:02X}{:02X}{:02X}".format(*rgb)


def variant_specs():
    """所有彩色菜单栏变体的 (文件名, 像素尺寸, 颜色, 图形类型)。"""
    specs = []
    for stem, color in TRAY_VARIANT_COLORS.items():
        for suffix, px in (("", 16), ("@2x", 32)):
            specs.append((f"SunClock{stem}{suffix}.png", px, color, "sun"))
    for stem, color in OVERTIME_VARIANT_COLORS.items():
        for suffix, px in (("", 16), ("@2x", 32)):
            specs.append((f"Overtime{stem}{suffix}.png", px, color, "moon"))
    return specs


def dominant_stroke_color(image: Image.Image):
    """取 alpha 足够高的笔画像素中出现次数最多的 RGB，返回 (颜色, 次数, 像素数)。"""
    array = np.asarray(image.convert("RGBA"), dtype=np.uint8)
    stroke = array[array[:, :, 3] >= STROKE_ALPHA_MIN][:, :3]
    if len(stroke) == 0:
        return None, 0, 0
    color, count = Counter(map(tuple, stroke.tolist())).most_common(1)[0]
    return color, count, len(stroke)


def verify_variant(path: str, expected, tolerance: int = COLOR_TOLERANCE) -> None:
    """校验彩色 PNG：尺寸、透明背景、主要笔画像素颜色在容差内。"""
    name = os.path.basename(path)
    if not os.path.isfile(path):
        raise AssertionError(f"缺少彩色图标：{path}")
    with Image.open(path) as source:
        image = source.convert("RGBA")
    width, height = image.size
    if width != height or width not in (16, 32):
        raise AssertionError(f"{name} 尺寸异常：{width}x{height}")
    corner = image.getpixel((0, 0))
    if corner[3] != 0:
        raise AssertionError(f"{name} 背景不是透明：corner={corner}")
    dominant, count, stroke = dominant_stroke_color(image)
    if dominant is None or count < MIN_STROKE_PIXELS:
        raise AssertionError(
            f"{name} 笔画像素不足：dominant={dominant} count={count} stroke={stroke}"
        )
    diff = max(abs(int(a) - int(b)) for a, b in zip(dominant, expected))
    if diff > tolerance:
        raise AssertionError(
            f"{name} 颜色不符：dominant={_hex(dominant)} expected={_hex(expected)} "
            f"max-diff={diff} tolerance={tolerance}"
        )
    print(
        f"verify {name:28s} {width:2d}x{height:2d} "
        f"stroke={_hex(dominant)} ({count}/{stroke} px) "
        f"expected={_hex(expected)} max-diff={diff} tolerance={tolerance} OK"
    )


def verify_all_variants(out_dir: str) -> bool:
    print("==> 校验彩色菜单栏图标像素颜色（Pillow）")
    ok = True
    for name, _px, color, _kind in variant_specs():
        try:
            verify_variant(os.path.join(out_dir, name), color)
        except AssertionError as error:
            ok = False
            print(f"verify FAIL {error}")
    return ok


# P1：alpha bbox 中心与画布中心的允许偏差（像素），以及相对「月牙」参考图标的
# 笔画质量 / 最大尺寸比例。用于防止午休绿图标又小又低。
CENTER_TOLERANCE_PX = 1.0
MASS_RATIO_RANGE = (0.6, 1.6)
EXTENT_RATIO_RANGE = (0.8, 1.35)
GLYPH_ALPHA_MIN = 8
GLYPH_MASS_ALPHA_MIN = 128


def glyph_metrics(image: Image.Image) -> dict:
    """计算 alpha 包围盒、中心、尺寸与笔画质量。"""
    array = np.asarray(image.convert("RGBA"), dtype=np.uint8)
    alpha = array[:, :, 3]
    ys, xs = np.nonzero(alpha >= GLYPH_ALPHA_MIN)
    if len(xs) == 0:
        return None
    width, height = image.size
    x0, y0, x1, y1 = int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())
    extent = (x1 - x0 + 1, y1 - y0 + 1)
    return {
        "size": (width, height),
        "bbox": (x0, y0, x1, y1),
        "center": ((x0 + x1) / 2.0, (y0 + y1) / 2.0),
        "extent": extent,
        "mass": int((alpha >= GLYPH_MASS_ALPHA_MIN).sum()),
    }


def verify_glyph_centering(out_dir: str) -> bool:
    """校验所有主状态图标（work/lunch/overtime/rest + 模板）的 bbox 居中与视觉重量。

    参考图标为同一像素尺寸的「月牙」加班图标：太阳图标应当与之质量相当。
    输出每个图标的中心偏移、笔画质量比、最大跨度比，任一超限即构建失败。
    """
    print("==> 校验菜单栏图标 alpha bbox 居中与视觉重量（P1）")
    sun_stems = [
        "SunClockTemplate",
        "SunClockWork",
        "SunClockLunch",
        "SunClockOvertime",
        "SunClockRest",
    ]
    ok = True
    for suffix, px in (("", 16), ("@2x", 32)):
        ref_name = f"OvertimeTemplate{suffix}.png"
        ref_path = os.path.join(out_dir, ref_name)
        if not os.path.isfile(ref_path):
            print(f"verify-center FAIL 缺少参考图标：{ref_path}")
            ok = False
            continue
        with Image.open(ref_path) as source:
            reference = glyph_metrics(source.convert("RGBA"))
        if reference is None:
            print(f"verify-center FAIL 参考图标为空：{ref_name}")
            ok = False
            continue
        center = ((px - 1) / 2.0, (px - 1) / 2.0)
        print(
            f"    reference {ref_name:24s} {px:2d}x{px:2d} "
            f"bbox={reference['bbox']} center=({reference['center'][0]:.2f},"
            f"{reference['center'][1]:.2f}) mass={reference['mass']} "
            f"extent={reference['extent'][0]}x{reference['extent'][1]}"
        )
        for stem in sun_stems:
            name = f"{stem}{suffix}.png"
            path = os.path.join(out_dir, name)
            if not os.path.isfile(path):
                print(f"verify-center FAIL 缺少图标：{path}")
                ok = False
                continue
            with Image.open(path) as source:
                metrics = glyph_metrics(source.convert("RGBA"))
            if metrics is None:
                print(f"verify-center FAIL 图标为空：{name}")
                ok = False
                continue
            if metrics["size"] != (px, px):
                print(
                    f"verify-center FAIL {name} 尺寸异常：{metrics['size']}"
                )
                ok = False
                continue
            offset_x = metrics["center"][0] - center[0]
            offset_y = metrics["center"][1] - center[1]
            mass_ratio = metrics["mass"] / max(1, reference["mass"])
            extent_ratio = max(metrics["extent"]) / max(1, max(reference["extent"]))
            centered = (
                abs(offset_x) <= CENTER_TOLERANCE_PX
                and abs(offset_y) <= CENTER_TOLERANCE_PX
            )
            mass_ok = MASS_RATIO_RANGE[0] <= mass_ratio <= MASS_RATIO_RANGE[1]
            extent_ok = EXTENT_RATIO_RANGE[0] <= extent_ratio <= EXTENT_RATIO_RANGE[1]
            status = "OK" if centered and mass_ok and extent_ok else "FAIL"
            print(
                f"verify-center {name:28s} {px:2d}x{px:2d} "
                f"bbox={metrics['bbox']} center=({metrics['center'][0]:.2f},"
                f"{metrics['center'][1]:.2f}) offset=({offset_x:+.2f},{offset_y:+.2f}) "
                f"mass={metrics['mass']} mass-ratio={mass_ratio:.2f} "
                f"extent={metrics['extent'][0]}x{metrics['extent'][1]} "
                f"extent-ratio={extent_ratio:.2f} {status}"
            )
            if not centered:
                print(
                    f"verify-center FAIL {name} bbox 中心偏离画布中心 "
                    f"({offset_x:+.2f}, {offset_y:+.2f}) > {CENTER_TOLERANCE_PX}px"
                )
            if not mass_ok:
                print(
                    f"verify-center FAIL {name} 笔画质量比 {mass_ratio:.2f} 不在 "
                    f"{MASS_RATIO_RANGE}"
                )
            if not extent_ok:
                print(
                    f"verify-center FAIL {name} 最大跨度比 {extent_ratio:.2f} 不在 "
                    f"{EXTENT_RATIO_RANGE}"
                )
            if not (centered and mass_ok and extent_ok):
                ok = False
    if ok:
        print(
            f"    全部通过：bbox 中心偏差 ≤ {CENTER_TOLERANCE_PX}px，"
            f"mass-ratio ∈ {MASS_RATIO_RANGE}，extent-ratio ∈ {EXTENT_RATIO_RANGE}"
        )
    return ok


def main() -> int:
    args = list(sys.argv[1:])
    verify_only = False
    if args and args[0] == "--verify":
        verify_only = True
        args = args[1:]
    out_dir = os.path.abspath(args[0] if args else "assets")
    os.makedirs(out_dir, exist_ok=True)

    if not verify_only:
        icon = make_app_icon()
        icon_png = os.path.join(out_dir, "icon-1024.png")
        icon.save(icon_png, "PNG")
        print(f"wrote {icon_png} ({icon.width}x{icon.height})")

        icns_path = os.path.join(out_dir, "OffWorkCountdown.icns")
        with tempfile.TemporaryDirectory() as tmp:
            iconset = os.path.join(tmp, "OffWorkCountdown.iconset")
            write_iconset(icon, iconset)
            subprocess.run(
                ["/usr/bin/iconutil", "--convert", "icns", "--output", icns_path, iconset],
                check=True,
            )
        print(f"wrote {icns_path}")

        for name, px in (("SunClockTemplate.png", 16), ("SunClockTemplate@2x.png", 32)):
            tray = make_tray_icon(px)
            path = os.path.join(out_dir, name)
            tray.save(path, "PNG")
            print(f"wrote {path} ({px}x{px})")

        for name, px in (("OvertimeTemplate.png", 16), ("OvertimeTemplate@2x.png", 32)):
            overtime = make_overtime_icon(px)
            path = os.path.join(out_dir, name)
            overtime.save(path, "PNG")
            print(f"wrote {path} ({px}x{px})")

        # 彩色非模板变体：与模板图同一套几何形状，只把笔画颜色换成状态色。
        for name, px, color, kind in variant_specs():
            maker = make_tray_icon if kind == "sun" else make_overtime_icon
            image = maker(px, color=color)
            path = os.path.join(out_dir, name)
            image.save(path, "PNG")
            print(f"wrote {path} ({px}x{px}, {_hex(color)}, template=false)")

    if not verify_all_variants(out_dir):
        print("彩色图标校验失败。", file=sys.stderr)
        return 1
    if not verify_glyph_centering(out_dir):
        print("图标居中/视觉重量校验失败。", file=sys.stderr)
        return 1

    if verify_only:
        return 0

    # 便于肉眼检查的放大预览（不进入 app 包）
    preview_dir = os.path.join(out_dir, "preview")
    os.makedirs(preview_dir, exist_ok=True)
    make_tray_icon(16).resize((256, 256), Image.NEAREST).save(
        os.path.join(preview_dir, "tray-preview-256.png"), "PNG"
    )
    make_overtime_icon(16).resize((256, 256), Image.NEAREST).save(
        os.path.join(preview_dir, "overtime-preview-256.png"), "PNG"
    )
    # 六种彩色状态并排预览（透明背景叠在中性底色上）
    colored = Image.new("RGBA", (6 * 72 + 24, 96), (246, 246, 246, 255))
    labels = [
        ("Work", "sun", TRAY_VARIANT_COLORS["Work"]),
        ("Lunch", "sun", TRAY_VARIANT_COLORS["Lunch"]),
        ("Overtime", "sun", TRAY_VARIANT_COLORS["Overtime"]),
        ("Rest", "sun", TRAY_VARIANT_COLORS["Rest"]),
        ("OT counting", "moon", OVERTIME_VARIANT_COLORS["Counting"]),
        ("OT idle", "moon", OVERTIME_VARIANT_COLORS["Idle"]),
    ]
    draw = ImageDraw.Draw(colored)
    for index, (_label, kind, color) in enumerate(labels):
        maker = make_tray_icon if kind == "sun" else make_overtime_icon
        glyph = maker(32, color=color).resize((64, 64), Image.NEAREST)
        x = 24 + index * 72
        colored.alpha_composite(glyph, (x, 8))
        draw.text((x, 76), f"#{color[0]:02X}{color[1]:02X}{color[2]:02X}", fill=(40, 40, 40, 255))
    colored.save(os.path.join(preview_dir, "tray-colors-preview.png"), "PNG")
    icon.resize((512, 512), Image.LANCZOS).save(
        os.path.join(preview_dir, "icon-preview-512.png"), "PNG"
    )
    # 模拟浅色/深色菜单栏上的效果
    for mode, bg, fg in (
        ("light", (246, 246, 246), (0, 0, 0)),
        ("dark", (32, 32, 34), (255, 255, 255)),
    ):
        bar = Image.new("RGBA", (320, 64), bg + (255,))
        tray = make_tray_icon(16).resize((32, 32), Image.NEAREST)
        mask = tray.split()[3]
        tinted = Image.new("RGBA", (32, 32), fg + (255,))
        bar.paste(tinted, (24, 16), mask)
        d = ImageDraw.Draw(bar)
        d.text((72, 24), "距下班 07:31:42", fill=fg + (255,))
        bar.save(os.path.join(preview_dir, f"menubar-{mode}.png"), "PNG")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
