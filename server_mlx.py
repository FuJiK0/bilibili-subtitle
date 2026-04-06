"""
server_mlx.py — mlx-audio (Qwen3-ASR-1.7B + ForcedAligner-0.6B) WebSocket 后端
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
协议（v2）:
    ws://localhost:8765

    客户端每次发送一个 chunk，分两条消息：
      1) TEXT   {"type":"chunk_meta","chunk_id":0,"time_offset":0.0}
      2) BINARY PCM s16le @ 16kHz mono

    服务端返回：
      {"chunk_id":0, "words":[{"word":"...","start":0.0,"end":0.3}, ...]}
      时间戳已加上 time_offset，为绝对时间。
"""

import asyncio
import io
import json
import logging
import sys
import tempfile
import os
import threading
import time

import numpy as np
import soundfile as sf
import websockets
from mlx_audio.stt import load as load_stt

import faulthandler
faulthandler.enable()

# ── 配置 ─────────────────────────────────────────────────
HOST          = "localhost"
PORT          = 8765
SAMPLE_RATE   = 16000
LANGUAGE      = "Chinese"

ASR_MODEL_ID     = "/Users/wjh/.omlx/models/Qwen3-ASR-1.7B-8bit"
ALIGNER_MODEL_ID = "/Users/wjh/.omlx/models/Qwen3-ForcedAligner-0.6B-8bit"

MAX_SEGMENT_SECONDS = 60.0   # 单 chunk 最长（防呆）

# ── 日志 ─────────────────────────────────────────────────
logging.basicConfig(
    level=logging.DEBUG,          # ← DEBUG 级别，便于调试
    format="%(asctime)s.%(msecs)03d [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
    handlers=[
        logging.StreamHandler(sys.stdout),
    ]
)
log = logging.getLogger("bilisub_mlx")

# ── 加载模型 ─────────────────────────────────────────────
log.info("=" * 60)
log.info("开始加载模型...")
log.info(f"  ASR 路径    : {ASR_MODEL_ID}")
log.info(f"  ASR 路径存在: {os.path.exists(ASR_MODEL_ID)}")
log.info(f"  Aligner 路径: {ALIGNER_MODEL_ID}")
log.info(f"  Aligner 存在: {os.path.exists(ALIGNER_MODEL_ID)}")

t0 = time.time()
log.info("正在加载 ASR 模型...")
try:
    asr = load_stt(ASR_MODEL_ID)
    log.info(f"ASR 模型加载成功 ✓ ({time.time()-t0:.1f}s)")
except Exception as e:
    log.error(f"ASR 模型加载失败: {e}", exc_info=True)
    raise

t1 = time.time()
log.info("正在加载 Aligner 模型...")
try:
    aligner = load_stt(ALIGNER_MODEL_ID)
    log.info(f"Aligner 模型加载成功 ✓ ({time.time()-t1:.1f}s)")
except Exception as e:
    log.error(f"Aligner 模型加载失败: {e}", exc_info=True)
    raise

log.info(f"所有模型就绪 ✓ 总耗时 {time.time()-t0:.1f}s")
log.info("=" * 60)

# 推理锁（mlx_audio 不是线程安全的）
inference_lock = threading.Lock()


# ════════════════════════════════════════════════════════
#  工具函数
# ════════════════════════════════════════════════════════

def _pcm16_to_float32(raw: bytes) -> np.ndarray:
    """PCM s16le bytes → float32 [-1, 1]"""
    samples = np.frombuffer(raw, dtype=np.int16)
    log.debug(f"[PCM解码] {len(raw)} bytes → {len(samples)} samples ({len(samples)/SAMPLE_RATE:.3f}s)")
    return samples.astype(np.float32) / 32768.0


def _write_temp_wav(audio: np.ndarray, sr: int) -> str:
    """Float32 → 临时 WAV 文件，返回路径"""
    fd, path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    sf.write(path, audio, sr, subtype="PCM_16")
    size_kb = os.path.getsize(path) / 1024
    log.debug(f"[临时文件] 写入 {path} ({size_kb:.1f} KB)")
    return path


# ════════════════════════════════════════════════════════
#  推理函数（同步，在线程池中运行）
# ════════════════════════════════════════════════════════

