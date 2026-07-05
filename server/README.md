# Backend

The backend keeps targets in memory. Restarting the server clears all generated
targets. New targets can use OpenAI vision to generate an RPG profile from the
scan image; no image is written to disk or stored in a database.

## Run

From the repository root:

```bash
source .venv/bin/activate
pip install -r server/requirements.txt
cp server/.env.example server/.env
# Edit server/.env and set OPENAI_API_KEY before starting.
uvicorn server.main:app --reload --host 0.0.0.0 --port 8000
```

`OPENAI_MODEL` defaults to `gpt-5.5`. Without `OPENAI_API_KEY`, profile
generation falls back to the local mock profile so development and tests still
work.

The API documentation is available at `http://localhost:8000/docs`.

## Current API Flow

1. `POST /v1/scan` matches identity using only the face embedding.
2. `POST /v1/targets/generate` creates a new persistent base profile and the
   first per-scan result.
3. Repeating `POST /v1/scan` with that person returns `matchFound: true`.
4. A possible match is resolved with `POST /v1/targets/{targetId}/confirm` or
   by generating a separate new target.
5. `POST /v1/targets/{targetId}/analyze` keeps the base profile unchanged and
   analyzes the current image again.
6. `GET /v1/targets/{targetId}` returns the existing base profile.
7. `PATCH /v1/targets/{targetId}` updates only an allowed Selfie display name.

The model classifies equipment, style, and pose into fixed tiers. FastAPI maps
those tiers to deterministic bonuses and calculates:

```text
current_power = base_power + equipment_bonus + style_bonus + pose_bonus
```

Identity matching uses every embedding stored for a target and takes the
highest cosine similarity:

```text
>= 0.75  confirmed match
0.45-0.75 possible match (confirm or create new)
< 0.45   new target
```

Confirming a possible match adds the current embedding as another face variant
for that target. The thresholds are initial prototype values and should be
calibrated with real-device samples.

Base power, level, threat, and attributes remain attached to the identity.
`scan_title`, equipment, style, pose, items, status, and current power are
recomputed from every scan image.

Display-name ownership rules:

```text
Selfie-created target  display_name="匿名"      editable in Selfie Mode
Field-created target   display_name="匿名目標"  never editable by the scanner
Public/Admin target    fixed display_name       never editable
```

The AI codename remains separate from `display_name` and can change with each
loadout scan. `PATCH /v1/targets/{targetId}` only updates `display_name` when
the target is editable and the request comes from Selfie Mode.

## Endpoint Summary

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | AI configuration and storage status |
| `POST` | `/v1/scan` | Graded face-embedding match |
| `GET` | `/v1/targets/{targetId}` | Read base profile |
| `POST` | `/v1/targets/{targetId}/confirm` | Add a possible-match embedding variant |
| `POST` | `/v1/targets/{targetId}/analyze` | Recalculate current loadout scan |
| `POST` | `/v1/targets/generate` | Create base profile and first scan result |
| `PATCH` | `/v1/targets/{targetId}` | Selfie-only display-name update |

Both image endpoints accept JPEG, PNG, or WebP files up to 10 MB. Generate also
requires `temporaryScanId`, JSON-encoded `faceEmbedding`, and `scanMode` set to
`selfie` or `field`.

Every generated/analyzed response includes `generationSource: "ai" | "mock"`.
See the root [`README.md`](../README.md#api) for complete request and response
examples.

Run tests with:

```bash
cd server
../.venv/bin/python -m pytest -q
```
