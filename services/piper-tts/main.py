import base64
import io
import logging
import os
import subprocess
import sys
import tempfile
import threading
import time
import wave
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

# Windows → use piper.exe subprocess (no Python wheel available).
# Linux/Docker → use piper-tts Python package (has manylinux wheels for 3.11).
_IS_WIN = sys.platform == "win32"

PIPER_EXE = Path(os.environ.get(
    "PIPER_EXE",
    str(Path(__file__).parent / "bin" / "piper" / "piper.exe"),
))
VOICE_DIR = Path(os.environ.get(
    "VOICE_DIR",
    str(Path(__file__).parent / "voices"),
))
VOICE_NAME = os.environ.get("VOICE_NAME", "en_US-ryan-medium")
LOG_LEVEL = os.environ.get("LOG_LEVEL", "info").upper()
MAX_CHARS = int(os.environ.get("MAX_CHARS", "2000"))

logging.basicConfig(
    level=LOG_LEVEL,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("piper-tts")

app = FastAPI(title="piper-tts", version="0.4.0")

_sample_rate: Optional[int] = None
_voice_ready = False

# Serialise Windows piper.exe calls — each subprocess loads the 60 MB ONNX
# model so concurrent calls saturate CPU/RAM. On Linux the model is loaded
# once into _piper_voice; the lock is only used there for lazy init.
_piper_lock = threading.Lock()

_gruut = None          # gruut module, pre-loaded at startup
_piper_voice = None    # Linux: PiperVoice instance (lazy, cached)


def _check_voice() -> None:
    global _voice_ready
    onnx = VOICE_DIR / f"{VOICE_NAME}.onnx"
    cfg  = VOICE_DIR / f"{VOICE_NAME}.onnx.json"
    if not onnx.exists() or not cfg.exists():
        log.error("voice files missing: %s", onnx)
        return
    if _IS_WIN and not PIPER_EXE.exists():
        log.error("piper.exe not found at: %s", PIPER_EXE)
        return
    _voice_ready = True
    backend = f"piper.exe ({PIPER_EXE})" if _IS_WIN else "piper-tts Python package"
    log.info("voice ready: %s  backend: %s", VOICE_NAME, backend)


def _warmup() -> None:
    global _gruut
    try:
        import gruut as _g
        _gruut = _g
        list(_gruut.sentences("Hello.", lang="en-us"))
        log.info("gruut pre-loaded")
    except Exception as exc:
        log.warning("gruut pre-load failed: %s", exc)

    if _voice_ready:
        try:
            _synthesize_audio("Hello.")
            log.info("warmup synthesis complete")
        except Exception as exc:
            log.warning("warmup synthesis failed: %s", exc)


_check_voice()
threading.Thread(target=_warmup, daemon=True, name="warmup").start()


class SynthesizeRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=MAX_CHARS)


class Phoneme(BaseModel):
    p: str
    t0_ms: int
    t1_ms: int


class SynthesizeResponse(BaseModel):
    audio_b64: str
    format: str
    sample_rate: int
    audio_ms: int
    phonemes: List[Phoneme]
    timing_source: str


@app.get("/health")
def health():
    info: dict = {
        "ok": _voice_ready,
        "voice": VOICE_NAME,
        "voice_loaded": _voice_ready,
        "sample_rate": _sample_rate,
        "platform": sys.platform,
        "gruut_loaded": _gruut is not None,
    }
    if _IS_WIN:
        info["piper_exe"] = str(PIPER_EXE)
        info["piper_exe_exists"] = PIPER_EXE.exists()
    else:
        info["piper_voice_loaded"] = _piper_voice is not None
    return info


@app.post("/synthesize", response_model=SynthesizeResponse)
def synthesize(req: SynthesizeRequest):
    if not _voice_ready:
        raise HTTPException(503, "voice_not_loaded")

    text = req.text.strip()
    if not text:
        raise HTTPException(400, "empty_text")

    t0 = time.time()
    wav_bytes, sample_rate = _synthesize_audio(text)
    audio_ms = _wav_duration_ms(wav_bytes)
    phonemes, timing_source = _phonemes_with_timing(text, audio_ms)

    elapsed_ms = int((time.time() - t0) * 1000)
    log.info(
        "synthesized chars=%d audio_ms=%d phonemes=%d took_ms=%d source=%s",
        len(text), audio_ms, len(phonemes), elapsed_ms, timing_source,
    )

    return SynthesizeResponse(
        audio_b64=base64.b64encode(wav_bytes).decode("ascii"),
        format="wav",
        sample_rate=sample_rate,
        audio_ms=audio_ms,
        phonemes=[Phoneme(**p) for p in phonemes],
        timing_source=timing_source,
    )


