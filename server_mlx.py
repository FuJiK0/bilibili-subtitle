"""
server_mlx.py — 双模型 WebSocket ASR 后端
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
支持两种模型（可在运行时热切换）：
  • qwen3   — Qwen3-ASR-1.7B + ForcedAligner-0.6B（需分块，依赖标点分句）
  • vibevoice — VibeVoice-ASR-bf16（自带句级时间戳，支持60分钟单次推理）

协议（v3）：
  客户端发送：
    1) TEXT  {"type":"set_model","model":"vibevoice"}   ← 切换模型（可选）
    2) TEXT  {"type":"chunk_meta","chunk_id":0,"time_offset":0.0,"overlap_after":0.0}
    3) BINARY PCM s16le @ 16kHz mono

  服务端返回：
    {"chunk_id":0, "sentences":[{"text":"…","start":0.0,"end":1.5}, …]}
    或模型状态：{"type":"model_status","current_model":"vibevoice","loading":false}
"""

import asyncio
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
from mlx_audio.stt.utils import load as load_stt_utils

import faulthandler
faulthandler.enable()

# ── 配置 ─────────────────────────────────────────────────
HOST        = "localhost"
PORT        = 8765
SAMPLE_RATE = 16000
LANGUAGE    = "Chinese"

QWEN3_ASR_ID     = "/Users/wjh/.omlx/models/Qwen3-ASR-1.7B-8bit"
QWEN3_ALIGNER_ID = "/Users/wjh/.omlx/models/Qwen3-ForcedAligner-0.6B-8bit"
VIBEVOICE_ID     = "mlx-community/VibeVoice-ASR-bf16"   # 自动从 HF 下载

MAX_SEGMENT_SECONDS = 60.0

