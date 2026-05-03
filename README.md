# B站实时字幕

一个面向 Bilibili 视频页的 Chrome 扩展，用本地 MLX ASR 服务为视频生成实时字幕。扩展负责获取音频、解码、分块和页面展示；`server_mlx.py` 负责通过 WebSocket 接收音频 PCM，并调用本地或 Hugging Face 模型完成转写。

## 功能

- 在 B 站视频页生成 AI 字幕覆盖层。
- 支持字幕列表，点击句子可跳转到对应时间。
- 字幕列表支持拖动，用户可以移动到合适位置。
- 支持两种后端模型：
  - `qwen3`：Qwen3-ASR + ForcedAligner，默认模型，按音频块处理。（推荐）
  - `vibevoice`：VibeVoice-ASR，自带句级时间戳，首次使用时懒加载。

## 环境要求

- macOS Apple Silicon。
- Python 3.10+。
- Chrome 或 Chromium 系浏览器。
- 可访问 Bilibili，并在浏览器中登录需要登录权限的视频。
- 已安装 MLX 音频相关依赖。

依赖安装示例：

```bash
pip install numpy soundfile websockets mlx-audio
```

如果你的环境使用 `uv`、`conda` 或虚拟环境，也可以在对应环境里安装这些依赖。

## 启动 ASR 服务

在项目目录运行：

```bash
python server_mlx.py
```

服务默认监听：

```text
ws://localhost:8765
```

扩展里的 offscreen 页面会连接这个地址，所以通常不需要改 host/port。

## 配置模型路径

`server_mlx.py` 支持 Hugging Face 模型 ID，也支持本地模型目录。推荐用命令行参数配置：

```bash
python server_mlx.py \
  --qwen3-asr /path/to/Qwen3-ASR-1.7B-8bit \
  --qwen3-aligner /path/to/Qwen3-ForcedAligner-0.6B-8bit \
  --vibevoice mlx-community/VibeVoice-ASR-bf16
```

也可以用环境变量：

```bash
export BILISUB_QWEN3_ASR=/path/to/Qwen3-ASR-1.7B-8bit
export BILISUB_QWEN3_ALIGNER=/path/to/Qwen3-ForcedAligner-0.6B-8bit
export BILISUB_VIBEVOICE=mlx-community/VibeVoice-ASR-bf16
python server_mlx.py
```

可配置项：

| 参数 | 环境变量 | 默认值 |
| --- | --- | --- |
| `--host` | `BILISUB_HOST` | `localhost` |
| `--port` | `BILISUB_PORT` | `8765` |
| `--language` | `BILISUB_LANGUAGE` | `Chinese` |
| `--qwen3-asr` | `BILISUB_QWEN3_ASR` | `mlx-community/Qwen3-ASR-1.7B-8bit` |
| `--qwen3-aligner` | `BILISUB_QWEN3_ALIGNER` | `mlx-community/Qwen3-ForcedAligner-0.6B-8bit` |
| `--vibevoice` | `BILISUB_VIBEVOICE` | `mlx-community/VibeVoice-ASR-bf16` |

## 加载 Chrome 扩展

1. 打开 `chrome://extensions/`。
2. 开启右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本项目目录。
5. 确认扩展已启用。

修改 `content.js`、`background.js`、`offscreen.js`、`popup.js` 或 `manifest.json` 后，需要在扩展管理页点击“重新加载”。

## 使用方法

1. 先启动本地服务：

   ```bash
   python server_mlx.py
   ```

2. 打开一个 Bilibili 视频页。
3. 点击浏览器工具栏里的扩展图标。
4. 选择模型：
   - `Qwen3-ASR`：启动快，适合普通使用。
   - `VibeVoice`：首次使用会加载或下载较大的模型。
5. 点击开始生成字幕。
6. 字幕生成过程中，视频页会显示字幕覆盖层和字幕列表。
7. 可以拖动字幕列表标题栏改变列表位置，点击列表中的时间或句子可跳转视频进度。

## 常见问题

### ASR 服务未连接

确认 `server_mlx.py` 正在运行，并且日志显示：

```text
启动 WebSocket 服务: ws://localhost:8765
```

如果你改了端口，需要同步修改 `offscreen.js` 里的 `WS_URL`。

### 音频下载失败 HTTP 403

Bilibili 音频 CDN URL 带临时鉴权，可能过期或被某个 CDN 节点拒绝。当前扩展会自动尝试 B 站返回的多个候选音频地址。如果所有候选都失败，刷新视频页面后重新开始通常可以重新获取有效 URL。

### 模型加载失败

检查模型路径是否存在，或 Hugging Face 模型 ID 是否可访问。本地路径建议使用绝对路径。

### VibeVoice 首次使用很慢

VibeVoice 模型较大，首次使用可能需要下载或加载较长时间。Qwen3 模型会在服务启动时加载，VibeVoice 会在切换到该模型时懒加载。

## 项目结构

```text
background.js   Chrome 扩展后台，获取 B 站视频信息和音频 URL
content.js      注入 B 站页面，渲染字幕和字幕列表
content.css     字幕覆盖层基础样式
offscreen.js    下载/解码音频，分块后发送给 WebSocket 服务
popup.html      扩展弹窗界面
popup.js        扩展弹窗逻辑
server_mlx.py   本地 MLX ASR WebSocket 服务
manifest.json   Chrome 扩展清单
assets/         扩展图标资源
```

