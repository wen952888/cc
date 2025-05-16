from PIL import Image
import os
import shutil

# +++ 调试代码开始 +++
import pathlib
print(f"脚本的当前工作目录 (os.getcwd()): {os.getcwd()}")
# SPRITESHEET_PATH_DEBUG 是脚本内定义的相对路径，用于调试
SPRITESHEET_PATH_DEBUG = "public/images/cards_spritesheet.png"
absolute_spritesheet_path = pathlib.Path(os.getcwd()) / SPRITESHEET_PATH_DEBUG
print(f"脚本将尝试访问的绝对路径 (基于 os.getcwd() 和 SPRITESHEET_PATH_DEBUG): {absolute_spritesheet_path}")
print(f"该绝对路径是否存在 (os.path.exists on absolute_spritesheet_path): {os.path.exists(absolute_spritesheet_path)}")

# 另一种构建绝对路径的方式，假设脚本在 utils 文件夹，项目根目录是 utils 的父目录
SCRIPT_FILE_PATH = pathlib.Path(__file__) # 获取脚本文件本身的路径
PROJECT_ROOT_FROM_SCRIPT = SCRIPT_FILE_PATH.parent.parent # utils -> project_root
ABSOLUTE_PATH_FROM_SCRIPT_LOC = PROJECT_ROOT_FROM_SCRIPT / SPRITESHEET_PATH_DEBUG
print(f"脚本文件路径: {SCRIPT_FILE_PATH}")
print(f"推断的项目根目录: {PROJECT_ROOT_FROM_SCRIPT}")
print(f"脚本将尝试访问的绝对路径 (基于脚本位置): {ABSOLUTE_PATH_FROM_SCRIPT_LOC}")
print(f"该绝对路径是否存在 (os.path.exists on ABSOLUTE_PATH_FROM_SCRIPT_LOC): {os.path.exists(ABSOLUTE_PATH_FROM_SCRIPT_LOC)}")

# +++ 调试代码结束 +++


# --- 请根据你的图片仔细调整以下参数 ---
# 脚本期望在项目根目录运行 (e.g., python utils/crop_cards.py)
SPRITESHEET_PATH = "public/images/cards_spritesheet.png" # 这是脚本实际使用的路径
OUTPUT_DIR_FACES = "public/images/cards/"
OUTPUT_DIR_BACKS_TEMP = "public/images/card_backs_temp/"
FINAL_CARD_BACK_PATH = "public/images/card-back.png"

# 估算的卡片内容尺寸 (不包括分隔线)
CARD_CONTENT_WIDTH = 158
CARD_CONTENT_HEIGHT = 161

# 卡片间的间距 (分隔线宽度/高度)
X_SPACING = 2
Y_SPACING = 2

# 从图像边缘到第一张卡片内容的偏移量
X_OFFSET = 1
Y_OFFSET = 1

NUM_COLS = 13
NUM_ROWS_FACES = 4

JOKERS_INFO = [
    {"name": "joker_1", "col_idx_in_sheet": 0},
    {"name": "joker_2", "col_idx_in_sheet": 1},
]
SKIP_JOKERS_FOR_BACKS = len(JOKERS_INFO)
NUM_CARD_BACKS_IN_SPRITE = 10 # 13 cols - 2 jokers - 1 grey back = 10 colored
# ------------------------------------------

RANKS_IN_IMAGE_ORDER = ["ace", "2", "3", "4", "5", "6", "7", "8", "9", "10", "jack", "queen", "king"]
SUITS_IN_IMAGE_ORDER = ["hearts", "diamonds", "spades", "clubs"]


