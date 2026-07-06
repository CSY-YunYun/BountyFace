下面是你這個 **BountyFace MVP** 的完成順序。

## 技術選擇

```text
Frontend:
React Native + Expo Dev Build
react-native-vision-camera
react-native-vision-camera-mlkit
react-native-fast-tflite

Backend:
Python FastAPI
Google Cloud Run

Database:
Supabase PostgreSQL
pgvector + HNSW index

AI / Game Profile:
第一版先用規則 + 隨機 seed
第二版再接 Vision AI / LLM 分析照片
```

## 整體流程

```text
Camera live preview
→ ML Kit 偵測臉
→ 臉穩定後裁切臉
→ TFLite 產生 face embedding
→ POST /v1/scan
→ pgvector 比對
```

如果找到：

```text
GET /v1/targets/{targetId}
→ 相機畫面 overlay 顯示原本數值
```

如果沒找到：

```text
擷取一張完整照片
→ POST /v1/targets/generate
→ Server 暫時分析照片
→ 產生 profile
→ 只存 face embedding + profile
→ 丟棄照片
→ 相機畫面 overlay 顯示新數值
```

---

# Step 1：建立 App 基礎

目標：

```text
React Native app 可以開啟相機
可以請求 camera permission
可以顯示 live preview
```

需要功能：

```text
CameraScreen
Permission handling
Loading / No permission UI
```

完成標準：

```text
手機上可以看到相機畫面
```

---

# Step 2：加入臉部偵測

目標：

```text
即時偵測畫面中是否有人臉
```

需要功能：

```text
Face Detection
face bounding box
face quality check
```

臉部品質條件：

```text
有臉
臉夠大
臉在畫面中央
角度不要太歪
穩定存在 1 秒以上
```

UI 狀態：

```text
Searching target...
Move closer
Face forward
Locking...
Target locked
```

完成標準：

```text
相機掃到臉後，可以進入 Target locked 狀態
```

---

# Step 3：加入掃描 UI Overlay

目標：

```text
讓畫面看起來像 Cyberpunk 掃描器
```

需要功能：

```text
Face box
Scanning line
Status text
Lock animation
Threat loading panel
```

完成標準：

```text
掃到臉時，畫面上有框線與掃描狀態
```

---

# Step 4：加入人體 / 姿勢偵測

目標：

```text
判斷是否有完整人物或人體姿勢
```

需要功能：

```text
Pose Detection
body landmarks
hasFullBody
poseConfidence
```

可判斷：

```text
有頭
有肩膀
有上半身
有手臂
是否面向鏡頭
```

完成標準：

```text
掃描畫面可以知道「只有臉」或「有完整人物」
```

---

# Step 5：加入 face embedding

目標：

```text
把臉轉成向量
```

需要功能：

```text
Crop face
Resize face image
Normalize input
TFLite inference
Generate embedding
```

模型選擇：

```text
MobileFaceNet / ArcFace TFLite
```

完成標準：

```text
同一個人掃描多次，產生的 embedding 相似
不同人 embedding 差距較大
```

---

# Step 6：建立 Backend API

目標：

```text
FastAPI 可以接收 embedding 並回傳是否找到
```

需要 API：

```text
POST /v1/scan
GET /v1/targets/{targetId}
POST /v1/targets/generate
POST /v1/targets/{targetId}/analyze
```

Backend 支援兩種儲存模式：未設定 Supabase 時使用記憶體供本機測試；設定
Supabase 後使用 PostgreSQL + pgvector 永久保存。新人物會上傳 scanImage，使用
OpenAI vision Structured Outputs 產生 RPG profile；未設定 API key 時保留 mock
profile fallback。

人物資料分成固定的 base profile，以及每張照片重新計算的 scan result。
AI 只回傳裝備、服裝、姿勢 tier 與可見物品；加成與 current_power 由後端固定公式計算。

