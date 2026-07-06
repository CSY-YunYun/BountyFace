import base64
import builtins
import json
import logging
import math
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Any, Literal
from uuid import uuid4

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from openai import AsyncOpenAI
from pydantic import BaseModel, ConfigDict, Field
from dotenv import load_dotenv

try:
    from supabase import Client, create_client
except ImportError:  # The memory backend remains available without Supabase extras.
    Client = None
    create_client = None


load_dotenv(Path(__file__).with_name(".env"), override=False)
logger = logging.getLogger("uvicorn.error")


class ScanRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    face_embedding: list[float] = Field(alias="faceEmbedding", min_length=256, max_length=256)


class ConfirmMatchRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    temporary_scan_id: str = Field(alias="temporaryScanId")


class UpdateDisplayNameRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    display_name: str = Field(alias="displayName", min_length=1, max_length=40)
    scan_mode: Literal["selfie", "field"] = Field(alias="scanMode")


class TargetProfile(BaseModel):
    id: str
    display_name: str
    title: str = ""
    base_power: int
    threat_level: str
    level: int
    str: int
    dex: int
    int: int
    luk: int
    description: str
    is_public_figure: bool = False
    is_verified: bool = False
    is_name_editable: bool = False


class GeneratedBaseProfile(BaseModel):
    base_power: builtins.int = Field(ge=1, le=99999)
    threat_level: builtins.str = Field(pattern="^(D|C|B|A|S|SS)$")
    level: builtins.int = Field(ge=1, le=100)
    str: builtins.int = Field(ge=1, le=100)
    dex: builtins.int = Field(ge=1, le=100)
    int: builtins.int = Field(ge=1, le=100)
    luk: builtins.int = Field(ge=1, le=100)
    description: builtins.str = Field(min_length=1, max_length=240)


class VisualAnalysis(BaseModel):
    scan_title: builtins.str = Field(min_length=1, max_length=40)
    equipment_tier: Literal["none", "basic", "advanced", "elite"]
    style_tier: Literal["plain", "coordinated", "distinctive", "iconic"]
    pose_tier: Literal["neutral", "ready", "dynamic", "dominant"]
    detected_items: list[builtins.str] = Field(max_length=8)
    current_status: builtins.str = Field(min_length=1, max_length=80)


class GeneratedTargetAnalysis(BaseModel):
    profile: GeneratedBaseProfile
    scan: VisualAnalysis


class ScanResult(BaseModel):
    current_title: str
    equipment_bonus: int
    style_bonus: int
    pose_bonus: int
    current_power: int
    detected_items: list[str]
    current_status: str


@dataclass
class StoredTarget:
    embedding_keys: list[tuple[float, ...]]
    profile: TargetProfile


app = FastAPI(title="BountyFace Mock Backend", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

targets: dict[str, StoredTarget] = {}
pending_scans: dict[str, tuple[float, ...]] = {}
EMBEDDING_DIMENSION = 256
CONFIRMED_MATCH_THRESHOLD = 0.75
POSSIBLE_MATCH_THRESHOLD = 0.45
MAX_EMBEDDINGS_PER_TARGET = 8
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-5.5")
MAX_SCAN_IMAGE_BYTES = 10 * 1024 * 1024
SUPPORTED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}
EQUIPMENT_BONUSES = {"none": 0, "basic": 120, "advanced": 260, "elite": 400}
STYLE_BONUSES = {"plain": 0, "coordinated": 60, "distinctive": 120, "iconic": 200}
POSE_BONUSES = {"neutral": 0, "ready": 40, "dynamic": 80, "dominant": 140}
SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip()
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
STORAGE_BACKEND = os.getenv("STORAGE_BACKEND", "memory").strip().lower()

if STORAGE_BACKEND not in {"memory", "supabase"}:
    raise RuntimeError("STORAGE_BACKEND must be either 'memory' or 'supabase'.")
if STORAGE_BACKEND == "supabase" and not (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY):
    raise RuntimeError("Supabase storage requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.")
if STORAGE_BACKEND == "supabase" and create_client is None:
    raise RuntimeError("Install server requirements before enabling Supabase storage.")

supabase: Any = (
    create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    if STORAGE_BACKEND == "supabase" and create_client is not None
    else None
)


def embedding_key(embedding: list[float]) -> tuple[float, ...]:
    return tuple(round(value, 6) for value in embedding)


def storage_name() -> str:
    return "supabase" if supabase is not None else "memory"