def _synthesize_audio(text: str) -> tuple[bytes, int]:
    if _IS_WIN:
        return _synthesize_win32(text)
    return _synthesize_linux(text)


def _synthesize_win32(text: str) -> tuple[bytes, int]:
    """Windows local dev: call piper.exe via subprocess."""
    global _sample_rate
    onnx = VOICE_DIR / f"{VOICE_NAME}.onnx"
    cfg  = VOICE_DIR / f"{VOICE_NAME}.onnx.json"

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        tmp = f.name

    try:
        with _piper_lock:
            proc = subprocess.Popen(
                [str(PIPER_EXE), "--model", str(onnx), "--config", str(cfg), "--output_file", tmp],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=str(PIPER_EXE.parent),
            )
            try:
                _, stderr = proc.communicate(input=text.encode(), timeout=20)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.communicate()
                raise RuntimeError("piper.exe timed out after 20 s")

        if proc.returncode != 0:
            raise RuntimeError(
                f"piper.exe failed (exit {proc.returncode}): "
                f"{stderr[:300].decode(errors='replace')}"
            )

        with open(tmp, "rb") as f:
            wav_bytes = f.read()
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass

    with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
        sr = wf.getframerate()

    _sample_rate = sr
    return wav_bytes, sr


def _synthesize_linux(text: str) -> tuple[bytes, int]:
    """Linux / Docker: use piper-tts Python package (manylinux wheel)."""
    global _sample_rate, _piper_voice

    # Lazy init — double-checked locking so concurrent calls don't double-load.
    if _piper_voice is None:
        with _piper_lock:
            if _piper_voice is None:
                from piper import PiperVoice  # type: ignore[import]
                onnx = VOICE_DIR / f"{VOICE_NAME}.onnx"
                cfg  = VOICE_DIR / f"{VOICE_NAME}.onnx.json"
                _piper_voice = PiperVoice.load(
                    str(onnx), config_path=str(cfg), use_cuda=False
                )
                log.info("PiperVoice loaded: %s", VOICE_NAME)

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        _piper_voice.synthesize(text, wf)
    wav_bytes = buf.getvalue()

    with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
        sr = wf.getframerate()

    _sample_rate = sr
    return wav_bytes, sr


def _wav_duration_ms(wav_bytes: bytes) -> int:
    with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
        return int(wf.getnframes() * 1000 / wf.getframerate())


def _phonemes_with_timing(text: str, audio_ms: int) -> tuple[list[dict], str]:
    phonemes = _gruut_phonemes(text)
    if not phonemes:
        return [], "none"
    return _distribute_durations(phonemes, audio_ms), "gruut_proportional"


def _gruut_phonemes(text: str) -> List[str]:
    global _gruut
    try:
        if _gruut is None:
            import gruut as _g
            _gruut = _g
        tokens: List[str] = []
        for sentence in _gruut.sentences(text, lang="en-us"):
            for word in sentence:
                if not word.phonemes:
                    continue
                tokens.extend(word.phonemes)
                tokens.append("_")
        if tokens and tokens[-1] == "_":
            tokens.pop()
        return tokens
    except Exception as exc:
        log.warning("gruut phonemization failed: %s", exc)
        return []


_VOWEL_CHARS     = set("aeiouɑɒæɛɪɔʊʌəɚɝœøyʏɵɜɐ")
_STOP_CHARS      = set("pbtdkgʔɖɟʈc")
_FRICATIVE_CHARS = set("fvszʃʒθðxɣçhɦ")
_NASAL_CHARS     = set("mnŋɲɳ")


def _weight(p: str) -> float:
    if not p or p == "_":
        return 0.4
    if any(ch in _VOWEL_CHARS for ch in p):
        return 2.0
    head = p[0]
    if head in _STOP_CHARS:      return 0.5
    if head in _FRICATIVE_CHARS: return 1.3
    if head in _NASAL_CHARS:     return 1.0
    return 1.0


def _distribute_durations(phonemes: List[str], total_ms: int) -> list[dict]:
    if not phonemes or total_ms <= 0:
        return []
    weights = [_weight(p) for p in phonemes]
    total_w = sum(weights) or 1.0
    out: list[dict] = []
    cursor = 0.0
    for p, w in zip(phonemes, weights):
        dur = total_ms * (w / total_w)
        out.append({"p": p, "t0_ms": int(round(cursor)), "t1_ms": int(round(cursor + dur))})
        cursor += dur
    if out:
        out[-1]["t1_ms"] = total_ms
    return out
