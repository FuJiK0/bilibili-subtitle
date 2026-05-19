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
import argparse
import json
import logging
import sys
import tempfile
import os
import platform
import threading
import time

import numpy as np

import faulthandler

faulthandler.enable()

# ── 配置 ─────────────────────────────────────────────────
HOST = "localhost"
PORT = 8765
SAMPLE_RATE = 16000
LANGUAGE = "Chinese"

MLX_QWEN3_ASR_ID = "mlx-community/Qwen3-ASR-1.7B-8bit"
MLX_QWEN3_ALIGNER_ID = "mlx-community/Qwen3-ForcedAligner-0.6B-8bit"
MLX_VIBEVOICE_ID = "mlx-community/VibeVoice-ASR-bf16"
TORCH_QWEN3_ASR_ID = "Qwen/Qwen3-ASR-1.7B"
TORCH_QWEN3_ALIGNER_ID = "Qwen/Qwen3-ForcedAligner-0.6B"
TORCH_VIBEVOICE_ID = "microsoft/VibeVoice-ASR-HF"

BACKEND = "auto"
TORCH_DEVICE = "auto"
QWEN3_ASR_ID = MLX_QWEN3_ASR_ID
QWEN3_ALIGNER_ID = MLX_QWEN3_ALIGNER_ID
VIBEVOICE_ID = MLX_VIBEVOICE_ID  # 可填 HF 模型 ID 或本地目录

MAX_SEGMENT_SECONDS = 60.0
websockets = None


def _env_int(name: str, default: int) -> int:
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        raise ValueError(f"环境变量 {name} 必须是整数，当前值: {value}") from None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="B站实时字幕 WebSocket ASR 后端")
    parser.add_argument(
        "--backend",
        choices=("auto", "mlx", "torch"),
        default=os.environ.get("BILISUB_BACKEND", BACKEND),
        help="ASR 后端：auto 在 macOS 使用 mlx，在 Windows/Linux 使用 torch",
    )
    parser.add_argument("--host", default=os.environ.get("BILISUB_HOST", HOST))
    parser.add_argument("--port", type=int, default=_env_int("BILISUB_PORT", PORT))
    parser.add_argument(
        "--language", default=os.environ.get("BILISUB_LANGUAGE", LANGUAGE)
    )
    parser.add_argument(
        "--torch-device",
        default=os.environ.get("BILISUB_TORCH_DEVICE", TORCH_DEVICE),
        help="Torch 后端设备，例如 auto、cuda:0 或 cpu",
    )
    parser.add_argument(
        "--qwen3-asr",
        default=os.environ.get("BILISUB_QWEN3_ASR"),
        help="Qwen3 ASR 模型 ID 或本地路径",
    )
    parser.add_argument(
        "--qwen3-aligner",
        default=os.environ.get("BILISUB_QWEN3_ALIGNER"),
        help="Qwen3 ForcedAligner 模型 ID 或本地路径",
    )
    parser.add_argument(
        "--vibevoice",
        default=os.environ.get("BILISUB_VIBEVOICE"),
        help="VibeVoice 模型 ID 或本地路径",
    )
    return parser.parse_args()


def apply_config(args: argparse.Namespace) -> None:
    global HOST, PORT, LANGUAGE, BACKEND, TORCH_DEVICE
    global QWEN3_ASR_ID, QWEN3_ALIGNER_ID, VIBEVOICE_ID

    HOST = args.host
    PORT = args.port
    LANGUAGE = args.language
    BACKEND = resolve_backend(args.backend)
    TORCH_DEVICE = args.torch_device
    defaults = get_backend_model_defaults(BACKEND)
    QWEN3_ASR_ID = args.qwen3_asr or defaults["qwen3_asr"]
    QWEN3_ALIGNER_ID = args.qwen3_aligner or defaults["qwen3_aligner"]
    VIBEVOICE_ID = args.vibevoice or defaults["vibevoice"]


def resolve_backend(requested: str) -> str:
    if requested == "auto":
        return "mlx" if platform.system() == "Darwin" else "torch"
    if requested == "mlx" and platform.system() == "Windows":
        raise RuntimeError("Windows 原生环境不支持 MLX，请使用 --backend torch")
    return requested