def get_stored_profile(target_id: str) -> TargetProfile | None:
    if supabase is None:
        target = targets.get(target_id)
        return target.profile if target else None

    response = supabase.table("targets").select("*").eq("id", target_id).limit(1).execute()
    if not response.data:
        return None
    return TargetProfile.model_validate(response.data[0])


def find_best_embedding_match(key: tuple[float, ...]) -> tuple[float, str] | None:
    if supabase is None:
        matches = [
            (
                max(cosine_similarity(key, stored_embedding) for stored_embedding in target.embedding_keys),
                target_id,
            )
            for target_id, target in targets.items()
            if target.embedding_keys
        ]
        return max(matches) if matches else None

    response = supabase.rpc(
        "match_target_embeddings",
        {"query_embedding": list(key), "match_count": 1},
    ).execute()
    if not response.data:
        return None
    match = response.data[0]
    return float(match["similarity"]), str(match["target_id"])


def add_stored_embedding(
    target_id: str,
    key: tuple[float, ...],
    source: str,
    quality_score: float = 1.0,
) -> int:
    if supabase is None:
        target = targets.get(target_id)
        if target is None:
            raise KeyError(target_id)
        target.embedding_keys.append(key)
        target.embedding_keys = target.embedding_keys[-MAX_EMBEDDINGS_PER_TARGET:]
        return len(target.embedding_keys)

    response = supabase.rpc(
        "add_target_embedding",
        {
            "p_target_id": target_id,
            "p_embedding": list(key),
            "p_source": source,
            "p_quality_score": quality_score,
        },
    ).execute()
    result = response.data[0] if isinstance(response.data, list) else response.data
    return int(result)


def create_stored_target(profile: TargetProfile, key: tuple[float, ...], source: str) -> None:
    if supabase is None:
        targets[profile.id] = StoredTarget(embedding_keys=[key], profile=profile)
        return

    supabase.table("targets").insert(profile.model_dump()).execute()
    try:
        add_stored_embedding(profile.id, key, source)
    except Exception:
        supabase.table("targets").delete().eq("id", profile.id).execute()
        raise


def update_stored_profile(profile: TargetProfile) -> None:
    if supabase is None:
        return
    supabase.table("targets").update(profile.model_dump(exclude={"id"})).eq("id", profile.id).execute()


def cosine_similarity(first: tuple[float, ...], second: tuple[float, ...]) -> float:
    if len(first) != len(second):
        return 0.0
    first_norm = math.sqrt(sum(value * value for value in first))
    second_norm = math.sqrt(sum(value * value for value in second))
    if first_norm == 0 or second_norm == 0:
        return 0.0
    return sum(a * b for a, b in zip(first, second, strict=True)) / (first_norm * second_norm)


def mock_generated_profile() -> GeneratedBaseProfile:
    return GeneratedBaseProfile(
        base_power=9842,
        threat_level="S",
        level=87,
        str=82,
        dex=91,
        int=35,
        luk=99,
        description="敏捷型角色，擅長高速移動與突襲，經常出沒於城市夜間區域。",
    )


def mock_visual_analysis() -> VisualAnalysis:
    return VisualAnalysis(
        scan_title="黑曜石・當前型態",
        equipment_tier="advanced",
        style_tier="distinctive",
        pose_tier="dynamic",
        detected_items=["Black coat"],
        current_status="Combat ready",
    )


def build_scan_result(profile: TargetProfile, analysis: VisualAnalysis) -> ScanResult:
    equipment_bonus = EQUIPMENT_BONUSES[analysis.equipment_tier]
    style_bonus = STYLE_BONUSES[analysis.style_tier]
    pose_bonus = POSE_BONUSES[analysis.pose_tier]
    return ScanResult(
        current_title=analysis.scan_title,
        equipment_bonus=equipment_bonus,
        style_bonus=style_bonus,
        pose_bonus=pose_bonus,
        current_power=profile.base_power + equipment_bonus + style_bonus + pose_bonus,
        detected_items=analysis.detected_items,
        current_status=analysis.current_status,
    )


def image_input(image: bytes, media_type: str) -> dict[str, str]:
    encoded_image = base64.b64encode(image).decode("ascii")
    return {
        "type": "input_image",
        "image_url": f"data:{media_type};base64,{encoded_image}",
        "detail": "low",
    }


