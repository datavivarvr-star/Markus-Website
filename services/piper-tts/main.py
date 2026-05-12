import base64
import io
import logging
import os
import subprocess
import time
import wave
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from piper import PiperVoice

VOICE_DIR = Path(os.environ.get("VOICE_DIR", "/voices"))
VOICE_NAME = os.environ.get("VOICE_NAME", "en_US-ryan-medium")
ESPEAK_VOICE = os.environ.get("ESPEAK_VOICE", "en-us")
LOG_LEVEL = os.environ.get("LOG_LEVEL", "info").upper()
MAX_CHARS = int(os.environ.get("MAX_CHARS", "2000"))

logging.basicConfig(
    level=LOG_LEVEL,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("piper-tts")

app = FastAPI(title="piper-tts", version="0.1.0")

_voice: Optional[PiperVoice] = None
_sample_rate: Optional[int] = None


def _load_voice() -> None:
    global _voice, _sample_rate
    onnx_path = VOICE_DIR / f"{VOICE_NAME}.onnx"
    config_path = VOICE_DIR / f"{VOICE_NAME}.onnx.json"

    if not onnx_path.exists() or not config_path.exists():
        log.error(
            "voice files missing: onnx=%s exists=%s, config=%s exists=%s",
            onnx_path, onnx_path.exists(), config_path, config_path.exists(),
        )
        return

    log.info("loading voice: %s", onnx_path)
    _voice = PiperVoice.load(str(onnx_path), config_path=str(config_path))
    _sample_rate = getattr(_voice.config, "sample_rate", None) or _voice.config.audio.sample_rate
    log.info("voice loaded: %s sample_rate=%s", VOICE_NAME, _sample_rate)


_load_voice()


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
    return {
        "ok": _voice is not None,
        "voice": VOICE_NAME,
        "voice_loaded": _voice is not None,
        "sample_rate": _sample_rate,
        "espeak_voice": ESPEAK_VOICE,
    }


@app.post("/synthesize", response_model=SynthesizeResponse)
def synthesize(req: SynthesizeRequest):
    if _voice is None:
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
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        _voice.synthesize(text, wf)
    data = buf.getvalue()
    with wave.open(io.BytesIO(data), "rb") as wf:
        sr = wf.getframerate()
    return data, sr


def _wav_duration_ms(wav_bytes: bytes) -> int:
    with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
        frames = wf.getnframes()
        sr = wf.getframerate()
        return int(frames * 1000 / sr)


def _phonemes_with_timing(text: str, audio_ms: int) -> tuple[list[dict], str]:
    phonemes = _espeak_phonemes(text)
    if not phonemes:
        return [], "none"
    return _distribute_durations(phonemes, audio_ms), "espeak_proportional"


def _espeak_phonemes(text: str) -> List[str]:
    try:
        result = subprocess.run(
            ["espeak-ng", "-v", ESPEAK_VOICE, "-q", "--sep=_", "--ipa", "--", text],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except FileNotFoundError:
        log.warning("espeak-ng not installed; phoneme timing disabled")
        return []
    except subprocess.TimeoutExpired:
        log.warning("espeak-ng timed out for text len=%d", len(text))
        return []

    if result.returncode != 0:
        log.warning("espeak-ng exit=%d stderr=%s", result.returncode, result.stderr[:200])
        return []

    raw = result.stdout.strip()
    tokens: List[str] = []
    words = raw.split()
    for i, word in enumerate(words):
        if i > 0:
            tokens.append("_")
        for p in word.split("_"):
            p = p.strip()
            if p:
                tokens.append(p)
    return tokens


_VOWEL_CHARS = set("aeiouɑɒæɛɪɔʊʌəɚɝœøyʏɵɜɐ")
_STOP_CHARS = set("pbtdkgʔɖɟʈc")
_FRICATIVE_CHARS = set("fvszʃʒθðxɣçhɦ")
_NASAL_CHARS = set("mnŋɲɳ")


def _weight(p: str) -> float:
    if not p or p == "_":
        return 0.4
    if any(ch in _VOWEL_CHARS for ch in p):
        return 2.0
    head = p[0]
    if head in _STOP_CHARS:
        return 0.5
    if head in _FRICATIVE_CHARS:
        return 1.3
    if head in _NASAL_CHARS:
        return 1.0
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
        t0 = cursor
        t1 = cursor + dur
        out.append({
            "p": p,
            "t0_ms": int(round(t0)),
            "t1_ms": int(round(t1)),
        })
        cursor = t1

    if out:
        out[-1]["t1_ms"] = total_ms
    return out
