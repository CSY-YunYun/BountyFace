import json
import os

os.environ["STORAGE_BACKEND"] = "memory"
import main
from fastapi.testclient import TestClient

from main import (
    GeneratedBaseProfile,
    GeneratedTargetAnalysis,
    VisualAnalysis,
    app,
    pending_scans,
    targets,
)


client = TestClient(app)


def face_embedding(*values: float) -> list[float]:
    return [*values, *([0.0] * (256 - len(values)))]


MOCK_EMBEDDING = face_embedding(0.0123, -0.4567, 0.8912)
MOCK_EMBEDDING_JSON = json.dumps(MOCK_EMBEDDING)


def setup_function():
    targets.clear()
    pending_scans.clear()


def test_new_target_then_existing_target_flow(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    first_scan = client.post("/v1/scan", json={"faceEmbedding": MOCK_EMBEDDING})
    assert first_scan.status_code == 200
    assert first_scan.json()["matchFound"] is False

    temporary_scan_id = first_scan.json()["temporaryScanId"]
    generated = client.post(
        "/v1/targets/generate",
        data={
            "temporaryScanId": temporary_scan_id,
            "faceEmbedding": MOCK_EMBEDDING_JSON,
            "scanMode": "field",
        },
    )
    assert generated.status_code == 200
    assert generated.json()["generationSource"] == "mock"
    target_id = generated.json()["targetId"]
    assert generated.json()["profile"]["display_name"] == "匿名目標"
    assert generated.json()["profile"]["codename"] == "黑曜石・當前型態"

    second_scan = client.post("/v1/scan", json={"faceEmbedding": MOCK_EMBEDDING})
    assert second_scan.status_code == 200
    assert second_scan.json()["matchFound"] is True
    assert second_scan.json()["matchStatus"] == "confirmed"
    assert second_scan.json()["targetId"] == target_id

    target = client.get(f"/v1/targets/{target_id}")
    assert target.status_code == 200
    assert target.json()["profile"]["base_power"] == 9842

    similar_scan = client.post(
        "/v1/scan",
        json={"faceEmbedding": face_embedding(0.013, -0.45, 0.89)},
    )
    assert similar_scan.status_code == 200
    assert similar_scan.json()["matchFound"] is True


def test_possible_match_confirmation_adds_face_variant(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    first_embedding = face_embedding(1.0, 0.0)
    possible_embedding = face_embedding(0.6, 0.8)
    first_scan = client.post("/v1/scan", json={"faceEmbedding": first_embedding})
    generated = client.post(
        "/v1/targets/generate",
        data={
            "temporaryScanId": first_scan.json()["temporaryScanId"],
            "faceEmbedding": json.dumps(first_embedding),
            "scanMode": "field",
        },
    )
    target_id = generated.json()["targetId"]

    possible = client.post("/v1/scan", json={"faceEmbedding": possible_embedding})
    assert possible.json()["matchStatus"] == "possible"
    assert possible.json()["targetId"] == target_id

    confirmed = client.post(
        f"/v1/targets/{target_id}/confirm",
        json={"temporaryScanId": possible.json()["temporaryScanId"]},
    )
    assert confirmed.status_code == 200
    assert confirmed.json()["embeddingCount"] == 2

    rescanned = client.post("/v1/scan", json={"faceEmbedding": possible_embedding})
    assert rescanned.json()["matchStatus"] == "confirmed"


def test_unknown_target_returns_404():
    response = client.get("/v1/targets/missing")
    assert response.status_code == 404


def test_scan_rejects_embedding_with_wrong_dimension():
    response = client.post("/v1/scan", json={"faceEmbedding": [1.0, 0.0]})
    assert response.status_code == 422


def test_generate_target_uses_scan_image(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    async def fake_generate_target(image: bytes, media_type: str):
        assert image == b"fake-jpeg"
        assert media_type == "image/jpeg"
        return GeneratedTargetAnalysis(
            profile=GeneratedBaseProfile(
                codename="夜行者",
                base_power=7200,
                threat_level="A",
                level=64,
                str=60,
                dex=88,
                int=72,
                luk=55,
                description="擅長快速偵察的敏捷型角色。",
            ),
            scan=VisualAnalysis(
                scan_title="夜行偵察型態",
                equipment_tier="advanced",
                style_tier="distinctive",
                pose_tier="dynamic",
                detected_items=["Long coat"],
                current_status="偵察中",
            ),
        )

    monkeypatch.setattr(main, "generate_target_from_image", fake_generate_target)
    scan = client.post("/v1/scan", json={"faceEmbedding": MOCK_EMBEDDING})
    generated = client.post(
        "/v1/targets/generate",
        data={
            "temporaryScanId": scan.json()["temporaryScanId"],
            "faceEmbedding": MOCK_EMBEDDING_JSON,
            "scanMode": "field",
        },
        files={"scanImage": ("scan.jpg", b"fake-jpeg", "image/jpeg")},
    )

    assert generated.status_code == 200
    assert generated.json()["generationSource"] == "ai"
    assert generated.json()["profile"]["display_name"] == "匿名目標"
    assert generated.json()["profile"]["codename"] == "夜行偵察型態"
    assert generated.json()["profile"]["base_power"] == 7200
    assert generated.json()["scan_result"]["equipment_bonus"] == 260
    assert generated.json()["scan_result"]["current_power"] == 7660


def test_existing_target_keeps_base_profile_and_recalculates_scan(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    scan = client.post("/v1/scan", json={"faceEmbedding": MOCK_EMBEDDING})
    generated = client.post(
        "/v1/targets/generate",
        data={
            "temporaryScanId": scan.json()["temporaryScanId"],
            "faceEmbedding": MOCK_EMBEDDING_JSON,
            "scanMode": "field",
        },
    )
    target_id = generated.json()["targetId"]

    analyzed = client.post(
        f"/v1/targets/{target_id}/analyze",
        files={"scanImage": ("scan.jpg", b"another-jpeg", "image/jpeg")},
    )

    assert analyzed.status_code == 200
    assert analyzed.json()["profile"]["base_power"] == 9842
    assert analyzed.json()["scan_result"]["current_power"] == 10302


def test_ai_generation_requires_scan_image(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    scan = client.post("/v1/scan", json={"faceEmbedding": MOCK_EMBEDDING})
    generated = client.post(
        "/v1/targets/generate",
        data={
            "temporaryScanId": scan.json()["temporaryScanId"],
            "faceEmbedding": MOCK_EMBEDDING_JSON,
            "scanMode": "field",
        },
    )

    assert generated.status_code == 422
    assert generated.json()["detail"] == "Scan image is required for AI generation."


def test_selfie_display_name_is_editable(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    scan = client.post("/v1/scan", json={"faceEmbedding": MOCK_EMBEDDING})
    generated = client.post(
        "/v1/targets/generate",
        data={
            "temporaryScanId": scan.json()["temporaryScanId"],
            "faceEmbedding": MOCK_EMBEDDING_JSON,
            "scanMode": "selfie",
        },
    )
    profile = generated.json()["profile"]
    assert profile["display_name"] == "匿名"
    assert profile["is_name_editable"] is True

    updated = client.patch(
        f"/v1/targets/{profile['id']}",
        json={"displayName": "Joey", "scanMode": "selfie"},
    )
    assert updated.status_code == 200
    assert updated.json()["profile"]["display_name"] == "Joey"


def test_field_display_name_is_not_editable(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    scan = client.post("/v1/scan", json={"faceEmbedding": MOCK_EMBEDDING})
    generated = client.post(
        "/v1/targets/generate",
        data={
            "temporaryScanId": scan.json()["temporaryScanId"],
            "faceEmbedding": MOCK_EMBEDDING_JSON,
            "scanMode": "field",
        },
    )
    profile = generated.json()["profile"]
    assert profile["display_name"] == "匿名目標"
    assert profile["is_name_editable"] is False

    updated = client.patch(
        f"/v1/targets/{profile['id']}",
        json={"displayName": "Not allowed", "scanMode": "field"},
    )
    assert updated.status_code == 403


def test_public_figure_display_name_is_never_editable(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    scan = client.post("/v1/scan", json={"faceEmbedding": MOCK_EMBEDDING})
    generated = client.post(
        "/v1/targets/generate",
        data={
            "temporaryScanId": scan.json()["temporaryScanId"],
            "faceEmbedding": MOCK_EMBEDDING_JSON,
            "scanMode": "selfie",
        },
    )
    target_id = generated.json()["targetId"]
    targets[target_id].profile.display_name = "管理員"
    targets[target_id].profile.is_public_figure = True
    targets[target_id].profile.is_name_editable = False

    updated = client.patch(
        f"/v1/targets/{target_id}",
        json={"displayName": "Not allowed", "scanMode": "selfie"},
    )
    assert updated.status_code == 403
