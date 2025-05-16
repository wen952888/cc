from PIL import Image
import os
import shutil

# --- 请根据你的图片仔细调整以下参数 ---
SPRITESHEET_PATH = "cards_spritesheet.png"  # 你保存的原始大图的路径
OUTPUT_DIR_FACES = "public/images/cards/"
OUTPUT_DIR_BACKS_TEMP = "public/images/card_backs_temp/" # 临时存放所有牌背
FINAL_CARD_BACK_PATH = "public/images/card-back.png" # 最终选定的牌背

# 估算的卡片内容尺寸 (不包括分隔线)
CARD_CONTENT_WIDTH = 158
CARD_CONTENT_HEIGHT = 161 # 估算值，原图每行约163px高，减去2px间隙

# 卡片间的间距 (分隔线宽度/高度)
X_SPACING = 2
Y_SPACING = 2

# 从图像边缘到第一张卡片内容的偏移量
X_OFFSET = 1 # 假设左边有1px的边框或起始分隔线
Y_OFFSET = 1 # 假设顶部有1px的边框或起始分隔线

NUM_COLS = 13 # A, 2, ..., K
NUM_ROWS_FACES = 4 # Hearts, Diamonds, Spades, Clubs

# Joker牌信息 (如果需要裁剪) - 当前游戏不用，但为了完整性可以添加
JOKERS_INFO = [
    {"name": "joker_1", "col_idx_in_sheet": 0}, # 第一个Joker在牌背行的第0列
    {"name": "joker_2", "col_idx_in_sheet": 1}, # 第二个Joker在牌背行的第1列
]
SKIP_JOKERS_FOR_BACKS = len(JOKERS_INFO) # 跳过Joker所占的列数来找牌背

NUM_CARD_BACKS_IN_SPRITE = 10 # 牌背行中彩色牌背的数量 (13列 - 2joker - 1灰色牌背 = 10)
# ------------------------------------------

# 牌面和花色的顺序，与图片中的顺序对应
# 牌面 (A, 2, ..., 10, J, Q, K)
RANKS_IN_IMAGE_ORDER = ["ace", "2", "3", "4", "5", "6", "7", "8", "9", "10", "jack", "queen", "king"]
# 花色 (从上到下)
SUITS_IN_IMAGE_ORDER = ["hearts", "diamonds", "spades", "clubs"]