def get_backend_model_defaults(backend: str) -> dict:
    if backend == "torch":
        return {
            "qwen3_asr": TORCH_QWEN3_ASR_ID,
            "qwen3_aligner": TORCH_QWEN3_ALIGNER_ID,
            "vibevoice": TORCH_VIBEVOICE_ID,
        }
    return {
        "qwen3_asr": MLX_QWEN3_ASR_ID,
        "qwen3_aligner": MLX_QWEN3_ALIGNER_ID,
        "vibevoice": MLX_VIBEVOICE_ID,
    }


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
    "qwen3": {"asr": None, "aligner": None, "loaded": False},
    "vibevoice": {"model": None, "loaded": False},
}
active_model = "qwen3"  # 当前使用的模型
model_lock = threading.Lock()  # 模型切换保护
inference_lock = threading.Lock()  # 推理串行化（mlx 不是线程安全的）


def _load_qwen3() -> None:
    """启动时加载默认 Qwen3 ASR 与对齐模型。"""
    log.info("=" * 60)
    log.info(f"加载默认模型 Qwen3-ASR + Aligner... backend={BACKEND}")
    log.info(f"[模型] Qwen3 ASR: {QWEN3_ASR_ID}")
    log.info(f"[模型] Qwen3 Aligner: {QWEN3_ALIGNER_ID}")
    t0 = time.time()
    try:
        if BACKEND == "mlx":
            from mlx_audio.stt import load as load_stt

            MODEL_REGISTRY["qwen3"]["asr"] = load_stt(QWEN3_ASR_ID)
            MODEL_REGISTRY["qwen3"]["aligner"] = load_stt(QWEN3_ALIGNER_ID)
        else:
            from qwen_asr.inference.qwen3_asr import Qwen3ASRModel

            torch_kwargs = _torch_model_kwargs()
            MODEL_REGISTRY["qwen3"]["asr"] = Qwen3ASRModel.from_pretrained(
                QWEN3_ASR_ID,
                forced_aligner=QWEN3_ALIGNER_ID,
                forced_aligner_kwargs=torch_kwargs,
                max_inference_batch_size=1,
                max_new_tokens=512,
                **torch_kwargs,
            )
        MODEL_REGISTRY["qwen3"]["loaded"] = True
        log.info(f"Qwen3 模型就绪 ✓ 耗时 {time.time() - t0:.1f}s")
    except Exception as e:
        log.error(f"Qwen3 加载失败: {e}", exc_info=True)
        raise
    log.info("=" * 60)


def _torch_model_kwargs() -> dict:
    import torch

    if TORCH_DEVICE == "auto":
        device = "cuda:0" if torch.cuda.is_available() else "cpu"
    else:
        device = TORCH_DEVICE

    if device.startswith("cuda") and not torch.cuda.is_available():
        log.warning(
            "[Torch] 指定了 CUDA 设备但当前未检测到 CUDA，将尝试按配置加载，可能失败"
        )
    if device == "cpu":
        log.warning("[Torch] 未检测到 CUDA，使用 CPU 推理会非常慢，长视频体验不佳")

    dtype = torch.bfloat16 if device.startswith("cuda") else torch.float32
    log.info(f"[Torch] device_map={device}, dtype={dtype}")
    return {"device_map": device, "dtype": dtype}


# ════════════════════════════════════════════════════════
#  VibeVoice 懒加载（第一次使用时或主动切换时）
# ════════════════════════════════════════════════════════


def _load_vibevoice() -> bool:
    """同步加载 VibeVoice，返回是否成功。已加载则直接返回 True。"""
    with model_lock:
        if MODEL_REGISTRY["vibevoice"]["loaded"]:
            return True
        log.info(f"[模型] 开始加载 VibeVoice: {VIBEVOICE_ID} backend={BACKEND}")
        t = time.time()
        try:
            if BACKEND == "mlx":
                from mlx_audio.stt.utils import load as load_stt_utils

                MODEL_REGISTRY["vibevoice"]["model"] = load_stt_utils(VIBEVOICE_ID)
            else:
                from transformers import (
                    AutoProcessor,
                    VibeVoiceAsrForConditionalGeneration,
                )

                torch_kwargs = _torch_model_kwargs()
                processor = AutoProcessor.from_pretrained(VIBEVOICE_ID)
                model = VibeVoiceAsrForConditionalGeneration.from_pretrained(
                    VIBEVOICE_ID,
                    **torch_kwargs,
                )
                MODEL_REGISTRY["vibevoice"]["model"] = {
                    "processor": processor,
                    "model": model,
                }
            MODEL_REGISTRY["vibevoice"]["loaded"] = True
            log.info(f"[模型] VibeVoice 加载成功 ✓ 耗时 {time.time() - t:.1f}s")
            return True
        except Exception as e:
            log.error(f"[模型] VibeVoice 加载失败: {e}", exc_info=True)
            return False


# ════════════════════════════════════════════════════════
#  工具函数
# ════════════════════════════════════════════════════════


