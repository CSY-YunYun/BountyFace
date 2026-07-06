const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://127.0.0.1:8000';

export type ApiTargetProfile = {
  id: string;
  display_name: string;
  codename: string;
  base_power: number;
  threat_level: string;
  level: number;
  str: number;
  dex: number;
  int: number;
  luk: number;
  description: string;
  is_public_figure: boolean;
  is_verified: boolean;
  is_name_editable: boolean;
};

export type ApiScanResult = {
  scan_title: string;
  equipment_bonus: number;
  style_bonus: number;
  pose_bonus: number;
  current_power: number;
  detected_items: string[];
  current_status: string;
};

type ScanResponse = {
  status: 'SUCCESS';
  matchStatus: 'confirmed' | 'possible' | 'new';
  matchFound: boolean;
  targetId?: string;
  temporaryScanId?: string;
  confidence?: number;
  message: string;
};

type ProfileResponse = {
  status: 'SUCCESS';
  profile: ApiTargetProfile;
};

type GenerateResponse = ProfileResponse & {
  message: string;
  targetId: string;
  generationSource: 'ai' | 'mock';
  scan_result: ApiScanResult;
};

type AnalyzeResponse = ProfileResponse & {
  generationSource: 'ai' | 'mock';
  scan_result: ApiScanResult;
};

async function requestJson<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, options);
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `API request failed with status ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function scanFace(faceEmbedding: number[], signal?: AbortSignal) {
  return requestJson<ScanResponse>('/v1/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ faceEmbedding }),
    signal,
  });
}

export function getTarget(targetId: string, signal?: AbortSignal) {
  return requestJson<ProfileResponse>(`/v1/targets/${encodeURIComponent(targetId)}`, { signal });
}

export function confirmTargetMatch(
  targetId: string,
  temporaryScanId: string,
  signal?: AbortSignal,
) {
  return requestJson<ProfileResponse & { embeddingCount: number }>(
    `/v1/targets/${encodeURIComponent(targetId)}/confirm`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ temporaryScanId }),
      signal,
    },
  );
}

export function updateTargetDisplayName(
  targetId: string,
  displayName: string,
  scanMode: 'selfie' | 'field',
  signal?: AbortSignal,
) {
  return requestJson<ProfileResponse>(`/v1/targets/${encodeURIComponent(targetId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName, scanMode }),
    signal,
  });
}

function appendScanImage(formData: FormData, scanImagePath: string) {
  formData.append('scanImage', {
    uri: scanImagePath.startsWith('file://') ? scanImagePath : `file://${scanImagePath}`,
    type: 'image/jpeg',
    name: 'scan.jpg',
  } as unknown as Blob);
}

export function analyzeTargetScan(
  targetId: string,
  scanImagePath: string,
  signal?: AbortSignal,
) {
  const formData = new FormData();
  appendScanImage(formData, scanImagePath);
  return requestJson<AnalyzeResponse>(`/v1/targets/${encodeURIComponent(targetId)}/analyze`, {
    method: 'POST',
    body: formData,
    signal,
  });
}

export function generateTarget(
  temporaryScanId: string,
  faceEmbedding: number[],
  scanMode: 'selfie' | 'field',
  scanImagePath?: string,
  signal?: AbortSignal,
) {
  const formData = new FormData();
  formData.append('temporaryScanId', temporaryScanId);
  formData.append('faceEmbedding', JSON.stringify(faceEmbedding));
  formData.append('scanMode', scanMode);
  if (scanImagePath) {
    appendScanImage(formData, scanImagePath);
  }
  return requestJson<GenerateResponse>('/v1/targets/generate', {
    method: 'POST',
    body: formData,
    signal,
  });
}