def transcribe_and_align(
    audio: np.ndarray,
    chunk_id: int = 0,
    time_offset: float = 0.0
) -> tuple[int, list[dict]]:
    """
    同步推理：ASR → ForcedAligner → 词级绝对时间戳列表
    返回: (chunk_id, [{"word":str, "start":float, "end":float}, ...])
    时间戳 = 模型输出时间 + time_offset（绝对时间）
    """
    log.info(f"[推理] ── chunk_id={chunk_id} | time_offset={time_offset:.3f}s ──")
    log.info("[推理] 等待获取推理锁（当前可能有其他 chunk 在推理中）...")

    lock_wait_t = time.time()
    with inference_lock:
        lock_wait = time.time() - lock_wait_t
        log.info(f"[推理] 获取锁耗时 {lock_wait:.2f}s | 音频长度: {len(audio)/SAMPLE_RATE:.2f}s ({len(audio)} samples)")

        if len(audio) < SAMPLE_RATE * 0.3:
            log.warning(f"[推理] 音频过短 ({len(audio)/SAMPLE_RATE:.2f}s < 0.3s)，跳过")
            return chunk_id, []

        if len(audio) > SAMPLE_RATE * MAX_SEGMENT_SECONDS:
            log.warning(f"[推理] 音频超长 ({len(audio)/SAMPLE_RATE:.1f}s > {MAX_SEGMENT_SECONDS}s)，截断")
            audio = audio[:int(SAMPLE_RATE * MAX_SEGMENT_SECONDS)]

        log.debug("[推理] 写入临时 WAV...")
        tmp_path = _write_temp_wav(audio, SAMPLE_RATE)

        try:
            # ── Step 1: ASR 转写 ──────────────────────────
            log.info(f"[推理][ASR] 开始转写 chunk_id={chunk_id}...")
            asr_t = time.time()
            try:
                asr_result = asr.generate(tmp_path, language=LANGUAGE, max_tokens=512)
            except Exception as e:
                log.error(f"[推理][ASR] 转写异常: {e}", exc_info=True)
                raise

            asr_elapsed = time.time() - asr_t
            text = (asr_result.text.strip()
                    if hasattr(asr_result, "text")
                    else str(asr_result).strip())

            log.info(f"[推理][ASR] 完成 ({asr_elapsed:.2f}s) → 文本: 「{text[:100]}{'...' if len(text)>100 else ''}」")

            if not text:
                log.info("[推理][ASR] 空文本，跳过对齐")
                return chunk_id, []

            # ── Step 2: ForcedAligner 对齐 ────────────────
            log.info(f"[推理][Aligner] 开始对齐 chunk_id={chunk_id}...")
            align_t = time.time()
            try:
                aligned = aligner.generate(tmp_path, text=text, language=LANGUAGE)
            except Exception as e:
                log.error(f"[推理][Aligner] 对齐异常: {e}", exc_info=True)
                raise

            align_elapsed = time.time() - align_t
            log.info(f"[推理][Aligner] 完成 ({align_elapsed:.2f}s)，处理词列表...")

            words = []
            for item in aligned:
                word = item.text.strip() if hasattr(item, "text") else ""
                if not word:
                    log.debug("[推理][Aligner] 跳过空词")
                    continue

                raw_start = float(item.start_time)
                raw_end   = float(item.end_time)
                abs_start = round(raw_start + time_offset, 3)
                abs_end   = round(raw_end   + time_offset, 3)

                log.debug(f"[推理][Aligner] 词: 「{word}」 raw=[{raw_start:.3f},{raw_end:.3f}] abs=[{abs_start:.3f},{abs_end:.3f}]")

                words.append({
                    "word":  word,
                    "start": abs_start,
                    "end":   abs_end,
                })

            total_elapsed = time.time() - (asr_t)
            log.info(f"[推理] chunk_id={chunk_id} 完成 ✓ | 词数={len(words)} | 总耗时={total_elapsed:.2f}s")

            if words:
                log.info(f"[推理] 时间范围: {words[0]['start']:.2f}s → {words[-1]['end']:.2f}s")

            return chunk_id, words

        except Exception as e:
            log.error(f"[推理] chunk_id={chunk_id} 推理失败: {e}", exc_info=True)
            return chunk_id, []

        finally:
            try:
                os.unlink(tmp_path)
                log.debug(f"[推理] 已删除临时文件: {tmp_path}")
            except OSError as e:
                log.warning(f"[推理] 删除临时文件失败: {e}")


# ════════════════════════════════════════════════════════
#  WebSocket 处理器
# ════════════════════════════════════════════════════════