def crop_spritesheet():
    if not os.path.exists(SPRITESHEET_PATH):
        print(f"错误：找不到精灵图文件 '{SPRITESHEET_PATH}'")
        return

    img = Image.open(SPRITESHEET_PATH)
    print(f"成功打开精灵图: {SPRITESHEET_PATH} (尺寸: {img.width}x{img.height})")

    # 创建输出目录
    os.makedirs(OUTPUT_DIR_FACES, exist_ok=True)
    os.makedirs(OUTPUT_DIR_BACKS_TEMP, exist_ok=True)
    # 清理旧的临时牌背
    for f in os.listdir(OUTPUT_DIR_BACKS_TEMP):
        os.remove(os.path.join(OUTPUT_DIR_BACKS_TEMP, f))


    # 1. 裁剪牌面
    print("\n--- 开始裁剪牌面 ---")
    for r_idx in range(NUM_ROWS_FACES): # 0: Hearts, 1: Diamonds, etc.
        suit = SUITS_IN_IMAGE_ORDER[r_idx]
        current_y = Y_OFFSET + r_idx * (CARD_CONTENT_HEIGHT + Y_SPACING)

        for c_idx in range(NUM_COLS): # 0: Ace, 1: Two, etc.
            rank = RANKS_IN_IMAGE_ORDER[c_idx]
            current_x = X_OFFSET + c_idx * (CARD_CONTENT_WIDTH + X_SPACING)

            # 定义裁剪区域 (left, top, right, bottom)
            # right = left + width, bottom = top + height
            box = (
                current_x,
                current_y,
                current_x + CARD_CONTENT_WIDTH,
                current_y + CARD_CONTENT_HEIGHT
            )

            card_img = img.crop(box)
            filename = f"{rank}_of_{suit}.png"
            output_path = os.path.join(OUTPUT_DIR_FACES, filename)
            card_img.save(output_path)
            print(f"已保存: {output_path} (区域: {box})")

    print("--- 牌面裁剪完成 ---")

    # 2. 裁剪牌背 (在牌面下方的一行)
    print("\n--- 开始裁剪所有可选牌背到临时文件夹 ---")
    y_backs_row = Y_OFFSET + NUM_ROWS_FACES * (CARD_CONTENT_HEIGHT + Y_SPACING)

    # 裁剪Joker (如果定义了) - 游戏中不用，但可以裁出来看看
    if JOKERS_INFO:
        print("裁剪Joker牌...")
        for joker_info in JOKERS_INFO:
            joker_name = joker_info["name"]
            c_idx = joker_info["col_idx_in_sheet"]
            current_x = X_OFFSET + c_idx * (CARD_CONTENT_WIDTH + X_SPACING)
            box = (
                current_x,
                y_backs_row,
                current_x + CARD_CONTENT_WIDTH,
                y_backs_row + CARD_CONTENT_HEIGHT
            )
            joker_img = img.crop(box)
            # 保存Joker到主图片目录，而不是牌背临时目录
            joker_filename = f"{joker_name}.png" # e.g., joker_1.png
            joker_output_path = os.path.join("public/images/", joker_filename) # 直接存到 public/images
            joker_img.save(joker_output_path)
            print(f"已保存Joker: {joker_output_path} (区域: {box})")


    # 裁剪彩色牌背
    # 假设彩色牌背从Joker之后开始
    start_col_for_colored_backs = SKIP_JOKERS_FOR_BACKS
    cropped_backs_filenames = []

    for i in range(NUM_CARD_BACKS_IN_SPRITE):
        # c_idx 是在整个精灵图中的列索引
        c_idx = start_col_for_colored_backs + i
        if c_idx >= NUM_COLS: # 防止超出精灵图的列数
            print(f"警告：尝试裁剪的牌背列索引 {c_idx} 超出总列数 {NUM_COLS}。停止裁剪牌背。")
            break

        current_x = X_OFFSET + c_idx * (CARD_CONTENT_WIDTH + X_SPACING)
        box = (
            current_x,
            y_backs_row,
            current_x + CARD_CONTENT_WIDTH,
            y_backs_row + CARD_CONTENT_HEIGHT
        )
        back_img = img.crop(box)
        # 使用一个通用的名字加上编号，例如 back_option_0.png, back_option_1.png
        # 牌背的颜色似乎是：红、橙、紫、蓝、青、浅绿、深绿、褐红、橄榄绿、深蓝
        # 我们可以简单地用数字编号
        back_filename = f"back_option_{i}.png"
        back_output_path = os.path.join(OUTPUT_DIR_BACKS_TEMP, back_filename)
        back_img.save(back_output_path)
        cropped_backs_filenames.append(back_filename)
        print(f"已保存可选牌背: {back_output_path} (区域: {box})")
    
    if not cropped_backs_filenames:
        print("错误：没有裁剪到任何牌背。请检查参数。")
        return

    print("\n--- 可选牌背已裁剪到临时文件夹 ---")
    print("请从以下牌背中选择一个作为游戏牌背:")
    for idx, name in enumerate(cropped_backs_filenames):
        print(f"{idx + 1}. {name}")

    while True:
        try:
            choice = int(input(f"请输入选项编号 (1-{len(cropped_backs_filenames)}): "))
            if 1 <= choice <= len(cropped_backs_filenames):
                selected_back_filename = cropped_backs_filenames[choice - 1]
                source_path = os.path.join(OUTPUT_DIR_BACKS_TEMP, selected_back_filename)
                
                # 确保目标目录存在
                os.makedirs(os.path.dirname(FINAL_CARD_BACK_PATH), exist_ok=True)
                shutil.copyfile(source_path, FINAL_CARD_BACK_PATH)
                print(f"已将 '{selected_back_filename}' 复制为 '{FINAL_CARD_BACK_PATH}'")
                break
            else:
                print("无效选项，请重新输入。")
        except ValueError:
            print("请输入数字。")

    print("\n--- 裁剪和牌背选择完成 ---")
    print(f"牌面已保存到: '{os.path.abspath(OUTPUT_DIR_FACES)}'")
    print(f"选定的牌背已保存为: '{os.path.abspath(FINAL_CARD_BACK_PATH)}'")
    print(f"你可以删除临时牌背文件夹: '{os.path.abspath(OUTPUT_DIR_BACKS_TEMP)}' (如果不再需要)")

if __name__ == "__main__":
    crop_spritesheet()