async def generate_target_from_image(image: bytes, media_type: str) -> GeneratedTargetAnalysis:
    client = AsyncOpenAI()
    response = await client.responses.parse(
        model=OPENAI_MODEL,
        input=[
            {
                "role": "system",
                "content": (
                    "You create fictional RPG character cards and classify current scan visuals. "
                    "Never identify the person or infer sensitive traits. Base the fictional card "
                    "only on visible clothing, pose, carried objects, and scene. Return "
                    "description, scan_title, and current_status in Traditional Chinese."
                ),
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": (
                            "Create one persistent base profile, then classify this scan using only "
                            "the allowed equipment, style, and pose tier enum values."
                        ),
                    },
                    image_input(image, media_type),
                ],
            },
        ],
        text_format=GeneratedTargetAnalysis,
    )
    if response.output_parsed is None:
        raise RuntimeError("The model did not return a profile.")
    return response.output_parsed


async def analyze_scan_image(image: bytes, media_type: str) -> VisualAnalysis:
    client = AsyncOpenAI()
    response = await client.responses.parse(
        model=OPENAI_MODEL,
        input=[
            {
                "role": "system",
                "content": (
                    "Classify only visible equipment, clothing style, pose, and carried objects for "
                    "a fictional RPG scan. Never identify the person or infer sensitive traits. "
                    "Use only the provided tier enum values. Return scan_title and current_status "
                    "in Traditional Chinese. The scan title should reflect the current equipment and style."
                ),
            },
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": "Analyze the current visual scan."},
                    image_input(image, media_type),
                ],
            },
        ],
        text_format=VisualAnalysis,
    )
    if response.output_parsed is None:
        raise RuntimeError("The model did not return a scan analysis.")
    return response.output_parsed


async def read_scan_image(scan_image: UploadFile) -> tuple[bytes, str]:
    media_type = scan_image.content_type or ""
    if media_type not in SUPPORTED_IMAGE_TYPES:
        await scan_image.close()
        raise HTTPException(status_code=415, detail="Unsupported scan image type.")
    image = await scan_image.read(MAX_SCAN_IMAGE_BYTES + 1)
    await scan_image.close()
    if not image:
        raise HTTPException(status_code=422, detail="Scan image is empty.")
    if len(image) > MAX_SCAN_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Scan image is too large.")
    return image, media_type


@app.get("/health")
def health_check():
    return {
        "status": "ok",
        "aiConfigured": bool(os.getenv("OPENAI_API_KEY")),
        "profileModel": OPENAI_MODEL,
        "storage": storage_name(),
        "embeddingDimension": EMBEDDING_DIMENSION,
    }


@app.post("/v1/scan")
def scan_target(request: ScanRequest):
    key = embedding_key(request.face_embedding)
    best_confidence = 0.0
    best_match = find_best_embedding_match(key)
    if best_match:
        confidence, target_id = best_match
        best_confidence = confidence
        logger.info(
            "Face match candidate target=%s confidence=%.4f threshold=%.2f",
            target_id,
            confidence,
            CONFIRMED_MATCH_THRESHOLD,
        )
        if confidence >= CONFIRMED_MATCH_THRESHOLD:
            if confidence < 0.995:
                add_stored_embedding(target_id, key, "confirmed_match")
            return {
                "status": "SUCCESS",
                "matchStatus": "confirmed",
                "matchFound": True,
                "targetId": target_id,
                "confidence": round(confidence, 4),
                "message": "Target identified successfully.",
            }

        if confidence >= POSSIBLE_MATCH_THRESHOLD:
            temporary_scan_id = f"temp-{uuid4()}"
            pending_scans[temporary_scan_id] = key
            return {
                "status": "SUCCESS",
                "matchStatus": "possible",
                "matchFound": False,
                "targetId": target_id,
                "temporaryScanId": temporary_scan_id,
                "confidence": round(confidence, 4),
                "message": "Possible target match. Confirmation required.",
            }

    temporary_scan_id = f"temp-{uuid4()}"
    pending_scans[temporary_scan_id] = key
    return {
        "status": "SUCCESS",
        "matchStatus": "new",
        "matchFound": False,
        "confidence": round(best_confidence, 4),
        "temporaryScanId": temporary_scan_id,
        "message": "New face detected. Please generate a profile.",
    }


@app.get("/v1/targets/{target_id}")
def get_target(target_id: str):
    profile = get_stored_profile(target_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="Target not found.")
    return {"status": "SUCCESS", "profile": profile}


@app.patch("/v1/targets/{target_id}")
def update_target_display_name(target_id: str, request: UpdateDisplayNameRequest):
    profile = get_stored_profile(target_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="Target not found.")
    if request.scan_mode != "selfie":
        raise HTTPException(status_code=403, detail="Display name can only be changed in Selfie Mode.")
    if profile.is_public_figure or not profile.is_name_editable:
        raise HTTPException(status_code=403, detail="Display name is not editable for this target.")

    display_name = request.display_name.strip()
    if not display_name:
        raise HTTPException(status_code=422, detail="Display name cannot be empty.")
    profile.display_name = display_name
    update_stored_profile(profile)
    return {"status": "SUCCESS", "profile": profile}


