# 🎯 BountyFace

[English](#english) | [繁體中文](#繁體中文)

---

## English

Cyberpunk-style facial scanner that detects individuals against a high-risk entity database to dynamically render gamified "Threat Levels," contextual danger titles, and safety risk attributes in real-time.

### 1. Core Philosophy: Zero-Image Cloud Footprint
In this field mission, your mobile device acts as an advanced Cyber-Scanner. Unlike traditional facial recognition systems that upload raw photos to central servers, **BountyFace** extracts 512-dimensional feature vectors directly on the local device. The original raw images never leave your device, ensuring total privacy.

### 2. Tech Stack
*   **Frontend:** React Native (Expo SDK 52 / Architecture 22) - Handles real-time camera frame processing and local biometric tokenization.
*   **Backend:** Python FastAPI (Deployed on Google Cloud Run) - Lightweight orchestration layer for managing game-logic verification.
*   **Database:** Supabase (PostgreSQL) with `pgvector` & HNSW indexing - Secures and indexes mathematical feature embeddings with sub-millisecond retrieval.

### 3. Architecture Boundaries & Constraints
*   **Zero-Image Privacy Compliance:**  
    All facial images are processed and converted into feature vectors directly on the local device. **Only these de-identified embeddings are transmitted via HTTPS to the cloud (FastAPI) and securely stored in the encrypted Supabase database. The original raw images never leave the device and are never stored on any server.** This ensures absolute biometric privacy from the very first step.
    
*   **Lightweight Single-Instance Architecture:**  
    To keep the architecture lean and cost-efficient, this project deliberately avoids heavy, distributed vector databases (e.g., Milvus, Qdrant) or complex cluster load-balancing. Instead, a single-instance PostgreSQL database equipped with HNSW indexing (via Supabase `pgvector`) is utilized, providing sub-millisecond retrieval speeds that perfectly match the game's sandbox volume.

---

## 繁體中文

賽博朋克（Cyberpunk）風格的人臉掃描器。可針對高風險實體資料庫進行即時檢測，並動態渲染出遊戲化的「威脅等級（Threat Levels）」、情境危險稱號以及安全風險屬性。

### 1. 核心理念：雲端零影像足跡
在這場外勤任務中，你的行動裝置將化身為高級「賽博掃描器」。有別於傳統將原始照片上傳至中央伺服器的人臉辨識系統，**BountyFace** 直接在本地端設備提取 512 維的特徵向量。原始影像絕不離開裝置，從源頭杜絕隱私洩漏風險。

### 2. 技術選型
*   **前端端 (Frontend)：** React Native (Expo SDK 52 / Architecture 22) - 負責即時相機影格擷取（Frame Processing）與本地生物特徵權杖化（Tokenization）。
*   **雲端後端 (Backend)：** Python FastAPI (部署於 Google Cloud Run) - 輕量化業務邏輯層，負責處理遊戲判定與中繼路由。
*   **資料庫 (Database)：** Supabase (PostgreSQL) 啟用 `pgvector` 與 HNSW 索引 - 安全儲存並檢索數學特徵向量，提供毫秒級的比對速度。

### 3. 架構邊界與約束 (Architecture Boundaries & Constraints)
*   **零影像生物隱私合規 (Zero-Image Privacy Compliance)：**  
    所有臉部影像直接在本地端設備進行處理並轉換為特徵向量。**只有這些去識別化的嵌入向量（Embeddings）會透過 HTTPS 傳輸至雲端（FastAPI）並安全地儲存於加密的 Supabase 資料庫中。原始影像絕不離開裝置，且絕不儲存在任何伺服器上。** 確保個人生物特徵不留任何雲端足跡。
    
*   **輕量化單實例架構 (Lightweight Single-Instance Architecture)：**  
    為了保持架構精實與成本效益，本專案刻意不採用繁重的分布式向量資料庫（如 Milvus、Qdrant）。取而代之的是，使用配備 HNSW 索引的單實例 PostgreSQL（透過 Supabase `pgvector`），這對於目前的遊戲資料量來說，已經能提供極其流暢且低於毫秒級的檢索效能。