# ── 日志 ─────────────────────────────────────────────────
logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s.%(msecs)03d [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("bilisub_mlx")

# ── 全局模型注册表 ────────────────────────────────────────
# 结构：{ "qwen3": {"asr": model, "aligner": model, "loaded": bool},
#         "vibevoice": {"model": model, "loaded": bool} }
MODEL_REGISTRY: dict = {
    "qwen3":     {"asr": None, "aligner": None, "loaded": False},
    "vibevoice": {"model": None, "loaded": False},
}
active_model   = "qwen3"        # 当前使用的模型
model_lock     = threading.Lock()   # 模型切换保护
inference_lock = threading.Lock()   # 推理串行化（mlx 不是线程安全的）

# ── 启动时加载 Qwen3（默认模型） ─────────────────────────
log.info("=" * 60)
log.info("加载默认模型 Qwen3-ASR + Aligner...")
t0 = time.time()
try:
    MODEL_REGISTRY["qwen3"]["asr"]     = load_stt(QWEN3_ASR_ID)
    MODEL_REGISTRY["qwen3"]["aligner"] = load_stt(QWEN3_ALIGNER_ID)
    MODEL_REGISTRY["qwen3"]["loaded"]  = True
    log.info(f"Qwen3 模型就绪 ✓ 耗时 {time.time()-t0:.1f}s")
except Exception as e:
    log.error(f"Qwen3 加载失败: {e}", exc_info=True)
    raise
log.info("=" * 60)


# ════════════════════════════════════════════════════════
#  VibeVoice 懒加载（第一次使用时或主动切换时）
# ════════════════════════════════════════════════════════

def _load_vibevoice() -> bool:
    """同步加载 VibeVoice，返回是否成功。已加载则直接返回 True。"""
    with model_lock:
        if MODEL_REGISTRY["vibevoice"]["loaded"]:
            return True
        log.info(f"[模型] 开始加载 VibeVoice: {VIBEVOICE_ID}")
        t = time.time()
        try:
            MODEL_REGISTRY["vibevoice"]["model"]  = load_stt_utils(VIBEVOICE_ID)
            MODEL_REGISTRY["vibevoice"]["loaded"] = True
            log.info(f"[模型] VibeVoice 加载成功 ✓ 耗时 {time.time()-t:.1f}s")
            return True
        except Exception as e:
            log.error(f"[模型] VibeVoice 加载失败: {e}", exc_info=True)
            return False


# ════════════════════════════════════════════════════════
#  工具函数
# ════════════════════════════════════════════════════════

def _pcm16_to_float32(raw: bytes) -> np.ndarray:
    samples = np.frombuffer(raw, dtype=np.int16)
    log.debug(f"[PCM] {len(raw)} bytes → {len(samples)} samples ({len(samples)/SAMPLE_RATE:.3f}s)")
    return samples.astype(np.float32) / 32768.0


def _write_temp_wav(audio: np.ndarray, sr: int) -> str:
    fd, path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    sf.write(path, audio, sr, subtype="PCM_16")
    log.debug(f"[临时文件] {path} ({os.path.getsize(path)/1024:.1f} KB)")
    return path


# ── 分句标点（Qwen3 路径使用） ────────────────────────────
SPLIT_PUNCTS   = set('。！？…!?，,、；;')
MIN_SENT_CHARS = 5


def _strip_punct(s: str) -> str:
    return ''.join(c for c in s if c.isalnum() or '\u4e00' <= c <= '\u9fff')


def _split_text_to_sentences(text: str) -> list[str]:
    """按标点切句，合并过短碎片（< MIN_SENT_CHARS 净字符）。"""
    raw, buf = [], []
    for ch in text:
        buf.append(ch)
        if ch in SPLIT_PUNCTS:
            s = ''.join(buf).strip()
            if s:
                raw.append(s)
            buf = []
    if buf:
        tail = ''.join(buf).strip()
        if tail:
            raw.append(tail)

    merged, hold = [], ''
    for s in raw:
        combined = hold + s
        if len(_strip_punct(combined)) < MIN_SENT_CHARS:
            hold = combined
        else:
            merged.append(combined)
            hold = ''
    if hold:
        if merged:
            merged[-1] += hold
        else:
            merged.append(hold)

    log.debug(f"[分句] {len(merged)} 句: {[s[:20] for s in merged]}")
    return merged


def _align_sentences_to_words(
    sentences: list[str],
    words: list[dict],
    time_offset: float,
) -> list[dict]:
    """将句子映射到 Aligner 词时间戳，返回句级绝对时间戳。"""
    sent_chars  = [len(_strip_punct(s)) for s in sentences]
    total_chars = sum(sent_chars)
    word_chars  = [len(_strip_punct(w["word"])) for w in words]
    total_wc    = sum(word_chars)

    if total_wc == 0:
        return []

    result, word_idx = [], 0
    for si, (sent, sc) in enumerate(zip(sentences, sent_chars)):
        if sc == 0:
            continue
        target = max(1, round(sc / total_chars * total_wc))
        sw, consumed = [], 0
        while word_idx < len(words) and consumed < target:
            sw.append(words[word_idx])
            consumed += word_chars[word_idx]
            word_idx += 1
        if not sw:
            log.warning(f"[对齐] 句{si}「{sent[:20]}」无词，跳过")
            continue
        result.append({
            "text":  sent,
            "start": round(sw[0]["start"]  + time_offset, 3),
            "end":   round(sw[-1]["end"]   + time_offset, 3),
        })
        log.info(f"[对齐] 句{si} [{result[-1]['start']:.2f}-{result[-1]['end']:.2f}s] 「{sent[:30]}」")

    if result and word_idx < len(words):
        result[-1]["end"] = round(words[-1]["end"] + time_offset, 3)
    return result


# ════════════════════════════════════════════════════════
#  推理：Qwen3 路径
# ════════════════════════════════════════════════════════

def _infer_qwen3(audio: np.ndarray, chunk_id: int, time_offset: float) -> tuple[int, list[dict]]:
    reg = MODEL_REGISTRY["qwen3"]
    asr_model, aligner_model = reg["asr"], reg["aligner"]

    log.info(f"[Qwen3] chunk_id={chunk_id} | {len(audio)/SAMPLE_RATE:.2f}s | offset={time_offset:.3f}s")
    tmp_path = _write_temp_wav(audio, SAMPLE_RATE)
    try:
        # ASR
        t = time.time()
        result = asr_model.generate(tmp_path, language=LANGUAGE, max_tokens=512)
        text   = (result.text.strip() if hasattr(result, "text") else str(result).strip())
        log.info(f"[Qwen3][ASR] {time.time()-t:.2f}s → 「{text[:100]}」")
        if not text:
            return chunk_id, []

        sentences = _split_text_to_sentences(text)
        log.info(f"[Qwen3][分句] {len(sentences)} 句")

        # Aligner
        t = time.time()
        aligned  = aligner_model.generate(tmp_path, text=text, language=LANGUAGE)
        log.info(f"[Qwen3][Aligner] {time.time()-t:.2f}s")

        raw_words = []
        for item in aligned:
            w = item.text.strip() if hasattr(item, "text") else ""
            if w:
                raw_words.append({"word": w, "start": float(item.start_time), "end": float(item.end_time)})
        log.debug(f"[Qwen3][Aligner] {len(raw_words)} 词")

        out = _align_sentences_to_words(sentences, raw_words, time_offset)
        log.info(f"[Qwen3] chunk_id={chunk_id} 完成 | {len(out)} 句")
        return chunk_id, out

    except Exception as e:
        log.error(f"[Qwen3] 推理失败: {e}", exc_info=True)
        return chunk_id, []
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


# ════════════════════════════════════════════════════════
#  推理：VibeVoice 路径
# ════════════════════════════════════════════════════════

def _infer_vibevoice(audio: np.ndarray, chunk_id: int, time_offset: float) -> tuple[int, list[dict]]:
    model = MODEL_REGISTRY["vibevoice"]["model"]

    log.info(f"[VibeVoice] chunk_id={chunk_id} | {len(audio)/SAMPLE_RATE:.2f}s | offset={time_offset:.3f}s")
    tmp_path = _write_temp_wav(audio, SAMPLE_RATE)
    try:
        t      = time.time()
        result = model.generate(audio=tmp_path, max_tokens=8192, temperature=0.0)
        log.info(f"[VibeVoice] 推理完成 {time.time()-t:.2f}s | 原始输出前200字: {str(result.text)[:200]}")

        sentences = []
        # result.segments: list of dict with start_time / end_time / text / speaker_id
        if hasattr(result, "segments") and result.segments:
            for seg in result.segments:
                start = round(float(seg.get("start_time", 0)) + time_offset, 3)
                end   = round(float(seg.get("end_time",   0)) + time_offset, 3)
                text  = str(seg.get("text", "")).strip()
                if text:
                    sentences.append({"text": text, "start": start, "end": end})
                    log.debug(f"[VibeVoice] 段 [{start:.2f}-{end:.2f}s] 「{text[:40]}」")
        else:
            # 兜底：仅有 result.text，无段落信息
            log.warning("[VibeVoice] 无 segments，尝试 result.text 兜底")
            text = str(result.text).strip()
            if text:
                sentences.append({"text": text, "start": time_offset, "end": time_offset + len(audio) / SAMPLE_RATE})

        log.info(f"[VibeVoice] chunk_id={chunk_id} 完成 | {len(sentences)} 句")
        return chunk_id, sentences

    except Exception as e:
        log.error(f"[VibeVoice] 推理失败: {e}", exc_info=True)
        return chunk_id, []
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


# ════════════════════════════════════════════════════════
#  统一推理入口（由线程池调用）
# ════════════════════════════════════════════════════════

def transcribe(audio: np.ndarray, chunk_id: int, time_offset: float) -> tuple[int, list[dict]]:
    if len(audio) < SAMPLE_RATE * 0.3:
        log.warning(f"[推理] 音频过短 ({len(audio)/SAMPLE_RATE:.2f}s)，跳过")
        return chunk_id, []
    if len(audio) > SAMPLE_RATE * MAX_SEGMENT_SECONDS:
        log.warning(f"[推理] 音频截断至 {MAX_SEGMENT_SECONDS}s")
        audio = audio[:int(SAMPLE_RATE * MAX_SEGMENT_SECONDS)]

    log.info(f"[推理] 等待锁... 当前模型: {active_model}")
    with inference_lock:
        model_name = active_model
        log.info(f"[推理] 获得锁，使用模型: {model_name}")
        if model_name == "vibevoice":
            return _infer_vibevoice(audio, chunk_id, time_offset)
        else:
            return _infer_qwen3(audio, chunk_id, time_offset)


# ════════════════════════════════════════════════════════
#  WebSocket 处理器
# ════════════════════════════════════════════════════════

async def handle_client(websocket):
    global active_model
    addr = websocket.remote_address
    log.info(f"[WS] 客户端连接: {addr}")
    loop = asyncio.get_event_loop()

    pending_meta: dict | None = None

    async def send_json(payload: dict):
        try:
            await websocket.send(json.dumps(payload, ensure_ascii=False))
        except websockets.exceptions.ConnectionClosed:
            log.warning("[WS] 发送失败，连接已断开")

    async def send_result(chunk_id: int, sentences: list[dict]):
        log.info(f"[WS] 发送结果: chunk_id={chunk_id}, {len(sentences)} 句")
        await send_json({"chunk_id": chunk_id, "sentences": sentences})

    async def run_inference_task(segment: np.ndarray, chunk_id: int, time_offset: float, overlap_after: float):
        try:
            cid, sentences = await loop.run_in_executor(None, transcribe, segment, chunk_id, time_offset)
            cutoff = time_offset + overlap_after
            if overlap_after > 0:
                before    = len(sentences)
                sentences = [s for s in sentences if s["start"] >= cutoff - 0.1]
                log.info(f"[任务] 重叠过滤: cutoff={cutoff:.2f}s, {before}→{len(sentences)} 句")
            await send_result(cid, sentences)
        except Exception as e:
            log.error(f"[任务] chunk_id={chunk_id} 异常: {e}", exc_info=True)
            await send_result(chunk_id, [])

    try:
        async for message in websocket:

            # ── 文本消息 ─────────────────────────────────
            if isinstance(message, str):
                log.debug(f"[WS] TEXT: {message[:200]}")
                try:
                    meta = json.loads(message)
                except json.JSONDecodeError as e:
                    log.warning(f"[WS] JSON 解析失败: {e}")
                    continue

                msg_type = meta.get("type", "")

                # 模型切换指令
                if msg_type == "set_model":
                    requested = meta.get("model", "qwen3").lower()
                    log.info(f"[WS] 收到 set_model: {requested}")

                    if requested not in ("qwen3", "vibevoice"):
                        await send_json({"type": "model_status", "error": f"未知模型: {requested}"})
                        continue

                    # VibeVoice 懒加载
                    if requested == "vibevoice" and not MODEL_REGISTRY["vibevoice"]["loaded"]:
                        log.info("[WS] VibeVoice 尚未加载，开始加载...")
                        await send_json({"type": "model_status", "current_model": requested, "loading": True})
                        ok = await loop.run_in_executor(None, _load_vibevoice)
                        if not ok:
                            await send_json({"type": "model_status", "current_model": active_model,
                                             "loading": False, "error": "VibeVoice 加载失败，已保持原模型"})
                            continue

                    active_model = requested
                    log.info(f"[WS] 模型切换成功: {active_model}")
                    await send_json({"type": "model_status", "current_model": active_model, "loading": False})
                    continue

                # chunk 元数据
                if msg_type == "chunk_meta":
                    pending_meta = meta
                    log.info(
                        f"[WS] chunk_meta: id={meta.get('chunk_id')} "
                        f"offset={meta.get('time_offset',0):.3f}s "
                        f"overlap={meta.get('overlap_after',0):.3f}s"
                    )
                    continue

                log.debug(f"[WS] 未知消息类型: {msg_type}")
                continue

            # ── 二进制消息：PCM ───────────────────────────
            if isinstance(message, bytes):
                chunk_id, time_offset, overlap_after = 0, 0.0, 0.0
                if pending_meta:
                    chunk_id      = int(pending_meta.get("chunk_id", 0))
                    time_offset   = float(pending_meta.get("time_offset", 0.0))
                    overlap_after = float(pending_meta.get("overlap_after", 0.0))
                    pending_meta  = None

                log.info(f"[WS] PCM: chunk_id={chunk_id} {len(message)} bytes offset={time_offset:.3f}s overlap={overlap_after:.3f}s model={active_model}")
                segment = _pcm16_to_float32(message)
                asyncio.create_task(run_inference_task(segment, chunk_id, time_offset, overlap_after))
                continue

    except websockets.exceptions.ConnectionClosedOK:
        log.info(f"[WS] 正常断开: {addr}")
    except websockets.exceptions.ConnectionClosedError as e:
        log.warning(f"[WS] 异常断开: {addr} | {e}")
    except Exception as e:
        log.error(f"[WS] 处理异常: {e}", exc_info=True)

    log.info(f"[WS] 连接结束: {addr}")


# ════════════════════════════════════════════════════════
#  主入口
# ════════════════════════════════════════════════════════

async def main():
    log.info(f"启动 WebSocket 服务: ws://{HOST}:{PORT}")
    log.info(f"默认模型: {active_model}")
    log.info("等待插件连接... (Ctrl+C 停止)")

    async with websockets.serve(
        handle_client, HOST, PORT,
        max_size=500 * 1024 * 1024,   # 500MB（VibeVoice 60min 音频）
        ping_interval=30,
        ping_timeout=120,
    ):
        await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log.info("服务已停止")
        sys.exit(0)