@app.post("/v1/targets/{target_id}/confirm")
def confirm_target_match(target_id: str, request: ConfirmMatchRequest):
    profile = get_stored_profile(target_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="Target not found.")
    pending_key = pending_scans.pop(request.temporary_scan_id, None)
    if pending_key is None:
        raise HTTPException(status_code=404, detail="Temporary scan not found.")
    embedding_count = add_stored_embedding(target_id, pending_key, "user_confirmed")
    return {
        "status": "SUCCESS",
        "message": "Face variant added to target.",
        "profile": profile,
        "embeddingCount": embedding_count,
    }


@app.post("/v1/targets/{target_id}/analyze")
async def analyze_target(target_id: str, scan_image: Annotated[UploadFile, File(alias="scanImage")]):
    profile = get_stored_profile(target_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="Target not found.")

    image, media_type = await read_scan_image(scan_image)
    generation_source = "mock"
    if os.getenv("OPENAI_API_KEY"):
        try:
            analysis = await analyze_scan_image(image, media_type)
            generation_source = "ai"
            logger.info(
                "AI scan analyzed model=%s target=%s analysis=%s",
                OPENAI_MODEL,
                target_id,
                analysis.model_dump_json(),
            )
        except Exception as error:
            logger.exception("AI scan analysis failed")
            raise HTTPException(status_code=502, detail="AI scan analysis failed.") from error
    else:
        analysis = mock_visual_analysis()

    return {
        "status": "SUCCESS",
        "generationSource": generation_source,
        "profile": profile,
        "scan_result": build_scan_result(profile, analysis),
    }


@app.post("/v1/targets/generate")
async def generate_target(
    temporary_scan_id: Annotated[str, Form(alias="temporaryScanId")],
    face_embedding: Annotated[str, Form(alias="faceEmbedding")],
    scan_mode: Annotated[Literal["selfie", "field"], Form(alias="scanMode")],
    scan_image: Annotated[UploadFile | None, File(alias="scanImage")] = None,
):
    pending_key = pending_scans.get(temporary_scan_id)
    if pending_key is None:
        raise HTTPException(status_code=404, detail="Temporary scan not found.")

    try:
        submitted_embedding = json.loads(face_embedding)
        submitted_key = embedding_key([float(value) for value in submitted_embedding])
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        raise HTTPException(status_code=422, detail="Invalid face embedding.") from error

    if len(submitted_key) != EMBEDDING_DIMENSION:
        raise HTTPException(status_code=422, detail="Face embedding must contain 256 values.")
    if submitted_key != pending_key:
        raise HTTPException(status_code=409, detail="Face embedding does not match temporary scan.")

    ai_configured = bool(os.getenv("OPENAI_API_KEY"))
    generation_source = "mock"
    if scan_image is not None:
        image, media_type = await read_scan_image(scan_image)
        if ai_configured:
            try:
                generated = await generate_target_from_image(image, media_type)
                generated_profile = generated.profile
                analysis = generated.scan
                generation_source = "ai"
                logger.info(
                    "AI target generated model=%s result=%s",
                    OPENAI_MODEL,
                    generated.model_dump_json(),
                )
            except Exception as error:
                logger.exception("AI profile generation failed")
                raise HTTPException(status_code=502, detail="AI profile generation failed.") from error
        else:
            generated_profile = mock_generated_profile()
            analysis = mock_visual_analysis()
    else:
        if ai_configured:
            raise HTTPException(status_code=422, detail="Scan image is required for AI generation.")
        generated_profile = mock_generated_profile()
        analysis = mock_visual_analysis()

    target_id = str(uuid4())
    profile_data = generated_profile.model_dump()
    profile = TargetProfile(
        id=target_id,
        display_name="匿名" if scan_mode == "selfie" else "匿名目標",
        is_name_editable=scan_mode == "selfie",
        **profile_data,
    )
    create_stored_target(profile, pending_key, scan_mode)
    pending_scans.pop(temporary_scan_id, None)
    return {
        "status": "SUCCESS",
        "message": "New target profile generated successfully.",
        "generationSource": generation_source,
        "targetId": target_id,
        "profile": profile,
        "scan_result": build_scan_result(profile, analysis),
    }
