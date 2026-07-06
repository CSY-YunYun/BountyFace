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
face embedding. A temporary scan image is used only to generate the per-scan
current title, visible equipment, style, pose, description, and gameplay bonuses.

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

Identity-bound permanent profile (stored in `targets` table):

```json
{
  "id": "target-uuid",
  "display_name": "Anonymous",
  "special_title": "",
  "base_power": 9842,
  "threat_level": "S",
  "level": 87,
  "str": 82,
  "dex": 91,
  "int": 35,
  "luk": 99,
  "is_public_figure": false,
  "is_verified": false,
  "is_name_editable": true
}
```

Per-scan result (AI-generated, never stored in DB):

```json
{
  "current_title": "Thunder Vanguard",
  "current_description": "A swift shadow in the neon rain.",
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
rescan. `special_title` is admin-assigned and never modified by AI.

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
Selfie Mode: new display_name="匿名"    editable=true   verified=false
Field Mode:  new display_name="匿名目標" editable=false  verified=false
Public/Admin: fixed display_name        editable=false  verified=true
```

`display_name` is user/admin-owned. `special_title` is admin-assigned.
`current_title` is AI-generated per scan and returned in `scan_result`.

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
    "current_title": "Thunder Vanguard",
    "current_description": "A swift shadow in the neon rain.",
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

### Publishing (AltStore / SideStore)

BountyFace is an open-source side project — no App Store, no Apple Developer
Program fees. Distribute via AltStore or SideStore.

#### Architecture

```text
Cloud
├── FastAPI (Supabase Cloud)
├── Supabase (PostgreSQL + pgvector)
└── OpenAI (GPT-5.5)

Client
├── Android → APK (direct install)
└── iPhone  → IPA via AltStore / SideStore
```

#### iPhone: Build & Install

1. **Build the IPA**

   ```bash
   cd frontend
   npx eas build --platform ios --profile production
   ```

   EAS Build produces a signed `.ipa` file.

2. **Install AltStore**

   - Install [AltServer](https://altstore.io) on your Mac/PC.
   - Connect your iPhone via USB.
   - Use AltServer to install AltStore onto your iPhone.
   - Sign in with your personal Apple ID (free account works).

3. **Install BountyFace**

   - Share the `.ipa` to your iPhone (AirDrop, Files, or any method).
   - Open the file in AltStore → **Install**.

   The app refreshes every 7 days (free Apple ID limit). AltStore
   auto-refreshes when your iPhone is on the same Wi-Fi as AltServer.

#### Android: Build & Install

```bash
cd frontend
npx eas build --platform android --profile production
```

Download the `.apk` and install directly on your Android device.

#### For Friends

Your friends follow the same steps: install AltStore → sign in with their
own Apple ID → install your IPA. No developer account needed.

#### Limitations (Free Apple ID)

- App signature expires after 7 days (AltStore auto-refreshes).
- Limited number of sideloaded apps (typically 3).
- Acceptable for testing and side-project distribution.

For larger audiences, consider Apple Developer Program ($99/year) for
TestFlight or App Store distribution.

---

## 繁體中文

BountyFace 是賽博龐克 RPG 掃描器。身份判斷以 iPhone 本機產生的 Face
Embedding 為主；暫時掃描照片只用來分析當次 AI 稱號、可見裝備、服裝、姿勢、
描述與遊戲加成。

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

永久資料（存於 `targets` 資料表）：

```text
display_name          special_title          base_power
threat_level          level                  STR / DEX / INT / LUK
is_public_figure      is_verified            is_name_editable
最多八組 face embeddings
```

每次掃描重新計算（AI 即時產生，不存 DB）：

```text
current_title          current_description
equipment_bonus        style_bonus            pose_bonus
current_power          detected_items         current_status
```

```text
current_power = base_power + equipment_bonus + style_bonus + pose_bonus
```

AI 只回傳裝備、服裝與姿勢的固定 tier；真正 bonus 由 FastAPI 的固定表格換算，
避免模型每次自由產生不同加成。`special_title` 為管理員手動設定，AI 永遠不會修改。

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
Selfie Mode：新人物 display_name="匿名"    editable=true   verified=false
Field Mode： 新人物 display_name="匿名目標" editable=false  verified=false
Public/Admin：固定 display_name            editable=false  verified=true
```

`display_name` 是使用者／管理員擁有的固定名稱。`special_title` 由管理員設定。
`current_title` 由 AI 每次掃描產生，僅存在 `scan_result` 中。

### 發布方式（AltStore / SideStore）

BountyFace 是開源 Side Project — 不需 App Store、不需 Apple Developer 年費，
透過 AltStore 或 SideStore 發布即可。

#### 架構

```text
Cloud
├── FastAPI（Supabase Cloud）
├── Supabase（PostgreSQL + pgvector）
└── OpenAI（GPT-5.5）

Client
├── Android → APK 直接安裝
└── iPhone  → IPA 透過 AltStore / SideStore 安裝
```

#### iPhone：編譯與安裝

1. **編譯 IPA**

   ```bash
   cd frontend
   npx eas build --platform ios --profile production
   ```

   EAS Build 會產生簽署好的 `.ipa` 檔案。

2. **安裝 AltStore**

   - 在 Mac/PC 安裝 [AltServer](https://altstore.io)。
   - iPhone 用 USB 連接電腦。
   - 透過 AltServer 將 AltStore 安裝到 iPhone。
   - 用自己的 Apple ID 登入（免費帳號即可）。

3. **安裝 BountyFace**

   - 將 `.ipa` 傳到 iPhone（AirDrop、Files 等方式）。
   - 在 AltStore 中開啟 → **Install**。

   App 每 7 天需重新簽署（免費 Apple ID 限制）。AltStore 在 iPhone 與
   AltServer 同 Wi-Fi 時會自動更新。

#### Android：編譯與安裝

```bash
cd frontend
npx eas build --platform android --profile production
```

下載 `.apk` 後直接在 Android 裝置上安裝。

#### 給朋友玩

朋友也照相同流程：安裝 AltStore → 用自己的 Apple ID 登入 → 安裝你的 IPA。
完全不需要 Developer 帳號。

#### 免費 Apple ID 限制

- App 簽章 7 天後過期（AltStore 自動更新）。
- 可安裝的自簽 App 數量有限（通常 3 個）。
- 對測試與 Side Project 發布來說完全夠用。

未來使用者變多時，可考慮加入 Apple Developer Program（$99/年），使用
TestFlight 或正式上架 App Store。

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

使用 `multipart/form-data` 上傳 `scanImage`。Base Profile 不變，只更新 current_title、
裝備／服裝／姿勢加成、描述、可見物品、狀態與 Current Power。

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