def crop_spritesheet():
    # 使用基于脚本位置计算的绝对路径进行检查，这通常更可靠
    # 如果脚本在 utils/ 下，项目根目录是其父目录
    script_dir = pathlib.Path(__file__).resolve().parent
    project_root = script_dir.parent
    actual_spritesheet_path = project_root / SPRITESHEET_PATH # SPRITESHEET_PATH 是 "public/images/..."

    print(f"crop_spritesheet 函数内，使用的精灵图绝对路径: {actual_spritesheet_path}")

    if not os.path.exists(actual_spritesheet_path): # 关键检查
        print(f"错误：找不到精灵图文件 '{actual_spritesheet_path}'")
        print(f"请确保将精灵图命名为 'cards_spritesheet.png' 并放置在 '{project_root / 'public/images/'}' 目录下。")
        return

    try:
        img = Image.open(actual_spritesheet_path)
    except FileNotFoundError:
        print(f"错误：Pillow 无法打开文件 '{actual_spritesheet_path}'. 文件确实不存在或无法访问。")
        return
    except Exception as e:
        print(f"错误：Pillow 打开文件时发生其他错误 '{actual_spritesheet_path}': {e}")
        return

    print(f"成功打开精灵图: {actual_spritesheet_path} (尺寸: {img.width}x{img.height})")

    # 使用 pathlib 构建输出路径，确保它们是相对于项目根目录的
    output_faces_abs = project_root / OUTPUT_DIR_FACES
    output_backs_temp_abs = project_root / OUTPUT_DIR_BACKS_TEMP
    final_card_back_abs = project_root / FINAL_CARD_BACK_PATH


    os.makedirs(output_faces_abs, exist_ok=True)
    os.makedirs(output_backs_temp_abs, exist_ok=True)
    if os.path.exists(output_backs_temp_abs): # 清理旧的临时牌背
        for f in os.listdir(output_backs_temp_abs):
            os.remove(output_backs_temp_abs / f)


    print("\n--- 开始裁剪牌面 ---")
    for r_idx in range(NUM_ROWS_FACES):
        suit = SUITS_IN_IMAGE_ORDER[r_idx]
        current_y = Y_OFFSET + r_idx * (CARD_CONTENT_HEIGHT + Y_SPACING)
        for c_idx in range(NUM_COLS):
            rank = RANKS_IN_IMAGE_ORDER[c_idx]
            current_x = X_OFFSET + c_idx * (CARD_CONTENT_WIDTH + X_SPACING)
            box = (current_x, current_y, current_x + CARD_CONTENT_WIDTH, current_y + CARD_CONTENT_HEIGHT)
            card_img = img.crop(box)
            filename = f"{rank}_of_{suit}.png"
            output_path = output_faces_abs / filename # 使用Path对象拼接
            card_img.save(output_path)
            print(f"已保存: {output_path} (区域: {box})")
    print("--- 牌面裁剪完成 ---")

    print("\n--- 开始裁剪所有可选牌背到临时文件夹 ---")
    y_backs_row = Y_OFFSET + NUM_ROWS_FACES * (CARD_CONTENT_HEIGHT + Y_SPACING)

    if JOKERS_INFO:
        print("裁剪Joker牌 (保存到 public/images/)...")
        for joker_info in JOKERS_INFO:
            joker_name = joker_info["name"]
            c_idx = joker_info["col_idx_in_sheet"]
            current_x = X_OFFSET + c_idx * (CARD_CONTENT_WIDTH + X_SPACING)
            box = (current_x, y_backs_row, current_x + CARD_CONTENT_WIDTH, y_backs_row + CARD_CONTENT_HEIGHT)
            joker_img = img.crop(box)
            joker_filename = f"{joker_name}.png"
            # Joker 保存到 public/images/，而不是 cards/ 子目录
            joker_output_path = project_root / "public/images/" / joker_filename
            os.makedirs(joker_output_path.parent, exist_ok=True) # 确保 public/images 存在
            joker_img.save(joker_output_path)
            print(f"已保存Joker: {joker_output_path} (区域: {box})")

    start_col_for_colored_backs = SKIP_JOKERS_FOR_BACKS
    cropped_backs_filenames = []
    for i in range(NUM_CARD_BACKS_IN_SPRITE):
        c_idx = start_col_for_colored_backs + i
        if c_idx >= NUM_COLS:
            print(f"警告：尝试裁剪的牌背列索引 {c_idx} 超出总列数 {NUM_COLS}。")
            break
        current_x = X_OFFSET + c_idx * (CARD_CONTENT_WIDTH + X_SPACING)
        box = (current_x, y_backs_row, current_x + CARD_CONTENT_WIDTH, y_backs_row + CARD_CONTENT_HEIGHT)
        back_img = img.crop(box)
        back_filename = f"back_option_{i}.png"
        back_output_path = output_backs_temp_abs / back_filename
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
            choice_str = input(f"请输入选项编号 (1-{len(cropped_backs_filenames)}): ")
            if not choice_str: # 用户直接回车
                print("未选择，将使用第一个牌背作为默认。")
                choice = 1
            else:
                choice = int(choice_str)

            if 1 <= choice <= len(cropped_backs_filenames):
                selected_back_filename = cropped_backs_filenames[choice - 1]
                source_path = output_backs_temp_abs / selected_back_filename
                os.makedirs(final_card_back_abs.parent, exist_ok=True) # 确保 public/images 存在
                shutil.copyfile(source_path, final_card_back_abs)
                print(f"已将 '{selected_back_filename}' 复制为 '{final_card_back_abs}'")
                break
            else:
                print("无效选项，请重新输入。")
        except ValueError:
            print("请输入数字。")
        except Exception as e_input:
            print(f"处理输入时发生错误: {e_input}")
            print("将使用第一个牌背作为默认。")
            selected_back_filename = cropped_backs_filenames[0]
            source_path = output_backs_temp_abs / selected_back_filename
            os.makedirs(final_card_back_abs.parent, exist_ok=True)
            shutil.copyfile(source_path, final_card_back_abs)
            print(f"已将 '{selected_back_filename}' 复制为 '{final_card_back_abs}' (默认选择)")
            break


    print("\n--- 裁剪和牌背选择完成 ---")
    print(f"牌面已保存到: '{output_faces_abs.resolve()}'") # resolve() 获取绝对路径
    print(f"选定的牌背已保存为: '{final_card_back_abs.resolve()}'")
    print(f"你可以删除临时牌背文件夹: '{output_backs_temp_abs.resolve()}' (如果不再需要)")

if __name__ == "__main__":
    # 确保在运行主函数前，所有路径都是基于当前文件位置计算的
    # 这使得脚本无论从哪个目录运行（理论上），都能正确找到相对于项目根目录的文件
    # （前提是脚本本身在 utils/ 子目录下，且项目结构固定）
    # 但通常我们期望用户在项目根目录运行 python utils/crop_cards.py
    # 所以顶部的 os.getcwd() 调试信息对于理解用户运行时的上下文仍然很重要。
    crop_spritesheet()