Face match 使用多 embedding 的最高 cosine similarity：0.75 以上 confirmed，
0.45 到 0.75 possible match，低於 0.45 建立新角色。possible match 可由使用者
Confirm 並加入新的 face variant，或選 Create New 建立不同年齡／造型版本。
臉部 crop 太暗、過曝或模糊時不送 API，要求重新掃描。
基本戰力、Level、Threat、STR/DEX/INT/LUK 綁定身份；當前稱號、裝備、服裝、
姿勢、物品與 current_power 每次掃描重新計算。
display_name 與 AI codename 分離：Selfie 建立為「匿名」且只能在 Selfie Mode
修改；Field 建立為「匿名目標」且不可修改；Public Figure / Admin 永遠不可修改。

完成標準：

```text
App 可以成功打到 FastAPI
```

---

# Step 7：建立 Supabase pgvector

目標：

```text
資料庫可以儲存 face embedding 並做相似度搜尋
```

需要資料表：

```text
targets
- id
- display_name
- special_title
- threat_level
- base_power
- level
- str / dex / int / luk
- description
- is_public_figure
- is_verified
- is_name_editable
- created_at
- updated_at

target_embeddings
- id
- target_id
- embedding vector(256)
- source
- quality_score
- created_at
```

需要索引：

```text
pgvector
cosine HNSW index
match_target_embeddings RPC
```

完成標準：

```text
後端可以用 embedding 找到最相似的 target
```

---

# Step 8：完成舊人物流程

目標：

```text
掃到同一張臉時，直接顯示既有 profile
```

流程：

```text
Face locked
→ Generate embedding
→ POST /v1/scan
→ matchFound = true
→ GET /v1/targets/{targetId}
→ Overlay 顯示 Threat Level
```

完成標準：

```text
同一個人第二次掃描，不會重新產生資料
而是直接顯示原本數值
```

---

# Step 9：完成新人物流程

目標：

```text
第一次掃描的人會產生新的遊戲角色資料
```

流程：

```text
Face locked
→ Generate embedding
→ POST /v1/scan
→ matchFound = false
→ Capture full scan image
→ POST /v1/targets/generate
→ Generate profile
→ Save embedding + profile
→ Show overlay
```

完成標準：

```text
新人物第一次掃描會建立 profile
照片不存 DB
只存 embedding + profile
```

---

# Step 10：遊戲數值產生邏輯

第一版建議先不要接 AI，看起來比較穩。

```text
用 targetId / embedding hash 當 seed
產生固定數值
```

例如：

```text
threat_level
power_level
net_worth
hacking
stealth
codename
description
```

完成標準：

```text
同一個人每次產生的數值一致
不同人數值不同
```

---

# Step 11：Live Overlay 顯示結果

目標：

```text
不要切到靜態照片頁
直接在相機畫面上顯示資料
```

需要 UI：

```text
Codename
Threat Level
Power Level
Hacking
Stealth
Description
```

完成標準：

```text
掃描成功後，相機繼續開著，數值浮在畫面上
```

---

# Step 12：防止重複掃描

目標：

```text
避免每秒一直打 API
```

需要功能：

```text
scan cooldown
same target lock
lastScannedTargetId
request throttle
```

建議：

```text
同一個 target 5 秒內不重複打 API
/v1/scan 每 1.5～2 秒最多一次
```

完成標準：

```text
不會因為 camera frame 太多造成 API 爆量
```

---

# Step 13：部署

目標：

```text
Backend 上 Cloud Run
Database 用 Supabase
App 連正式 API
```

需要功能：

```text
env config
CORS
API key / auth
HTTPS
error handling
```

完成標準：

```text
手機 App 可以連線到正式後端
```

---

# 建議開發順序

```text
1. Camera live preview
2. Face detection
3. Face lock UI
4. Mock profile overlay
5. FastAPI mock /v1/scan
6. Supabase targets table
7. pgvector search
8. TFLite face embedding
9. 舊人物 match flow
10. 新人物 generate flow
11. Pose detection
12. Cyberpunk UI polish
13. Deploy
```

你現在下一步應該先做：

```text
Camera live preview + Face detection + Target locked
```

先不要急著碰 embedding。
只要第一關穩了，後面才接得起來。