async def handle_client(websocket):
    addr = websocket.remote_address
    log.info(f"[WS] 客户端连接: {addr}")

    loop = asyncio.get_event_loop()

    # 协议状态机：等待 JSON 元数据 → 等待二进制 PCM → 循环
    pending_meta: dict | None = None   # 上一条 JSON 消息的解析结果

    async def send_result(chunk_id: int, words: list[dict]):
        payload = json.dumps({"chunk_id": chunk_id, "words": words}, ensure_ascii=False)
        log.info(f"[WS] 发送结果: chunk_id={chunk_id}, {len(words)} 词, {len(payload)} bytes")
        try:
            await websocket.send(payload)
            log.debug("[WS] 发送成功")
        except websockets.exceptions.ConnectionClosed:
            log.warning("[WS] 发送失败，连接已断开")

    async def run_inference_task(segment: np.ndarray, chunk_id: int, time_offset: float):
        log.info(f"[任务] 提交推理: chunk_id={chunk_id}, {len(segment)/SAMPLE_RATE:.2f}s, offset={time_offset:.3f}s")
        try:
            cid, words = await loop.run_in_executor(
                None, transcribe_and_align, segment, chunk_id, time_offset
            )
            await send_result(cid, words)
        except Exception as e:
            log.error(f"[任务] chunk_id={chunk_id} 推理任务异常: {e}", exc_info=True)
            await send_result(chunk_id, [])  # 返回空结果，不卡死客户端

    try:
        async for message in websocket:

            # ── 文本消息：JSON 元数据 ─────────────────────
            if isinstance(message, str):
                log.debug(f"[WS] 收到文本消息: {message[:200]}")
                try:
                    meta = json.loads(message)
                except json.JSONDecodeError as e:
                    log.warning(f"[WS] JSON 解析失败: {e} | 原文: {message[:100]}")
                    continue

                msg_type = meta.get("type", "")
                if msg_type == "chunk_meta":
                    pending_meta = meta
                    log.info(
                        f"[WS] 收到 chunk_meta: chunk_id={meta.get('chunk_id')}, "
                        f"time_offset={meta.get('time_offset', 0.0):.3f}s"
                    )
                else:
                    log.debug(f"[WS] 未知文本消息类型: {msg_type}")
                continue

            # ── 二进制消息：PCM 数据 ──────────────────────
            if isinstance(message, bytes):
                chunk_id    = 0
                time_offset = 0.0

                if pending_meta:
                    chunk_id    = int(pending_meta.get("chunk_id", 0))
                    time_offset = float(pending_meta.get("time_offset", 0.0))
                    log.info(
                        f"[WS] 收到 PCM: chunk_id={chunk_id}, "
                        f"{len(message)} bytes, time_offset={time_offset:.3f}s"
                    )
                    pending_meta = None  # 消费掉，防止下一条二进制误用
                else:
                    log.info(f"[WS] 收到 PCM（无元数据）: {len(message)} bytes，使用默认 chunk_id=0")

                segment = _pcm16_to_float32(message)
                asyncio.create_task(run_inference_task(segment, chunk_id, time_offset))
                continue

            log.debug(f"[WS] 忽略未知消息类型: {type(message)}")

    except websockets.exceptions.ConnectionClosedOK:
        log.info(f"[WS] 客户端正常断开: {addr}")
    except websockets.exceptions.ConnectionClosedError as e:
        log.warning(f"[WS] 客户端异常断开: {addr} | {e}")
    except Exception as e:
        log.error(f"[WS] handle_client 异常: {e}", exc_info=True)

    log.info(f"[WS] 连接结束: {addr}")


# ════════════════════════════════════════════════════════
#  主入口
# ════════════════════════════════════════════════════════

async def main():
    log.info(f"启动 WebSocket 服务: ws://{HOST}:{PORT}")
    log.info(f"语言={LANGUAGE} | ASR={os.path.basename(ASR_MODEL_ID)} | Aligner={os.path.basename(ALIGNER_MODEL_ID)}")
    log.info("等待插件连接... (Ctrl+C 停止)")

    async with websockets.serve(
        handle_client,
        HOST,
        PORT,
        max_size=200 * 1024 * 1024,   # 200MB（单 chunk 最大）
        ping_interval=20,
        ping_timeout=60,
    ):
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("服务已停止")
        sys.exit(0)
