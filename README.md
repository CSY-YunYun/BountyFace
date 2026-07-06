# BountyFace

[English](#english) | [繁體中文](#繁體中文)

## Project Structure

- Frontend: [`frontend`](frontend)
- Backend: [`server`](server)
- System design: [`systemDesignChart.png`](systemDesignChart.png)

![System design chart](systemDesignChart.png)

---

## English

BountyFace is a cyberpunk RPG scanner. Identity is matched from an on-device
face embedding. A temporary scan image is used only to generate the current AI
codename, visible equipment, style, pose, and gameplay bonuses.

### Current Implementation

- React Native with Expo SDK 54 and VisionCamera.
- SE-MobileFaceNet TensorFlow Lite inference on iPhone.
- 256-dimensional, L2-normalized face embeddings.
- FastAPI with switchable memory or Supabase PostgreSQL + pgvector storage.
- GPT-5.5 vision with Structured Outputs for fictional RPG analysis.
- Supabase stores persistent base profiles and up to eight embeddings per target.
- Raw scan images are processed in memory and are not stored.

Run `npx --yes supabase start` to launch the local database and open Supabase
Studio at `http://127.0.0.1:54323`. See [`supabase/README.md`](supabase/README.md).

### Data Model

Identity-bound base profile:

```json
{
  "id": "target-uuid",
  "display_name": "Anonymous target",
  "codename": "Current AI codename",
  "base_power": 9842,
  "threat_level": "S",
  "level": 87,
  "str": 82,
  "dex": 91,
  "int": 35,
  "luk": 99,
  "description": "Persistent base character description.",
  "is_public_figure": false,
  "is_name_editable": false
}
```

Per-scan result:

```json
{
  "scan_title": "Thunder Vanguard",
  "equipment_bonus": 350,
  "style_bonus": 120,
  "pose_bonus": 80,
  "current_power": 10392,
  "detected_items": ["Katana", "Black coat"],
  "current_status": "Combat ready"
}
```

```text
current_power = base_power + equipment_bonus + style_bonus + pose_bonus
```

The AI chooses categorical equipment/style/pose tiers. FastAPI converts those
tiers to deterministic bonus values. Base stats never change during a loadout
rescan.

### Identity Matching

Each target can hold up to eight face embeddings. A query is compared against
all embeddings and uses the highest cosine similarity.

```text
similarity >= 0.75       confirmed match
0.45 <= similarity < .75 possible match; user confirms or creates a new target
similarity < 0.45        new target
```

Confirmed scans automatically add high-quality appearance variants. Confirming
a possible match also adds the new embedding to that target.

### Display Name Rules

```text
Selfie Mode: new display_name="匿名", editable only in Selfie Mode
Field Mode:  new display_name="匿名目標", never editable by the scanner
Public/Admin: fixed display_name, never editable
```

`display_name` is user/admin-owned. `codename` is AI-generated and may change
with the current equipment and appearance.

### API

#### Health

`GET /health`

```json
{
  "status": "ok",
  "aiConfigured": true,
  "profileModel": "gpt-5.5",
  "storage": "supabase",
  "embeddingDimension": 256
}
```

#### Match Face Embedding

`POST /v1/scan`

```json
{ "faceEmbedding": [0.0123, -0.4567, 0.8912] }
```

Confirmed response:

```json
{
  "status": "SUCCESS",
  "matchStatus": "confirmed",
  "matchFound": true,
  "targetId": "target-uuid",
  "confidence": 0.91,
  "message": "Target identified successfully."
}
```

Possible response:

```json
{
  "status": "SUCCESS",
  "matchStatus": "possible",
  "matchFound": false,
  "targetId": "candidate-target-uuid",
  "temporaryScanId": "temp-uuid",
  "confidence": 0.63,
  "message": "Possible target match. Confirmation required."
}
```

New response:

```json
{
  "status": "SUCCESS",
  "matchStatus": "new",
  "matchFound": false,
  "temporaryScanId": "temp-uuid",
  "confidence": 0.31,
  "message": "New face detected. Please generate a profile."
}
```

#### Get Base Profile

`GET /v1/targets/{targetId}`

```json
{ "status": "SUCCESS", "profile": { "id": "target-uuid", "display_name": "Joey" } }
```

#### Confirm Possible Match

`POST /v1/targets/{targetId}/confirm`

```json
{ "temporaryScanId": "temp-uuid" }
```

The pending embedding is added to the existing target.

#### Analyze Current Loadout

`POST /v1/targets/{targetId}/analyze`

Content type: `multipart/form-data`

```text
scanImage: JPEG, PNG, or WebP; maximum 10 MB
```

Response:

```json
{
  "status": "SUCCESS",
  "generationSource": "ai",
  "profile": { "id": "target-uuid", "base_power": 9842 },
  "scan_result": {
    "scan_title": "Thunder Vanguard",
    "equipment_bonus": 350,
    "style_bonus": 120,
    "pose_bonus": 80,
    "current_power": 10392,
    "detected_items": ["Katana", "Black coat"],
    "current_status": "Combat ready"
  }
}
```

#### Generate New Target

`POST /v1/targets/generate`

Content type: `multipart/form-data`

```text
temporaryScanId: string
faceEmbedding: JSON-encoded number array
scanMode: selfie | field
scanImage: JPEG, PNG, or WebP; maximum 10 MB
```

Returns the new base `profile` and first `scan_result`. `generationSource` is
`ai` when OpenAI is configured, otherwise `mock`.

#### Update Display Name

`PATCH /v1/targets/{targetId}`

```json
{ "displayName": "Joey", "scanMode": "selfie" }
```

Only an editable, non-public target can be renamed, and only from Selfie Mode.
Field, public-figure, and admin rename attempts return `403`.

---

## 繁體中文

BountyFace 是賽博龐克 RPG 掃描器。身份判斷以 iPhone 本機產生的 Face
Embedding 為主；暫時掃描照片只用來分析當次 AI 稱號、可見裝備、服裝、姿勢與
遊戲加成。

### 目前實作

- React Native、Expo SDK 54、VisionCamera。
- iPhone 本機執行 SE-MobileFaceNet TensorFlow Lite。
- 產生 256 維、L2 Normalize 的 Face Embedding。
- FastAPI 支援 memory 測試模式與 Supabase PostgreSQL + pgvector 永久儲存。
- GPT-5.5 Vision + Structured Outputs 產生虛構 RPG 資料。
- Supabase 保存人物基本資料，以及每人最多八組 Face Embedding。
- 原始掃描照片只在記憶體處理，不永久儲存。

執行 `npx --yes supabase start` 可啟動本機資料庫，並在
`http://127.0.0.1:54323` 開啟 Supabase Studio。詳細步驟請看
[`supabase/README.md`](supabase/README.md)。

### 資料分層

身份固定資料：

```text
display_name
base_power
threat_level
level
STR / DEX / INT / LUK
description
is_public_figure
is_name_editable
最多八組 face embeddings
```

每次掃描重新計算：

```text
codename / scan_title
equipment_bonus
style_bonus
pose_bonus
current_power
detected_items
current_status
```

```text
current_power = base_power + equipment_bonus + style_bonus + pose_bonus
```

AI 只回傳裝備、服裝與姿勢的固定 tier；真正 bonus 由 FastAPI 的固定表格換算，
避免模型每次自由產生不同加成。

### 身份比對規則

每個人物最多保存八組 Face Embedding，比對時取所有 embedding 中最高的 cosine
similarity：

```text
>= 0.75      Confirmed Match，直接使用原本基本資料
0.45–0.75   Possible Match，使用者選 Confirm 或 Create New
< 0.45       New Target，建立新角色
```

Confirm 後會把這次 embedding 加入該人物。高相似度 Confirmed Match 也會自動加入
合格的新外觀版本。

### 顯示名稱權限

```text
Selfie Mode：新人物 display_name="匿名"，只能在 Selfie Mode 修改
Field Mode： 新人物 display_name="匿名目標"，掃描者不能修改
Public/Admin：固定 display_name，永遠不能修改
```

`display_name` 是使用者／管理員擁有的固定名稱；`codename` 是 AI 依當次裝備與
外觀重新產生的稱號。

### API Design

#### 健康狀態

`GET /health`

回傳 AI 是否設定、模型名稱與目前儲存模式。

#### 比對 Face Embedding

`POST /v1/scan`

```json
{ "faceEmbedding": [0.0123, -0.4567, 0.8912] }
```

回傳 `matchStatus: confirmed | possible | new`、最高 `confidence`，以及需要時使用的
`targetId`／`temporaryScanId`。

#### 取得基本資料

`GET /v1/targets/{targetId}`

只取得該身份的 Base Profile，不重新分析照片。

#### 確認 Possible Match

`POST /v1/targets/{targetId}/confirm`

```json
{ "temporaryScanId": "temp-uuid" }
```

將這次 embedding 加入既有人物，未來用多 embedding 的最高相似度比對。

#### 重新分析當次裝備

`POST /v1/targets/{targetId}/analyze`

使用 `multipart/form-data` 上傳 `scanImage`。Base Profile 不變，只更新 AI Codename、
裝備／服裝／姿勢加成、可見物品、狀態與 Current Power。

#### 建立新人物

`POST /v1/targets/generate`

```text
temporaryScanId: string
faceEmbedding: JSON number array
scanMode: selfie | field
scanImage: JPEG / PNG / WebP，最大 10 MB
```

回傳新 Base Profile 與第一次 Scan Result。

#### 修改 Display Name

`PATCH /v1/targets/{targetId}`

```json
{ "displayName": "Joey", "scanMode": "selfie" }
```

只允許 Selfie Mode 修改 `is_name_editable=true` 且非 Public Figure 的人物。Field、
Public Figure 與 Admin 都會由後端回傳 `403`。

### 常見錯誤

```text
403  Display Name 不可修改
404  Target 或 Temporary Scan 不存在
409  Face Embedding 與 Temporary Scan 不一致
413  Scan Image 超過 10 MB
415  不支援的圖片格式
422  缺少／無效欄位或照片品質流程未完成
502  OpenAI RPG 分析失敗
```

詳細啟動與測試方式請參考 [`server/README.md`](server/README.md)。