def _pcm16_to_float32(raw: bytes) -> np.ndarray:
    samples = np.frombuffer(raw, dtype=np.int16)
    log.debug(
        f"[PCM] {len(raw)} bytes → {len(samples)} samples ({len(samples) / SAMPLE_RATE:.3f}s)"
    )
    return samples.astype(np.float32) / 32768.0


def _write_temp_wav(audio: np.ndarray, sr: int) -> str:
    import soundfile as sf

    fd, path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    sf.write(path, audio, sr, subtype="PCM_16")
    log.debug(f"[临时文件] {path} ({os.path.getsize(path) / 1024:.1f} KB)")
    return path


# ── 分句标点（Qwen3 路径使用） ────────────────────────────
SPLIT_PUNCTS = set("。！？…!?，,、；;")
MIN_SENT_CHARS = 5


def _strip_punct(s: str) -> str:
    """
    去除字符串中的标点符号，仅保留字母、数字和中文字符。
    用于计算句子的“净字符数”。
    """
    return "".join(
        c for c in s 
        if c.isalnum()                   # 字母或数字
        or "\u4e00" <= c <= "\u9fff"     # 中文字符（基本汉字范围）
    )


def _split_text_to_sentences(text: str) -> list[str]:
    """按标点切句，合并过短碎片（< MIN_SENT_CHARS 净字符）。"""
    raw, buf = [], []
    for ch in text:
        buf.append(ch)
        if ch in SPLIT_PUNCTS:
            s = "".join(buf).strip()
            if s:
                raw.append(s)
            buf = []
    if buf:
        tail = "".join(buf).strip()
        if tail:
            raw.append(tail)

    merged, hold = [], ""
    for s in raw:
        combined = hold + s
        if len(_strip_punct(combined)) < MIN_SENT_CHARS:
            hold = combined
        else:
            merged.append(combined)
            hold = ""
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
    sent_chars = [len(_strip_punct(s)) for s in sentences]
    total_chars = sum(sent_chars)
    word_chars = [len(_strip_punct(w["word"])) for w in words]
    total_wc = sum(word_chars)

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
        result.append(
            {
                "text": sent,
                "start": round(sw[0]["start"] + time_offset, 3),
                "end": round(sw[-1]["end"] + time_offset, 3),
            }
        )
        log.info(
            f"[对齐] 句{si} [{result[-1]['start']:.2f}-{result[-1]['end']:.2f}s] 「{sent[:30]}」"
        )

    if result and word_idx < len(words):
        result[-1]["end"] = round(words[-1]["end"] + time_offset, 3)
    return result


# ════════════════════════════════════════════════════════
#  推理：Qwen3 路径
# ════════════════════════════════════════════════════════


def _infer_qwen3(
    audio: np.ndarray, chunk_id: int, time_offset: float
) -> tuple[int, list[dict]]:
    reg = MODEL_REGISTRY["qwen3"]
    asr_model, aligner_model = reg["asr"], reg["aligner"]

    log.info(
        f"[Qwen3] chunk_id={chunk_id} | {len(audio) / SAMPLE_RATE:.2f}s | offset={time_offset:.3f}s"
    )
    tmp_path = _write_temp_wav(audio, SAMPLE_RATE)
    try:
        if BACKEND == "torch":
            t = time.time()
            results = asr_model.transcribe(
                audio=tmp_path,
                language=LANGUAGE,
                return_time_stamps=True,
            )
            result = results[0] if results else None
            text = str(getattr(result, "text", "")).strip() if result else ""
            log.info(f"[Qwen3][Torch] {time.time() - t:.2f}s → 「{text[:100]}」")
            if not text:
                return chunk_id, []

            timestamps = getattr(result, "time_stamps", None)
            raw_words = []
            for item in list(timestamps or []):
                w = str(getattr(item, "text", "")).strip()
                if w:
                    raw_words.append(
                        {
                            "word": w,
                            "start": float(getattr(item, "start_time", 0)),
                            "end": float(getattr(item, "end_time", 0)),
                        }
                    )

            if raw_words:
                sentences = _split_text_to_sentences(text)
                out = _align_sentences_to_words(sentences, raw_words, time_offset)
            else:
                log.warning("[Qwen3][Torch] 无时间戳，使用整块时长兜底")
                out = [
                    {
                        "text": text,
                        "start": time_offset,
                        "end": round(time_offset + len(audio) / SAMPLE_RATE, 3),
                    }
                ]
            log.info(f"[Qwen3][Torch] chunk_id={chunk_id} 完成 | {len(out)} 句")
            return chunk_id, out

        # ASR
        t = time.time()
        result = asr_model.generate(tmp_path, language=LANGUAGE, max_tokens=512)
        text = result.text.strip() if hasattr(result, "text") else str(result).strip()
        log.info(f"[Qwen3][ASR] {time.time() - t:.2f}s → 「{text[:100]}」")
        if not text:
            return chunk_id, []

        sentences = _split_text_to_sentences(text)
        log.info(f"[Qwen3][分句] {len(sentences)} 句")

        # Aligner
        t = time.time()
        aligned = aligner_model.generate(tmp_path, text=text, language=LANGUAGE)
        log.info(f"[Qwen3][Aligner] {time.time() - t:.2f}s")

        raw_words = []
        for item in aligned:
            w = item.text.strip() if hasattr(item, "text") else ""
            if w:
                raw_words.append(
                    {
                        "word": w,
                        "start": float(item.start_time),
                        "end": float(item.end_time),
                    }
                )
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


def _infer_vibevoice(
    audio: np.ndarray, chunk_id: int, time_offset: float
) -> tuple[int, list[dict]]:
    model = MODEL_REGISTRY["vibevoice"]["model"]

    log.info(
        f"[VibeVoice] chunk_id={chunk_id} | {len(audio) / SAMPLE_RATE:.2f}s | offset={time_offset:.3f}s"
    )
    tmp_path = _write_temp_wav(audio, SAMPLE_RATE)
    try:
        if BACKEND == "torch":
            import torch

            processor = model["processor"]
            vv_model = model["model"]
            t = time.time()
            inputs = processor.apply_transcription_request(audio=tmp_path).to(
                vv_model.device,
                vv_model.dtype,
            )
            with torch.no_grad():
                output_ids = vv_model.generate(**inputs)
            generated_ids = output_ids[:, inputs["input_ids"].shape[1] :]
            parsed = processor.decode(generated_ids, return_format="parsed")[0]
            log.info(
                f"[VibeVoice][Torch] 推理完成 {time.time() - t:.2f}s | parsed={isinstance(parsed, list)}"
            )

            sentences = []
            if isinstance(parsed, list):
                for seg in parsed:
                    text = str(seg.get("Content", "") or seg.get("text", "")).strip()
                    if not text:
                        continue
                    start = float(seg.get("Start", seg.get("start", 0)))
                    end = float(seg.get("End", seg.get("end", start)))
                    sentences.append(
                        {
                            "text": text,
                            "start": round(start + time_offset, 3),
                            "end": round(end + time_offset, 3),
                        }
                    )
            else:
                text = str(
                    processor.decode(generated_ids, return_format="transcription_only")[
                        0
                    ]
                ).strip()
                if text:
                    sentences.append(
                        {
                            "text": text,
                            "start": time_offset,
                            "end": round(time_offset + len(audio) / SAMPLE_RATE, 3),
                        }
                    )

            log.info(
                f"[VibeVoice][Torch] chunk_id={chunk_id} 完成 | {len(sentences)} 句"
            )
            return chunk_id, sentences

        t = time.time()
        result = model.generate(audio=tmp_path, max_tokens=8192, temperature=0.0)
        log.info(
            f"[VibeVoice] 推理完成 {time.time() - t:.2f}s | 原始输出前200字: {str(result.text)[:200]}"
        )

        sentences = []
        # result.segments: list of dict with start_time / end_time / text / speaker_id
        if hasattr(result, "segments") and result.segments:
            for seg in result.segments:
                start = round(float(seg.get("start_time", 0)) + time_offset, 3)
                end = round(float(seg.get("end_time", 0)) + time_offset, 3)
                text = str(seg.get("text", "")).strip()
                if text:
                    sentences.append({"text": text, "start": start, "end": end})
                    log.debug(
                        f"[VibeVoice] 段 [{start:.2f}-{end:.2f}s] 「{text[:40]}」"
                    )
        else:
            # 兜底：仅有 result.text，无段落信息
            log.warning("[VibeVoice] 无 segments，尝试 result.text 兜底")
            text = str(result.text).strip()
            if text:
                sentences.append(
                    {
                        "text": text,
                        "start": time_offset,
                        "end": time_offset + len(audio) / SAMPLE_RATE,
                    }
                )

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


def transcribe(
    audio: np.ndarray, chunk_id: int, time_offset: float
) -> tuple[int, list[dict]]:
    if len(audio) < SAMPLE_RATE * 0.3:
        log.warning(f"[推理] 音频过短 ({len(audio) / SAMPLE_RATE:.2f}s)，跳过")
        return chunk_id, []
    if active_model != "vibevoice" and len(audio) > SAMPLE_RATE * MAX_SEGMENT_SECONDS:
        log.warning(f"[推理] 音频截断至 {MAX_SEGMENT_SECONDS}s")
        audio = audio[: int(SAMPLE_RATE * MAX_SEGMENT_SECONDS)]

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

    async def run_inference_task(
        segment: np.ndarray, chunk_id: int, time_offset: float, overlap_after: float
    ):
        try:
            cid, sentences = await loop.run_in_executor(
                None, transcribe, segment, chunk_id, time_offset
            )
            if overlap_after > 0:
                # 保留 [time_offset, time_offset+overlap_after) 区间内的句子
                # 超出 overlap_after 的部分属于本块的尾部重叠上下文，将由下一块负责，避免重复
                cutoff = time_offset + overlap_after
                before = len(sentences)
                sentences = [
                    s
                    for s in sentences
                    if (time_offset - 0.1) <= s["start"] < (cutoff + 0.1)
                ]
                log.info(
                    f"[任务] 重叠过滤: [{time_offset:.2f}s, {cutoff:.2f}s), {before}→{len(sentences)} 句"
                )
            else:
                # 末块或无重叠块：仅过滤掉时间戳异常漂移到本块之前的句子
                before = len(sentences)
                sentences = [s for s in sentences if s["start"] >= time_offset - 0.1]
                if before != len(sentences):
                    log.info(f"[任务] 末块时间戳修正: {before}→{len(sentences)} 句")
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
                        await send_json(
                            {"type": "model_status", "error": f"未知模型: {requested}"}
                        )
                        continue

                    # VibeVoice 懒加载
                    if (
                        requested == "vibevoice"
                        and not MODEL_REGISTRY["vibevoice"]["loaded"]
                    ):
                        log.info("[WS] VibeVoice 尚未加载，开始加载...")
                        await send_json(
                            {
                                "type": "model_status",
                                "current_model": requested,
                                "loading": True,
                            }
                        )
                        ok = await loop.run_in_executor(None, _load_vibevoice)
                        if not ok:
                            await send_json(
                                {
                                    "type": "model_status",
                                    "current_model": active_model,
                                    "loading": False,
                                    "error": "VibeVoice 加载失败，已保持原模型",
                                }
                            )
                            continue

                    active_model = requested
                    log.info(f"[WS] 模型切换成功: {active_model}")
                    await send_json(
                        {
                            "type": "model_status",
                            "current_model": active_model,
                            "loading": False,
                        }
                    )
                    continue

                # chunk 元数据
                if msg_type == "chunk_meta":
                    pending_meta = meta
                    log.info(
                        f"[WS] chunk_meta: id={meta.get('chunk_id')} "
                        f"offset={meta.get('time_offset', 0):.3f}s "
                        f"overlap={meta.get('overlap_after', 0):.3f}s"
                    )
                    continue

                log.debug(f"[WS] 未知消息类型: {msg_type}")
                continue

            # ── 二进制消息：PCM ───────────────────────────
            if isinstance(message, bytes):
                chunk_id, time_offset, overlap_after = 0, 0.0, 0.0
                if pending_meta:
                    chunk_id = int(pending_meta.get("chunk_id", 0))
                    time_offset = float(pending_meta.get("time_offset", 0.0))
                    overlap_after = float(pending_meta.get("overlap_after", 0.0))
                    pending_meta = None

                log.info(
                    f"[WS] PCM: chunk_id={chunk_id} {len(message)} bytes offset={time_offset:.3f}s overlap={overlap_after:.3f}s model={active_model}"
                )
                segment = _pcm16_to_float32(message)
                asyncio.create_task(
                    run_inference_task(segment, chunk_id, time_offset, overlap_after)
                )
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


async def main(args: argparse.Namespace):
    global websockets

    apply_config(args)
    import websockets as websockets_module

    websockets = websockets_module
    _load_qwen3()

    log.info(f"启动 WebSocket 服务: ws://{HOST}:{PORT}")
    log.info(f"ASR 后端: {BACKEND}")
    log.info(f"默认模型: {active_model}")
    log.info(f"VibeVoice 模型: {VIBEVOICE_ID}")
    log.info("等待插件连接... (Ctrl+C 停止)")

    async with websockets.serve(
        handle_client,
        HOST,
        PORT,
        max_size=500 * 1024 * 1024,  # 500MB（VibeVoice 60min 音频）
        ping_interval=30,
        ping_timeout=120,
    ):
        await asyncio.Future()


if __name__ == "__main__":
    try:
        cli_args = parse_args()
        asyncio.run(main(cli_args))
    except KeyboardInterrupt:
        log.info("服务已停止")
        sys.exit(0)
